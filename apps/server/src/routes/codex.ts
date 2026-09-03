import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CodexAdapterConfigurationError,
  type CodexExpectedRoute,
  type CodexUserRouteBridge,
} from "../codex/adapter.js";
import { resolveAllowedWorkspacePath } from "../codex/config.js";
import {
  CodexRpcError,
  CodexRuntimeError,
  type JsonValue,
} from "../codex/runtime.js";
import type { HarnessConfig } from "../config.js";
import {
  uploadSummary,
  type HarnessStore,
  type UploadBatchClaimResult,
  type UploadRecord,
} from "../database.js";
import {
  RunAdmissionError,
  RunAdmissionPolicy,
  USAGE_RESERVATION_LEASE_MS,
} from "../admission.js";
import { ApiHttpError, requireUser } from "../http.js";
import type { HarnessRuntime } from "../runtime.js";
import { TaskMutationLedger } from "../task-mutations.js";
import { decryptToStaged, unlinkStagedThread, type StagedFile } from "../uploads/blob.js";
import { prepareUserUploadPaths, type UserUploadPaths } from "../uploads/paths.js";
import { uploadErrorReason } from "../uploads/redaction.js";
import {
  inputMentionsAttachmentEnvelope,
  renderAttachmentEnvelope,
  type StagedAttachment,
} from "../uploads/prompt.js";

interface InteractiveHarnessRuntime extends HarnessRuntime {
  forUser(
    identity: { tenantId: string; userId: string },
    expectedRoute?: CodexExpectedRoute,
  ): Promise<CodexUserRouteBridge>;
}

type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval";

interface PendingApproval {
  method: ApprovalMethod;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  actionDigest: string;
  expiresAt: number;
}

const APPROVAL_METHODS = new Set<ApprovalMethod>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const APPROVAL_TTL_MS = 30 * 60 * 1_000;
const MAX_PENDING_APPROVALS_PER_USER = 128;
/**
 * Ceiling on remembered attachment turns. Entries expire with the approval TTL
 * and are pruned on every write, so this only bounds a burst; it drops the
 * oldest, exactly as the pending-approval map does.
 */
const MAX_ATTACHMENT_TURNS = 512;
const MAX_SSE_QUEUE_BYTES = 1024 * 1024;
const MAX_BUFFERED_TURN_EVENTS = 256;

const textInputSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(100_000),
  })
  .strict();

const reviewTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommittedChanges") }).strict(),
  z
    .object({
      type: z.literal("baseBranch"),
      branch: z.string().trim().min(1).max(512).refine((value) => !value.includes("\0")),
    })
    .strict(),
  z
    .object({
      type: z.literal("commit"),
      sha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i),
      title: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("custom"),
      instructions: z.string().trim().min(1).max(20_000),
    })
    .strict(),
]);

const requestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("turn/start"),
      params: z
        .object({
          threadId: z.string().trim().min(1).max(256),
          input: z.array(textInputSchema).min(1).max(8),
          // Opaque server-generated upload ids and nothing else: never a path,
          // never a URL. `textInputSchema` stays closed for the same reason —
          // the app-server's `localImage` / `localAudio` / `mention` / `skill`
          // input variants each take a `PathBuf`, and `LocalImage` is read with
          // a bare `std::fs::read` with no sandbox and no allow-list. The
          // server resolves these ids against its own rows, stages the bytes
          // itself, and never lets a client name a file.
          attachments: z.array(z.string().uuid()).max(4).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/resume"),
      params: z.object({ threadId: z.string().trim().min(1).max(256) }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("review/start"),
      params: z
        .object({
          threadId: z.string().trim().min(1).max(256),
          target: reviewTargetSchema,
        })
        .strict(),
    })
    .strict(),
]);

const approvalSchema = z
  .object({
    requestId: z.union([z.string().min(1).max(256), z.number().finite()]),
    method: z.enum([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  })
  .strict();

const threadPathSchema = z.object({
  threadId: z.string().trim().min(1).max(256),
});

const createTaskSchema = z.object({ projectId: z.string().uuid() }).strict();

const threadNameSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();

const threadForkSchema = z
  .object({ lastTurnId: z.string().trim().min(1).max(256).nullable().optional() })
  .strict();

const turnPathSchema = z.object({
  threadId: z.string().trim().min(1).max(256),
  turnId: z.string().trim().min(1).max(256),
});

const turnSteerSchema = z
  .object({ input: z.array(textInputSchema).min(1).max(8) })
  .strict();

function interactive(runtime: HarnessRuntime): InteractiveHarnessRuntime {
  if (!("forUser" in runtime) || typeof runtime.forUser !== "function") {
    throw new ApiHttpError(
      503,
      "runtime_unavailable",
      "Interactive Codex runtime is not configured.",
    );
  }
  return runtime as InteractiveHarnessRuntime;
}

async function userBridge(
  runtime: HarnessRuntime,
  identity: { tenantId: string; userId: string },
  expectedRoute?: CodexExpectedRoute,
): Promise<CodexUserRouteBridge> {
  try {
    return await interactive(runtime).forUser(identity, expectedRoute);
  } catch (error) {
    if (error instanceof CodexAdapterConfigurationError) {
      throw new ApiHttpError(409, "provider_setup_required", error.message);
    }
    if (error instanceof CodexRuntimeError) {
      throw new ApiHttpError(503, "runtime_unavailable", "Codex runtime could not start.");
    }
    throw error;
  }
}

async function runtimeRequest<T extends JsonValue>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CodexRpcError) {
      throw new ApiHttpError(502, "codex_request_rejected", "Codex rejected the request.", {
        rpcCode: error.code,
      });
    }
    if (error instanceof CodexRuntimeError) {
      throw new ApiHttpError(503, "runtime_unavailable", "Codex runtime is unavailable.");
    }
    throw error;
  }
}

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredEventOrigins(config: HarnessConfig): Set<string> {
  const configured = [config.webOrigin, config.publicAppUrl]
    .map((value) => normalizedOrigin(value))
    .filter((value): value is string => value !== null);
  const origins = new Set(configured);
  if (process.env.NODE_ENV !== "production") {
    for (const value of configured) {
      const parsed = new URL(value);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) continue;
      for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
        origins.add(`${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}`);
      }
    }
  }
  return origins;
}

function approvalIdKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function userRuntimeKey(tenantId: string, userId: string): string {
  return `${tenantId}\0${userId}`;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function approvalIdentifier(params: JsonValue | undefined, key: string): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = params[key];
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function approvalActionDigest(method: ApprovalMethod, params: JsonValue | undefined): string {
  return createHash("sha256")
    .update(canonicalJson({ method, params: params ?? null }))
    .digest("hex");
}

function idempotencyKey(request: { headers: Record<string, unknown> }): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,255}$/.test(value)) {
    throw new ApiHttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 1 to 255 visible ASCII characters.",
    );
  }
  return value;
}

function admitted<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RunAdmissionError) {
      throw new ApiHttpError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedString(value: unknown, key: string): string | null {
  const candidate = objectValue(value)?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function nestedNumber(value: unknown, ...keys: string[]): number | null {
  const record = objectValue(value);
  if (!record) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

function leaseExpiry(): string {
  return new Date(Date.now() + USAGE_RESERVATION_LEASE_MS).toISOString();
}

/**
 * Refuses client input that mentions the server attachment envelope.
 *
 * The envelope is assembled from module constants *after* `requestSchema.parse`
 * and appended last, so a client can neither author nor reorder it — but client
 * text containing the marker could close it early and re-frame the files it
 * announced as trusted instructions. The check is on the whole input, not on
 * one item: both `turn/start` and `turn/steer` take up to eight text items and
 * the model sees them concatenated, so a per-item test is defeated by splitting
 * the marker across an item boundary. `inputMentionsAttachmentEnvelope` matches
 * each item *and* the joined text, after folding the compatibility and
 * invisible characters that would otherwise break a literal match.
 *
 * This runs on every `turn/start` and every `turn/steer`, attachment or not,
 * because in a multi-user tenant one member's upload is read inside whichever
 * member's session sends the turn.
 */
function assertNoEnvelopeForgery(input: ReadonlyArray<{ text: string }>): void {
  if (!inputMentionsAttachmentEnvelope(input.map((item) => item.text))) return;
  throw new ApiHttpError(
    400,
    "invalid_attachment_reference",
    "Turn input may not reference the server attachment envelope.",
  );
}

function attachmentTurnKey(
  tenantId: string,
  userId: string,
  threadId: string,
  turnId: string,
): string {
  return `${tenantId}\0${userId}\0${threadId}\0${turnId}`;
}

/**
 * The turn component used to arm the `acceptForSession` block before Codex has
 * assigned a turn id.
 *
 * It is derived from the run reservation, which is one-per-turn and already
 * unique, so two concurrent attachment turns on one thread arm and disarm
 * independently. A Codex turn id would have to be this exact string to collide,
 * and even then the collision could only ever *extend* a block, never lift one.
 */
function pendingAttachmentTurn(reservationId: string): string {
  return `pending:${reservationId}`;
}

/**
 * The directory key for one turn's staged plaintext.
 *
 * `decryptToStaged` and `unlinkStagedThread` hash whatever string they are
 * given into `staged/<sha256(...)>/`; the parameter is named `threadId`
 * upstream, but the value only has to be stable for the life of one turn and
 * unique across turns. It must be the *turn*, not the thread: nothing enforces
 * one live turn per thread — `activeRunLimit` is per tenant, and two
 * `turn/start` calls on one thread both succeed — so a thread-keyed directory
 * lets the second turn's cleanup delete the first turn's plaintext while the
 * first turn is still reading it, leaving its envelope pointing at an ENOENT
 * path. The run reservation id is one-per-turn, server-generated, and already
 * in hand before the first decrypt.
 */
export function attachmentStagingScope(threadId: string, reservationId: string): string {
  return `${threadId}\0${reservationId}`;
}

/**
 * A staging failure that names the upload it was about.
 *
 * The dispatch `catch` has to tell "these bytes are unusable" from "the runtime
 * was unavailable": only the first is terminal for the upload, and only the
 * first may retire the row.
 */
class AttachmentStagingError extends ApiHttpError {
  readonly uploadId: string;

  constructor(uploadId: string) {
    super(500, "upload_staging_failed", "An attachment could not be prepared for this turn.");
    this.name = "AttachmentStagingError";
    this.uploadId = uploadId;
  }
}

export function registerCodexRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig; runtime: HarnessRuntime },
): void {
  const { store, config, runtime } = input;
  const admissionPolicy = new RunAdmissionPolicy(store);
  const pendingApprovals = new Map<string, Map<string, PendingApproval>>();
  const mutationLedger = new TaskMutationLedger(store.db);
  /**
   * Turns that carried user-attached files, keyed tenant/user/thread/turn and
   * held for the same 30 minutes as a pending approval.
   *
   * Membership forbids `acceptForSession` on that turn. That is the one control
   * that stops a single injected command inside an untrusted file from becoming
   * standing authority for the rest of the session; `accept`, `decline` and
   * `cancel` are untouched, so the per-command approval gate still works
   * normally. Nothing is persisted, matching the in-memory, per-user,
   * single-use, 30-minute design of `pendingApprovals` above — and, like it,
   * this lives in the registrar closure rather than at module scope so two apps
   * built in one process never share a registry.
   */
  const attachmentTurns = new Map<string, number>();

  const idempotentMutation = async (
    identity: { tenantId: string; userId: string },
    key: string,
    descriptor: {
      action: string;
      targetId: string;
      fingerprintValue: JsonValue;
    },
    operation: () => Promise<JsonValue>,
  ): Promise<{ result: JsonValue }> => {
    const fingerprint = createHash("sha256")
      .update(canonicalJson(descriptor.fingerprintValue))
      .digest("hex");
    const reservation = mutationLedger.reserve({
      tenantId: identity.tenantId,
      userId: identity.userId,
      idempotencyKey: key,
      action: descriptor.action,
      targetId: descriptor.targetId,
      requestHash: fingerprint,
    });
    switch (reservation.state) {
      case "replayed":
        return { result: reservation.response };
      case "conflict":
        throw new ApiHttpError(
          409,
          "idempotency_conflict",
          "This Idempotency-Key was already used for a different task action.",
        );
      case "in_progress":
        throw new ApiHttpError(
          409,
          "request_in_progress",
          "This task action is already in progress.",
        );
      case "closed":
        throw new ApiHttpError(
          409,
          "idempotent_request_closed",
          "This task action can no longer be retried with the same Idempotency-Key.",
        );
      case "started":
        break;
    }
    try {
      const result = await operation();
      if (
        !mutationLedger.complete({
          id: reservation.id,
          tenantId: identity.tenantId,
          userId: identity.userId,
          response: result,
        })
      ) {
        throw new ApiHttpError(
          500,
          "mutation_record_failed",
          "The task action completed but its durable receipt could not be recorded.",
        );
      }
      return { result };
    } catch (error) {
      mutationLedger.fail({
        id: reservation.id,
        tenantId: identity.tenantId,
        userId: identity.userId,
        errorCode: error instanceof ApiHttpError ? error.code : "mutation_failed",
      });
      throw error;
    }
  };

  const pruneApprovals = (userKey: string, approvals: Map<string, PendingApproval>) => {
    const now = Date.now();
    for (const [id, approval] of approvals) {
      if (approval.expiresAt <= now) approvals.delete(id);
    }
    if (approvals.size === 0) pendingApprovals.delete(userKey);
  };

  const rememberApproval = (
    tenantId: string,
    userId: string,
    requestId: string | number,
    approval: PendingApproval,
  ) => {
    const userKey = userRuntimeKey(tenantId, userId);
    const approvals = pendingApprovals.get(userKey) ?? new Map<string, PendingApproval>();
    pruneApprovals(userKey, approvals);
    if (approvals.size >= MAX_PENDING_APPROVALS_PER_USER) {
      const oldestId = approvals.keys().next().value as string | undefined;
      if (oldestId) approvals.delete(oldestId);
    }
    approvals.set(approvalIdKey(requestId), approval);
    pendingApprovals.set(userKey, approvals);
  };

  const pendingApproval = (
    tenantId: string,
    userId: string,
    requestId: string | number,
  ): PendingApproval | null => {
    const userKey = userRuntimeKey(tenantId, userId);
    const approvals = pendingApprovals.get(userKey);
    if (!approvals) return null;
    pruneApprovals(userKey, approvals);
    return approvals.get(approvalIdKey(requestId)) ?? null;
  };

  const forgetApproval = (tenantId: string, userId: string, requestId: string | number) => {
    const userKey = userRuntimeKey(tenantId, userId);
    const approvals = pendingApprovals.get(userKey);
    if (!approvals) return;
    approvals.delete(approvalIdKey(requestId));
    if (approvals.size === 0) pendingApprovals.delete(userKey);
  };

  const pruneAttachmentTurns = () => {
    const now = Date.now();
    for (const [key, expiresAt] of attachmentTurns) {
      if (expiresAt <= now) attachmentTurns.delete(key);
    }
  };

  const rememberAttachmentTurn = (
    tenantId: string,
    userId: string,
    threadId: string,
    turnId: string,
  ) => {
    pruneAttachmentTurns();
    if (attachmentTurns.size >= MAX_ATTACHMENT_TURNS) {
      const oldestKey = attachmentTurns.keys().next().value as string | undefined;
      if (oldestKey) attachmentTurns.delete(oldestKey);
    }
    attachmentTurns.set(
      attachmentTurnKey(tenantId, userId, threadId, turnId),
      Date.now() + APPROVAL_TTL_MS,
    );
  };

  const forgetAttachmentTurn = (
    tenantId: string,
    userId: string,
    threadId: string,
    turnId: string,
  ) => {
    attachmentTurns.delete(attachmentTurnKey(tenantId, userId, threadId, turnId));
  };

  /**
   * Whether this thread still holds a file the agent has been handed.
   *
   * The in-memory registry above only covers a turn that is still running, but
   * an attached file's content stays in the thread's rollout — and therefore in
   * the model's context — on every later turn. Session-wide approval must not
   * become available again one turn after the injected text was read, so the
   * block lasts as long as the durable row does: from the claim (`attached`)
   * through the turn that read it (`extracted`), until the user deletes the
   * upload or its retention expires. A `stored` row bound to the thread but
   * never attached to a turn does not count — nothing has read it.
   */
  const threadHoldsAttachment = (
    tenantId: string,
    userId: string,
    threadId: string,
  ): boolean =>
    store
      .listThreadUploads(tenantId, userId, threadId)
      .some((upload) => upload.status === "attached" || upload.status === "extracted");

  /**
   * Whether `acceptForSession` is refused for the thread an approval belongs to.
   *
   * Four ways to match, each failing closed:
   *
   * - the thread has a durable attached/extracted upload (the content is in its
   *   context for the rest of the thread's life);
   * - any live attachment turn on that thread, including one armed before Codex
   *   assigned its turn id — approvals arrive as independent `server-request`
   *   frames and can be raised *and* resolved before `turn/start` returns, so
   *   an exact turn match would be empty during precisely the window an
   *   injected command asks for authority in;
   * - an approval with no thread id while any of this user's threads has a
   *   durable attached/extracted upload (the runtime omitted the only safe
   *   correlation key, so a narrower decision is impossible);
   * - for an approval that does not name its thread, any live attachment turn
   *   for that user.
   *
   * The approval's own `turnId` is deliberately not part of the test: it is
   * unknown during the dispatch window, and a thread whose context already
   * holds an attached file is contaminated for every turn on it, not just the
   * one that staged the bytes.
   *
   * Per-command `accept` remains available in every case.
   */
  const sessionApprovalBlocked = (
    tenantId: string,
    userId: string,
    threadId: string | null,
  ): boolean => {
    const durableAttachmentHeld =
      threadId === null
        ? store.userHasDurableThreadAttachments(tenantId, userId)
        : threadHoldsAttachment(tenantId, userId, threadId);
    if (durableAttachmentHeld) return true;
    pruneAttachmentTurns();
    if (attachmentTurns.size === 0) return false;
    const prefix =
      threadId === null
        ? `${tenantId}\0${userId}\0`
        : `${tenantId}\0${userId}\0${threadId}\0`;
    for (const key of attachmentTurns.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  };

  type TurnAttachmentClaim = {
    tenantId: string;
    userId: string;
    threadId: string;
    workspacePath: string;
    attachmentIds: readonly string[];
  };

  const attachmentClaimInput = (claim: TurnAttachmentClaim) => {
    if (new Set(claim.attachmentIds).size !== claim.attachmentIds.length) {
      throw new ApiHttpError(
        400,
        "invalid_attachment_reference",
        "Each attachment may be referenced only once per turn.",
      );
    }
    return {
      tenantId: claim.tenantId,
      userId: claim.userId,
      uploadIds: claim.attachmentIds,
      threadId: claim.threadId,
      workspacePath: claim.workspacePath,
    };
  };

  const resolveAttachmentClaim = (outcome: UploadBatchClaimResult): UploadRecord[] => {
    switch (outcome.outcome) {
      case "claimed":
        return outcome.uploads;
      case "already_bound":
        throw new ApiHttpError(
          409,
          "upload_already_bound",
          "This attachment is already bound to a different task.",
        );
      case "workspace_conflict":
        throw new ApiHttpError(
          409,
          "upload_workspace_conflict",
          "This attachment belongs to a different workspace than the task.",
        );
      // A `reserving` row is an upload that does not exist yet; a `failed` or
      // `deleted` one no longer exists. Neither is attachable, and neither is
      // worth distinguishing from an unknown id to the caller.
      case "not_claimable":
      case "not_found":
        throw new ApiHttpError(404, "upload_not_found", "Attachment not found.");
    }
  };

  /** Read-only preflight: bad ids must not consume a run reservation. */
  const inspectTurnAttachments = (claim: TurnAttachmentClaim): void => {
    resolveAttachmentClaim(store.inspectUploadsForThread(attachmentClaimInput(claim)));
  };

  /**
   * Claims the complete set in one store transaction after admission succeeds.
   * The store rechecks every row, closing the preflight/admission TOCTOU gap.
   */
  const claimTurnAttachments = (claim: TurnAttachmentClaim): UploadRecord[] => {
    return resolveAttachmentClaim(store.claimUploadsForThread(attachmentClaimInput(claim)));
  };

  /**
   * Decrypts each claimed upload into this turn's staged plaintext.
   *
   * `decryptToStaged` writes to a scratch file and verifies the GCM tag at
   * `final()` before the staged name exists, so a tampered or truncated blob
   * fails with no path for anything to read. The staged file is `0400` under
   * `staged/<sha256(threadId)>/`, and its extension comes from the server's own
   * classification, never from the client's label.
   *
   * Sequential by design: at most four files, and a failure part-way through
   * leaves nothing racing behind it for `stopWatching` to clean up.
   */
  const stageAttachments = async (staging: {
    paths: UserUploadPaths;
    stagingScope: string;
    uploads: readonly UploadRecord[];
  }): Promise<StagedAttachment[]> => {
    const staged: StagedAttachment[] = [];
    for (const upload of staging.uploads) {
      const summary = uploadSummary(upload);
      let file: StagedFile;
      try {
        file = await decryptToStaged({
          paths: staging.paths,
          uploadId: upload.id,
          threadId: staging.stagingScope,
          contentType: upload.contentType,
          storageKey: upload.storageKey,
          encryptionSecret: config.credentialEncryptionKey,
          encryptionIv: upload.encryptionIv,
          encryptionTag: upload.encryptionTag,
          wrappedDataKey: upload.wrappedDataKey,
        });
      } catch (error) {
        app.log.warn(
          { uploadId: upload.id, reason: uploadErrorReason(error) },
          "an attachment could not be staged for a turn",
        );
        throw new AttachmentStagingError(upload.id);
      }
      // The GCM tag already proves the ciphertext was not modified. This catches
      // the other half: a row paired with the wrong blob, which only a partial
      // restore can produce, and which would otherwise hand the agent a file the
      // envelope mislabels.
      if (file.contentSha256 !== upload.contentSha256) {
        app.log.warn(
          { uploadId: upload.id, reason: "digest_mismatch" },
          "a staged attachment did not match its recorded digest",
        );
        throw new AttachmentStagingError(upload.id);
      }
      staged.push({
        label: summary.filename,
        contentType: summary.contentType,
        sizeBytes: upload.sizeBytes,
        path: file.path,
      });
    }
    return staged;
  };

  const authorizedThreadBridge = async (identity: {
    tenantId: string;
    userId: string;
    threadId: string;
  }): Promise<{ bridge: CodexUserRouteBridge; workspacePath: string }> => {
    const existing = store.getThreadWorkspaceBinding(
      identity.tenantId,
      identity.userId,
      identity.threadId,
    );
    if (existing) {
      let canonicalWorkspace: string;
      try {
        canonicalWorkspace = await resolveAllowedWorkspacePath(
          existing.workspacePath,
          config.allowedWorkspaceRoots,
        );
      } catch {
        throw new ApiHttpError(
          403,
          "workspace_not_allowed",
          "The thread workspace is outside the server allow-list.",
        );
      }
      if (canonicalWorkspace !== existing.workspacePath) {
        throw new ApiHttpError(
          409,
          "thread_workspace_conflict",
          "The thread workspace no longer resolves to its trusted canonical path.",
        );
      }
      const workspacePath = admitted(() =>
        admissionPolicy.authorizeThreadAccess(identity),
      );
      return {
        bridge: await userBridge(runtime, identity),
        workspacePath,
      };
    }

    const bridge = await userBridge(runtime, identity);
    const readResult = await runtimeRequest(() =>
      bridge.request<JsonValue>("thread/read", {
        threadId: identity.threadId,
        includeTurns: false,
      }),
    );
    const readRecord = objectValue(readResult);
    const thread = objectValue(readRecord?.thread);
    if (nestedString(thread, "id") !== identity.threadId) {
      throw new ApiHttpError(
        409,
        "thread_workspace_unbound",
        "Codex did not return the requested legacy thread.",
      );
    }
    const runtimeWorkspace = nestedString(thread, "cwd");
    if (!runtimeWorkspace) {
      throw new ApiHttpError(
        409,
        "thread_workspace_unbound",
        "The legacy thread does not expose a workspace to bind.",
      );
    }
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await resolveAllowedWorkspacePath(
        runtimeWorkspace,
        config.allowedWorkspaceRoots,
      );
    } catch {
      throw new ApiHttpError(
        403,
        "workspace_not_allowed",
        "The legacy thread workspace is outside the server allow-list.",
      );
    }
    admitted(() =>
      admissionPolicy.authorizeWorkspaceAccess({
        tenantId: identity.tenantId,
        userId: identity.userId,
        workspacePath: canonicalWorkspace,
      }),
    );
    try {
      store.bindThreadWorkspace({
        tenantId: identity.tenantId,
        userId: identity.userId,
        threadId: identity.threadId,
        workspacePath: canonicalWorkspace,
      });
    } catch {
      throw new ApiHttpError(
        409,
        "thread_workspace_conflict",
        "The legacy thread conflicts with an existing workspace binding.",
      );
    }
    return {
      bridge,
      workspacePath: admitted(() => admissionPolicy.authorizeThreadAccess(identity)),
    };
  };

  const startThreadAtWorkspace = async (input: {
    tenantId: string;
    userId: string;
    workspacePath: string;
    idempotencyKey: string;
    requestPayload: JsonValue;
    projectId: string;
    workspaceId: string;
  }): Promise<{ result: JsonValue; replayed?: true }> => {
    const admission = admitted(() =>
      admissionPolicy.admit({
        tenantId: input.tenantId,
        userId: input.userId,
        operation: "thread_start",
        workspacePath: input.workspacePath,
        requestedModel: null,
        idempotencyKey: input.idempotencyKey,
        requestPayload: input.requestPayload,
      }),
    );
    if (admission.replayed && admission.replayResult !== null) {
      return { result: admission.replayResult, replayed: true };
    }

    try {
      const bridge = await userBridge(runtime, {
        tenantId: input.tenantId,
        userId: input.userId,
      }, {
        providerId: admission.provider.id,
        model: admission.model,
      });
      const result = await runtimeRequest(() =>
        bridge.startThread(input.workspacePath, { model: admission.model }),
      );
      const resultRecord = objectValue(result);
      const resultThread = objectValue(resultRecord?.thread);
      const threadId = nestedString(resultThread, "id") ?? nestedString(resultRecord, "id");
      const returnedWorkspace = nestedString(resultRecord, "cwd");
      const returnedModel = nestedString(resultRecord, "model");
      if (!threadId || !returnedWorkspace || !returnedModel) {
        throw new ApiHttpError(
          502,
          "codex_response_invalid",
          "Codex started a task without returning its identifier, workspace, and model.",
        );
      }
      let canonicalReturnedWorkspace: string;
      try {
        canonicalReturnedWorkspace = await resolveAllowedWorkspacePath(
          returnedWorkspace,
          config.allowedWorkspaceRoots,
        );
      } catch {
        throw new ApiHttpError(
          403,
          "workspace_not_allowed",
          "Codex returned a task workspace outside the server allow-list.",
        );
      }
      if (canonicalReturnedWorkspace !== input.workspacePath) {
        throw new ApiHttpError(
          409,
          "thread_workspace_conflict",
          "Codex did not start the task in its authorized saved project.",
        );
      }
      if (returnedModel !== admission.model) {
        throw new ApiHttpError(
          409,
          "model_route_changed",
          "Codex did not start the task with its admitted model route.",
        );
      }
      const committed = store.commitThreadStart({
        reservationId: admission.reservationId,
        tenantId: input.tenantId,
        userId: input.userId,
        threadId,
        workspacePath: input.workspacePath,
        response: result,
        usageMetadata: {
          threadId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          routeId: admission.provider.id,
          model: admission.model,
        },
        auditMetadata: { projectId: input.projectId, workspaceId: input.workspaceId },
      });
      if (!committed) {
        throw new ApiHttpError(
          409,
          "run_reservation_closed",
          "The run reservation closed before the task could be durably recorded.",
        );
      }
      return { result };
    } catch (error) {
      store.failUsageReservation(admission.reservationId, input.tenantId, "dispatch_failed");
      throw error;
    }
  };

  app.post("/api/tasks", async (request) => {
    const user = requireUser(request, store);
    const { projectId } = createTaskSchema.parse(request.body);
    const project = store.getSavedProject(user.tenantId, projectId);
    if (!project) {
      throw new ApiHttpError(404, "project_not_found", "Saved project not found.");
    }
    if (!project.enabled) {
      throw new ApiHttpError(
        409,
        "project_disabled",
        "This saved project is disabled for new tasks.",
      );
    }
    if (
      !project.workspaceGrantId ||
      !store.workspaceGrantAllowsPath(
        user.tenantId,
        project.workspaceGrantId,
        project.workspacePath,
      )
    ) {
      throw new ApiHttpError(
        403,
        "workspace_grant_revoked",
        "This saved project's workspace grant is no longer active.",
      );
    }

    let workspacePath: string;
    try {
      workspacePath = await resolveAllowedWorkspacePath(
        project.workspacePath,
        config.allowedWorkspaceRoots,
      );
    } catch {
      throw new ApiHttpError(
        409,
        "project_workspace_unavailable",
        "This saved project's workspace is unavailable on the server.",
      );
    }
    if (workspacePath !== project.workspacePath) {
      throw new ApiHttpError(
        409,
        "project_workspace_changed",
        "This saved project's workspace no longer resolves to its registered path.",
      );
    }

    return startThreadAtWorkspace({
      tenantId: user.tenantId,
      userId: user.id,
      workspacePath,
      idempotencyKey: idempotencyKey(request),
      requestPayload: {
        method: "task/create",
        projectId: project.id,
        workspaceId: project.workspaceId,
      },
      projectId: project.id,
      workspaceId: project.workspaceId,
    });
  });

  app.get("/api/codex/threads/:threadId", async (request) => {
    const user = requireUser(request, store);
    const { threadId } = threadPathSchema.parse(request.params);
    if (typeof runtime.threadSnapshot !== "function") {
      throw new ApiHttpError(
        503,
        "runtime_unavailable",
        "Task history is not available from the configured runtime.",
      );
    }
    try {
      const snapshot = await runtime.threadSnapshot({
        tenantId: user.tenantId,
        userId: user.id,
        threadId,
      });
      if (!snapshot) {
        throw new ApiHttpError(404, "thread_not_found", "Task history was not found.");
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      if (error instanceof CodexAdapterConfigurationError) {
        throw new ApiHttpError(409, "provider_setup_required", error.message);
      }
      if (error instanceof CodexRpcError) {
        throw new ApiHttpError(502, "codex_request_rejected", "Codex rejected the history request.", {
          rpcCode: error.code,
        });
      }
      if (error instanceof CodexRuntimeError) {
        throw new ApiHttpError(503, "runtime_unavailable", "Codex runtime is unavailable.");
      }
      throw error;
    }
  });

  app.post("/api/codex/request", async (request) => {
    const user = requireUser(request, store);
    const body = requestSchema.parse(request.body);
    if (body.method === "turn/start") assertNoEnvelopeForgery(body.params.input);

    if (body.method === "turn/start" || body.method === "review/start") {
      const { workspacePath } = await authorizedThreadBridge({
        tenantId: user.tenantId,
        userId: user.id,
        threadId: body.params.threadId,
      });
      const attachmentClaim = {
        tenantId: user.tenantId,
        userId: user.id,
        threadId: body.params.threadId,
        workspacePath,
        attachmentIds: body.method === "turn/start" ? body.params.attachments ?? [] : [],
      } satisfies TurnAttachmentClaim;
      // This phase is intentionally read-only. It keeps unknown and foreign ids
      // from consuming admission quota without binding any valid sibling ids.
      inspectTurnAttachments(attachmentClaim);
      const admission = admitted(() =>
        admissionPolicy.admit({
          tenantId: user.tenantId,
          userId: user.id,
          operation: "turn_start",
          threadId: body.params.threadId,
          idempotencyKey: idempotencyKey(request),
          requestPayload: { method: body.method, params: body.params },
        }),
      );
      if (admission.replayed && admission.replayResult !== null) {
        return { result: admission.replayResult, replayed: true };
      }
      let bridge: CodexUserRouteBridge;
      try {
        bridge = await userBridge(
          runtime,
          { tenantId: user.tenantId, userId: user.id },
          { providerId: admission.provider.id, model: admission.model },
        );
      } catch (error) {
        store.failUsageReservation(admission.reservationId, user.tenantId, "dispatch_failed");
        throw error;
      }
      let claimedAttachments: UploadRecord[];
      try {
        // Repeat every check and bind the full set atomically after admission.
        // If state changed since preflight, the fresh reservation is failed and
        // the store rolls every attachment claim back together.
        claimedAttachments = claimTurnAttachments(attachmentClaim);
      } catch (error) {
        store.failUsageReservation(
          admission.reservationId,
          user.tenantId,
          "attachment_claim_failed",
        );
        throw error;
      }
      // One reservation is one turn, so it names both of this turn's
      // turn-scoped resources: its staged plaintext directory, and the
      // `acceptForSession` arm that has to exist before Codex assigns a turn id.
      const stagingScope = attachmentStagingScope(
        body.params.threadId,
        admission.reservationId,
      );
      const pendingTurn = pendingAttachmentTurn(admission.reservationId);
      if (claimedAttachments.length > 0) {
        // Armed *before* dispatch, not after. Approvals do not travel on the
        // `turn/start` RPC: they arrive as independent `server-request` frames
        // and register in `pendingApprovals` the instant Codex raises one,
        // which can be both raised and resolved before `turn/start` returns. An
        // arm that waited for the turn id would be empty for exactly the window
        // an injected command spends asking for standing authority.
        rememberAttachmentTurn(user.tenantId, user.id, body.params.threadId, pendingTurn);
      }

      let unsubscribe: () => void = () => undefined;
      let watchTimeout: NodeJS.Timeout | null = null;
      let expectedTurnId: string | null = null;
      let settled = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let stagedPaths: UserUploadPaths | null = null;
      const bufferedEvents: Array<{
        sequence: number;
        method: string;
        params?: JsonValue;
        turnId: string;
      }> = [];

      const stopWatching = () => {
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = null;
        unsubscribe();
        const paths = stagedPaths;
        stagedPaths = null;
        if (!paths) return;
        // Staged plaintext lives for exactly one turn, and the Codex child
        // cannot write, so it can never clean up after itself. This is the one
        // function already called on settle, on lease expiry, and in the
        // dispatch catch, so it is the only place that covers every exit.
        //
        // The directory it clears is this *turn's* (`stagingScope`), never the
        // thread's: two `turn/start` calls on one thread both succeed whenever
        // the tenant's active-run limit allows, and a thread-wide `rm -r` would
        // delete a concurrent turn's plaintext out from under it while its
        // envelope still points at the path. A predecessor's orphaned directory
        // is the boot sweep's and the janitor's business instead.
        void unlinkStagedThread(paths, stagingScope).catch((error: unknown) => {
          app.log.warn(
            { reason: uploadErrorReason(error) },
            "staged attachment plaintext could not be removed",
          );
        });
      };
      const scheduleLeaseTimeout = () => {
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(() => {
          if (!settled) {
            store.failUsageReservation(
              admission.reservationId,
              user.tenantId,
              "lease_expired",
            );
          }
          stopWatching();
        }, USAGE_RESERVATION_LEASE_MS);
        watchTimeout.unref();
      };
      const renewLease = (turnId: string): boolean => {
        const renewed = store.renewUsageReservation({
          reservationId: admission.reservationId,
          tenantId: user.tenantId,
          expiresAt: leaseExpiry(),
          threadId: body.params.threadId,
          turnId,
        });
        if (renewed) scheduleLeaseTimeout();
        return renewed;
      };
      const processEvent = (event: {
        sequence: number;
        method: string;
        params?: JsonValue;
        turnId: string;
      }) => {
        if (settled || event.turnId !== expectedTurnId) return;
        if (!renewLease(event.turnId)) {
          settled = true;
          stopWatching();
          return;
        }
        const params = objectValue(event.params);
        if (event.method === "thread/tokenUsage/updated") {
          const tokenUsage = objectValue(params?.tokenUsage);
          const last = objectValue(tokenUsage?.last);
          inputTokens += nestedNumber(last, "inputTokens", "input_tokens") ?? 0;
          outputTokens += nestedNumber(last, "outputTokens", "output_tokens") ?? 0;
          return;
        }
        if (event.method !== "turn/completed") return;

        const turn = objectValue(params?.turn);
        settled = store.completeUsageReservation({
          reservationId: admission.reservationId,
          tenantId: user.tenantId,
          eventKey: `turn-completed:${event.turnId}`,
          eventType: "turn_completed",
          expectedThreadId: body.params.threadId,
          expectedTurnId: event.turnId,
          inputTokens,
          outputTokens,
          metadata: {
            threadId: body.params.threadId,
            turnId: event.turnId,
            status: nestedString(turn, "status"),
            routeId: admission.provider.id,
            model: admission.model,
          },
        });
        // The turn that carried these attachments is over: the agent has had
        // its one turn with the plaintext. The UPDATE only matches a `stored`
        // or `attached` row, so a repeated completion is a no-op.
        for (const upload of claimedAttachments) {
          store.markUploadExtracted({
            tenantId: user.tenantId,
            userId: user.id,
            uploadId: upload.id,
            threadId: body.params.threadId,
            turnId: event.turnId,
          });
        }
        if (settled) {
          forgetAttachmentTurn(user.tenantId, user.id, body.params.threadId, event.turnId);
          stopWatching();
        }
      };

      try {
        unsubscribe = bridge.subscribe((event) => {
          const params = objectValue(event.params);
          const turn = objectValue(params?.turn);
          const eventThreadId = nestedString(params, "threadId");
          if (eventThreadId !== body.params.threadId) return;
          const turnId = nestedString(params, "turnId") ?? nestedString(turn, "id");
          if (!turnId) return;
          const correlated = {
            sequence: event.sequence,
            method: event.method,
            ...(event.params === undefined ? {} : { params: event.params }),
            turnId,
          };
          if (expectedTurnId === null) {
            if (bufferedEvents.length >= MAX_BUFFERED_TURN_EVENTS) bufferedEvents.shift();
            bufferedEvents.push(correlated);
            return;
          }
          processEvent(correlated);
        });
        scheduleLeaseTimeout();

        let runtimeParams: JsonValue;
        if (body.method === "review/start") {
          runtimeParams = { ...body.params, delivery: "inline" };
        } else {
          const turnInput: JsonValue[] = [...body.params.input];
          if (claimedAttachments.length > 0) {
            const paths = await prepareUserUploadPaths(config.uploadDataDir, {
              tenantId: user.tenantId,
              userId: user.id,
            });
            // Recorded before the first decrypt so a run that fails part-way is
            // still reclaimed by `stopWatching` in the catch below.
            stagedPaths = paths;
            // Appended last, so the standing rules sit closest to generation and
            // precede every read the agent performs against a staged file.
            turnInput.push({
              type: "text",
              text: renderAttachmentEnvelope(
                await stageAttachments({
                  paths,
                  stagingScope,
                  uploads: claimedAttachments,
                }),
              ),
            });
          }
          // `attachments` is a control-plane field, not an app-server one. The
          // dispatched params are rebuilt from fields `turn/start` defines, so
          // the id list cannot survive into the runtime. A file-bearing turn is
          // pinned to server-owned, sticky app-server policy: it cannot write or
          // use the network, and any attempted escalation needs an approval.
          // The public schema intentionally exposes none of these override
          // fields, so a client cannot weaken them.
          runtimeParams = {
            threadId: body.params.threadId,
            input: turnInput,
            ...(claimedAttachments.length > 0
              ? {
                  approvalPolicy: "on-request",
                  sandboxPolicy: { type: "readOnly", networkAccess: false },
                }
              : {}),
          };
        }
        const result = await runtimeRequest(() => bridge.request(body.method, runtimeParams));
        const resultRecord = objectValue(result);
        const turn = objectValue(resultRecord?.turn);
        const turnId = nestedString(turn, "id") ?? nestedString(resultRecord, "id");
        if (!turnId) {
          throw new ApiHttpError(
            502,
            "codex_response_invalid",
            "Codex started a turn without returning its identifier.",
          );
        }
        if (
          body.method === "review/start"
          && nestedString(resultRecord, "reviewThreadId") !== body.params.threadId
        ) {
          throw new ApiHttpError(
            502,
            "codex_response_invalid",
            "Codex did not keep the inline review on its authorized task.",
          );
        }
        const recorded = store.recordUsageReservationResponse({
          reservationId: admission.reservationId,
          tenantId: user.tenantId,
          response: result,
          completesReservation: false,
          threadId: body.params.threadId,
          turnId,
        });
        if (!recorded || !renewLease(turnId)) {
          throw new ApiHttpError(
            409,
            "run_reservation_closed",
            "The run reservation closed before Codex returned the turn.",
          );
        }
        expectedTurnId = turnId;
        if (claimedAttachments.length > 0) {
          // Narrow the pre-dispatch arm onto the turn Codex just named, so the
          // block is pruned by the same settle path that prunes everything else
          // about this turn. `acceptForSession` has been refused since before
          // dispatch and stays refused: one injected command inside an
          // untrusted file must not become standing authority for the session.
          rememberAttachmentTurn(user.tenantId, user.id, body.params.threadId, turnId);
          forgetAttachmentTurn(user.tenantId, user.id, body.params.threadId, pendingTurn);
        }
        const matching = bufferedEvents.filter((event) => event.turnId === turnId);
        bufferedEvents.length = 0;
        // Usage is emitted independently from completion. Apply every `last`
        // breakdown before settling a completion that raced the start response.
        for (const event of matching) {
          if (event.method === "thread/tokenUsage/updated") processEvent(event);
        }
        for (const event of matching) {
          if (event.method !== "thread/tokenUsage/updated") processEvent(event);
        }
        if (body.method === "review/start") {
          store.audit({
            tenantId: user.tenantId,
            userId: user.id,
            action: "codex.review_started",
            targetType: "thread",
            targetId: body.params.threadId,
            metadata: { targetType: body.params.target.type, delivery: "inline", turnId },
          });
        }
        return { result };
      } catch (error) {
        stopWatching();
        store.failUsageReservation(admission.reservationId, user.tenantId, "dispatch_failed");
        // Never leave a thread armed by a dispatch that threw: the turn is over,
        // and a block nothing can clear would cost the user `acceptForSession`
        // on that thread for the whole approval TTL. What the *rows* say is a
        // separate question, answered below and independently.
        forgetAttachmentTurn(user.tenantId, user.id, body.params.threadId, pendingTurn);
        if (expectedTurnId !== null) {
          forgetAttachmentTurn(user.tenantId, user.id, body.params.threadId, expectedTurnId);
        }
        // Retire an upload only when the failure was *about that upload*: its
        // ciphertext failed its authentication tag, or its row and its blob
        // disagree. Those bytes will never stage, so the row is terminal and
        // the janitor's orphan sweep reclaims the file on its next pass.
        //
        // Every other dispatch failure — `runtime_unavailable`,
        // `codex_request_rejected`, a closed reservation, a bare throw — says
        // nothing about the file. Failing the upload there would make one
        // transient 503 destroy the user's document: a `failed` row is neither
        // claimable nor visible, so the file silently disappears and has to be
        // re-uploaded, while its blob stops counting toward tenant storage
        // quota. The claim is therefore left exactly as it is — `attached`,
        // still listed, still metered, still attachable — so the natural retry
        // re-uses it.
        if (error instanceof AttachmentStagingError) {
          store.failUpload({
            tenantId: user.tenantId,
            userId: user.id,
            uploadId: error.uploadId,
            errorCode: error.code,
          });
        }
        throw error;
      }
    }

    const { bridge } = await authorizedThreadBridge({
      tenantId: user.tenantId,
      userId: user.id,
      threadId: body.params.threadId,
    });
    admitted(() =>
      admissionPolicy.authorizeThreadAccess({
        tenantId: user.tenantId,
        userId: user.id,
        threadId: body.params.threadId,
      }),
    );
    const result = await runtimeRequest(() => bridge.request(body.method, body.params));
    return { result };
  });

  const assertActiveTurn = async (
    bridge: CodexUserRouteBridge,
    threadId: string,
    turnId: string,
  ): Promise<void> => {
    const readResult = await runtimeRequest(() =>
      bridge.request<JsonValue>("thread/read", { threadId, includeTurns: true }),
    );
    const thread = objectValue(objectValue(readResult)?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const active = turns.some((candidate) => {
      const turn = objectValue(candidate);
      return nestedString(turn, "id") === turnId && nestedString(turn, "status") === "inProgress";
    });
    if (!active) {
      throw new ApiHttpError(
        409,
        "active_turn_mismatch",
        "The requested turn is no longer the active turn for this task.",
      );
    }
  };

  app.patch("/api/tasks/:threadId/name", async (request) => {
    const user = requireUser(request, store);
    const { threadId } = threadPathSchema.parse(request.params);
    const { name } = threadNameSchema.parse(request.body);
    const key = idempotencyKey(request);
    return idempotentMutation(
      { tenantId: user.tenantId, userId: user.id },
      key,
      {
        action: "rename",
        targetId: threadId,
        fingerprintValue: { action: "rename", threadId, name },
      },
      async () => {
        const { bridge } = await authorizedThreadBridge({
          tenantId: user.tenantId,
          userId: user.id,
          threadId,
        });
        const result = await runtimeRequest(() =>
          bridge.request<JsonValue>("thread/name/set", { threadId, name }),
        );
        store.audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: "codex.thread_renamed",
          targetType: "thread",
          targetId: threadId,
          metadata: { nameLength: name.length },
        });
        return result;
      },
    );
  });

  app.post("/api/tasks/:threadId/actions/fork", async (request) => {
    const user = requireUser(request, store);
    const { threadId } = threadPathSchema.parse(request.params);
    const body = threadForkSchema.parse(request.body ?? {});
    const key = idempotencyKey(request);
    return idempotentMutation(
      { tenantId: user.tenantId, userId: user.id },
      key,
      {
        action: "fork",
        targetId: threadId,
        fingerprintValue: { action: "fork", threadId, lastTurnId: body.lastTurnId ?? null },
      },
      async () => {
        const { bridge, workspacePath } = await authorizedThreadBridge({
          tenantId: user.tenantId,
          userId: user.id,
          threadId,
        });
        const result = await runtimeRequest(() =>
          bridge.request<JsonValue>("thread/fork", {
            threadId,
            lastTurnId: body.lastTurnId ?? null,
            excludeTurns: true,
          }),
        );
        const resultRecord = objectValue(result);
        const forkedThread = objectValue(resultRecord?.thread);
        const forkedThreadId = nestedString(forkedThread, "id");
        const returnedWorkspace = nestedString(resultRecord, "cwd") ?? nestedString(forkedThread, "cwd");
        if (!forkedThreadId || !returnedWorkspace) {
          throw new ApiHttpError(
            502,
            "codex_response_invalid",
            "Codex forked the task without returning a verifiable task and workspace.",
          );
        }
        let canonicalReturnedWorkspace: string;
        try {
          canonicalReturnedWorkspace = await resolveAllowedWorkspacePath(
            returnedWorkspace,
            config.allowedWorkspaceRoots,
          );
        } catch {
          throw new ApiHttpError(
            403,
            "workspace_not_allowed",
            "The forked task workspace is outside the server allow-list.",
          );
        }
        if (canonicalReturnedWorkspace !== workspacePath) {
          throw new ApiHttpError(
            409,
            "fork_workspace_conflict",
            "The forked task did not inherit the authorized source workspace.",
          );
        }
        store.bindThreadWorkspace({
          tenantId: user.tenantId,
          userId: user.id,
          threadId: forkedThreadId,
          workspacePath,
        });
        store.audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: "codex.thread_forked",
          targetType: "thread",
          targetId: forkedThreadId,
          metadata: { sourceThreadId: threadId, lastTurnId: body.lastTurnId ?? null },
        });
        return result;
      },
    );
  });

  const archiveAction = (
    route: "archive" | "unarchive",
    method: "thread/archive" | "thread/unarchive",
  ) => {
    app.post(`/api/tasks/:threadId/actions/${route}`, async (request) => {
      const user = requireUser(request, store);
      const { threadId } = threadPathSchema.parse(request.params);
      const key = idempotencyKey(request);
      return idempotentMutation(
        { tenantId: user.tenantId, userId: user.id },
        key,
        {
          action: route,
          targetId: threadId,
          fingerprintValue: { action: route, threadId },
        },
        async () => {
          const { bridge } = await authorizedThreadBridge({
            tenantId: user.tenantId,
            userId: user.id,
            threadId,
          });
          const result = await runtimeRequest(() =>
            bridge.request<JsonValue>(method, { threadId }),
          );
          store.audit({
            tenantId: user.tenantId,
            userId: user.id,
            action: `codex.thread_${route === "archive" ? "archived" : "unarchived"}`,
            targetType: "thread",
            targetId: threadId,
            metadata: {},
          });
          return result;
        },
      );
    });
  };
  archiveAction("archive", "thread/archive");
  archiveAction("unarchive", "thread/unarchive");

  app.post("/api/tasks/:threadId/turns/:turnId/actions/interrupt", async (request) => {
    const user = requireUser(request, store);
    const { threadId, turnId } = turnPathSchema.parse(request.params);
    const key = idempotencyKey(request);
    return idempotentMutation(
      { tenantId: user.tenantId, userId: user.id },
      key,
      {
        action: "interrupt",
        targetId: turnId,
        fingerprintValue: { action: "interrupt", threadId, turnId },
      },
      async () => {
        const { bridge } = await authorizedThreadBridge({
          tenantId: user.tenantId,
          userId: user.id,
          threadId,
        });
        await assertActiveTurn(bridge, threadId, turnId);
        const result = await runtimeRequest(() =>
          bridge.request<JsonValue>("turn/interrupt", { threadId, turnId }),
        );
        store.audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: "codex.turn_interrupted",
          targetType: "turn",
          targetId: turnId,
          metadata: { threadId },
        });
        return result;
      },
    );
  });

  app.post("/api/tasks/:threadId/turns/:turnId/actions/steer", async (request) => {
    const user = requireUser(request, store);
    const { threadId, turnId } = turnPathSchema.parse(request.params);
    const body = turnSteerSchema.parse(request.body);
    // A steer appends input to a turn whose envelope has already been sent, so
    // it is the other half of the forgery check on `turn/start`.
    assertNoEnvelopeForgery(body.input);
    const key = idempotencyKey(request);
    return idempotentMutation(
      { tenantId: user.tenantId, userId: user.id },
      key,
      {
        action: "steer",
        targetId: turnId,
        fingerprintValue: { action: "steer", threadId, turnId, input: body.input },
      },
      async () => {
        const { bridge } = await authorizedThreadBridge({
          tenantId: user.tenantId,
          userId: user.id,
          threadId,
        });
        await assertActiveTurn(bridge, threadId, turnId);
        const result = await runtimeRequest(() =>
          bridge.request<JsonValue>("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: body.input,
          }),
        );
        store.audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: "codex.turn_steered",
          targetType: "turn",
          targetId: turnId,
          metadata: { threadId, inputCount: body.input.length },
        });
        return result;
      },
    );
  });

  app.post("/api/codex/approval", async (request) => {
    const user = requireUser(request, store);
    const body = approvalSchema.parse(request.body);
    const approval = pendingApproval(user.tenantId, user.id, body.requestId);
    if (!approval || approval.method !== body.method) {
      throw new ApiHttpError(
        409,
        "approval_not_pending",
        "This approval request is no longer pending for the current user.",
      );
    }
    if (
      body.decision === "acceptForSession"
      && sessionApprovalBlocked(user.tenantId, user.id, approval.threadId)
    ) {
      // Refused *before* the approval is consumed, so the user can still decide
      // this same request with `accept` or `decline`.
      throw new ApiHttpError(
        403,
        "approval_scope_forbidden",
        "This turn reads user-attached files. Approve each command individually; "
          + "session-wide approval is not available while a turn carries attachments.",
      );
    }
    forgetApproval(user.tenantId, user.id, body.requestId);
    try {
      const bridge = await userBridge(runtime, { tenantId: user.tenantId, userId: user.id });
      await runtimeRequest(async () => {
        await bridge.respond(body.requestId, { decision: body.decision });
        return null;
      });
    } catch (error) {
      rememberApproval(user.tenantId, user.id, body.requestId, approval);
      throw error;
    }
    store.audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: "codex.approval_resolved",
      targetType: "runtime_request",
      targetId: String(body.requestId),
      metadata: {
        method: body.method,
        decision: body.decision,
        threadId: approval.threadId,
        turnId: approval.turnId,
        itemId: approval.itemId,
        actionDigest: approval.actionDigest,
      },
    });
    return { ok: true };
  });

  app.get("/api/codex/events", async (request, reply) => {
    const user = requireUser(request, store);
    const requestOrigin = normalizedOrigin(request.headers.origin);
    const allowedOrigins = configuredEventOrigins(config);
    if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
      throw new ApiHttpError(403, "invalid_origin", "Request origin is not allowed.");
    }
    const bridge = await userBridge(runtime, { tenantId: user.tenantId, userId: user.id });

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });

    let closed = false;
    let blocked = false;
    let queuedBytes = 0;
    const queue: string[] = [];
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      queue.length = 0;
      queuedBytes = 0;
      unsubscribe();
    };

    const flush = () => {
      if (closed || reply.raw.destroyed) return;
      blocked = false;
      while (queue.length > 0) {
        const frame = queue.shift();
        if (!frame) continue;
        queuedBytes -= Buffer.byteLength(frame);
        if (!reply.raw.write(frame)) {
          blocked = true;
          reply.raw.once("drain", flush);
          return;
        }
      }
    };

    const writeFrame = (frame: string) => {
      if (closed || reply.raw.destroyed) return;
      if (!blocked && queue.length === 0) {
        if (!reply.raw.write(frame)) {
          blocked = true;
          reply.raw.once("drain", flush);
        }
        return;
      }

      const bytes = Buffer.byteLength(frame);
      if (queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
        close();
        reply.raw.destroy();
        return;
      }
      queue.push(frame);
      queuedBytes += bytes;
    };

    const write = (value: unknown) => {
      writeFrame(`data: ${JSON.stringify(value)}\n\n`);
    };
    write({ kind: "notification", method: "runtime/connected", params: {} });

    unsubscribe = bridge.subscribe((event) => {
      if (
        event.kind === "server-request" &&
        event.requestId !== undefined &&
        APPROVAL_METHODS.has(event.method as ApprovalMethod)
      ) {
        rememberApproval(
          user.tenantId,
          user.id,
          event.requestId,
          {
            method: event.method as ApprovalMethod,
            threadId: approvalIdentifier(event.params, "threadId"),
            turnId: approvalIdentifier(event.params, "turnId"),
            itemId: approvalIdentifier(event.params, "itemId"),
            actionDigest: approvalActionDigest(
              event.method as ApprovalMethod,
              event.params,
            ),
            expiresAt: Date.now() + APPROVAL_TTL_MS,
          },
        );
      }
      write(event);
    });
    heartbeat = setInterval(() => {
      if (!blocked) writeFrame(": keepalive\n\n");
    }, 20_000);
    heartbeat.unref();

    request.raw.once("aborted", close);
    reply.raw.once("close", close);
    reply.raw.once("error", close);
  });
}
