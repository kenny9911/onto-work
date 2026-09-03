import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  HarnessStore,
  SeatLimitExceededError,
  type StripeSubscriptionEventInput,
} from "../database.js";
import { ApiHttpError } from "../http.js";
import { checkoutIdempotencyKey } from "./billing.js";

async function storeFixture(t: TestContext): Promise<{
  databasePath: string;
  store: HarnessStore;
  tenantId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-billing-"));
  const databasePath = join(directory, "billing.db");
  const store = new HarnessStore(databasePath);
  const user = await store.bootstrapAdmin("billing-admin", "billing-test-password");
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { databasePath, store, tenantId: user.tenantId };
}

function subscriptionEvent(
  tenantId: string,
  overrides: Partial<StripeSubscriptionEventInput> = {},
): StripeSubscriptionEventInput {
  return {
    eventId: "evt_initial",
    eventType: "customer.subscription.updated",
    eventCreated: 1_800_000_000,
    objectId: "sub_test",
    tenantId,
    plan: "team",
    status: "active",
    seats: 3,
    customerId: "cus_test",
    subscriptionId: "sub_test",
    currentPeriodStart: "2027-01-01T00:00:00.000Z",
    currentPeriodEnd: "2027-02-01T00:00:00.000Z",
    ...overrides,
  };
}

test("Stripe events preserve billing periods, deduplicate, and reject stale state", async (t) => {
  const { store, tenantId } = await storeFixture(t);
  const initial = subscriptionEvent(tenantId);
  assert.equal(store.applyStripeSubscriptionEvent(initial), "applied");
  assert.equal(store.getLatestEntitlementSnapshot(tenantId)?.periodStart, initial.currentPeriodStart);

  const versionAfterInitial = store.getLatestEntitlementSnapshot(tenantId)!.version;
  assert.equal(store.applyStripeSubscriptionEvent(initial), "duplicate");
  assert.equal(store.getLatestEntitlementSnapshot(tenantId)?.version, versionAfterInitial);

  const samePeriod = subscriptionEvent(tenantId, {
    eventId: "evt_same_period",
    eventCreated: initial.eventCreated + 100,
    seats: 4,
  });
  assert.equal(store.applyStripeSubscriptionEvent(samePeriod), "applied");
  const samePeriodEntitlement = store.getLatestEntitlementSnapshot(tenantId)!;
  assert.equal(samePeriodEntitlement.periodStart, initial.currentPeriodStart);
  assert.equal(samePeriodEntitlement.seatLimit, 4);

  const stale = subscriptionEvent(tenantId, {
    eventId: "evt_stale",
    eventCreated: initial.eventCreated + 50,
    status: "canceled",
    seats: 1,
  });
  const versionBeforeStale = samePeriodEntitlement.version;
  assert.equal(store.applyStripeSubscriptionEvent(stale), "stale");
  assert.equal(store.getLatestEntitlementSnapshot(tenantId)?.version, versionBeforeStale);
  assert.equal(store.getSubscription(tenantId, true).status, "active");
  const staleEvent = store.db
    .prepare("SELECT outcome FROM billing_webhook_events WHERE event_id = ?")
    .get(stale.eventId) as { outcome: string };
  assert.equal(staleEvent.outcome, "stale");
  const staleAudit = store.db
    .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?")
    .get(stale.eventId) as { count: number };
  assert.equal(staleAudit.count, 1);

  const rollover = subscriptionEvent(tenantId, {
    eventId: "evt_rollover",
    eventCreated: initial.eventCreated + 200,
    currentPeriodStart: "2027-02-01T00:00:00.000Z",
    currentPeriodEnd: "2027-03-01T00:00:00.000Z",
  });
  assert.equal(store.applyStripeSubscriptionEvent(rollover), "applied");
  assert.equal(store.getLatestEntitlementSnapshot(tenantId)?.periodStart, rollover.currentPeriodStart);
});

test("failed Stripe mutation rolls back its event and audit atomically", async (t) => {
  const { store } = await storeFixture(t);
  const invalid = subscriptionEvent("missing-tenant", { eventId: "evt_invalid_tenant" });
  assert.throws(() => store.applyStripeSubscriptionEvent(invalid));
  assert.equal(store.stripeWebhookProcessed(invalid.eventId), false);
  const audit = store.db
    .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?")
    .get(invalid.eventId) as { count: number };
  assert.equal(audit.count, 0);
});

test("ignored Stripe events are durably idempotent", async (t) => {
  const { store } = await storeFixture(t);
  const event = {
    eventId: "evt_ignored",
    eventType: "invoice.created",
    eventCreated: 1_800_000_000,
    objectId: "in_test",
  };
  assert.equal(store.recordIgnoredStripeWebhook(event), "ignored");
  assert.equal(store.recordIgnoredStripeWebhook(event), "duplicate");
});

test("seat admission is serialized across database connections", async (t) => {
  const { databasePath, store, tenantId } = await storeFixture(t);
  const current = store.getLatestEntitlementSnapshot(tenantId)!;
  store.createEntitlementSnapshot({
    tenantId,
    plan: current.plan,
    status: current.status,
    seatLimit: 2,
    activeRunLimit: current.activeRunLimit,
    requestLimit: current.requestLimit,
    periodStart: current.periodStart,
    periodEnd: current.periodEnd,
    allowedRouteIds: current.allowedRouteIds,
  });
  const secondStore = new HarnessStore(databasePath);
  t.after(() => secondStore.close());

  const attempts = await Promise.allSettled([
    store.createUser({
      tenantId,
      username: "seat-one",
      displayName: "Seat One",
      password: "seat-one-long-password",
      role: "member",
    }),
    secondStore.createUser({
      tenantId,
      username: "seat-two",
      displayName: "Seat Two",
      password: "seat-two-long-password",
      role: "member",
    }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof SeatLimitExceededError);
  assert.equal(store.listUsers(tenantId).filter((user) => user.status === "active").length, 2);
});

test("checkout idempotency keys are mandatory and strictly bounded", () => {
  assert.equal(checkoutIdempotencyKey("checkout-123"), "checkout-123");
  for (const invalid of [undefined, "", "contains space", "é", "x".repeat(256)]) {
    assert.throws(
      () => checkoutIdempotencyKey(invalid),
      (error: unknown) =>
        error instanceof ApiHttpError && error.code === "invalid_idempotency_key",
    );
  }
});
