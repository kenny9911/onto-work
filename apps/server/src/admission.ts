import { createHash } from "node:crypto";

import type { JsonValue } from "./codex/runtime.js";
import type { HarnessStore, ProviderRow, UsageReservation } from "./database.js";

export const USAGE_RESERVATION_LEASE_MS = 30 * 60 * 1_000;

export class RunAdmissionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunAdmissionError";
  }
}

export interface RunAdmissionInput {
  tenantId: string;
  userId: string;
  operation: UsageReservation["operation"];
  workspacePath?: string | null;
  threadId?: string | null;
  requestedModel?: string | null;
  idempotencyKey: string;
  requestPayload: unknown;
}

export interface RunAdmission {
  reservationId: string;
  provider: ProviderRow;
  model: string;
  workspacePath: string | null;
  replayed: boolean;
  replayResult: JsonValue | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requestHash(input: {
  operation: UsageReservation["operation"];
  workspacePath: string | null;
  threadId: string | null;
  providerId: string;
  model: string;
  payload: unknown;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function subscriptionAllowsRuns(plan: string, status: string): boolean {
  if (status === "active" || status === "trialing") return true;
  return plan === "free" && status === "none";
}

function replayResult(reservation: UsageReservation): JsonValue | null {
  if (!reservation.responseJson) return null;
  try {
    return JSON.parse(reservation.responseJson) as JsonValue;
  } catch {
    throw new RunAdmissionError(
      500,
      "invalid_idempotent_response",
      "The durable response for this request is invalid.",
    );
  }
}

export class RunAdmissionPolicy {
  constructor(private readonly store: HarnessStore) {}

  authorizeWorkspaceAccess(input: {
    tenantId: string;
    userId: string;
    workspacePath: string;
  }): string {
    const user = this.store.getUserById(input.userId);
    if (!user || user.tenant_id !== input.tenantId || user.status !== "active") {
      throw new RunAdmissionError(403, "run_not_authorized", "The user cannot access work.");
    }
    if (!this.store.isWorkspaceGranted(input.tenantId, input.workspacePath)) {
      throw new RunAdmissionError(
        403,
        "workspace_not_granted",
        "This workspace is not granted to the authenticated tenant.",
      );
    }
    return input.workspacePath;
  }

  authorizeThreadAccess(input: {
    tenantId: string;
    userId: string;
    threadId: string;
  }): string {
    const user = this.store.getUserById(input.userId);
    if (!user || user.tenant_id !== input.tenantId || user.status !== "active") {
      throw new RunAdmissionError(403, "run_not_authorized", "The user cannot access work.");
    }
    const binding = this.store.getThreadWorkspaceBinding(
      input.tenantId,
      input.userId,
      input.threadId,
    );
    if (!binding) {
      throw new RunAdmissionError(
        409,
        "thread_workspace_unbound",
        "This thread does not have a trusted workspace binding.",
      );
    }
    return this.authorizeWorkspaceAccess({
      tenantId: input.tenantId,
      userId: input.userId,
      workspacePath: binding.workspacePath,
    });
  }

  admit(input: RunAdmissionInput): RunAdmission {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
      throw new RunAdmissionError(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must contain 1 to 255 visible ASCII characters.",
      );
    }
    if (input.operation === "thread_start" && !input.workspacePath) {
      throw new RunAdmissionError(
        403,
        "workspace_not_granted",
        "A tenant-granted workspace is required to start a thread.",
      );
    }
    if (input.operation === "turn_start" && !input.threadId) {
      throw new RunAdmissionError(
        409,
        "thread_workspace_unbound",
        "A trusted thread workspace binding is required to start a turn.",
      );
    }

    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + USAGE_RESERVATION_LEASE_MS).toISOString();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const user = this.store.getUserById(input.userId);
      if (!user || user.tenant_id !== input.tenantId || user.status !== "active") {
        throw new RunAdmissionError(403, "run_not_authorized", "The user cannot start work.");
      }

      const subscription = this.store.getSubscriptionRow(input.tenantId);
      const entitlement = this.store.getLatestEntitlementSnapshot(input.tenantId);
      if (!subscription || !entitlement || entitlement.plan !== subscription.plan) {
        throw new RunAdmissionError(
          403,
          "entitlement_missing",
          "No current entitlement is available for this workspace.",
        );
      }
      if (
        !subscriptionAllowsRuns(subscription.plan, subscription.status) ||
        (entitlement.status !== "active" && entitlement.status !== "trialing")
      ) {
        throw new RunAdmissionError(
          402,
          "subscription_inactive",
          "The workspace subscription does not permit new runs.",
        );
      }
      if (
        entitlement.periodStart > timestamp ||
        (entitlement.periodEnd !== null && entitlement.periodEnd <= timestamp)
      ) {
        throw new RunAdmissionError(
          402,
          "entitlement_expired",
          "The workspace entitlement period has expired.",
        );
      }

      const provider = this.store.getDefaultProviderRow(input.tenantId);
      const model = provider?.default_model?.trim() ?? "";
      if (!provider || !model) {
        throw new RunAdmissionError(
          409,
          "provider_setup_required",
          "Connect an enabled default model route before starting work.",
        );
      }
      if (
        !entitlement.allowedRouteIds.includes("*") &&
        !entitlement.allowedRouteIds.includes(provider.id) &&
        !entitlement.allowedRouteIds.includes(provider.catalog_id)
      ) {
        throw new RunAdmissionError(
          403,
          "route_not_entitled",
          "The selected model route is not included in this workspace entitlement.",
        );
      }
      if (input.requestedModel && input.requestedModel !== model) {
        throw new RunAdmissionError(
          403,
          "model_override_forbidden",
          "The server-selected model cannot be overridden by the client.",
        );
      }

      const workspacePath =
        input.operation === "turn_start"
          ? this.authorizeThreadAccess({
              tenantId: input.tenantId,
              userId: input.userId,
              threadId: input.threadId!,
            })
          : input.workspacePath ?? null;
      if (
        input.operation === "turn_start" &&
        input.workspacePath &&
        input.workspacePath !== workspacePath
      ) {
        throw new RunAdmissionError(
          409,
          "thread_workspace_conflict",
          "The requested workspace does not match the trusted thread binding.",
        );
      }
      if (workspacePath) {
        this.authorizeWorkspaceAccess({
          tenantId: input.tenantId,
          userId: input.userId,
          workspacePath,
        });
      }

      const hash = requestHash({
        operation: input.operation,
        workspacePath,
        threadId: input.threadId ?? null,
        providerId: provider.id,
        model,
        payload: input.requestPayload,
      });
      this.store.expireUsageReservations(input.tenantId, timestamp);
      const existing = this.store.findUsageReservation(input.tenantId, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== hash || existing.userId !== input.userId) {
          throw new RunAdmissionError(
            409,
            "idempotency_conflict",
            "This idempotency key was already used for a different request.",
          );
        }
        const result = replayResult(existing);
        if (result !== null) {
          this.store.db.exec("COMMIT");
          return {
            reservationId: existing.id,
            provider,
            model,
            workspacePath,
            replayed: true,
            replayResult: result,
          };
        }
        throw new RunAdmissionError(
          409,
          existing.status === "reserved" ? "request_in_progress" : "idempotent_request_closed",
          existing.status === "reserved"
            ? "This request is already in progress."
            : "This idempotency key belongs to a completed or failed request.",
        );
      }

      const activeRuns = this.store.countActiveUsageReservations(input.tenantId, timestamp);
      if (activeRuns >= entitlement.activeRunLimit) {
        throw new RunAdmissionError(
          429,
          "active_run_limit_reached",
          "The workspace has reached its active run limit.",
        );
      }
      const requests = this.store.countUsageReservationsSince(
        input.tenantId,
        entitlement.periodStart,
      );
      if (requests >= entitlement.requestLimit) {
        throw new RunAdmissionError(
          429,
          "request_quota_exhausted",
          "The workspace has exhausted its request quota for this entitlement period.",
        );
      }

      const reservation = this.store.createUsageReservation({
        tenantId: input.tenantId,
        userId: input.userId,
        providerConnectionId: provider.id,
        routeCatalogId: provider.catalog_id,
        model,
        operation: input.operation,
        workspacePath,
        threadId: input.threadId ?? null,
        idempotencyKey,
        requestHash: hash,
        createdAt: timestamp,
        expiresAt,
      });
      this.store.db.exec("COMMIT");
      return {
        reservationId: reservation.id,
        provider,
        model,
        workspacePath,
        replayed: false,
        replayResult: null,
      };
    } catch (error) {
      try {
        this.store.db.exec("ROLLBACK");
      } catch {
        // A replay path may already have committed its read-only transaction.
      }
      throw error;
    }
  }
}
