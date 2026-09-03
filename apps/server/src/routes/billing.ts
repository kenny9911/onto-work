import type { FastifyInstance, FastifyRequest } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import type { PlanId, SubscriptionStatus } from "@agent-harness/contracts";
import type { HarnessConfig } from "../config.js";
import type { HarnessStore, StripeWebhookOutcome } from "../database.js";
import { ApiHttpError, requireAdmin, requireUser } from "../http.js";

interface CheckoutSessionLike {
  client_reference_id?: string | null;
  customer?: unknown;
  metadata?: Record<string, string> | null;
  subscription?: unknown;
}

interface SubscriptionItemLike {
  current_period_start?: number;
  current_period_end?: number;
  price?: { id?: string };
  quantity?: number | null;
}

interface SubscriptionLike {
  id: string;
  current_period_start?: number;
  current_period_end?: number;
  customer?: unknown;
  items?: { data?: SubscriptionItemLike[] };
  metadata?: Record<string, string> | null;
  status?: string;
}

const checkoutSchema = z
  .object({
    plan: z.enum(["pro", "team"]),
    seats: z.number().int().min(1).max(1_000).default(1),
  })
  .strict();

function configuredStripe(stripe: Stripe | null): Stripe {
  if (!stripe) {
    throw new ApiHttpError(503, "billing_not_configured", "Subscription billing is not configured.");
  }
  return stripe;
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function planFromValue(value: unknown): PlanId | null {
  return value === "free" || value === "pro" || value === "team" || value === "enterprise"
    ? value
    : null;
}

function subscriptionStatus(value: string | undefined, deleted: boolean): SubscriptionStatus {
  if (deleted) return "canceled";
  if (
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled" ||
    value === "unpaid"
  ) {
    return value;
  }
  if (value === "incomplete_expired") return "canceled";
  return "none";
}

function tenantFromBillingReference(
  store: HarnessStore,
  customerId: string | null,
  subscriptionId: string | null,
): string | null {
  const row = store.db
    .prepare(`
      SELECT tenant_id
      FROM subscriptions
      WHERE (? IS NOT NULL AND stripe_subscription_id = ?)
         OR (? IS NOT NULL AND stripe_customer_id = ?)
      LIMIT 1
    `)
    .get(subscriptionId, subscriptionId, customerId, customerId) as
    | { tenant_id: string }
    | undefined;
  return row?.tenant_id ?? null;
}

function inferPlan(
  subscription: SubscriptionLike,
  config: HarnessConfig,
  fallback: PlanId,
): PlanId {
  const metadataPlan = planFromValue(subscription.metadata?.plan);
  if (metadataPlan) return metadataPlan;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (priceId && priceId === config.stripePricePro) return "pro";
  if (priceId && priceId === config.stripePriceTeam) return "team";
  return fallback;
}

function stripeTimestamp(value: number | undefined, field: string): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiHttpError(
      502,
      "billing_data_invalid",
      `Stripe did not return a valid ${field}.`,
    );
  }
  return new Date(value * 1_000).toISOString();
}

export function checkoutIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,255}$/.test(value)) {
    throw new ApiHttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 1 to 255 visible ASCII characters.",
    );
  }
  return value;
}

function applySubscription(
  store: HarnessStore,
  config: HarnessConfig,
  tenantId: string,
  subscription: SubscriptionLike,
  deleted: boolean,
  event: Pick<Stripe.Event, "id" | "type" | "created">,
): StripeWebhookOutcome {
  const current = store.getSubscription(tenantId, true);
  const firstItem = subscription.items?.data?.[0];
  const periodStart = firstItem?.current_period_start ?? subscription.current_period_start;
  const periodEnd = firstItem?.current_period_end ?? subscription.current_period_end;
  return store.applyStripeSubscriptionEvent({
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    objectId: subscription.id,
    tenantId,
    plan: inferPlan(subscription, config, current.plan),
    status: subscriptionStatus(subscription.status, deleted),
    seats: Math.max(1, firstItem?.quantity ?? current.seats),
    customerId: objectId(subscription.customer),
    subscriptionId: subscription.id,
    currentPeriodStart: stripeTimestamp(periodStart, "billing period start"),
    currentPeriodEnd:
      periodEnd === undefined ? null : stripeTimestamp(periodEnd, "billing period end"),
  });
}

async function processWebhook(
  stripe: Stripe,
  store: HarnessStore,
  config: HarnessConfig,
  event: Stripe.Event,
): Promise<StripeWebhookOutcome> {
  if (store.stripeWebhookProcessed(event.id)) return "duplicate";
  const eventObjectId = objectId(event.data.object);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as unknown as CheckoutSessionLike;
    const subscriptionId = objectId(session.subscription);
    const customerId = objectId(session.customer);
    const tenantId =
      session.client_reference_id ??
      session.metadata?.tenantId ??
      tenantFromBillingReference(store, customerId, subscriptionId);
    if (!tenantId || !subscriptionId) {
      return store.recordIgnoredStripeWebhook({
        eventId: event.id,
        eventType: event.type,
        eventCreated: event.created,
        objectId: eventObjectId,
      });
    }
    const subscription = (await stripe.subscriptions.retrieve(
      subscriptionId,
    )) as unknown as SubscriptionLike;
    return applySubscription(store, config, tenantId, subscription, false, event);
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const eventSubscription = event.data.object as unknown as SubscriptionLike;
    const customerId = objectId(eventSubscription.customer);
    const tenantId =
      eventSubscription.metadata?.tenantId ??
      tenantFromBillingReference(store, customerId, eventSubscription.id);
    if (!tenantId) {
      return store.recordIgnoredStripeWebhook({
        eventId: event.id,
        eventType: event.type,
        eventCreated: event.created,
        objectId: eventObjectId,
      });
    }
    const deleted = event.type === "customer.subscription.deleted";
    const subscription = deleted
      ? eventSubscription
      : (await stripe.subscriptions.retrieve(eventSubscription.id)) as unknown as SubscriptionLike;
    return applySubscription(
      store,
      config,
      tenantId,
      subscription,
      deleted,
      event,
    );
  }

  return store.recordIgnoredStripeWebhook({
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    objectId: eventObjectId,
  });
}

export function registerBillingRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig; stripe: Stripe | null },
): void {
  const { store, config, stripe } = input;

  app.get("/api/billing/subscription", async (request) => {
    const user = requireUser(request, store);
    return {
      subscription: store.getSubscription(user.tenantId, Boolean(stripe)),
    };
  });

  app.post("/api/billing/checkout", async (request) => {
    const actor = requireAdmin(request, store);
    const body = checkoutSchema.parse(request.body);
    const client = configuredStripe(stripe);
    const price = body.plan === "pro" ? config.stripePricePro : config.stripePriceTeam;
    if (!price) {
      throw new ApiHttpError(
        503,
        "billing_plan_not_configured",
        `The ${body.plan} plan is not configured for checkout.`,
      );
    }
    const existingCustomerId = store.getStripeCustomerId(actor.tenantId);
    const idempotencyKey = checkoutIdempotencyKey(request.headers["idempotency-key"]);
    const session = await client.checkout.sessions.create(
      {
        mode: "subscription",
        ...(existingCustomerId ? { customer: existingCustomerId } : {}),
        client_reference_id: actor.tenantId,
        line_items: [{ price, quantity: body.seats }],
        metadata: { tenantId: actor.tenantId, plan: body.plan },
        subscription_data: {
          metadata: { tenantId: actor.tenantId, plan: body.plan },
        },
        success_url: `${config.publicAppUrl.replace(/\/$/, "")}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.publicAppUrl.replace(/\/$/, "")}/settings/billing?checkout=canceled`,
      },
      { idempotencyKey: `${actor.tenantId}:${idempotencyKey}` },
    );
    if (!session.url) {
      throw new ApiHttpError(502, "checkout_unavailable", "Stripe did not return a checkout URL.");
    }
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "billing.checkout_created",
      targetType: "checkout_session",
      targetId: session.id,
      metadata: { plan: body.plan, seats: body.seats },
    });
    return { url: session.url };
  });

  app.post("/api/billing/portal", async (request) => {
    const actor = requireAdmin(request, store);
    const client = configuredStripe(stripe);
    const customerId = store.getStripeCustomerId(actor.tenantId);
    if (!customerId) {
      throw new ApiHttpError(
        409,
        "billing_customer_missing",
        "Start a subscription before opening the billing portal.",
      );
    }
    const session = await client.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${config.publicAppUrl.replace(/\/$/, "")}/settings/billing`,
    });
    store.audit({
      tenantId: actor.tenantId,
      userId: actor.id,
      action: "billing.portal_opened",
      targetType: "billing_customer",
      targetId: customerId,
    });
    return { url: session.url };
  });

  app.post(
    "/api/billing/webhook",
    { config: { rawBody: true } },
    async (request: FastifyRequest, reply) => {
      const client = configuredStripe(stripe);
      if (!config.stripeWebhookSecret) {
        throw new ApiHttpError(
          503,
          "billing_webhook_not_configured",
          "Stripe webhook verification is not configured.",
        );
      }
      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      const signatureHeader = request.headers["stripe-signature"];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (!rawBody || !signature) {
        throw new ApiHttpError(400, "invalid_webhook", "Missing Stripe webhook signature.");
      }

      let event: Stripe.Event;
      try {
        event = client.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
      } catch {
        throw new ApiHttpError(400, "invalid_webhook", "Stripe webhook signature is invalid.");
      }
      const outcome = await processWebhook(client, store, config, event);
      return reply.status(200).send({
        received: true,
        ...(outcome === "duplicate" ? { duplicate: true } : {}),
      });
    },
  );
}
