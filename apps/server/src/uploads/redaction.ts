import { ApiHttpError } from "../http.js";
import { UploadStorageError } from "./paths.js";

/**
 * The single path-free reason string used by every log line about the upload
 * store.
 *
 * `logger.warn({ err: error }, …)` hands pino a raw `fs` error, and *every*
 * field of one carries the absolute store path: `message`
 * (`EPERM: … unlink '/…/blobs/a9/a975…'`), `stack`, and the enumerable `path`
 * property that survives a plain `JSON.stringify`. The upload design's §6
 * invariant is "the Fastify logger never receives the label or a path; only
 * `uploadId`", and ADR-0001 requires sensitive filesystem paths to be
 * redacted; `{ err }` breaks both. The janitor logs through `app.log` exactly
 * like the routes do, so it is bound by the same invariant.
 *
 * Three copies of this function existed — one in `routes/codex.ts`, one in
 * `routes/uploads.ts`, and the gap in `uploads/janitor.ts` where a third was
 * missing — with comments in two of them promising to keep in step. One home
 * removes the drift: a surface that starts logging a raw `fs` error is now the
 * only kind of regression left, and it is visible in review as an `{ err }`.
 *
 * The output is bounded by construction. `UploadStorageError.reason` and
 * `ApiHttpError.code` are drawn from fixed sets, and the errno branch admits
 * only up to 32 characters of upper-case, digits and underscore — so no
 * attacker-influenced `code` can smuggle a path through it.
 */
export function uploadErrorReason(error: unknown): string {
  if (error instanceof UploadStorageError) return error.reason;
  if (error instanceof ApiHttpError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  }
  return "unknown";
}
