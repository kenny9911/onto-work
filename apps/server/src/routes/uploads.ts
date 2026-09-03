import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { PassThrough, Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { UPLOAD_MAX_BYTES } from "@agent-harness/contracts";

import { RunAdmissionError, RunAdmissionPolicy } from "../admission.js";
import { resolveAllowedWorkspacePath } from "../codex/config.js";
import type { JsonValue } from "../codex/runtime.js";
import type { HarnessConfig } from "../config.js";
import { uploadSummary, type HarnessStore, type UploadRecord } from "../database.js";
import { ApiHttpError, requireUser } from "../http.js";
import { TaskMutationLedger } from "../task-mutations.js";
import { unlinkStaged, writeEncryptedBlob } from "../uploads/blob.js";
import {
  UploadStorageError,
  prepareUserUploadPaths,
  resolveStorageKey,
  stagedPath,
  uploadStorageKey,
  type UserUploadPaths,
} from "../uploads/paths.js";
import { uploadErrorReason } from "../uploads/redaction.js";
import { UploadSniffer } from "../uploads/sniff.js";

/**
 * Upload routes.
 *
 *   POST   /api/tasks/:threadId/uploads       raw application/octet-stream
 *   POST   /api/projects/:projectId/uploads   raw application/octet-stream
 *   GET    /api/tasks/:threadId/uploads
 *   DELETE /api/uploads/:uploadId
 *
 * There are two POST routes because the composer must be able to attach a file
 * *before* a thread exists. A project-scoped row is written with
 * `thread_id = NULL` and is claimed for a thread — one way, inside one
 * transaction — the first time a turn attaches it.
 *
 * ## Why `requireUser` is the first statement of every handler
 *
 * `buildApp` registers a pass-through parser for `application/octet-stream`,
 * so the handler runs with the request body *unread*. Authenticating before
 * the first byte is consumed is the whole point of that parser: an anonymous
 * caller cannot make this process buffer, hash, encrypt, or write anything.
 * Nothing may be inserted above `requireUser`, and nothing between it and the
 * header checks may touch `request.body`. `uploads.test.ts` asserts that an
 * unauthenticated POST reads zero bytes off the payload stream.
 *
 * ## Why this route counts its own bytes
 *
 * Fastify enforces `bodyLimit` only inside `rawBody()`
 * (`fastify/lib/content-type-parser.js`), which is reached solely by
 * *buffering* parsers. A pass-through parser never calls it, so `bodyLimit` is
 * not a size control here at all. Size is enforced at four independent points,
 * exactly as the design requires:
 *
 * 1. the declared `Content-Length` is range-checked before anything is read;
 * 2. that many bytes are reserved against the tenant's quota before anything
 *    is read, so concurrent uploads cannot each pass a check-then-write race;
 * 3. `byteLimitGuard` destroys the stream the instant the running total passes
 *    either `UPLOAD_MAX_BYTES` or the declared length;
 * 4. after the pipeline settles, bytes written must *equal* the declared
 *    length.
 *
 * Deliberately **no route-level `bodyLimit`**: raising it would not affect the
 * streaming path (see above) but it *would* raise the ceiling for any
 * buffering parser that can still be selected on these paths — a 20 MiB
 * `application/json` POST would then be fully buffered before `requireUser`
 * runs. Inheriting the app's 1 MiB keeps that window as small as it is
 * everywhere else; `uploads.test.ts` pins it.
 *
 * ## Why every route declares `config.rateLimit`
 *
 * `@fastify/rate-limit` is registered with `global: false`, so a route without
 * its own `config.rateLimit` has no throttling whatsoever.
 */

/** The only wire content type these routes accept. */
const UPLOAD_WIRE_CONTENT_TYPE = "application/octet-stream";

/** Concurrent in-flight uploads allowed per user. */
const MAX_CONCURRENT_UPLOADS_PER_USER = 3;

/**
 * How long a stored upload is retained before the janitor reclaims it.
 *
 * The design fixes the reservation lease (10 minutes, `database.ts`) but not
 * the durable window, and `uploads.expires_at` is `NOT NULL` for every status
 * the janitor can reach — so a durable row needs a real retention deadline or
 * it would inherit the 10-minute lease and vanish mid-session.
 */
export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Raw `x-upload-filename` header shape: percent-encoded UTF-8, therefore
 * visible ASCII, at most 512 encoded bytes. Headers are latin-1 on the wire,
 * so requiring ASCII here is what makes "percent-encoded UTF-8" true rather
 * than hopeful.
 */
const FILENAME_HEADER_PATTERN = /^[\x20-\x7e]{1,512}$/;

/**
 * The decoded, NFC-normalized display label. It is stored on the row, shown in
 * the UI, and quoted into the attachment envelope — and it never becomes a
 * path component anywhere. Slashes, backslashes, C0 controls and DEL are
 * rejected regardless.
 */
const UPLOAD_LABEL_PATTERN = /^[^\u0000-\u001f\u007f/\\]{1,255}$/;

/** The existing `Idempotency-Key` rule, verbatim (`routes/codex.ts`). */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

const CONTENT_LENGTH_PATTERN = /^\d{1,15}$/;

const threadPathSchema = z.object({
  threadId: z.string().trim().min(1).max(256),
});

const projectPathSchema = z.object({
  projectId: z.string().uuid(),
});

const uploadPathSchema = z.object({
  uploadId: z.string().uuid(),
});

// --- Request header validation -------------------------------------------

/**
 * Reads a header that must appear exactly once. `name` must be lower case.
 *
 * A `typeof value === "string"` guard does **not** reject a repeated header.
 * Node reduces every repeated header to a single string before Fastify sees
 * it, so the array form such a guard watches for never appears for any header
 * this reads. Measured against a real socket:
 *
 * - `x-upload-filename` and `idempotency-key` are comma-joined, so two label
 *   lines arrive as one `"a.csv, b.csv"` and two keys as `"k1, k2"`;
 * - `content-type` keeps the first occurrence and silently drops the rest;
 * - `content-length` is the only one Node itself refuses
 *   (`HPE_UNEXPECTED_CONTENT_LENGTH`), even when both copies agree — that one
 *   never reaches a handler at all.
 *
 * `request.raw.rawHeaders` is the only place the wire's repetition survives —
 * it holds one `name, value` pair per occurrence — so occurrences are counted
 * there.
 *
 * A header sent twice is not a single header, so it is reported as absent and
 * each caller raises its own missing-or-malformed error: `400
 * invalid_idempotency_key`, `400 invalid_upload_filename`, `415
 * unsupported_media_type` for `content-type`, `400 validation_error` for the
 * `content-length` Node would have rejected first anyway. No new code, so
 * nothing changes for `apps/web/src/lib/api.ts`.
 *
 * The label is display-only, but the others are not: a doubled
 * `idempotency-key` would key the mutation ledger on a joined value neither
 * client sent, and a doubled `content-type` would pick the body parser from
 * one copy while the caller believed the other.
 */
function singleHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value !== "string") return null;
  const raw = request.raw.rawHeaders;
  let seen = 0;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() !== name) continue;
    seen += 1;
    if (seen > 1) return null;
  }
  return value;
}

/**
 * The wire type is fixed, so there is no declared type to reconcile with the
 * bytes and no content-type spoofing to defend against at this layer. A
 * request with any other type never reaches this handler — Fastify has no
 * parser for it and answers `415` from the body-error branch in `app.ts` —
 * so this is the belt for `application/octet-stream; charset=…` and for a
 * future parser registration.
 */
function requireOctetStream(request: FastifyRequest): void {
  const header = singleHeader(request, "content-type");
  const essence = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (essence !== UPLOAD_WIRE_CONTENT_TYPE) {
    throw new ApiHttpError(
      415,
      "unsupported_media_type",
      `Uploads must be sent as ${UPLOAD_WIRE_CONTENT_TYPE}.`,
    );
  }
}

/**
 * Enforcement point 1: the declared length, checked before the body is read.
 * A caller cannot get bytes past this without also announcing them.
 */
function declaredContentLength(request: FastifyRequest): number {
  const header = singleHeader(request, "content-length");
  if (header === null || !CONTENT_LENGTH_PATTERN.test(header)) {
    throw new ApiHttpError(
      400,
      "validation_error",
      "Uploads must declare exactly one integer Content-Length.",
    );
  }
  const length = Number.parseInt(header, 10);
  if (length === 0) {
    throw new ApiHttpError(400, "upload_empty", "The uploaded file is empty.");
  }
  if (length > UPLOAD_MAX_BYTES) {
    throw new ApiHttpError(
      413,
      "upload_too_large",
      `Uploads are limited to ${UPLOAD_MAX_BYTES} bytes.`,
    );
  }
  return length;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = singleHeader(request, "idempotency-key");
  if (value === null || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiHttpError(
      400,
      "invalid_idempotency_key",
      "Exactly one Idempotency-Key of 1 to 255 visible ASCII characters is required.",
    );
  }
  return value;
}

/**
 * Decodes `x-upload-filename` into a display label.
 *
 * Percent-decoded, NFC-normalized, then required to be free of path
 * separators and control characters and not to be `.` or `..`. The result is
 * a **label**: it is stored, displayed and quoted, and no code path turns it
 * into a filename. Blob names are the server-generated upload UUID and staged
 * extensions come from the server's own classification, so a traversal-shaped
 * label has nothing to traverse.
 */
function uploadFilenameLabel(request: FastifyRequest): string {
  const header = singleHeader(request, "x-upload-filename");
  if (header === null || !FILENAME_HEADER_PATTERN.test(header)) {
    throw new ApiHttpError(
      400,
      "invalid_upload_filename",
      "Exactly one x-upload-filename is required: percent-encoded UTF-8, at most 512 bytes.",
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    throw new ApiHttpError(
      400,
      "invalid_upload_filename",
      "x-upload-filename is not valid percent-encoded UTF-8.",
    );
  }
  const label = decoded.normalize("NFC");
  if (!UPLOAD_LABEL_PATTERN.test(label) || label === "." || label === "..") {
    throw new ApiHttpError(
      400,
      "invalid_upload_filename",
      "x-upload-filename must be 1 to 255 characters and contain no path separators.",
    );
  }
  return label;
}

// --- Stream guards --------------------------------------------------------

/**
 * Enforcement point 3, plus the abort handle the pace monitor pulls.
 *
 * `callback(error)` destroys this transform, which `stream.pipeline` turns
 * into a rejection and a teardown of the whole chain — so an overlong body
 * stops being read at the first chunk that crosses the line rather than at the
 * end of the request. The request itself is deliberately not in that chain;
 * see `storeUpload`.
 */
export interface UploadStreamGuard {
  readonly stream: Transform;
  bytes(): number;
  abort(error: ApiHttpError): void;
}

function byteLimitGuard(declaredLength: number): UploadStreamGuard {
  let bytes = 0;
  let aborted = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > UPLOAD_MAX_BYTES) {
        callback(
          new ApiHttpError(
            413,
            "upload_too_large",
            `Uploads are limited to ${UPLOAD_MAX_BYTES} bytes.`,
          ),
        );
        return;
      }
      if (bytes > declaredLength) {
        callback(
          new ApiHttpError(
            400,
            "upload_length_mismatch",
            "The request body is longer than its declared Content-Length.",
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  return {
    stream,
    bytes: () => bytes,
    abort(error: ApiHttpError) {
      if (aborted || stream.destroyed) return;
      aborted = true;
      stream.destroy(error);
    },
  };
}

/**
 * Tees every byte into the classifier while passing it through untouched. The
 * sniffer validates the *whole* stream, so a NUL 19 MiB in rejects exactly as
 * a leading one does, and it throws the moment that happens.
 */
function sniffTee(sniffer: UploadSniffer): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        sniffer.update(chunk);
      } catch (error) {
        callback(error as Error);
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Slow-loris limits. Overridable so the monitor is testable in milliseconds. */
export interface UploadPaceLimits {
  /** Hard ceiling on one upload, however fast it is going. */
  wallClockMs: number;
  /** Width of the rolling throughput window. */
  windowMs: number;
  /** Sustained rate below which the upload is abandoned. */
  floorBytesPerSecond: number;
  /** How often the monitor samples progress. */
  sampleIntervalMs: number;
}

export const UPLOAD_PACE_LIMITS: UploadPaceLimits = {
  wallClockMs: 120_000,
  windowMs: 20_000,
  floorBytesPerSecond: 8 * 1024,
  sampleIntervalMs: 1_000,
};

/** The half of `UploadStreamGuard` the monitor needs. */
export type UploadPaceTarget = Pick<UploadStreamGuard, "bytes" | "abort">;

/**
 * Aborts an upload that stalls.
 *
 * Two independent limits: a hard wall clock, and a rolling window that has to
 * carry at least `floorBytesPerSecond`. The window is only judged once it is
 * actually `windowMs` wide, so a fast small upload finishes long before the
 * monitor has an opinion.
 *
 * The timer is `unref`ed — a stalled upload must never be the reason a process
 * stays alive — and the returned function must be called on every exit path.
 */
export function startUploadPaceMonitor(
  target: UploadPaceTarget,
  limits: UploadPaceLimits = UPLOAD_PACE_LIMITS,
): () => void {
  const startedAt = Date.now();
  const samples: Array<{ at: number; bytes: number }> = [{ at: startedAt, bytes: 0 }];
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - startedAt >= limits.wallClockMs) {
      target.abort(
        new ApiHttpError(
          408,
          "upload_timeout",
          "The upload took longer than this endpoint allows.",
        ),
      );
      return;
    }
    const bytes = target.bytes();
    samples.push({ at: now, bytes });
    // Keep exactly the oldest sample still needed to span a full window.
    while (samples.length > 2 && now - (samples[1]?.at ?? now) >= limits.windowMs) {
      samples.shift();
    }
    const oldest = samples[0];
    if (!oldest) return;
    const elapsedMs = now - oldest.at;
    if (elapsedMs < limits.windowMs) return;
    if ((bytes - oldest.bytes) * 1_000 < limits.floorBytesPerSecond * elapsedMs) {
      target.abort(
        new ApiHttpError(
          408,
          "upload_timeout",
          "The upload fell below the minimum sustained transfer rate.",
        ),
      );
    }
  }, limits.sampleIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// --- Misc helpers ---------------------------------------------------------

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

function readableBody(request: FastifyRequest): Readable {
  const body = request.body as Readable | undefined;
  if (!body || typeof body.pipe !== "function" || typeof body.on !== "function") {
    throw new ApiHttpError(
      400,
      "validation_error",
      "The upload body was not delivered as a raw stream.",
    );
  }
  return body;
}

/**
 * The wire projection, spelled field by field so it is a `JsonValue` the
 * idempotency ledger can persist and replay verbatim. It carries no storage
 * path, no encryption material and no bytes.
 */
function uploadDetailPayload(record: UploadRecord): JsonValue {
  const summary = uploadSummary(record);
  return {
    upload: {
      id: summary.id,
      scope: summary.scope,
      threadId: summary.threadId,
      projectId: summary.projectId,
      filename: summary.filename,
      contentType: summary.contentType,
      sizeBytes: summary.sizeBytes,
      status: summary.status,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      expiresAt: summary.expiresAt,
    },
  };
}

/** Digs the upload id out of a receipt the mutation ledger stored earlier. */
function replayedUploadId(response: JsonValue): string | null {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return null;
  }
  const upload = (response as { upload?: unknown }).upload;
  if (typeof upload !== "object" || upload === null || Array.isArray(upload)) return null;
  const id = (upload as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/**
 * Reads the body and returns its sha256, storing nothing.
 *
 * The same guards a stored upload gets — the byte-limit transform and the pace
 * monitor — because this reads an attacker-controlled body of the same size.
 * There is no reservation, no cipher and no file: an upload whose key is
 * already spent must never cost storage, and the digest is all this needs.
 */
async function hashRequestBody(
  request: FastifyRequest,
  declaredLength: number,
): Promise<string> {
  const source = readableBody(request);
  const guard = byteLimitGuard(declaredLength);
  const stopPaceMonitor = startUploadPaceMonitor(guard);
  const hash = createHash("sha256");
  // Same reason as `storeUpload`: the request must not be handed to
  // `pipeline`, which destroys every stream it is given on error and would
  // kill the socket before the 4xx could be written.
  const body = new PassThrough();
  source.pipe(body);
  source.once("error", (error: Error) => {
    if (!body.destroyed) body.destroy(error);
  });
  try {
    await pipeline(body, guard.stream, async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) hash.update(chunk);
    });
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError(
      400,
      "validation_error",
      "The upload body could not be read.",
    );
  } finally {
    source.unpipe(body);
    stopPaceMonitor();
  }
}

/** Maps a pure storage failure onto the design's status codes. */
function storageFailure(error: UploadStorageError): ApiHttpError {
  if (error.reason === "integrity" || error.reason === "staging_failed") {
    return new ApiHttpError(
      500,
      "upload_staging_failed",
      "The upload could not be written to the server's store.",
    );
  }
  return new ApiHttpError(
    500,
    "internal_error",
    "The upload could not be written to the server's store.",
  );
}

interface UploadScope {
  kind: "thread" | "project";
  targetId: string;
  threadId: string | null;
  projectId: string | null;
  workspacePath: string;
}

export function registerUploadRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig },
): void {
  const { store, config } = input;
  const admissionPolicy = new RunAdmissionPolicy(store);
  const mutationLedger = new TaskMutationLedger(store.db);
  /** Per-user in-flight upload count; the semaphore is per process, like approvals. */
  const inFlightUploads = new Map<string, number>();

  /**
   * Ledger 2 (`task_mutations`), the same one every task mutation uses. An
   * upload is not a run, so it must not touch `usage_reservations`, whose
   * `operation` CHECK admits only `thread_start` and `turn_start`.
   *
   * This mirrors `registerCodexRoutes`' private `idempotentMutation` rather
   * than sharing it: `routes/codex.ts` is being edited by another change in
   * this same batch, so lifting the helper into a shared module now would mean
   * editing that file. Extracting the two copies into one home is a
   * follow-up — the shapes are identical and deliberately so.
   */
  const idempotentMutation = async (
    identity: { tenantId: string; userId: string },
    key: string,
    descriptor: { action: string; targetId: string; fingerprint: readonly (string | number)[] },
    operation: () => Promise<JsonValue>,
    /**
     * Runs before a stored receipt is replayed, and may refuse it. The upload
     * routes pass `assertReplayMatchesBody`; see the note there for why a
     * replay has to look at the body at all.
     */
    verifyReplay?: (response: JsonValue) => Promise<void>,
  ): Promise<JsonValue> => {
    const requestHash = createHash("sha256")
      .update(JSON.stringify([descriptor.action, ...descriptor.fingerprint]))
      .digest("hex");
    const reservation = mutationLedger.reserve({
      tenantId: identity.tenantId,
      userId: identity.userId,
      idempotencyKey: key,
      action: descriptor.action,
      targetId: descriptor.targetId,
      requestHash,
    });
    switch (reservation.state) {
      case "replayed":
        if (verifyReplay) await verifyReplay(reservation.response);
        return reservation.response;
      case "conflict":
        throw new ApiHttpError(
          409,
          "idempotency_conflict",
          "This Idempotency-Key was already used for a different upload.",
        );
      case "in_progress":
        throw new ApiHttpError(
          409,
          "request_in_progress",
          "This upload is already in progress.",
        );
      case "closed":
        throw new ApiHttpError(
          409,
          "idempotent_request_closed",
          "This upload can no longer be retried with the same Idempotency-Key.",
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
          "The upload completed but its durable receipt could not be recorded.",
        );
      }
      return result;
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

  const acquireUploadSlot = (tenantId: string, userId: string): (() => void) => {
    const key = `${tenantId}\0${userId}`;
    const current = inFlightUploads.get(key) ?? 0;
    if (current >= MAX_CONCURRENT_UPLOADS_PER_USER) {
      throw new ApiHttpError(
        429,
        "upload_concurrency_limit",
        `At most ${MAX_CONCURRENT_UPLOADS_PER_USER} uploads may be in flight at once.`,
      );
    }
    inFlightUploads.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (inFlightUploads.get(key) ?? 1) - 1;
      if (next <= 0) inFlightUploads.delete(key);
      else inFlightUploads.set(key, next);
    };
  };

  /**
   * The `authorizedThreadBridge` chain from `routes/codex.ts`, minus the
   * bridge: binding → `resolveAllowedWorkspacePath` → equality →
   * `authorizeThreadAccess`.
   *
   * The one branch that cannot be mirrored is the lazy bind from
   * `thread/read`: this route has no runtime and must not acquire one, since
   * that would let an upload spawn a Codex child. A thread with no binding for
   * this `(tenant, user)` is therefore reported as absent — `404`, the same
   * answer another tenant's thread gets, so a thread id is not oracle-able
   * from here. Resuming the task binds it and the upload then succeeds.
   */
  const resolveThreadScope = async (identity: {
    tenantId: string;
    userId: string;
    threadId: string;
  }): Promise<UploadScope> => {
    const binding = store.getThreadWorkspaceBinding(
      identity.tenantId,
      identity.userId,
      identity.threadId,
    );
    if (!binding) {
      throw new ApiHttpError(404, "thread_not_found", "Task not found.");
    }
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await resolveAllowedWorkspacePath(
        binding.workspacePath,
        config.allowedWorkspaceRoots,
      );
    } catch {
      throw new ApiHttpError(
        403,
        "workspace_not_allowed",
        "The thread workspace is outside the server allow-list.",
      );
    }
    if (canonicalWorkspace !== binding.workspacePath) {
      throw new ApiHttpError(
        409,
        "thread_workspace_conflict",
        "The thread workspace no longer resolves to its trusted canonical path.",
      );
    }
    const workspacePath = admitted(() => admissionPolicy.authorizeThreadAccess(identity));
    return {
      kind: "thread",
      targetId: identity.threadId,
      threadId: identity.threadId,
      projectId: null,
      workspacePath,
    };
  };

  /** The `POST /api/tasks` chain, verbatim: saved project → enabled → grant → realpath → equality. */
  const resolveProjectScope = async (identity: {
    tenantId: string;
    userId: string;
    projectId: string;
  }): Promise<UploadScope> => {
    const project = store.getSavedProject(identity.tenantId, identity.projectId);
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
        identity.tenantId,
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
    admitted(() =>
      admissionPolicy.authorizeWorkspaceAccess({
        tenantId: identity.tenantId,
        userId: identity.userId,
        workspacePath,
      }),
    );
    return {
      kind: "project",
      targetId: project.id,
      threadId: null,
      projectId: project.id,
      workspacePath,
    };
  };

  /**
   * Best-effort unlink of a file whose row did not survive, or no longer
   * points at it. An absent file is the expected case on several paths (a
   * delete for an upload that was never staged, a double settle), so only a
   * real failure is worth a log line — and the line carries `uploadId` and a
   * bounded reason, never the error object and never the path it failed on.
   */
  const discardFile = async (uploadId: string, path: string): Promise<void> => {
    try {
      await unlink(path);
    } catch (error) {
      const reason = uploadErrorReason(error);
      if (reason === "ENOENT") return;
      app.log.warn({ uploadId, reason }, "upload file could not be removed");
    }
  };

  /**
   * Nothing leaves this route carrying a filesystem path.
   *
   * The route's own `app.log` calls are not the only door: `app.ts`'s handler does
   * `request.log.error({ err: error }, "request failed")` for every 5xx, so a
   * raw `fs` failure escaping `storeUpload` puts the absolute store path in the
   * log just as surely. Typed failures are mapped as before; anything else is
   * recorded here with a bounded reason and replaced by a path-free 500.
   *
   * SQLite failures pass through untouched: they carry no path, and the
   * central handler maps a constraint violation — which is how the scope-guard
   * trigger reports a `workspace_path` that disagrees with the binding — to
   * `409 conflict`.
   */
  const typedFailure = (uploadId: string, error: unknown): unknown => {
    if (error instanceof ApiHttpError) return error;
    if (error instanceof UploadStorageError) return storageFailure(error);
    const reason = uploadErrorReason(error);
    if (reason.startsWith("SQLITE_")) return error;
    app.log.warn({ uploadId, reason }, "upload failed inside the store");
    return new ApiHttpError(
      500,
      "internal_error",
      "The upload could not be written to the server's store.",
    );
  };

  /**
   * Refuses to replay a receipt for bytes other than the ones on the wire.
   *
   * The idempotency fingerprint is `[scope, targetId, filename,
   * declaredLength]` and it *cannot* contain the content: the key is claimed
   * before a byte is read, which is exactly what lets the quota reservation
   * precede the stream. So two different files that share a name and a byte
   * count hash to the same key, and a bare `state === "replayed"` would hand
   * the second caller a receipt naming the first caller's stored bytes — a
   * wrong answer delivered with a 201.
   *
   * The content cannot go *into* the key, but it can be checked *against* it.
   * On a replay the body is read and hashed — never stored, never encrypted,
   * no reservation, no disk, and under the same byte-limit guard and pace
   * monitor a real upload gets — and compared with `content_sha256` of the
   * upload this key already named. Same bytes: the receipt is replayed, which
   * is what an honest retry of a dropped connection wants. Different bytes:
   * `409 idempotency_conflict`, the same answer a different filename or a
   * different declared length already gets from the ledger.
   *
   * The cost is a sha256 over a body the client is transmitting either way —
   * the current code does not read it, but the bytes are still on the wire.
   * The alternative, short-circuiting before the body is read, cannot tell the
   * two files apart at all, and would leave the mismatch silent.
   *
   * A receipt whose row is gone (a cascade from user or binding deletion, or
   * the janitor hard-deleting an expired reservation) cannot be checked
   * against anything, so it is refused rather than replayed — and refused
   * without reading the body, since there is nothing to compare it to.
   */
  const assertReplayMatchesBody = async (
    identity: { tenantId: string; userId: string },
    request: FastifyRequest,
    reply: FastifyReply,
    declaredLength: number,
    response: JsonValue,
  ): Promise<void> => {
    const conflict = (message: string): ApiHttpError => {
      // The body is either unread or half-read; either way this connection
      // cannot be reused. Same handling as a failed `storeUpload`.
      reply.header("connection", "close");
      return new ApiHttpError(409, "idempotency_conflict", message);
    };
    const uploadId = replayedUploadId(response);
    const record = uploadId
      ? store.getUpload(identity.tenantId, identity.userId, uploadId)
      : null;
    if (!record) {
      throw conflict(
        "The upload this Idempotency-Key names is no longer available to replay.",
      );
    }
    if ((await hashRequestBody(request, declaredLength)) === record.contentSha256) return;
    throw conflict("This Idempotency-Key was already used for a different upload.");
  };

  /**
   * Reserve → stream → settle. Every failure path releases the reservation and
   * leaves nothing on disk, so an abandoned upload costs the tenant nothing.
   */
  const storeUpload = async (
    identity: { tenantId: string; userId: string },
    scope: UploadScope,
    request: FastifyRequest,
    reply: FastifyReply,
    details: { filename: string; declaredLength: number },
  ): Promise<JsonValue> => {
    const source = readableBody(request);
    const uploadId = randomUUID();
    let paths: UserUploadPaths;
    try {
      paths = await prepareUserUploadPaths(config.uploadDataDir, identity);
    } catch (error) {
      throw typedFailure(uploadId, error);
    }
    const storageKey = uploadStorageKey(paths.userDirectoryKey, uploadId);

    // Enforcement point 2. Taken inside `BEGIN IMMEDIATE` before a byte is
    // accepted, so two uploads racing the same remaining allowance cannot both
    // pass. The row also counts toward the tenant sum from this moment.
    const reservation = store.createUploadReservation({
      id: uploadId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      threadId: scope.threadId,
      projectId: scope.projectId,
      workspacePath: scope.workspacePath,
      filename: details.filename,
      sizeBytes: details.declaredLength,
      storageKey,
    });
    switch (reservation.outcome) {
      case "storage_quota_exhausted":
        throw new ApiHttpError(
          429,
          "storage_quota_exhausted",
          "This tenant has no remaining upload storage.",
        );
      case "upload_quota_exhausted":
        throw new ApiHttpError(
          429,
          "upload_quota_exhausted",
          "This tenant has used its upload allowance for the current period.",
        );
      case "entitlement_missing":
        throw new ApiHttpError(
          403,
          "forbidden",
          "This tenant has no entitlement snapshot and cannot store uploads.",
        );
      case "reserved":
        break;
    }

    const guard = byteLimitGuard(details.declaredLength);
    const sniffer = new UploadSniffer({ filename: details.filename });
    const stopPaceMonitor = startUploadPaceMonitor(guard);
    // `stream.pipeline` destroys *every* stream it is given when one errors,
    // and the request must not be one of them: destroying it kills the socket
    // before the 4xx can be written, so the client learns nothing about why it
    // was refused. Fastify's own over-limit path never destroys the request
    // either — it sets `connection: close` and replies. Feeding the pipeline a
    // pass-through we own keeps that property: `Readable.pipe` unpipes when its
    // destination errors, so aborting stops us reading further while leaving
    // the request intact for the reply.
    const body = new PassThrough();
    source.pipe(body);
    // `pipe` forwards `end` but never `error`, so a client that disconnects
    // mid-upload would otherwise leave the pipeline waiting for the wall clock.
    source.once("error", (error: Error) => {
      if (!body.destroyed) body.destroy(error);
    });
    let publishedPath: string | null = null;
    try {
      // pipeline(body, byteCounter, sniffTee, sha256Hasher, cipher, tmpFile) —
      // `writeEncryptedBlob` owns the last three stages and splices these two
      // in ahead of them, so one pass counts, classifies, hashes, encrypts and
      // writes without the body ever being held in memory.
      const blob = await writeEncryptedBlob({
        paths,
        uploadId,
        source: body,
        encryptionSecret: config.credentialEncryptionKey,
        transforms: [guard.stream, sniffTee(sniffer)],
      });
      publishedPath = blob.path;

      // Enforcement point 4. A body that ends early never reaches the guard,
      // so equality — not just a ceiling — is what closes that gap.
      if (blob.sizeBytes !== details.declaredLength) {
        throw new ApiHttpError(
          400,
          "upload_length_mismatch",
          "The request body did not match its declared Content-Length.",
        );
      }

      const contentType = sniffer.finalize();
      const record = store.commitUpload({
        tenantId: identity.tenantId,
        userId: identity.userId,
        uploadId,
        sizeBytes: blob.sizeBytes,
        contentType,
        contentSha256: blob.contentSha256,
        storageKey: blob.storageKey,
        encryptionIv: blob.encryptionIv,
        encryptionTag: blob.encryptionTag,
        wrappedDataKey: blob.wrappedDataKey,
        expiresAt: new Date(Date.now() + UPLOAD_RETENTION_MS).toISOString(),
      });
      if (!record) {
        // The reservation was released underneath us — the janitor expired the
        // lease, or a delete tombstoned the row. The bytes are real but nothing
        // durable names them, so they are discarded by the catch below.
        throw new ApiHttpError(
          500,
          "internal_error",
          "The upload reservation closed before its bytes could be recorded.",
        );
      }
      publishedPath = null;
      return uploadDetailPayload(record);
    } catch (error) {
      const failure = typedFailure(uploadId, error);
      // Stop reading immediately and tell the client the connection is spent:
      // the rest of the body will never be consumed, so it cannot be reused.
      source.unpipe(body);
      reply.header("connection", "close");
      // Releasing the reservation must never replace the reason the upload
      // failed: the client is owed the real code, and a store failure here is
      // a quota leak the janitor's expiry pass reclaims.
      try {
        store.failUpload({
          tenantId: identity.tenantId,
          userId: identity.userId,
          uploadId,
          errorCode: failure instanceof ApiHttpError ? failure.code : "upload_failed",
        });
      } catch (releaseError) {
        app.log.warn(
          { uploadId, reason: uploadErrorReason(releaseError) },
          "upload reservation could not be released",
        );
      }
      if (publishedPath !== null) await discardFile(uploadId, publishedPath);
      throw failure;
    } finally {
      stopPaceMonitor();
    }
  };

  const uploadRouteOptions = {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  } as const;

  // Reads and deletes are cheap, but `global: false` means "no config, no
  // limit" — a bare route here would be the only unthrottled surface added.
  const readRouteOptions = {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  } as const;

  app.post("/api/tasks/:threadId/uploads", uploadRouteOptions, async (request, reply) => {
    // FIRST STATEMENT. The body is an unread stream at this point; nothing
    // above this line may change, and nothing below it may read the body until
    // the header checks have passed.
    const user = requireUser(request, store);
    const { threadId } = threadPathSchema.parse(request.params);
    requireOctetStream(request);
    const declaredLength = declaredContentLength(request);
    const key = idempotencyKey(request);
    const filename = uploadFilenameLabel(request);

    const release = acquireUploadSlot(user.tenantId, user.id);
    try {
      const scope = await resolveThreadScope({
        tenantId: user.tenantId,
        userId: user.id,
        threadId,
      });
      const result = await idempotentMutation(
        { tenantId: user.tenantId, userId: user.id },
        key,
        {
          action: "upload.create",
          targetId: scope.targetId,
          fingerprint: [scope.kind, scope.targetId, filename, declaredLength],
        },
        () =>
          storeUpload({ tenantId: user.tenantId, userId: user.id }, scope, request, reply, {
            filename,
            declaredLength,
          }),
        (response) =>
          assertReplayMatchesBody(
            { tenantId: user.tenantId, userId: user.id },
            request,
            reply,
            declaredLength,
            response,
          ),
      );
      reply.code(201);
      return result;
    } finally {
      release();
    }
  });

  app.post("/api/projects/:projectId/uploads", uploadRouteOptions, async (request, reply) => {
    // FIRST STATEMENT — see the thread-scoped route above.
    const user = requireUser(request, store);
    const { projectId } = projectPathSchema.parse(request.params);
    requireOctetStream(request);
    const declaredLength = declaredContentLength(request);
    const key = idempotencyKey(request);
    const filename = uploadFilenameLabel(request);

    const release = acquireUploadSlot(user.tenantId, user.id);
    try {
      const scope = await resolveProjectScope({
        tenantId: user.tenantId,
        userId: user.id,
        projectId,
      });
      const result = await idempotentMutation(
        { tenantId: user.tenantId, userId: user.id },
        key,
        {
          action: "upload.create",
          targetId: scope.targetId,
          fingerprint: [scope.kind, scope.targetId, filename, declaredLength],
        },
        () =>
          storeUpload({ tenantId: user.tenantId, userId: user.id }, scope, request, reply, {
            filename,
            declaredLength,
          }),
        (response) =>
          assertReplayMatchesBody(
            { tenantId: user.tenantId, userId: user.id },
            request,
            reply,
            declaredLength,
            response,
          ),
      );
      reply.code(201);
      return result;
    } finally {
      release();
    }
  });

  app.get("/api/tasks/:threadId/uploads", readRouteOptions, async (request) => {
    const user = requireUser(request, store);
    const { threadId } = threadPathSchema.parse(request.params);
    await resolveThreadScope({ tenantId: user.tenantId, userId: user.id, threadId });
    const uploads = store
      .listThreadUploads(user.tenantId, user.id, threadId)
      .map((record) => uploadSummary(record));
    return { uploads };
  });

  app.delete("/api/uploads/:uploadId", readRouteOptions, async (request) => {
    const user = requireUser(request, store);
    const { uploadId } = uploadPathSchema.parse(request.params);
    // `deleteUpload` is scoped by tenant *and* user and tombstones in one
    // transaction with its `upload.deleted` audit row. Another tenant's id —
    // and another member's within this tenant — reads as absent, so possession
    // of an id conveys nothing and ids are not oracle-able.
    const record = store.deleteUpload({
      tenantId: user.tenantId,
      userId: user.id,
      uploadId,
    });
    if (!record) {
      throw new ApiHttpError(404, "upload_not_found", "Upload not found.");
    }

    // The row is already a tombstone, so a failure below only leaves an
    // orphaned file for the janitor's filesystem sweep — never a live row
    // pointing at bytes that are gone.
    try {
      await discardFile(record.id, resolveStorageKey(config.uploadDataDir, record.storageKey));
    } catch (error) {
      app.log.warn(
        { uploadId: record.id, reason: uploadErrorReason(error) },
        "upload blob path could not be resolved for deletion",
      );
    }
    // Staged plaintext is the only other copy of these bytes. It is normally
    // reclaimed when the turn settles, but a delete during a live turn must not
    // leave it behind.
    if (record.threadId !== null) {
      try {
        const paths = await prepareUserUploadPaths(config.uploadDataDir, {
          tenantId: user.tenantId,
          userId: user.id,
        });
        // `unlinkStaged` re-checks containment in this user's own staged
        // tree, so a mis-derived path can never reach a durable blob.
        await unlinkStaged(
          paths,
          stagedPath(paths, record.threadId, record.id, record.contentType),
        );
      } catch (error) {
        // A row that never reached a staged type (or a shard that is gone)
        // simply has nothing staged.
        app.log.debug(
          { uploadId: record.id, reason: uploadErrorReason(error) },
          "no staged plaintext to remove for upload",
        );
      }
    }

    return { ok: true };
  });
}
