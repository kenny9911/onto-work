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
  UploadContentType,
  UploadStatus,
  UploadSummary,
  UserRole,
  UserStatus,
  UserSummary,
  UsageSummary,
} from "@agent-harness/contracts";
import {
  UPLOAD_ALLOWED_CONTENT_TYPES,
  UPLOAD_MAX_BYTES,
  UPLOAD_PLAN_LIMITS,
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
  /**
   * Upload ceilings. The durable columns are nullable: NULL means "use the
   * plan default", so these are always resolved, never null.
   */
  storageBytesLimit: number;
  uploadBytesPeriodLimit: number;
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
  storage_bytes_limit: number | null;
  upload_bytes_period_limit: number | null;
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

// --- Uploads --------------------------------------------------------------
//
// Ownership is `(tenant_id, user_id)`; possession of an id conveys nothing.
// Every read below is scoped by both, and a row belonging to anyone else is
// reported as absent rather than forbidden so ids are not oracle-able.

/**
 * Wire content type of a body whose bytes have not been classified yet. A
 * `reserving` row is written before the first byte is read, so it cannot name
 * a real type; `commitUpload` replaces it with the server's own
 * classification and refuses anything off `UPLOAD_ALLOWED_CONTENT_TYPES`.
 */
export const UPLOAD_PENDING_CONTENT_TYPE = "application/octet-stream";

/** Placeholder digest for a `reserving` row; the column requires 64 chars. */
export const UPLOAD_PENDING_SHA256 = "0".repeat(64);

/** How long a quota reservation may hold bytes it has not settled. */
export const UPLOAD_RESERVATION_LEASE_MS = 10 * 60 * 1_000;

/**
 * Statuses whose bytes the tenant still holds. `reserving` is deliberately
 * included — the reservation is taken before a single byte is accepted
 * precisely so concurrent uploads cannot each pass a pre-check and race past
 * the limit. `failed` and `deleted` rows no longer occupy the store.
 *
 * This is the *storage* meter only. The period meter counts every row created
 * in the period whatever its status, because a release is a row deletion: an
 * upload abandoned mid-stream leaves nothing behind, while one that reached
 * `stored` really did consume ingest and is not refunded by deleting the file
 * later. That is what the `deleted` tombstone is for.
 */
const UPLOAD_ACCOUNTED_STATUSES: readonly UploadStatus[] = [
  "reserving",
  "stored",
  "attached",
  "extracted",
];

/** Statuses a listing surfaces: durable rows the user can still act on. */
const UPLOAD_VISIBLE_STATUSES: readonly UploadStatus[] = [
  "stored",
  "attached",
  "extracted",
];

/** Statuses a thread claim may transition. */
const UPLOAD_CLAIMABLE_STATUSES: readonly UploadStatus[] = [
  "stored",
  "attached",
  "extracted",
];

/**
 * Statuses the janitor reclaims once `expires_at` has passed — every status
 * whose row still names a blob on disk.
 *
 * `extracted` is included deliberately: an upload the agent has already read
 * is still a durable file on a retention clock, and leaving it out would make
 * its bytes hold tenant storage quota forever.
 *
 * `failed` is included for the opposite reason. A durable row that failed
 * *stops* counting toward storage quota (it is not in
 * `UPLOAD_ACCOUNTED_STATUSES`) while its blob is still on disk, so omitting it
 * would leak that file permanently and silently: nothing meters it, and no
 * other status transition can ever reach it. `expireUploads` is the store's
 * only reclamation surface, so every status that owns bytes has to pass
 * through it exactly once.
 *
 * `deleted` is excluded on purpose — it is the terminal tombstone. Expiring it
 * again would rewrite the same row and emit an `upload.expired` audit on every
 * pass forever. Its blob is unlinked by whoever wrote the tombstone
 * (`deleteUpload` returns the `storageKey` for exactly that), with the
 * janitor's filesystem-side orphan sweep as the crash-recovery backstop.
 */
const UPLOAD_EXPIRABLE_STATUSES: readonly UploadStatus[] = [
  "reserving",
  "stored",
  "attached",
  "extracted",
  "failed",
];

const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Defence in depth. The route normalizes and validates the display label
// first; this is the last gate before it reaches a durable row, and the
// column CHECK only bounds its length.
const UPLOAD_FILENAME_PATTERN = /^[^\u0000-\u001f\u007f/\\]{1,255}$/;
const UPLOAD_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UPLOAD_ERROR_CODE_LIMIT = 128;
const UPLOAD_STORAGE_KEY_LIMIT = 512;
const UPLOAD_EXPIRY_BATCH_LIMIT = 200;

export interface UploadRecord {
  id: string;
  tenantId: string;
  userId: string;
  threadId: string | null;
  projectId: string | null;
  workspacePath: string;
  /** Display label only. It never becomes a filesystem path component. */
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  encryptionIv: string;
  encryptionTag: string;
  wrappedDataKey: string;
  status: UploadStatus;
  extractionTurnId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface UploadRow {
  id: string;
  tenant_id: string;
  user_id: string;
  thread_id: string | null;
  project_id: string | null;
  workspace_path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_sha256: string;
  storage_key: string;
  encryption_iv: string;
  encryption_tag: string;
  wrapped_data_key: string;
  status: UploadStatus;
  extraction_turn_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/**
 * Outcome of a quota reservation. The comparison runs inside the same
 * `BEGIN IMMEDIATE` as the insert, so two concurrent uploads cannot both pass
 * it. The store never speaks HTTP: the route maps `storage_quota_exhausted`
 * and `upload_quota_exhausted` to 429 and `entitlement_missing` to 403.
 */
export type UploadReservationResult =
  | { outcome: "reserved"; upload: UploadRecord }
  | { outcome: "storage_quota_exhausted"; usedBytes: number; limitBytes: number }
  | { outcome: "upload_quota_exhausted"; usedBytes: number; limitBytes: number }
  | { outcome: "entitlement_missing" };

/**
 * `released` deleted a reservation and returned its bytes to the tenant quota;
 * `failed` marked a durable row so its blob is reclaimed by the janitor.
 */
export interface UploadFailureResult {
  outcome: "released" | "failed" | "unchanged" | "missing";
  /**
   * The row as it stood when the decision was taken. For `released` this is
   * the only copy left, and it carries the `storageKey` of the partial blob
   * the caller still has to unlink.
   */
  upload: UploadRecord | null;
}

export type UploadClaimResult =
  | { outcome: "claimed"; upload: UploadRecord }
  | { outcome: "already_bound"; upload: UploadRecord }
  | { outcome: "workspace_conflict"; upload: UploadRecord }
  | { outcome: "not_claimable"; upload: UploadRecord }
  | { outcome: "not_found" };

export interface UploadBatchClaimInput {
  tenantId: string;
  userId: string;
  uploadIds: readonly string[];
  threadId: string;
  workspacePath: string;
}

export type UploadBatchClaimResult =
  | { outcome: "claimed"; uploads: UploadRecord[] }
  | { outcome: "already_bound"; upload: UploadRecord }
  | { outcome: "workspace_conflict"; upload: UploadRecord }
  | { outcome: "not_claimable"; upload: UploadRecord }
  | { outcome: "not_found" };

export interface ExpiredUploadRecord {
  id: string;
  tenantId: string;
  userId: string;
  /** The blob the caller must unlink; no live row points at it any more. */
  storageKey: string;
  sizeBytes: number;
  previousStatus: UploadStatus;
  /** `released` deleted a reservation row; `deleted` tombstoned a durable one. */
  outcome: "released" | "deleted";
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

/**
 * A snapshot column added after the fact is NULL on every pre-existing row.
 * NULL, and anything a hand-edited row could hold that is not a usable
 * ceiling, resolves to the code-level plan default.
 */
function durableLimit(value: number | null, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "bigint") return fallback;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
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
  const planUploadLimits = UPLOAD_PLAN_LIMITS[row.plan];
  return {
    tenantId: row.tenant_id,
    version: row.version,
    plan: row.plan,
    status: row.status,
    seatLimit: row.seat_limit,
    activeRunLimit: row.active_run_limit,
    requestLimit: row.request_limit,
    storageBytesLimit: durableLimit(
      row.storage_bytes_limit,
      planUploadLimits.storageBytesLimit,
    ),
    uploadBytesPeriodLimit: durableLimit(
      row.upload_bytes_period_limit,
      planUploadLimits.uploadBytesPeriodLimit,
    ),
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

function uploadRecord(row: UploadRow): UploadRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    threadId: row.thread_id,
    projectId: row.project_id,
    workspacePath: row.workspace_path,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    contentSha256: row.content_sha256,
    storageKey: row.storage_key,
    encryptionIv: row.encryption_iv,
    encryptionTag: row.encryption_tag,
    wrappedDataKey: row.wrapped_data_key,
    status: row.status,
    extractionTurnId: row.extraction_turn_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/**
 * `commitUpload` is what guarantees a durable row carries an allow-listed
 * type, so this narrowing always succeeds for the rows a client can see. The
 * fallback exists only so a hand-edited row degrades to a harmless display
 * label instead of crashing a listing.
 */
function uploadContentType(value: string): UploadContentType {
  return (UPLOAD_ALLOWED_CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as UploadContentType)
    : "text/plain";
}

/** Client-facing projection of an upload row. Carries no path and no bytes. */
export function uploadSummary(record: UploadRecord): UploadSummary {
  return {
    id: record.id,
    scope: record.threadId !== null ? "thread" : "project",
    threadId: record.threadId,
    projectId: record.projectId,
    filename: record.filename,
    contentType: uploadContentType(record.contentType),
    sizeBytes: record.sizeBytes,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}

/**
 * Audit metadata for every upload action: flat scalars, no filename, no path,
 * no bytes. `sanitizedAuditMetadata` redacts by *key name*, so a secret
 * arriving as the value of `filename` would pass straight through — the
 * filename is therefore never handed to it at all, and neither is
 * `workspace_path` or `storage_key`.
 */
function uploadAuditMetadata(record: UploadRecord): Record<string, string | number | null> {
  return {
    threadId: record.threadId,
    projectId: record.projectId,
    sizeBytes: record.sizeBytes,
    contentType: record.contentType,
    sha256Prefix: record.contentSha256.slice(0, 12),
  };
}

function statusPlaceholders(statuses: readonly UploadStatus[]): string {
  return statuses.map(() => "?").join(", ");
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

  /**
   * Takes the quota reservation that makes concurrent uploads safe.
   *
   * The row is written with `status='reserving'` and `size_bytes` set to the
   * *declared* Content-Length **before** a single byte is accepted, and it
   * counts toward the tenant sum from that moment. The limit comparison runs
   * inside the same `BEGIN IMMEDIATE` as the insert, so two uploads racing
   * against the same remaining allowance cannot both pass a pre-check — this
   * is the `RunAdmissionPolicy.admit` shape, and the reason the route must
   * never do its own check-then-insert.
   *
   * `commitUpload` settles the row to the true byte count; `failUpload`
   * releases it. The insert is guarded by the migration-8 scope triggers, so a
   * `workspacePath` that disagrees with the thread binding (or the project's
   * canonical path) aborts here rather than becoming a durable row.
   */
  createUploadReservation(input: {
    /** Server-generated; defaults to a fresh UUID. */
    id?: string;
    tenantId: string;
    userId: string;
    threadId?: string | null;
    projectId?: string | null;
    workspacePath: string;
    filename: string;
    /** The declared Content-Length. It is the ceiling the settle may not raise. */
    sizeBytes: number;
    storageKey: string;
    createdAt?: string;
    expiresAt?: string;
  }): UploadReservationResult {
    const id = input.id ?? randomUUID();
    if (!UPLOAD_ID_PATTERN.test(id)) {
      throw new Error("Upload ids must be server-generated UUIDs");
    }
    if (
      !UPLOAD_FILENAME_PATTERN.test(input.filename) ||
      input.filename === "." ||
      input.filename === ".."
    ) {
      throw new Error("Upload filename label is not a storable display label");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("Upload size must be a non-negative safe integer");
    }
    if (input.sizeBytes > UPLOAD_MAX_BYTES) {
      throw new Error("Upload size exceeds the maximum the control plane accepts");
    }
    if (input.storageKey.length < 1 || input.storageKey.length > UPLOAD_STORAGE_KEY_LIMIT) {
      throw new Error("Upload storage key must be 1 to 512 characters");
    }
    if (input.workspacePath.length === 0) {
      throw new Error("Upload workspace path must be the canonical bound path");
    }
    const threadId = input.threadId ?? null;
    const projectId = input.projectId ?? null;
    if (threadId === null && projectId === null) {
      throw new Error("An upload must be scoped to a thread or to a saved project");
    }

    const timestamp = input.createdAt ?? now();
    const expiresAt =
      input.expiresAt ?? new Date(Date.now() + UPLOAD_RESERVATION_LEASE_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ownership = this.db
        .prepare(`
          SELECT
            EXISTS(
              SELECT 1 FROM users WHERE id = ? AND tenant_id = ?
            ) AS user_matches,
            (? IS NULL OR EXISTS(
              SELECT 1 FROM projects WHERE id = ? AND tenant_id = ?
            )) AS project_matches
        `)
        .get(
          input.userId,
          input.tenantId,
          projectId,
          projectId,
          input.tenantId,
        ) as { user_matches: number; project_matches: number };
      if (ownership.user_matches !== 1 || ownership.project_matches !== 1) {
        throw new Error("Upload references must belong to the supplied tenant");
      }

      const entitlement = this.getLatestEntitlementSnapshot(input.tenantId);
      if (!entitlement) {
        this.db.exec("COMMIT");
        return { outcome: "entitlement_missing" };
      }

      const storedBytes = this.getUploadStorageUsage(input.tenantId);
      if (storedBytes + input.sizeBytes > entitlement.storageBytesLimit) {
        this.db.exec("COMMIT");
        return {
          outcome: "storage_quota_exhausted",
          usedBytes: storedBytes,
          limitBytes: entitlement.storageBytesLimit,
        };
      }
      const periodBytes = this.getUploadBytesSince(input.tenantId, entitlement.periodStart);
      if (periodBytes + input.sizeBytes > entitlement.uploadBytesPeriodLimit) {
        this.db.exec("COMMIT");
        return {
          outcome: "upload_quota_exhausted",
          usedBytes: periodBytes,
          limitBytes: entitlement.uploadBytesPeriodLimit,
        };
      }

      this.db
        .prepare(`
          INSERT INTO uploads (
            id, tenant_id, user_id, thread_id, project_id, workspace_path,
            filename, content_type, size_bytes, content_sha256, storage_key,
            encryption_iv, encryption_tag, wrapped_data_key, status,
            extraction_turn_id, error_code, created_at, updated_at, expires_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            '', '', '', 'reserving',
            NULL, NULL, ?, ?, ?
          )
        `)
        .run(
          id,
          input.tenantId,
          input.userId,
          threadId,
          projectId,
          input.workspacePath,
          input.filename,
          UPLOAD_PENDING_CONTENT_TYPE,
          input.sizeBytes,
          UPLOAD_PENDING_SHA256,
          input.storageKey,
          timestamp,
          timestamp,
          expiresAt,
        );
      const row = this.db
        .prepare("SELECT * FROM uploads WHERE id = ?")
        .get(id) as unknown as UploadRow;
      this.db.exec("COMMIT");
      return { outcome: "reserved", upload: uploadRecord(row) };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A quota rejection has already closed its read-only transaction.
      }
      throw error;
    }
  }

  /**
   * Settles a reservation to the bytes actually written, in one transaction
   * with its `upload.created` audit row.
   *
   * Returns `null` when the reservation is gone or already settled — the
   * janitor can expire a lease while a slow upload is still streaming, and
   * that race belongs to the route, not to an exception.
   */
  commitUpload(input: {
    tenantId: string;
    userId: string;
    uploadId: string;
    sizeBytes: number;
    contentType: UploadContentType;
    contentSha256: string;
    storageKey?: string;
    encryptionIv: string;
    encryptionTag: string;
    wrappedDataKey: string;
    expiresAt?: string;
  }): UploadRecord | null {
    if (!(UPLOAD_ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      throw new Error("Upload content type is not on the server allow-list");
    }
    if (!UPLOAD_SHA256_PATTERN.test(input.contentSha256)) {
      throw new Error("Upload content digest must be 64 lowercase hex characters");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("Upload size must be a non-negative safe integer");
    }
    if (
      input.encryptionIv.length === 0 ||
      input.encryptionTag.length === 0 ||
      input.wrappedDataKey.length === 0
    ) {
      throw new Error("A stored upload must carry its encryption material");
    }

    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(`
          SELECT * FROM uploads
          WHERE id = ? AND tenant_id = ? AND user_id = ?
        `)
        .get(input.uploadId, input.tenantId, input.userId) as UploadRow | undefined;
      if (!current || current.status !== "reserving") {
        this.db.exec("ROLLBACK");
        return null;
      }
      // The reservation is the ceiling the tenant was charged for. A settle
      // may shrink it; raising it would spend quota nobody reserved.
      if (input.sizeBytes > Number(current.size_bytes)) {
        throw new Error("A settled upload cannot exceed its reserved byte count");
      }

      const settled = this.db
        .prepare(`
          UPDATE uploads
          SET status = 'stored',
              size_bytes = ?,
              content_type = ?,
              content_sha256 = ?,
              storage_key = COALESCE(?, storage_key),
              encryption_iv = ?,
              encryption_tag = ?,
              wrapped_data_key = ?,
              updated_at = ?,
              expires_at = COALESCE(?, expires_at)
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'reserving'
        `)
        .run(
          input.sizeBytes,
          input.contentType,
          input.contentSha256,
          input.storageKey ?? null,
          input.encryptionIv,
          input.encryptionTag,
          input.wrappedDataKey,
          timestamp,
          input.expiresAt ?? null,
          input.uploadId,
          input.tenantId,
          input.userId,
        );
      if (Number(settled.changes) !== 1) {
        throw new Error("Upload reservation closed before its bytes were settled");
      }
      const row = this.db
        .prepare("SELECT * FROM uploads WHERE id = ?")
        .get(input.uploadId) as unknown as UploadRow;
      const record = uploadRecord(row);
      this.audit({
        tenantId: input.tenantId,
        userId: input.userId,
        action: "upload.created",
        targetType: "upload",
        targetId: record.id,
        metadata: uploadAuditMetadata(record),
      });
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The release half of reserve/settle/release.
   *
   * A `reserving` row is *deleted*, which is what returns its bytes to the
   * tenant quota — the caller still has to unlink the partial blob named by
   * the returned `storageKey`. A durable row is instead marked `failed` with
   * its error code, which is the extraction-failure counterpart of
   * `markUploadExtracted`. Neither is audited: a reservation that never became
   * an upload is quota bookkeeping, and a failed extraction is already carried
   * by its turn's own reservation and audit trail.
   */
  failUpload(input: {
    tenantId: string;
    userId: string;
    uploadId: string;
    errorCode: string;
  }): UploadFailureResult {
    const errorCode = input.errorCode.slice(0, UPLOAD_ERROR_CODE_LIMIT);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT * FROM uploads
          WHERE id = ? AND tenant_id = ? AND user_id = ?
        `)
        .get(input.uploadId, input.tenantId, input.userId) as UploadRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return { outcome: "missing", upload: null };
      }
      const record = uploadRecord(row);
      if (record.status === "reserving") {
        this.db
          .prepare(`
            DELETE FROM uploads
            WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'reserving'
          `)
          .run(input.uploadId, input.tenantId, input.userId);
        this.db.exec("COMMIT");
        return { outcome: "released", upload: record };
      }
      if (record.status === "failed") {
        this.db.exec("COMMIT");
        return { outcome: "failed", upload: record };
      }
      if (record.status === "deleted") {
        this.db.exec("COMMIT");
        return { outcome: "unchanged", upload: record };
      }
      this.db
        .prepare(`
          UPDATE uploads
          SET status = 'failed', error_code = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ?
        `)
        .run(errorCode, timestamp, input.uploadId, input.tenantId, input.userId);
      const settled = this.db
        .prepare("SELECT * FROM uploads WHERE id = ?")
        .get(input.uploadId) as unknown as UploadRow;
      this.db.exec("COMMIT");
      return { outcome: "failed", upload: uploadRecord(settled) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Scoped by tenant *and* user. Another tenant's row — or another user's
   * within the same tenant — reads as absent, so the route answers 404 rather
   * than 403 and ids stay un-oracle-able.
   */
  getUpload(tenantId: string, userId: string, uploadId: string): UploadRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM uploads
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `)
      .get(uploadId, tenantId, userId) as UploadRow | undefined;
    return row ? uploadRecord(row) : null;
  }

  /**
   * Durable uploads bound to one thread, oldest first. In-flight reservations
   * and tombstones are omitted: a listing is what the user can still attach.
   */
  listThreadUploads(tenantId: string, userId: string, threadId: string): UploadRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM uploads
        WHERE tenant_id = ? AND user_id = ? AND thread_id = ?
          AND status IN (${statusPlaceholders(UPLOAD_VISIBLE_STATUSES)})
        ORDER BY created_at ASC, id ASC
      `)
      .all(tenantId, userId, threadId, ...UPLOAD_VISIBLE_STATUSES) as unknown as UploadRow[];
    return rows.map(uploadRecord);
  }

  /**
   * Fail-closed approval fallback for runtimes that omit a thread id from an
   * approval request. A durable attachment on any of the user's threads means
   * the request cannot safely receive standing session authority.
   */
  userHasDurableThreadAttachments(tenantId: string, userId: string): boolean {
    const row = this.db
      .prepare(`
        SELECT 1
        FROM uploads
        WHERE tenant_id = ? AND user_id = ? AND thread_id IS NOT NULL
          AND status IN ('attached', 'extracted')
        LIMIT 1
      `)
      .get(tenantId, userId);
    return row !== undefined;
  }

  /**
   * Performs the read-only half of a turn attachment claim.
   *
   * Routes call this before admission so a bad opaque id cannot consume a run
   * reservation. The mutating method repeats every check inside one write
   * transaction; this preflight is deliberately not trusted across that gap.
   */
  inspectUploadsForThread(input: UploadBatchClaimInput): UploadBatchClaimResult {
    return this.evaluateUploadClaims(input);
  }

  /**
   * Claims every attachment for one turn as a single all-or-nothing change.
   *
   * The transition is one-way and idempotent for the same thread. Every row is
   * validated before the first UPDATE, under the same `BEGIN IMMEDIATE`, so a
   * later invalid id can never leave earlier ids bound to a turn that did not
   * start. The migration-8 scope trigger remains the final workspace guard.
   */
  claimUploadsForThread(input: UploadBatchClaimInput): UploadBatchClaimResult {
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const evaluated = this.evaluateUploadClaims(input);
      if (evaluated.outcome !== "claimed") {
        this.db.exec("ROLLBACK");
        return evaluated;
      }

      const claimedUploads: UploadRecord[] = [];
      for (const record of evaluated.uploads) {
        // An attachment/extracted row already scoped to this thread is an
        // idempotent re-claim and must not emit a second audit event.
        if (record.threadId === input.threadId && record.status !== "stored") {
          claimedUploads.push(record);
          continue;
        }

        const claimed = this.db
          .prepare(`
            UPDATE uploads
            SET thread_id = ?, status = 'attached', updated_at = ?
            WHERE id = ? AND tenant_id = ? AND user_id = ?
              AND (thread_id IS NULL OR thread_id = ?)
          `)
          .run(
            input.threadId,
            timestamp,
            record.id,
            input.tenantId,
            input.userId,
            input.threadId,
          );
        if (Number(claimed.changes) !== 1) {
          throw new Error("Upload was rebound before its thread claim was recorded");
        }
        const attachedRow = this.db
          .prepare("SELECT * FROM uploads WHERE id = ?")
          .get(record.id) as unknown as UploadRow;
        const attached = uploadRecord(attachedRow);
        this.audit({
          tenantId: input.tenantId,
          userId: input.userId,
          action: "upload.attached",
          targetType: "upload",
          targetId: attached.id,
          metadata: uploadAuditMetadata(attached),
        });
        claimedUploads.push(attached);
      }
      this.db.exec("COMMIT");
      return { outcome: "claimed", uploads: claimedUploads };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Backwards-compatible single-upload wrapper used by maintenance callers. */
  claimUploadForThread(input: {
    tenantId: string;
    userId: string;
    uploadId: string;
    threadId: string;
    workspacePath: string;
  }): UploadClaimResult {
    const result = this.claimUploadsForThread({
      tenantId: input.tenantId,
      userId: input.userId,
      uploadIds: [input.uploadId],
      threadId: input.threadId,
      workspacePath: input.workspacePath,
    });
    if (result.outcome === "claimed") {
      const upload = result.uploads[0];
      if (!upload) throw new Error("A successful upload claim returned no upload");
      return { outcome: "claimed", upload };
    }
    return result;
  }

  private evaluateUploadClaims(input: UploadBatchClaimInput): UploadBatchClaimResult {
    const uploads: UploadRecord[] = [];
    for (const uploadId of input.uploadIds) {
      const row = this.db
        .prepare(`
          SELECT * FROM uploads
          WHERE id = ? AND tenant_id = ? AND user_id = ?
        `)
        .get(uploadId, input.tenantId, input.userId) as UploadRow | undefined;
      if (!row) return { outcome: "not_found" };

      const record = uploadRecord(row);
      if (!UPLOAD_CLAIMABLE_STATUSES.includes(record.status)) {
        return { outcome: "not_claimable", upload: record };
      }
      if (record.workspacePath !== input.workspacePath) {
        return { outcome: "workspace_conflict", upload: record };
      }
      if (record.threadId !== null && record.threadId !== input.threadId) {
        return { outcome: "already_bound", upload: record };
      }
      uploads.push(record);
    }
    return { outcome: "claimed", uploads };
  }

  /**
   * Records that a completed turn read this upload. Not audited on its own —
   * the turn that did the reading already has a usage receipt and an audit
   * row, and this only annotates which upload it consumed.
   */
  markUploadExtracted(input: {
    tenantId: string;
    userId: string;
    uploadId: string;
    threadId: string;
    turnId: string;
  }): boolean {
    const result = this.db
      .prepare(`
        UPDATE uploads
        SET status = 'extracted', extraction_turn_id = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND thread_id = ?
          AND status IN ('stored', 'attached')
      `)
      .run(
        input.turnId,
        now(),
        input.uploadId,
        input.tenantId,
        input.userId,
        input.threadId,
      );
    return Number(result.changes) === 1;
  }

  /**
   * Tombstones an upload and audits the deletion in one transaction. The row
   * survives as an audit anchor while its bytes stop counting toward quota
   * immediately; the caller unlinks the blob named by the returned
   * `storageKey`.
   */
  deleteUpload(input: {
    tenantId: string;
    userId: string;
    uploadId: string;
  }): UploadRecord | null {
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`
          SELECT * FROM uploads
          WHERE id = ? AND tenant_id = ? AND user_id = ?
        `)
        .get(input.uploadId, input.tenantId, input.userId) as UploadRow | undefined;
      if (!row || row.status === "deleted") {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db
        .prepare(`
          UPDATE uploads
          SET status = 'deleted', updated_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ?
        `)
        .run(timestamp, input.uploadId, input.tenantId, input.userId);
      const deletedRow = this.db
        .prepare("SELECT * FROM uploads WHERE id = ?")
        .get(input.uploadId) as unknown as UploadRow;
      const record = uploadRecord(deletedRow);
      this.audit({
        tenantId: input.tenantId,
        userId: input.userId,
        action: "upload.deleted",
        targetType: "upload",
        targetId: record.id,
        metadata: uploadAuditMetadata(record),
      });
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Bytes the tenant currently holds, in-flight reservations included so that
   * a reservation taken before any byte is accepted already occupies quota.
   */
  getUploadStorageUsage(tenantId: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(size_bytes), 0) AS total
        FROM uploads
        WHERE tenant_id = ? AND status IN (${statusPlaceholders(UPLOAD_ACCOUNTED_STATUSES)})
      `)
      .get(tenantId, ...UPLOAD_ACCOUNTED_STATUSES) as { total: number };
    return Number(row.total);
  }

  /**
   * Bytes the tenant has accepted since a timestamp, usually a period start.
   *
   * Every surviving row counts, whatever its status: the release half of
   * reserve/settle/release *deletes* the row, so an upload abandoned before
   * its bytes were accepted leaves nothing to meter, while deleting a stored
   * file afterwards does not refund the ingest it already spent.
   */
  getUploadBytesSince(tenantId: string, since: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(size_bytes), 0) AS total
        FROM uploads
        WHERE tenant_id = ? AND created_at >= ?
      `)
      .get(tenantId, since) as { total: number };
    return Number(row.total);
  }

  /**
   * Storage keys of every upload whose blob must stay on disk.
   *
   * "Live" is exactly `UPLOAD_ACCOUNTED_STATUSES`: a blob is live if and only
   * if its row still holds tenant storage quota. A `failed` or `deleted` row
   * has already stopped being metered, so its bytes are reclaimable —
   * `deleteUpload` and `expireUploads` hand their storage keys back for the
   * caller to unlink, and the janitor's filesystem sweep is the crash-recovery
   * backstop for when that unlink never happened.
   *
   * The only caller is `uploads/janitor.ts`. It must take this snapshot
   * **after** it has listed the blob tree, never before: a row is always
   * inserted before its blob is written, so a snapshot taken second is
   * necessarily a superset of the blobs the walk saw, and an upload that
   * started mid-sweep can never be mistaken for an orphan.
   */
  listLiveUploadStorageKeys(): string[] {
    const rows = this.db
      .prepare(`
        SELECT storage_key FROM uploads
        WHERE status IN (${statusPlaceholders(UPLOAD_ACCOUNTED_STATUSES)})
      `)
      .all(...UPLOAD_ACCOUNTED_STATUSES) as unknown as { storage_key: string }[];
    return rows.map((row) => row.storage_key);
  }

  /**
   * Janitor pass: reclaims rows whose `expires_at` has already passed, and
   * nothing else.
   *
   * An expired `reserving` row is deleted — that is what releases the quota an
   * abandoned upload was holding. An expired durable row is tombstoned. Each
   * row's audit is written under that row's own tenant, so a global sweep
   * never crosses a tenant boundary; pass `tenantId` to scope the sweep too.
   * The returned `storageKey`s are the blobs the caller must unlink.
   */
  expireUploads(input: {
    timestamp?: string;
    tenantId?: string;
    limit?: number;
  } = {}): ExpiredUploadRecord[] {
    const timestamp = input.timestamp ?? now();
    const requestedLimit = input.limit;
    const limit =
      typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(UPLOAD_EXPIRY_BATCH_LIMIT, Math.trunc(requestedLimit)))
        : UPLOAD_EXPIRY_BATCH_LIMIT;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(`
          SELECT * FROM uploads
          WHERE status IN (${statusPlaceholders(UPLOAD_EXPIRABLE_STATUSES)})
            AND expires_at <= ?
            AND (? IS NULL OR tenant_id = ?)
          ORDER BY expires_at ASC, id ASC
          LIMIT ?
        `)
        .all(
          ...UPLOAD_EXPIRABLE_STATUSES,
          timestamp,
          input.tenantId ?? null,
          input.tenantId ?? null,
          limit,
        ) as unknown as UploadRow[];

      const expired: ExpiredUploadRecord[] = [];
      for (const row of rows) {
        const record = uploadRecord(row);
        if (record.status === "reserving") {
          this.db
            .prepare("DELETE FROM uploads WHERE id = ? AND status = 'reserving'")
            .run(record.id);
        } else {
          this.db
            .prepare(`
              UPDATE uploads
              SET status = 'deleted', updated_at = ?
              WHERE id = ? AND status = ?
            `)
            .run(timestamp, record.id, record.status);
        }
        this.audit({
          tenantId: record.tenantId,
          // A janitor sweep has no actor; the owner is reachable through the
          // upload id this row targets.
          userId: null,
          action: "upload.expired",
          targetType: "upload",
          targetId: record.id,
          metadata: uploadAuditMetadata(record),
        });
        expired.push({
          id: record.id,
          tenantId: record.tenantId,
          userId: record.userId,
          storageKey: record.storageKey,
          sizeBytes: record.sizeBytes,
          previousStatus: record.status,
          outcome: record.status === "reserving" ? "released" : "deleted",
        });
      }
      this.db.exec("COMMIT");
      return expired;
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
