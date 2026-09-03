import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { JsonValue } from "./codex/runtime.js";

const MUTATION_LEASE_MS = 10 * 60 * 1_000;

interface MutationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  idempotency_key: string;
  action: string;
  target_id: string;
  request_hash: string;
  status: "pending" | "completed" | "failed";
  response_json: string | null;
  error_code: string | null;
  expires_at: string;
}

export type TaskMutationReservation =
  | { state: "started"; id: string }
  | { state: "replayed"; id: string; response: JsonValue }
  | { state: "conflict"; id: string }
  | { state: "in_progress"; id: string }
  | { state: "closed"; id: string };

export class TaskMutationLedger {
  constructor(private readonly database: DatabaseSync) {}

  reserve(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    action: string;
    targetId: string;
    requestHash: string;
  }): TaskMutationReservation {
    const timestamp = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(`
          SELECT * FROM task_mutations
          WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
        `)
        .get(input.tenantId, input.userId, input.idempotencyKey) as
        | MutationRow
        | undefined;

      if (existing) {
        if (
          existing.action !== input.action ||
          existing.target_id !== input.targetId ||
          existing.request_hash !== input.requestHash
        ) {
          this.database.exec("COMMIT");
          return { state: "conflict", id: existing.id };
        }
        if (existing.status === "completed" && existing.response_json) {
          const response = JSON.parse(existing.response_json) as JsonValue;
          this.database.exec("COMMIT");
          return { state: "replayed", id: existing.id, response };
        }
        if (existing.status === "pending" && existing.expires_at > timestamp) {
          this.database.exec("COMMIT");
          return { state: "in_progress", id: existing.id };
        }
        if (existing.status === "pending") {
          this.database
            .prepare(`
              UPDATE task_mutations
              SET status = 'failed', error_code = 'lease_expired', updated_at = ?
              WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'
            `)
            .run(timestamp, existing.id, input.tenantId, input.userId);
        }
        this.database.exec("COMMIT");
        return { state: "closed", id: existing.id };
      }

      const id = randomUUID();
      this.database
        .prepare(`
          INSERT INTO task_mutations (
            id, tenant_id, user_id, idempotency_key, action, target_id,
            request_hash, status, response_json, error_code,
            created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
        `)
        .run(
          id,
          input.tenantId,
          input.userId,
          input.idempotencyKey,
          input.action,
          input.targetId,
          input.requestHash,
          timestamp,
          timestamp,
          new Date(Date.now() + MUTATION_LEASE_MS).toISOString(),
        );
      this.database.exec("COMMIT");
      return { state: "started", id };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(input: {
    id: string;
    tenantId: string;
    userId: string;
    response: JsonValue;
  }): boolean {
    const result = this.database
      .prepare(`
        UPDATE task_mutations
        SET status = 'completed', response_json = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'
      `)
      .run(
        JSON.stringify(input.response),
        new Date().toISOString(),
        input.id,
        input.tenantId,
        input.userId,
      );
    return result.changes === 1;
  }

  fail(input: {
    id: string;
    tenantId: string;
    userId: string;
    errorCode: string;
  }): boolean {
    const result = this.database
      .prepare(`
        UPDATE task_mutations
        SET status = 'failed', error_code = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'
      `)
      .run(
        input.errorCode.slice(0, 128),
        new Date().toISOString(),
        input.id,
        input.tenantId,
        input.userId,
      );
    return result.changes === 1;
  }
}
