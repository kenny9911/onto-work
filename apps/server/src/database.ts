import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEventSummary,
  PlanId,
  ProviderAdapter,
  ProviderConnection,
  SubscriptionStatus,
  SubscriptionSummary,
  UserRole,
  UserStatus,
  UserSummary,
  UsageSummary,
} from "@agent-harness/contracts";
import { applyDatabaseMigrations } from "./migrations.js";
import { hashPassword, tokenDigest } from "./security.js";

interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
}

interface ProviderRow {
  id: string;
  tenant_id: string;
  catalog_id: string;
  name: string;
  adapter: ProviderAdapter;
  base_url: string | null;
  default_model: string | null;
  credential_ciphertext: string | null;
  enabled: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface SubscriptionRow {
  tenant_id: string;
  plan: PlanId;
  status: SubscriptionStatus;
  seats: number;
  current_period_start: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  last_stripe_event_created: number | null;
  last_stripe_event_id: string | null;
}

export class SeatLimitExceededError extends Error {
  constructor(public readonly seatLimit: number) {
    super(`The workspace seat limit of ${seatLimit} has been reached`);
    this.name = "SeatLimitExceededError";
  }
}

export type StripeWebhookOutcome = "applied" | "duplicate" | "stale" | "ignored";

export interface StripeSubscriptionEventInput {
  eventId: string;
  eventType: string;
  eventCreated: number;
  objectId?: string | null;
  tenantId: string;
  plan: PlanId;
  status: SubscriptionStatus;
  seats: number;
  customerId?: string | null;
  subscriptionId: string;
  currentPeriodStart: string;
  currentPeriodEnd?: string | null;
}

export interface EntitlementSnapshot {
  tenantId: string;
  version: number;
  plan: PlanId;
  status: SubscriptionStatus;
  seatLimit: number;
  activeRunLimit: number;
  requestLimit: number;
  periodStart: string;
  periodEnd: string | null;
  allowedRouteIds: string[];
  createdAt: string;
}

interface EntitlementSnapshotRow {
  tenant_id: string;
  version: number;
  plan: PlanId;
  status: SubscriptionStatus;
  seat_limit: number;
  active_run_limit: number;
  request_limit: number;
  period_start: string;
  period_end: string | null;
  allowed_route_ids_json: string;
  created_at: string;
}

export interface UsageReservation {
  id: string;
  tenantId: string;
  userId: string;
  providerConnectionId: string | null;
  routeCatalogId: string;
  model: string;
  operation: "thread_start" | "turn_start";
  workspacePath: string | null;
  threadId: string | null;
  turnId: string | null;
  idempotencyKey: string;
  requestHash: string;
  status: "reserved" | "completed" | "failed" | "expired";
  responseJson: string | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}

export interface ThreadWorkspaceBinding {
  tenantId: string;
  userId: string;
  threadId: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGrantRecord {
  id: string;
  tenantId: string;
  rootPath: string;
}

export interface SavedProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  workspaceId: string;
  workspacePath: string;
  workspaceGrantId: string | null;
  workspaceGrantRoot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedProjectPage {
  projects: SavedProjectRecord[];
  nextCursor: string | null;
}

interface ThreadWorkspaceBindingRow {
  tenant_id: string;
  user_id: string;
  thread_id: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
}

interface WorkspaceGrantRow {
  id: string;
  tenant_id: string;
  root_path: string;
}

interface SavedProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  workspace_path: string;
  workspace_grant_id: string | null;
  workspace_grant_root: string | null;
}

interface UsageReservationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  provider_connection_id: string | null;
  route_catalog_id: string;
  model: string;
  operation: UsageReservation["operation"];
  workspace_path: string | null;
  thread_id: string | null;
  turn_id: string | null;
  idempotency_key: string;
  request_hash: string;
  status: UsageReservation["status"];
  response_json: string | null;
  error_code: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

interface AuditEventRow {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface AuditEventPage {
  events: AuditEventSummary[];
  nextCursor: string | null;
}

const AUDIT_METADATA_FIELD_LIMIT = 32;
const AUDIT_METADATA_KEY_LIMIT = 64;
const AUDIT_METADATA_STRING_LIMIT = 1_024;
const REDACTED_AUDIT_VALUE = "[REDACTED]";
const SAVED_PROJECT_SELECT = `
  SELECT
    project.id,
    project.tenant_id,
    project.name,
    project.enabled,
    project.created_at,
    project.updated_at,
    workspace.id AS workspace_id,
    workspace.canonical_path AS workspace_path,
    workspace.workspace_grant_id,
    grant_record.root_path AS workspace_grant_root
  FROM projects AS project
  JOIN project_workspaces AS workspace
    ON workspace.tenant_id = project.tenant_id
   AND workspace.project_id = project.id
   AND workspace.is_primary = 1
  LEFT JOIN workspace_grants AS grant_record
    ON grant_record.id = workspace.workspace_grant_id
   AND grant_record.tenant_id = project.tenant_id
`;

function sensitiveAuditMetadataKey(key: string, value: unknown): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const statusOnlySuffixes = [
    "changed",
    "configured",
    "enabled",
    "exists",
    "present",
    "removed",
    "rotated",
    "set",
  ];
  const containsSensitiveTerm = [
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "password",
    "privatekey",
    "refreshtoken",
    "secret",
    "sessiontoken",
    "accesstoken",
  ].some((sensitive) => normalized.includes(sensitive));
  if (!containsSensitiveTerm) return false;
  return !(
    typeof value === "boolean" &&
    statusOnlySuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}

function sanitizedAuditMetadata(
  value: unknown,
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return metadata;

  for (const [key, entry] of Object.entries(value).slice(0, AUDIT_METADATA_FIELD_LIMIT)) {
    if (key.length === 0 || key.length > AUDIT_METADATA_KEY_LIMIT) continue;
    if (sensitiveAuditMetadataKey(key, entry)) {
      metadata[key] = REDACTED_AUDIT_VALUE;
      continue;
    }
    if (entry === null || typeof entry === "boolean") {
      metadata[key] = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      metadata[key] = entry;
    } else if (typeof entry === "string") {
      metadata[key] = entry.slice(0, AUDIT_METADATA_STRING_LIMIT);
    }
  }
  return metadata;
}

function auditEventSummary(row: AuditEventRow): AuditEventSummary {
  let metadata: Record<string, string | number | boolean | null> = {};
  if (row.metadata_json) {
    try {
      metadata = sanitizedAuditMetadata(JSON.parse(row.metadata_json) as unknown);
    } catch {
      // Audit rows remain visible even if legacy metadata is malformed.
    }
  }
  return {
    id: row.id,
    actorUserId: row.user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata,
    createdAt: row.created_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

function isWithinPath(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function userSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function providerSummary(row: ProviderRow): ProviderConnection {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    name: row.name,
    adapter: row.adapter,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    hasCredential: Boolean(row.credential_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function entitlementSnapshot(row: EntitlementSnapshotRow): EntitlementSnapshot {
  let allowedRouteIds: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_route_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      allowedRouteIds = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // Invalid durable policy must fail closed as an empty allow-list.
  }
  return {
    tenantId: row.tenant_id,
    version: row.version,
    plan: row.plan,
    status: row.status,
    seatLimit: row.seat_limit,
    activeRunLimit: row.active_run_limit,
    requestLimit: row.request_limit,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    allowedRouteIds,
    createdAt: row.created_at,
  };
}

function usageReservation(row: UsageReservationRow): UsageReservation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    providerConnectionId: row.provider_connection_id,
    routeCatalogId: row.route_catalog_id,
    model: row.model,
    operation: row.operation,
    workspacePath: row.workspace_path,
    threadId: row.thread_id,
    turnId: row.turn_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    responseJson: row.response_json,
    errorCode: row.error_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

function threadWorkspaceBinding(row: ThreadWorkspaceBindingRow): ThreadWorkspaceBinding {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    threadId: row.thread_id,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceGrantRecord(row: WorkspaceGrantRow): WorkspaceGrantRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    rootPath: row.root_path,
  };
}

function savedProjectRecord(row: SavedProjectRow): SavedProjectRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    enabled: row.enabled === 1,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    workspaceGrantId: row.workspace_grant_id,
    workspaceGrantRoot: row.workspace_grant_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planLimits(plan: PlanId): { activeRunLimit: number; requestLimit: number } {
  if (plan === "free") return { activeRunLimit: 1, requestLimit: 1_000 };
  if (plan === "pro") return { activeRunLimit: 4, requestLimit: 10_000 };
  if (plan === "team") return { activeRunLimit: 16, requestLimit: 100_000 };
  return { activeRunLimit: 64, requestLimit: 1_000_000 };
}

function effectiveEntitlementStatus(
  plan: PlanId,
  status: SubscriptionStatus,
): SubscriptionStatus {
  return plan === "free" && status === "none" ? "active" : status;
}

function secureDatabaseFiles(path: string): void {
  if (process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

export class HarnessStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    secureDatabaseFiles(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    applyDatabaseMigrations(this.db);
    secureDatabaseFiles(path);
  }

  close(): void {
    this.db.close();
  }

  async bootstrapAdmin(username: string, password: string): Promise<UserSummary> {
    const existing = this.getUserByUsername(username);
    if (existing) return userSummary(existing);

    const tenantId = randomUUID();
    const userId = randomUUID();
    const timestamp = now();
    const passwordHash = await hashPassword(password);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
        .run(tenantId, "Default workspace", "default", timestamp);
      this.db
        .prepare(`
          INSERT INTO users (
            id, tenant_id, username, display_name, password_hash, role, status,
            must_change_password, created_at
          ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 1, ?)
        `)
        .run(userId, tenantId, username, "Administrator", passwordHash, timestamp);
      this.db
        .prepare(`
          INSERT INTO subscriptions (
            tenant_id, plan, status, seats, current_period_start, created_at, updated_at
          ) VALUES (?, 'free', 'none', 1, ?, ?, ?)
        `)
        .run(tenantId, timestamp, timestamp, timestamp);
      const limits = planLimits("free");
      this.db
        .prepare(`
          INSERT INTO entitlement_snapshots (
            tenant_id, version, plan, status, seat_limit, active_run_limit,
            request_limit, period_start, period_end, allowed_route_ids_json, created_at
          ) VALUES (?, 1, 'free', 'active', 1, ?, ?, ?, NULL, '["*"]', ?)
        `)
        .run(
          tenantId,
          limits.activeRunLimit,
          limits.requestLimit,
          timestamp,
          timestamp,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return userSummary(this.getUserById(userId)!);
  }

  async resetBootstrapAdminPassword(username: string, password: string): Promise<UserSummary | null> {
    const existing = this.getUserByUsername(username);
    if (!existing || existing.role !== "admin") return null;

    const passwordHash = await hashPassword(password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE users
          SET password_hash = ?, must_change_password = 1
          WHERE id = ? AND role = 'admin'
        `)
        .run(passwordHash, existing.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
      this.audit({
        tenantId: existing.tenant_id,
        userId: existing.id,
        action: "auth.bootstrap_password_reset",
        targetType: "user",
        targetId: existing.id,
        metadata: { source: "local_cli" },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getUserSummary(existing.id);
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as UserRow | undefined;
  }

  getUserById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  getUserSummary(id: string): UserSummary | null {
    const row = this.getUserById(id);
    return row ? userSummary(row) : null;
  }

  getPasswordHash(id: string): string | null {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as
      | { password_hash: string }
      | undefined;
    return row?.password_hash ?? null;
  }

  async changePassword(id: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    this.db
      .prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(passwordHash, id);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  }

  recordLogin(id: string): void {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), id);
  }

  createSession(rawToken: string, userId: string, expiresAt: string): void {
    this.db
      .prepare("INSERT INTO sessions (token_digest, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenDigest(rawToken), userId, now(), expiresAt);
  }

  getSessionUser(rawToken: string): UserSummary | null {
    const row = this.db
      .prepare(`
        SELECT users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_digest = ? AND sessions.expires_at > ? AND users.status = 'active'
      `)
      .get(tokenDigest(rawToken), now()) as UserRow | undefined;
    return row ? userSummary(row) : null;
  }

  deleteSession(rawToken: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_digest = ?").run(tokenDigest(rawToken));
  }

  deleteExpiredSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  }

  listUsers(tenantId: string): UserSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at ASC")
      .all(tenantId) as unknown as UserRow[];
    return rows.map(userSummary);
  }

  getTenantIdBySlug(slug: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM tenants WHERE slug = ?")
      .get(slug) as { id: string } | undefined;
    return row?.id ?? null;
  }

  grantWorkspace(input: {
    tenantId: string;
    rootPath: string;
    createdByUserId?: string | null;
  }): void {
    this.db
      .prepare(`
        INSERT INTO workspace_grants (
          id, tenant_id, root_path, created_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, root_path) DO NOTHING
      `)
      .run(
        randomUUID(),
        input.tenantId,
        input.rootPath,
        input.createdByUserId ?? null,
        now(),
      );
  }

  listWorkspaceGrants(tenantId: string): string[] {
    return this.listWorkspaceGrantRecords(tenantId).map((grant) => grant.rootPath);
  }

  listWorkspaceGrantRecords(tenantId: string): WorkspaceGrantRecord[] {
    const rows = this.db
      .prepare("SELECT id, tenant_id, root_path FROM workspace_grants WHERE tenant_id = ? ORDER BY root_path")
      .all(tenantId) as unknown as WorkspaceGrantRow[];
    return rows.map(workspaceGrantRecord);
  }

  getWorkspaceGrant(
    tenantId: string,
    workspaceGrantId: string,
  ): WorkspaceGrantRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, tenant_id, root_path
        FROM workspace_grants
        WHERE tenant_id = ? AND id = ?
      `)
      .get(tenantId, workspaceGrantId) as WorkspaceGrantRow | undefined;
    return row ? workspaceGrantRecord(row) : null;
  }

  findWorkspaceGrantForPath(
    tenantId: string,
    workspacePath: string,
  ): WorkspaceGrantRecord | null {
    const matches = this.listWorkspaceGrantRecords(tenantId)
      .filter((grant) => isWithinPath(grant.rootPath, workspacePath))
      .sort((left, right) => right.rootPath.length - left.rootPath.length);
    return matches[0] ?? null;
  }

  workspaceGrantAllowsPath(
    tenantId: string,
    workspaceGrantId: string,
    workspacePath: string,
  ): boolean {
    const grant = this.getWorkspaceGrant(tenantId, workspaceGrantId);
    return grant ? isWithinPath(grant.rootPath, workspacePath) : false;
  }

  isWorkspaceGranted(tenantId: string, workspacePath: string): boolean {
    return this.findWorkspaceGrantForPath(tenantId, workspacePath) !== null;
  }

  getSavedProject(tenantId: string, projectId: string): SavedProjectRecord | null {
    const row = this.db
      .prepare(`${SAVED_PROJECT_SELECT} WHERE project.tenant_id = ? AND project.id = ?`)
      .get(tenantId, projectId) as SavedProjectRow | undefined;
    return row ? savedProjectRecord(row) : null;
  }

  findSavedProjectByWorkspacePath(
    tenantId: string,
    canonicalWorkspacePath: string,
  ): SavedProjectRecord | null {
    const row = this.db
      .prepare(`
        ${SAVED_PROJECT_SELECT}
        WHERE project.tenant_id = ?
          AND workspace.canonical_path = ?
        LIMIT 1
      `)
      .get(tenantId, canonicalWorkspacePath) as SavedProjectRow | undefined;
    return row ? savedProjectRecord(row) : null;
  }

  listSavedProjectPage(
    tenantId: string,
    limit = 50,
    cursor?: string,
  ): SavedProjectPage {
    const integerLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const boundedLimit = Math.max(1, Math.min(100, integerLimit));
    const rows = cursor
      ? (this.db
          .prepare(`
            WITH project_cursor AS (
              SELECT updated_at, id
              FROM projects
              WHERE tenant_id = ? AND id = ?
            )
            ${SAVED_PROJECT_SELECT}
            JOIN project_cursor
            WHERE project.tenant_id = ?
              AND (
                project.updated_at < project_cursor.updated_at
                OR (
                  project.updated_at = project_cursor.updated_at
                  AND project.id < project_cursor.id
                )
              )
            ORDER BY project.updated_at DESC, project.id DESC
            LIMIT ?
          `)
          .all(tenantId, cursor, tenantId, boundedLimit + 1) as unknown as SavedProjectRow[])
      : (this.db
          .prepare(`
            ${SAVED_PROJECT_SELECT}
            WHERE project.tenant_id = ?
            ORDER BY project.updated_at DESC, project.id DESC
            LIMIT ?
          `)
          .all(tenantId, boundedLimit + 1) as unknown as SavedProjectRow[]);
    const projects = rows.slice(0, boundedLimit).map(savedProjectRecord);
    return {
      projects,
      nextCursor: rows.length > boundedLimit ? projects.at(-1)?.id ?? null : null,
    };
  }

  registerSavedProject(input: {
    tenantId: string;
    name: string;
    workspacePath: string;
    workspaceGrantId: string;
    createdByUserId: string;
  }): SavedProjectRecord {
    const grant = this.getWorkspaceGrant(input.tenantId, input.workspaceGrantId);
    if (!grant || !isWithinPath(grant.rootPath, input.workspacePath)) {
      throw new Error("Project workspace is not covered by the supplied tenant grant");
    }

    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO projects (
            id, tenant_id, name, enabled, created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?)
        `)
        .run(
          projectId,
          input.tenantId,
          input.name,
          input.createdByUserId,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(`
          INSERT INTO project_workspaces (
            id, tenant_id, project_id, workspace_grant_id, canonical_path,
            kind, is_primary, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'existing', 1, ?, ?)
        `)
        .run(
          workspaceId,
          input.tenantId,
          projectId,
          input.workspaceGrantId,
          input.workspacePath,
          timestamp,
          timestamp,
        );
      this.audit({
        tenantId: input.tenantId,
        userId: input.createdByUserId,
        action: "project.registered",
        targetType: "project",
        targetId: projectId,
        metadata: { workspaceId, kind: "existing" },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSavedProject(input.tenantId, projectId)!;
  }

  updateSavedProject(input: {
    tenantId: string;
    projectId: string;
    actorUserId: string;
    name?: string;
    enabled?: boolean;
    workspaceGrantId?: string;
  }): SavedProjectRecord | null {
    const current = this.getSavedProject(input.tenantId, input.projectId);
    if (!current) return null;

    if (input.workspaceGrantId !== undefined) {
      const grant = this.getWorkspaceGrant(input.tenantId, input.workspaceGrantId);
      if (!grant || !isWithinPath(grant.rootPath, current.workspacePath)) {
        throw new Error("Project workspace is not covered by the supplied tenant grant");
      }
    }

    const timestamp = now();
    const nextName = input.name ?? current.name;
    const nextEnabled = input.enabled ?? current.enabled;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE projects
          SET name = ?, enabled = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?
        `)
        .run(
          nextName,
          nextEnabled ? 1 : 0,
          timestamp,
          input.tenantId,
          input.projectId,
        );
      if (input.workspaceGrantId !== undefined) {
        this.db
          .prepare(`
            UPDATE project_workspaces
            SET workspace_grant_id = ?, updated_at = ?
            WHERE tenant_id = ? AND project_id = ? AND is_primary = 1
          `)
          .run(
            input.workspaceGrantId,
            timestamp,
            input.tenantId,
            input.projectId,
          );
      }
      this.audit({
        tenantId: input.tenantId,
        userId: input.actorUserId,
        action: "project.updated",
        targetType: "project",
        targetId: input.projectId,
        metadata: {
          nameChanged: nextName !== current.name,
          enabledChanged: nextEnabled !== current.enabled,
          enabled: nextEnabled,
          workspaceGrantRebound: input.workspaceGrantId !== undefined,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getSavedProject(input.tenantId, input.projectId);
  }

  getThreadWorkspaceBinding(
    tenantId: string,
    userId: string,
    threadId: string,
  ): ThreadWorkspaceBinding | null {
    const row = this.db
      .prepare(`
        SELECT * FROM thread_workspace_bindings
        WHERE tenant_id = ? AND user_id = ? AND thread_id = ?
      `)
      .get(tenantId, userId, threadId) as ThreadWorkspaceBindingRow | undefined;
    return row ? threadWorkspaceBinding(row) : null;
  }

  bindThreadWorkspace(input: {
    tenantId: string;
    userId: string;
    threadId: string;
    workspacePath: string;
  }): ThreadWorkspaceBinding {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO thread_workspace_bindings (
          tenant_id, user_id, thread_id, workspace_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, user_id, thread_id) DO NOTHING
      `)
      .run(
        input.tenantId,
        input.userId,
        input.threadId,
        input.workspacePath,
        timestamp,
        timestamp,
      );
    const binding = this.getThreadWorkspaceBinding(
      input.tenantId,
      input.userId,
      input.threadId,
    );
    if (!binding || binding.workspacePath !== input.workspacePath) {
      throw new Error("Thread workspace binding conflicts with its existing canonical path");
    }
    return binding;
  }

  async createUser(input: {
    tenantId: string;
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
  }): Promise<UserSummary> {
    const id = randomUUID();
    const createdAt = now();
    const passwordHash = await hashPassword(input.password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const entitlement = this.getLatestEntitlementSnapshot(input.tenantId);
      if (!entitlement) throw new Error("The workspace has no seat entitlement");
      const active = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND status = 'active'",
        )
        .get(input.tenantId) as { count: number };
      if (active.count >= entitlement.seatLimit) {
        throw new SeatLimitExceededError(entitlement.seatLimit);
      }
      this.db
        .prepare(`
          INSERT INTO users (
            id, tenant_id, username, display_name, password_hash, role, status,
            must_change_password, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?)
        `)
        .run(
          id,
          input.tenantId,
          input.username,
          input.displayName,
          passwordHash,
          input.role,
          createdAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return userSummary(this.getUserById(id)!);
  }

  setUserStatus(tenantId: string, userId: string, status: UserStatus): UserSummary | null {
    this.db
      .prepare("UPDATE users SET status = ? WHERE tenant_id = ? AND id = ?")
      .run(status, tenantId, userId);
    if (status === "suspended") this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    const row = this.getUserById(userId);
    return row && row.tenant_id === tenantId ? userSummary(row) : null;
  }

  listProviders(tenantId: string): ProviderConnection[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_connections WHERE tenant_id = ? ORDER BY is_default DESC, name ASC")
      .all(tenantId) as unknown as ProviderRow[];
    return rows.map(providerSummary);
  }

  getProviderRow(tenantId: string, providerId: string): ProviderRow | undefined {
    return this.db
      .prepare("SELECT * FROM provider_connections WHERE tenant_id = ? AND id = ?")
      .get(tenantId, providerId) as ProviderRow | undefined;
  }

  getDefaultProviderRow(tenantId: string): ProviderRow | undefined {
    return this.db
      .prepare(`
        SELECT * FROM provider_connections
        WHERE tenant_id = ? AND enabled = 1
        ORDER BY is_default DESC, created_at ASC
        LIMIT 1
      `)
      .get(tenantId) as ProviderRow | undefined;
  }

  saveProvider(input: {
    id?: string;
    tenantId: string;
    catalogId: string;
    name: string;
    adapter: ProviderAdapter;
    baseUrl: string | null;
    defaultModel: string | null;
    credentialCiphertext?: string | null;
    enabled: boolean;
    isDefault: boolean;
  }): ProviderConnection {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.isDefault) {
        this.db
          .prepare("UPDATE provider_connections SET is_default = 0, updated_at = ? WHERE tenant_id = ?")
          .run(timestamp, input.tenantId);
      }
      const existing = input.id ? this.getProviderRow(input.tenantId, input.id) : undefined;
      if (existing) {
        this.db
          .prepare(`
            UPDATE provider_connections SET
              catalog_id = ?, name = ?, adapter = ?, base_url = ?, default_model = ?,
              credential_ciphertext = ?, enabled = ?, is_default = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?
          `)
          .run(
            input.catalogId,
            input.name,
            input.adapter,
            input.baseUrl,
            input.defaultModel,
            input.credentialCiphertext === undefined
              ? existing.credential_ciphertext
              : input.credentialCiphertext,
            input.enabled ? 1 : 0,
            input.isDefault ? 1 : 0,
            timestamp,
            input.tenantId,
            id,
          );
      } else {
        this.db
          .prepare(`
            INSERT INTO provider_connections (
              id, tenant_id, catalog_id, name, adapter, base_url, default_model,
              credential_ciphertext, enabled, is_default, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            id,
            input.tenantId,
            input.catalogId,
            input.name,
            input.adapter,
            input.baseUrl,
            input.defaultModel,
            input.credentialCiphertext ?? null,
            input.enabled ? 1 : 0,
            input.isDefault ? 1 : 0,
            timestamp,
            timestamp,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return providerSummary(this.getProviderRow(input.tenantId, id)!);
  }

  deleteProvider(tenantId: string, providerId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM provider_connections WHERE tenant_id = ? AND id = ?")
      .run(tenantId, providerId);
    return result.changes > 0;
  }

  getSubscription(tenantId: string, stripeConfigured: boolean): SubscriptionSummary {
    const row = this.getSubscriptionRow(tenantId);
    return {
      plan: row?.plan ?? "free",
      status: row?.status ?? "none",
      seats: row?.seats ?? 1,
      currentPeriodEnd: row?.current_period_end ?? null,
      stripeConfigured,
    };
  }

  getSubscriptionRow(tenantId: string): SubscriptionRow | undefined {
    return this.db
      .prepare("SELECT * FROM subscriptions WHERE tenant_id = ?")
      .get(tenantId) as SubscriptionRow | undefined;
  }

  getLatestEntitlementSnapshot(tenantId: string): EntitlementSnapshot | null {
    const row = this.db
      .prepare(`
        SELECT * FROM entitlement_snapshots
        WHERE tenant_id = ?
        ORDER BY version DESC
        LIMIT 1
      `)
      .get(tenantId) as EntitlementSnapshotRow | undefined;
    return row ? entitlementSnapshot(row) : null;
  }

  createEntitlementSnapshot(input: {
    tenantId: string;
    plan: PlanId;
    status: SubscriptionStatus;
    seatLimit: number;
    activeRunLimit: number;
    requestLimit: number;
    periodStart: string;
    periodEnd?: string | null;
    allowedRouteIds: readonly string[];
  }): EntitlementSnapshot {
    const versionRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM entitlement_snapshots WHERE tenant_id = ?",
      )
      .get(input.tenantId) as { version: number };
    const version = versionRow.version;
    const createdAt = now();
    this.db
      .prepare(`
        INSERT INTO entitlement_snapshots (
          tenant_id, version, plan, status, seat_limit, active_run_limit,
          request_limit, period_start, period_end, allowed_route_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.tenantId,
        version,
        input.plan,
        input.status,
        input.seatLimit,
        input.activeRunLimit,
        input.requestLimit,
        input.periodStart,
        input.periodEnd ?? null,
        JSON.stringify([...new Set(input.allowedRouteIds)]),
        createdAt,
      );
    return this.getLatestEntitlementSnapshot(input.tenantId)!;
  }

  getStripeCustomerId(tenantId: string): string | null {
    const row = this.db
      .prepare("SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ?")
      .get(tenantId) as { stripe_customer_id: string | null } | undefined;
    return row?.stripe_customer_id ?? null;
  }

  private writeSubscription(input: {
    tenantId: string;
    plan: PlanId;
    status: SubscriptionStatus;
    seats: number;
    customerId?: string | null;
    subscriptionId?: string | null;
    currentPeriodStart: string;
    currentPeriodEnd?: string | null;
    lastStripeEventCreated?: number | null;
    lastStripeEventId?: string | null;
  }): void {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO subscriptions (
          tenant_id, plan, status, seats, stripe_customer_id, stripe_subscription_id,
          current_period_start, current_period_end, last_stripe_event_created,
          last_stripe_event_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          plan = excluded.plan,
          status = excluded.status,
          seats = excluded.seats,
          stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
          stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          last_stripe_event_created = COALESCE(
            excluded.last_stripe_event_created,
            subscriptions.last_stripe_event_created
          ),
          last_stripe_event_id = COALESCE(
            excluded.last_stripe_event_id,
            subscriptions.last_stripe_event_id
          ),
          updated_at = excluded.updated_at
      `)
      .run(
        input.tenantId,
        input.plan,
        input.status,
        Math.max(1, input.seats),
        input.customerId ?? null,
        input.subscriptionId ?? null,
        input.currentPeriodStart,
        input.currentPeriodEnd ?? null,
        input.lastStripeEventCreated ?? null,
        input.lastStripeEventId ?? null,
        timestamp,
        timestamp,
      );

    const current = this.getLatestEntitlementSnapshot(input.tenantId);
    const limits = planLimits(input.plan);
    this.createEntitlementSnapshot({
      tenantId: input.tenantId,
      plan: input.plan,
      status: effectiveEntitlementStatus(input.plan, input.status),
      seatLimit: Math.max(1, input.seats),
      activeRunLimit: limits.activeRunLimit,
      requestLimit: limits.requestLimit,
      periodStart: input.currentPeriodStart,
      periodEnd: input.currentPeriodEnd ?? null,
      allowedRouteIds: current?.allowedRouteIds.length ? current.allowedRouteIds : ["*"],
    });
  }

  updateSubscription(input: {
    tenantId: string;
    plan: PlanId;
    status: SubscriptionStatus;
    seats: number;
    customerId?: string | null;
    subscriptionId?: string | null;
    currentPeriodStart: string;
    currentPeriodEnd?: string | null;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.writeSubscription(input);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stripeWebhookProcessed(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM billing_webhook_events WHERE event_id = ?")
      .get(eventId) as { found: number } | undefined;
    return Boolean(row);
  }

  recordIgnoredStripeWebhook(input: {
    eventId: string;
    eventType: string;
    eventCreated: number;
    objectId?: string | null;
  }): StripeWebhookOutcome {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.stripeWebhookProcessed(input.eventId)) {
        this.db.exec("COMMIT");
        return "duplicate";
      }
      this.db
        .prepare(`
          INSERT INTO billing_webhook_events (
            event_id, event_type, object_id, tenant_id, stripe_created, outcome, processed_at
          ) VALUES (?, ?, ?, NULL, ?, 'ignored', ?)
        `)
        .run(
          input.eventId,
          input.eventType,
          input.objectId ?? null,
          input.eventCreated,
          now(),
        );
      this.db.exec("COMMIT");
      return "ignored";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  applyStripeSubscriptionEvent(input: StripeSubscriptionEventInput): StripeWebhookOutcome {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.stripeWebhookProcessed(input.eventId)) {
        this.db.exec("COMMIT");
        return "duplicate";
      }

      const current = this.getSubscriptionRow(input.tenantId);
      const outcome: Exclude<StripeWebhookOutcome, "duplicate" | "ignored"> =
        current?.last_stripe_event_created !== null &&
        current?.last_stripe_event_created !== undefined &&
        current.last_stripe_event_created > input.eventCreated
          ? "stale"
          : "applied";

      if (outcome === "applied") {
        this.writeSubscription({
          tenantId: input.tenantId,
          plan: input.plan,
          status: input.status,
          seats: input.seats,
          customerId: input.customerId,
          subscriptionId: input.subscriptionId,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          lastStripeEventCreated: input.eventCreated,
          lastStripeEventId: input.eventId,
        });
      }

      const processedAt = now();
      this.db
        .prepare(`
          INSERT INTO billing_webhook_events (
            event_id, event_type, object_id, tenant_id, stripe_created, outcome, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.eventId,
          input.eventType,
          input.objectId ?? input.subscriptionId,
          input.tenantId,
          input.eventCreated,
          outcome,
          processedAt,
        );
      this.audit({
        tenantId: input.tenantId,
        userId: null,
        action: "billing.stripe_webhook",
        targetType: "stripe_event",
        targetId: input.eventId,
        metadata: {
          type: input.eventType,
          outcome,
          stripeCreated: input.eventCreated,
          subscriptionId: input.subscriptionId,
        },
      });
      this.db.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  expireUsageReservations(tenantId: string, timestamp: string): void {
    this.db
      .prepare(`
        UPDATE usage_reservations
        SET status = 'expired', completed_at = ?
        WHERE tenant_id = ? AND status = 'reserved' AND expires_at <= ?
      `)
      .run(timestamp, tenantId, timestamp);
  }

  reconcileOrphanedUsageReservations(errorCode = "server_restarted"): number {
    const result = this.db
      .prepare(`
        UPDATE usage_reservations
        SET status = 'failed', error_code = ?, completed_at = ?
        WHERE status = 'reserved'
      `)
      .run(errorCode, now());
    return Number(result.changes);
  }

  getUsageReservation(reservationId: string): UsageReservation | null {
    const row = this.db
      .prepare("SELECT * FROM usage_reservations WHERE id = ?")
      .get(reservationId) as UsageReservationRow | undefined;
    return row ? usageReservation(row) : null;
  }

  findUsageReservation(tenantId: string, idempotencyKey: string): UsageReservation | null {
    const row = this.db
      .prepare(`
        SELECT * FROM usage_reservations
        WHERE tenant_id = ? AND idempotency_key = ?
      `)
      .get(tenantId, idempotencyKey) as UsageReservationRow | undefined;
    return row ? usageReservation(row) : null;
  }

  countActiveUsageReservations(tenantId: string, timestamp: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM usage_reservations
        WHERE tenant_id = ? AND status = 'reserved' AND expires_at > ?
      `)
      .get(tenantId, timestamp) as { count: number };
    return row.count;
  }

  countUsageReservationsSince(tenantId: string, periodStart: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM usage_reservations
        WHERE tenant_id = ? AND created_at >= ?
      `)
      .get(tenantId, periodStart) as { count: number };
    return row.count;
  }

  getUsageSummary(tenantId: string): UsageSummary {
    const entitlement = this.getLatestEntitlementSnapshot(tenantId);
    if (!entitlement) throw new Error("The workspace has no current entitlement snapshot");
    const timestamp = now();
    const tokens = this.db
      .prepare(`
        SELECT
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM usage_events
        WHERE tenant_id = ? AND created_at >= ?
      `)
      .get(tenantId, entitlement.periodStart) as {
        input_tokens: number;
        output_tokens: number;
      };
    const seats = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND status = 'active'",
      )
      .get(tenantId) as { count: number };
    return {
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
      requestsUsed: this.countUsageReservationsSince(tenantId, entitlement.periodStart),
      requestLimit: entitlement.requestLimit,
      activeRuns: this.countActiveUsageReservations(tenantId, timestamp),
      activeRunLimit: entitlement.activeRunLimit,
      inputTokens: Number(tokens.input_tokens),
      outputTokens: Number(tokens.output_tokens),
      seatsUsed: seats.count,
      seatLimit: entitlement.seatLimit,
    };
  }

  listAuditEventPage(tenantId: string, limit = 100, cursor?: string): AuditEventPage {
    const integerLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const boundedLimit = Math.max(1, Math.min(500, integerLimit));
    const rows = cursor
      ? (this.db
          .prepare(`
            WITH audit_cursor AS (
              SELECT created_at, id
              FROM audit_logs
              WHERE tenant_id = ? AND id = ?
            )
            SELECT
              event.id,
              event.user_id,
              event.action,
              event.target_type,
              event.target_id,
              event.metadata_json,
              event.created_at
            FROM audit_logs AS event
            JOIN audit_cursor
            WHERE event.tenant_id = ?
              AND (
                event.created_at < audit_cursor.created_at
                OR (
                  event.created_at = audit_cursor.created_at
                  AND event.id < audit_cursor.id
                )
              )
            ORDER BY event.created_at DESC, event.id DESC
            LIMIT ?
          `)
          .all(tenantId, cursor, tenantId, boundedLimit + 1) as unknown as AuditEventRow[])
      : (this.db
          .prepare(`
            SELECT id, user_id, action, target_type, target_id, metadata_json, created_at
            FROM audit_logs
            WHERE tenant_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `)
          .all(tenantId, boundedLimit + 1) as unknown as AuditEventRow[]);
    const events = rows.slice(0, boundedLimit).map(auditEventSummary);
    return {
      events,
      nextCursor: rows.length > boundedLimit ? events.at(-1)?.id ?? null : null,
    };
  }

  listAuditEvents(tenantId: string, limit = 100): AuditEventSummary[] {
    return this.listAuditEventPage(tenantId, limit).events;
  }

  createUsageReservation(input: {
    tenantId: string;
    userId: string;
    providerConnectionId: string;
    routeCatalogId: string;
    model: string;
    operation: UsageReservation["operation"];
    workspacePath?: string | null;
    threadId?: string | null;
    idempotencyKey: string;
    requestHash: string;
    createdAt: string;
    expiresAt: string;
  }): UsageReservation {
    const ownership = this.db
      .prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM users WHERE id = ? AND tenant_id = ?
          ) AS user_matches,
          EXISTS(
            SELECT 1 FROM provider_connections WHERE id = ? AND tenant_id = ?
          ) AS provider_matches
      `)
      .get(
        input.userId,
        input.tenantId,
        input.providerConnectionId,
        input.tenantId,
      ) as { user_matches: number; provider_matches: number };
    if (ownership.user_matches !== 1 || ownership.provider_matches !== 1) {
      throw new Error("Usage reservation references must belong to the supplied tenant");
    }
    const id = randomUUID();
    this.db
      .prepare(`
        INSERT INTO usage_reservations (
          id, tenant_id, user_id, provider_connection_id, route_catalog_id,
          model, operation, workspace_path, thread_id, idempotency_key,
          request_hash, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `)
      .run(
        id,
        input.tenantId,
        input.userId,
        input.providerConnectionId,
        input.routeCatalogId,
        input.model,
        input.operation,
        input.workspacePath ?? null,
        input.threadId ?? null,
        input.idempotencyKey,
        input.requestHash,
        input.createdAt,
        input.expiresAt,
      );
    const row = this.db
      .prepare("SELECT * FROM usage_reservations WHERE id = ?")
      .get(id) as unknown as UsageReservationRow;
    return usageReservation(row);
  }

  recordUsageReservationResponse(input: {
    reservationId: string;
    tenantId: string;
    response: unknown;
    completesReservation: boolean;
    threadId?: string | null;
    turnId?: string | null;
  }): boolean {
    const timestamp = now();
    const result = this.db
      .prepare(`
        UPDATE usage_reservations
        SET response_json = ?,
            status = CASE WHEN ? = 1 THEN 'completed' ELSE status END,
            completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
            thread_id = COALESCE(thread_id, ?),
            turn_id = COALESCE(turn_id, ?)
        WHERE id = ? AND tenant_id = ? AND status IN ('reserved', 'completed')
          AND (? IS NULL OR thread_id IS NULL OR thread_id = ?)
          AND (? IS NULL OR turn_id IS NULL OR turn_id = ?)
      `)
      .run(
        JSON.stringify(input.response),
        input.completesReservation ? 1 : 0,
        input.completesReservation ? 1 : 0,
        timestamp,
        input.threadId ?? null,
        input.turnId ?? null,
        input.reservationId,
        input.tenantId,
        input.threadId ?? null,
        input.threadId ?? null,
        input.turnId ?? null,
        input.turnId ?? null,
      );
    return Number(result.changes) === 1;
  }

  commitThreadStart(input: {
    reservationId: string;
    tenantId: string;
    userId: string;
    threadId: string;
    workspacePath: string;
    response: unknown;
    usageMetadata: unknown;
    auditMetadata: unknown;
  }): boolean {
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.db
        .prepare(`
          SELECT tenant_id, user_id, operation, status, workspace_path, thread_id, expires_at
          FROM usage_reservations
          WHERE id = ?
        `)
        .get(input.reservationId) as
          | {
              tenant_id: string;
              user_id: string;
              operation: UsageReservation["operation"];
              status: UsageReservation["status"];
              workspace_path: string | null;
              thread_id: string | null;
              expires_at: string;
            }
          | undefined;
      if (
        !owner
        || owner.tenant_id !== input.tenantId
        || owner.user_id !== input.userId
        || owner.operation !== "thread_start"
        || owner.status !== "reserved"
        || owner.workspace_path !== input.workspacePath
        || (owner.thread_id !== null && owner.thread_id !== input.threadId)
        || owner.expires_at <= timestamp
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }

      this.bindThreadWorkspace({
        tenantId: input.tenantId,
        userId: input.userId,
        threadId: input.threadId,
        workspacePath: input.workspacePath,
      });
      const receipt = this.db
        .prepare(`
          UPDATE usage_reservations
          SET response_json = ?, status = 'completed', completed_at = ?, thread_id = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ?
            AND operation = 'thread_start' AND status = 'reserved'
            AND workspace_path = ? AND expires_at > ?
        `)
        .run(
          JSON.stringify(input.response),
          timestamp,
          input.threadId,
          input.reservationId,
          input.tenantId,
          input.userId,
          input.workspacePath,
          timestamp,
        );
      if (Number(receipt.changes) !== 1) {
        throw new Error("Thread-start reservation closed before its receipt was recorded");
      }
      this.db
        .prepare(`
          INSERT INTO usage_events (
            id, tenant_id, reservation_id, event_key, event_type,
            input_tokens, output_tokens, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'thread_started', NULL, NULL, ?, ?)
        `)
        .run(
          randomUUID(),
          input.tenantId,
          input.reservationId,
          `thread-started:${input.threadId}`,
          JSON.stringify(input.usageMetadata),
          timestamp,
        );
      this.audit({
        tenantId: input.tenantId,
        userId: input.userId,
        action: "codex.thread_started",
        targetType: "thread",
        targetId: input.threadId,
        metadata: input.auditMetadata,
      });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewUsageReservation(input: {
    reservationId: string;
    tenantId: string;
    expiresAt: string;
    threadId: string;
    turnId: string;
  }): boolean {
    const result = this.db
      .prepare(`
        UPDATE usage_reservations
        SET expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END
        WHERE id = ?
          AND tenant_id = ?
          AND operation = 'turn_start'
          AND status = 'reserved'
          AND thread_id = ?
          AND turn_id = ?
      `)
      .run(
        input.expiresAt,
        input.expiresAt,
        input.reservationId,
        input.tenantId,
        input.threadId,
        input.turnId,
      );
    return Number(result.changes) === 1;
  }

  failUsageReservation(reservationId: string, tenantId: string, errorCode: string): void {
    this.db
      .prepare(`
        UPDATE usage_reservations
        SET status = 'failed', error_code = ?, completed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'reserved'
      `)
      .run(errorCode, now(), reservationId, tenantId);
  }

  completeUsageReservation(input: {
    reservationId: string;
    tenantId: string;
    eventKey: string;
    eventType: string;
    expectedThreadId?: string;
    expectedTurnId?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    metadata?: unknown;
  }): boolean {
    for (const tokenCount of [input.inputTokens, input.outputTokens]) {
      if (
        tokenCount !== undefined &&
        tokenCount !== null &&
        (!Number.isSafeInteger(tokenCount) || tokenCount < 0)
      ) {
        throw new Error("Usage token counts must be non-negative safe integers");
      }
    }
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.db
        .prepare(`
          SELECT tenant_id, operation, status, thread_id, turn_id
          FROM usage_reservations
          WHERE id = ?
        `)
        .get(input.reservationId) as
          | {
              tenant_id: string;
              operation: UsageReservation["operation"];
              status: UsageReservation["status"];
              thread_id: string | null;
              turn_id: string | null;
            }
          | undefined;
      if (!owner || owner.tenant_id !== input.tenantId) {
        throw new Error("Usage reservation does not belong to the supplied tenant");
      }
      if (
        owner.operation === "turn_start" &&
        (input.expectedThreadId === undefined || input.expectedTurnId === undefined)
      ) {
        throw new Error("Turn usage settlement requires exact thread and turn correlation");
      }
      if (
        input.expectedThreadId !== undefined &&
        (owner.operation !== "turn_start" ||
          owner.thread_id !== input.expectedThreadId ||
          owner.turn_id !== input.expectedTurnId)
      ) {
        throw new Error("Usage reservation does not match the supplied turn correlation");
      }
      if (owner.status !== "reserved" && owner.status !== "completed") {
        this.db.exec("COMMIT");
        return false;
      }
      this.db
        .prepare(`
          UPDATE usage_reservations
          SET status = 'completed', completed_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'reserved'
        `)
        .run(timestamp, input.reservationId, input.tenantId);
      this.db
        .prepare(`
          INSERT INTO usage_events (
            id, tenant_id, reservation_id, event_key, event_type,
            input_tokens, output_tokens, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(reservation_id, event_key) DO NOTHING
        `)
        .run(
          randomUUID(),
          input.tenantId,
          input.reservationId,
          input.eventKey,
          input.eventType,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          timestamp,
        );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  audit(input: {
    tenantId: string;
    userId: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: unknown;
  }): void {
    if (input.userId !== null) {
      const actor = this.db
        .prepare("SELECT 1 AS found FROM users WHERE id = ? AND tenant_id = ?")
        .get(input.userId, input.tenantId) as { found: number } | undefined;
      if (!actor) throw new Error("Audit actor does not belong to the supplied tenant");
    }
    const metadata =
      input.metadata === undefined ? null : JSON.stringify(sanitizedAuditMetadata(input.metadata));
    this.db
      .prepare(`
        INSERT INTO audit_logs (
          id, tenant_id, user_id, action, target_type, target_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.tenantId,
        input.userId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        metadata,
        now(),
      );
  }
}

export type { ProviderRow, SubscriptionRow, UserRow };
