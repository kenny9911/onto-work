import { createHash, randomUUID } from "node:crypto";
import type { ManagedTaskDetail, ManagedTaskSummary, UserSummary } from "@agent-harness/contracts";
import type { HarnessStore } from "../database.js";
import { ApiHttpError } from "../http.js";
import type { ReviewerDefinition } from "./catalog.js";

export interface ManagedTaskRecord {
  tenantId: string;
  userId: string;
  workspacePath: string;
  definition: ReviewerDefinition;
  detail: ManagedTaskDetail;
  sessionId: string | null;
  environmentId: string | null;
  remoteUrl: string | null;
  reservationId: string | null;
  deadlineAt: string | null;
}
interface Row {
  tenant_id: string; user_id: string; workspace_path: string; definition_json: string; detail_json: string;
  session_id: string | null; environment_id: string | null; remote_url: string | null;
  reservation_id: string | null; deadline_at: string | null;
}
function record(row: Row): ManagedTaskRecord {
  return { tenantId: row.tenant_id, userId: row.user_id, workspacePath: row.workspace_path,
    definition: JSON.parse(row.definition_json), detail: JSON.parse(row.detail_json),
    sessionId: row.session_id, environmentId: row.environment_id, remoteUrl: row.remote_url,
    reservationId: row.reservation_id, deadlineAt: row.deadline_at };
}
export const activeTask = (task: ManagedTaskSummary) => task.status === "starting" || task.status === "running";

export class ManagedTaskRepository {
  constructor(readonly store: HarnessStore, private readonly allowedTenantIds: readonly string[] = []) {}

  authorizedProject(user: UserSummary, projectId: string, workspacePath?: string) {
    const current = this.store.getUserById(user.id);
    if (!current || current.tenant_id !== user.tenantId || current.status !== "active" || current.must_change_password) {
      throw new ApiHttpError(403, "run_not_authorized", "The user cannot access managed work.");
    }
    const project = this.store.getSavedProject(user.tenantId, projectId);
    if (!project || !project.enabled) throw new ApiHttpError(404, "project_unavailable", "The saved project is unavailable.");
    if ((workspacePath !== undefined && project.workspacePath !== workspacePath) || !project.workspaceGrantId ||
        !this.store.workspaceGrantAllowsPath(user.tenantId, project.workspaceGrantId, project.workspacePath)) {
      throw new ApiHttpError(403, "workspace_not_granted", "The project workspace grant is no longer active.");
    }
    return project;
  }

  get(id: string): ManagedTaskRecord | null {
    const row = this.store.db.prepare("SELECT * FROM managed_agent_tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? record(row) : null;
  }
  owned(user: UserSummary, id: string): ManagedTaskRecord {
    const row = this.store.db.prepare("SELECT * FROM managed_agent_tasks WHERE id = ? AND tenant_id = ? AND user_id = ?").get(id, user.tenantId, user.id) as Row | undefined;
    if (!row) throw new ApiHttpError(404, "managed_task_not_found", "Managed task not found.");
    return record(row);
  }
  list(user: UserSummary): ManagedTaskRecord[] {
    return (this.store.db.prepare("SELECT * FROM managed_agent_tasks WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100").all(user.tenantId, user.id) as unknown as Row[]).map(record);
  }
  unfinished(): ManagedTaskRecord[] {
    return (this.store.db.prepare("SELECT * FROM managed_agent_tasks WHERE status IN ('starting', 'running', 'deleting') OR (status = 'interrupted' AND reservation_id IS NOT NULL)").all() as unknown as Row[]).map(record);
  }
  insert(task: ManagedTaskRecord): void {
    this.store.db.prepare(`INSERT INTO managed_agent_tasks
      (id,tenant_id,user_id,project_id,workspace_path,definition_json,detail_json,session_id,environment_id,remote_url,reservation_id,deadline_at,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(task.detail.id, task.tenantId, task.userId, task.detail.projectId, task.workspacePath,
      JSON.stringify(task.definition), JSON.stringify(task.detail), task.sessionId, task.environmentId, task.remoteUrl, task.reservationId,
      task.deadlineAt, task.detail.status, task.detail.createdAt, task.detail.updatedAt);
  }
  update(id: string, change: (task: ManagedTaskRecord) => void): ManagedTaskRecord {
    const task = this.get(id);
    if (!task) throw new Error("Managed task disappeared");
    const identity = JSON.stringify([task.tenantId, task.userId, task.workspacePath, task.detail.id, task.detail.projectId,
      task.definition.id, task.definition.model, task.definition.instructions, task.definition.skillIds]);
    change(task);
    if (JSON.stringify([task.tenantId, task.userId, task.workspacePath, task.detail.id, task.detail.projectId,
      task.definition.id, task.definition.model, task.definition.instructions, task.definition.skillIds]) !== identity) {
      throw new Error("Managed task identity and execution policy are immutable");
    }
    task.detail.revision++;
    task.detail.updatedAt = new Date().toISOString();
    this.store.db.prepare(`UPDATE managed_agent_tasks SET definition_json=?,detail_json=?,session_id=?,environment_id=?,remote_url=?,reservation_id=?,deadline_at=?,status=?,updated_at=? WHERE id=?`).run(
      JSON.stringify(task.definition), JSON.stringify(task.detail), task.sessionId, task.environmentId, task.remoteUrl,
      task.reservationId, task.deadlineAt, task.detail.status, task.detail.updatedAt, id);
    return task;
  }

  /** Admission shares the existing durable request and active-run counters with native work. */
  reserveTurn(input: { user: UserSummary; taskId: string; projectId: string; workspacePath: string; model: string; maxConcurrentSessions: number; maxTurnSeconds: number }): { reservationId: string; deadlineAt: string } {
    if (!this.allowedTenantIds.includes(input.user.tenantId)) throw new ApiHttpError(403, "managed_tenant_not_enabled", "Managed agents are not enabled for this workspace.");
    if (!Number.isSafeInteger(input.maxConcurrentSessions) || input.maxConcurrentSessions < 1 || input.maxConcurrentSessions > 16 ||
        !Number.isSafeInteger(input.maxTurnSeconds) || input.maxTurnSeconds < 1 || input.maxTurnSeconds > 1_200) {
      throw new ApiHttpError(503, "managed_limits_invalid", "Managed execution limits are invalid.");
    }
    const now = new Date().toISOString();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.authorizedProject(input.user, input.projectId, input.workspacePath);
      const existing = this.get(input.taskId);
      if (existing && (existing.tenantId !== input.user.tenantId || existing.userId !== input.user.id ||
          existing.detail.projectId !== input.projectId || existing.workspacePath !== input.workspacePath || existing.definition.model !== input.model)) {
        throw new ApiHttpError(404, "managed_task_not_found", "Managed task not found.");
      }
      if (existing && (activeTask(existing.detail) || existing.detail.status === "deleting" || existing.detail.status === "deleted" || existing.reservationId)) {
        throw new ApiHttpError(409, "managed_task_not_ready", "The managed task cannot start another turn yet.");
      }
      const entitlement = this.store.getLatestEntitlementSnapshot(input.user.tenantId);
      const subscription = this.store.getSubscriptionRow(input.user.tenantId);
      const currentUser = this.store.getUserById(input.user.id);
      if (!currentUser || currentUser.tenant_id !== input.user.tenantId || currentUser.status !== "active") throw new ApiHttpError(403, "run_not_authorized", "The user cannot start work.");
      if (!entitlement || !subscription || entitlement.plan !== subscription.plan) throw new ApiHttpError(403, "entitlement_missing", "A current workspace entitlement is required.");
      if (!(subscription.status === "active" || subscription.status === "trialing" || (subscription.plan === "free" && subscription.status === "none")) || !["active", "trialing"].includes(entitlement.status)) throw new ApiHttpError(402, "subscription_inactive", "The workspace subscription does not permit new runs.");
      if (entitlement.periodStart > now || (entitlement.periodEnd && entitlement.periodEnd <= now)) throw new ApiHttpError(402, "entitlement_expired", "The workspace entitlement has expired.");
      if (!entitlement.allowedRouteIds.some((id) => id === "*" || id === "agents_api")) throw new ApiHttpError(403, "route_not_entitled", "Managed agents are not included in this workspace entitlement.");
      if (!this.store.isWorkspaceGranted(input.user.tenantId, input.workspacePath)) throw new ApiHttpError(403, "workspace_not_granted", "The project workspace grant is no longer active.");
      this.store.expireUsageReservations(input.user.tenantId, now);
      if (this.store.countActiveUsageReservations(input.user.tenantId, now) >= entitlement.activeRunLimit) throw new ApiHttpError(429, "active_run_limit_reached", "The workspace has reached its active run limit.");
      if (this.store.countUsageReservationsSince(input.user.tenantId, entitlement.periodStart) >= entitlement.requestLimit) throw new ApiHttpError(429, "request_quota_exhausted", "The workspace request quota is exhausted.");
      const { count } = this.store.db.prepare("SELECT COUNT(*) AS count FROM usage_reservations WHERE route_catalog_id='agents_api' AND status='reserved' AND expires_at > ?").get(now) as { count: number };
      if (count >= input.maxConcurrentSessions) throw new ApiHttpError(429, "managed_capacity_reached", "All managed executor slots are in use.");
      const deadlineAt = new Date(Date.now() + input.maxTurnSeconds * 1000).toISOString();
      const key = `managed-${randomUUID()}`;
      const usage = this.store.createUsageReservation({ tenantId: input.user.tenantId, userId: input.user.id, providerConnectionId: null,
        routeCatalogId: "agents_api", model: input.model, operation: "turn_start", workspacePath: input.workspacePath,
        threadId: input.taskId, idempotencyKey: key, requestHash: createHash("sha256").update(key).digest("hex"), createdAt: now,
        // Keep the lease beyond the execution deadline until cancellation/cleanup has been attempted.
        expiresAt: new Date(Date.parse(deadlineAt) + 120_000).toISOString() });
      this.store.db.exec("COMMIT");
      return { reservationId: usage.id, deadlineAt };
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }

  /** Terminal usage can arrive after a lease expires. Settling existing work
   * never admits new execution, and must remain possible after a grant is revoked. */
  settleTurn(task: ManagedTaskRecord, turnId: string, status: "completed" | "failed" | "cancelled", inputTokens: number | null, outputTokens: number | null): boolean {
    if (!turnId || turnId.length > 256 || /[\x00-\x20]/.test(turnId) || !["completed", "failed", "cancelled"].includes(status)) {
      throw new Error("Managed usage requires a terminal turn identity");
    }
    for (const count of [inputTokens, outputTokens]) {
      if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error("Usage token counts must be non-negative safe integers");
    }
    if (!task.reservationId) return false;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.get(task.detail.id);
      const reservation = this.store.getUsageReservation(task.reservationId);
      if (!stored || stored.tenantId !== task.tenantId || stored.userId !== task.userId || stored.reservationId !== task.reservationId ||
          stored.detail.projectId !== task.detail.projectId || stored.workspacePath !== task.workspacePath || stored.sessionId !== task.sessionId ||
          !reservation || reservation.tenantId !== task.tenantId || reservation.userId !== task.userId ||
          reservation.routeCatalogId !== "agents_api" || reservation.operation !== "turn_start" || reservation.threadId !== task.detail.id ||
          reservation.workspacePath !== stored.workspacePath || reservation.model !== stored.definition.model ||
          (reservation.turnId !== null && reservation.turnId !== turnId) || !["reserved", "completed", "expired"].includes(reservation.status)) {
        this.store.db.exec("COMMIT");
        return false;
      }
      const timestamp = new Date().toISOString();
      this.store.db.prepare(`UPDATE usage_reservations SET status='completed', completed_at=COALESCE(completed_at,?),
        turn_id=COALESCE(turn_id,?), error_code=NULL WHERE id=?`).run(timestamp, turnId, task.reservationId);
      this.store.db.prepare(`INSERT INTO usage_events
        (id,tenant_id,reservation_id,event_key,event_type,input_tokens,output_tokens,metadata_json,created_at)
        VALUES (?,?,?,?,?,?,?,NULL,?) ON CONFLICT(reservation_id,event_key) DO UPDATE SET
        input_tokens=COALESCE(usage_events.input_tokens,excluded.input_tokens),
        output_tokens=COALESCE(usage_events.output_tokens,excluded.output_tokens)`).run(
        randomUUID(), task.tenantId, task.reservationId, `managed-turn:${turnId}`, `managed_turn_${status}`, inputTokens, outputTokens, timestamp);
      this.store.db.exec("COMMIT");
      return true;
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
}
