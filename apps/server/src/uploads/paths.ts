import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { UploadContentType } from "@agent-harness/contracts";

/**
 * Path derivation for the durable upload store.
 *
 * Every path in this module is built from server-generated values only. No
 * byte the client supplied — not the tenant id, not the user id, not the
 * display filename, not the declared content type — ever becomes a path
 * component. The client's label is a display string that lives in the database
 * and never reaches the filesystem.
 *
 * Layout, all directories 0700:
 *
 * ```
 * <uploadDataDir>/
 *   users/<userDirectoryKey>/
 *     blobs/<uploadId[0:2]>/<uploadId>          0400  AES-256-GCM ciphertext
 *     tmp/<uuid>.part                           0600  in-flight only
 *     staged/<sha256(threadId)>/<uploadId>.<ext> 0400 plaintext, one turn only
 * ```
 *
 * `userDirectoryKey` is the **same double hash** the Codex runtime shard uses,
 * so the two per-user trees are keyed identically and neither can be walked
 * back to a tenant or user id:
 *
 * 1. `CodexHarnessAdapter.runtimeKey` (`codex/adapter.ts`) builds
 *    `"tenant-user-" + sha256(tenantId + "\0" + userId)`.
 * 2. `prepareUserRuntimePaths` (`codex/config.ts`) hashes that again to get the
 *    directory component: `sha256(runtimeKey)`.
 *
 * `uploadUserDirectoryKey` reproduces both steps. `paths.test.ts` pins the two
 * implementations against each other so a change to either is caught.
 *
 * The store itself is kept outside every entry of `ALLOWED_WORKSPACE_ROOTS` by
 * `assertUploadStoreIsolated` in `app.ts`. That is a hygiene and lifecycle
 * boundary — uploads stay out of `git status` and out of a `review/start`
 * `uncommittedChanges` target — never a containment one; see `blob.ts`.
 *
 * ## Confinement: real paths, not joined strings
 *
 * A string built with `join` says nothing about what the kernel will do with
 * it. `mkdir -p`, `chmod`, `open` and `rename` all follow a symlink sitting in
 * a *directory* component, so a link planted where `users/`, `blobs/`,
 * `blobs/<xx>/`, `tmp/`, `staged/` or `staged/<hash>/` belongs would redirect
 * a "contained" path anywhere on the disk — publishing a blob outside the
 * store and dragging an unrelated directory down to 0700 on the way. `O_EXCL`
 * in `blob.ts` protects the *leaf* name only; it says nothing about the
 * directories above it.
 *
 * So this module never trusts a joined string:
 *
 * - **The store root is the only path allowed to be a symlink.** It is
 *   operator configuration (putting the store on another volume is a
 *   legitimate thing to do), so it is `mkdir -p`ed and then `realpath`ed once;
 *   the canonical result is the root every later check measures against, and
 *   it travels on `UserUploadPaths.storeRoot`.
 * - **Everything below the root is created one component at a time.**
 *   `mkdir` without `recursive` never follows a link at the name it is
 *   creating — a planted symlink is `EEXIST`, not a traversal — and each
 *   component is then required to `realpath` to *itself* and to sit inside the
 *   canonical root. `realpath` resolves the whole chain, so equality is a
 *   complete statement that no component between the root and this directory
 *   is a symlink.
 * - **The 0700 mode is set through a descriptor, not a path.** The directory
 *   is opened `O_DIRECTORY|O_NOFOLLOW` and `fchmod`ed, so a link swapped in
 *   after the check cannot receive the `chmod`.
 * - **The check is re-run immediately before each use**, because a directory
 *   verified at the start of a 20 MiB upload is not a directory verified at
 *   the `rename` that ends it.
 *
 * This is the write-path counterpart of the reclamation-path confinement in
 * `janitor.ts`, which `realpath`s a parent and `lstat`s the entry before every
 * unlink. The two differ in one deliberate way: the janitor tolerates a
 * symlink that stays inside the store, while this module refuses every symlink
 * below the root outright. Nothing here should ever meet one — every directory
 * under the root was created by this module — so meeting one means something
 * planted it, and the fail-closed answer is `unsafe_path`.
 */

const USER_DIRECTORY_PREFIX = "tenant-user-";
const MAX_IDENTIFIER_LENGTH = 512;

/** Lowercase hex UUID, the shape `randomUUID()` produces. */
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_DIRECTORY_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** `users/<64 hex>/blobs/<2 hex>/<uuid>` and nothing else. */
const STORAGE_KEY_PATTERN =
  /^users\/[0-9a-f]{64}\/blobs\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type UploadStorageErrorReason =
  /** A tenant, user, thread, or upload id is empty, over-long, or malformed. */
  | "invalid_identifier"
  /** No extension is defined for the given content type. */
  | "unsupported_content_type"
  /** A derived path escaped the directory that must contain it. */
  | "unsafe_path"
  /** `open(…, "wx")` refused: something already occupies the target name. */
  | "target_exists"
  /** `fstat` reported more than one link to the descriptor we just created. */
  | "hard_link"
  /** `fstat` reported the descriptor is not a regular file. */
  | "not_a_regular_file"
  /** A GCM authentication tag or a wrapped data key failed to verify. */
  | "integrity"
  /** Decrypt-to-staging failed for any other reason. */
  | "staging_failed";

/**
 * Storage-layer failure with a machine-readable reason.
 *
 * These modules are pure — no HTTP, no database — so they do not throw
 * `ApiHttpError`; `routes/uploads.ts` maps `reason` onto the design's status
 * codes (`integrity` and `staging_failed` → `500 upload_staging_failed`,
 * everything else → `500 internal_error`). Messages carry a basename at most,
 * never a full path, because upload errors are logged.
 */
export class UploadStorageError extends Error {
  readonly reason: UploadStorageErrorReason;

  constructor(reason: UploadStorageErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UploadStorageError";
    this.reason = reason;
  }
}

/** Fixed sniffed-type → extension map. The client label never contributes. */
export const UPLOAD_FILE_EXTENSIONS: Readonly<Record<UploadContentType, string>> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "application/x-ndjson": "ndjson",
  "application/xml": "xml",
};

// A Map, not the record itself: lookups take an arbitrary string (a database
// column is only length-checked), and a Map has no prototype chain to walk.
const EXTENSION_BY_CONTENT_TYPE = new Map<string, string>(
  Object.entries(UPLOAD_FILE_EXTENSIONS),
);

export interface UploadUserIdentity {
  tenantId: string;
  userId: string;
}

export interface UserUploadPaths {
  /**
   * The `realpath`ed store root. Carried so that every later step can re-assert
   * containment against a canonical reference instead of a joined string; see
   * the confinement notes above.
   */
  readonly storeRoot: string;
  /** `sha256("tenant-user-" + sha256(tenantId + "\0" + userId))`. */
  readonly userDirectoryKey: string;
  readonly userDir: string;
  readonly blobsDir: string;
  readonly tmpDir: string;
  readonly stagedDir: string;
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UploadStorageError("invalid_identifier", `${field} must not be empty`);
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new UploadStorageError("invalid_identifier", `${field} is too long`);
  }
  return value;
}

function requireUploadId(uploadId: string): string {
  if (typeof uploadId !== "string" || !UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new UploadStorageError(
      "invalid_identifier",
      "uploadId must be a lowercase hex UUID generated by the control plane",
    );
  }
  return uploadId;
}

function requireUserDirectoryKey(userDirectoryKey: string): string {
  if (typeof userDirectoryKey !== "string" || !USER_DIRECTORY_KEY_PATTERN.test(userDirectoryKey)) {
    throw new UploadStorageError("invalid_identifier", "userDirectoryKey must be a sha256 digest");
  }
  return userDirectoryKey;
}

/** Containment test, identical in behaviour to the one in `codex/config.ts`. */
export function isWithinDirectory(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function assertWithin(root: string, candidate: string, label: string): string {
  if (!isWithinDirectory(root, candidate)) {
    throw new UploadStorageError("unsafe_path", `Unable to derive a safe ${label} path`);
  }
  return candidate;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The outcome of resolving a directory, with `missing` kept distinct from
 * `escaped` for the same reason `janitor.ts` keeps them apart: an absent
 * directory is the ordinary state of a shard nobody has used yet, while one
 * that resolves elsewhere is something a caller must refuse loudly.
 */
export type ResolvedUploadDirectory =
  | { ok: true; path: string }
  | { ok: false; reason: "missing" | "escaped" };

/**
 * Resolves `directory` and requires it to be *itself* — no symlink anywhere
 * between `root` and it — and to sit inside `root`.
 *
 * `realpath` walks every component, so `canonical === directory` is a complete
 * statement about the whole chain, given a `root` that is already canonical.
 * The containment test is then made against the resolved path rather than the
 * string a caller happened to build.
 */
export async function resolveDirectoryWithin(
  root: string,
  directory: string,
): Promise<ResolvedUploadDirectory> {
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    throw error;
  }
  return canonical === directory && isWithinDirectory(root, canonical)
    ? { ok: true, path: canonical }
    : { ok: false, reason: "escaped" };
}

/** `resolveDirectoryWithin`, as an assertion. A missing directory is unsafe too. */
async function assertDirectoryWithin(
  root: string,
  directory: string,
  label: string,
): Promise<string> {
  const resolved = await resolveDirectoryWithin(root, directory);
  if (!resolved.ok) {
    throw new UploadStorageError("unsafe_path", `Unable to derive a safe ${label} path`);
  }
  return resolved.path;
}

/**
 * `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`: a symlink at the final component fails
 * the open (`ELOOP` on Linux, `ENOTDIR` on macOS) instead of being followed,
 * and a non-directory fails it too.
 */
const PRIVATE_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

/**
 * Pins an existing directory to 0700 through a descriptor.
 *
 * `chmod` by path would follow a symlink swapped in between the containment
 * check and the call; `fchmod` on a descriptor opened `O_NOFOLLOW` cannot. The
 * `fstat` is belt to the open's braces.
 *
 * Any failure to open becomes `unsafe_path`: this is the step that proves the
 * directory is what it claims to be, so not being able to prove it is a
 * refusal, whatever the errno. The original is kept as `cause`.
 */
async function pinPrivateDirectory(directory: string, label: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(directory, PRIVATE_DIRECTORY_FLAGS);
  } catch (error) {
    throw new UploadStorageError(
      "unsafe_path",
      `Unable to derive a safe ${label} path`,
      { cause: error },
    );
  }
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new UploadStorageError("unsafe_path", `Unable to derive a safe ${label} path`);
    }
    // mkdir's mode is masked by umask and does not update a pre-existing path.
    await handle.chmod(0o700);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Creates one 0700 directory named `name` directly under `parent`, and returns
 * its path.
 *
 * `mkdir` is deliberately **not** recursive: a link already occupying `name`
 * fails with `EEXIST` rather than being traversed, so nothing outside the
 * store is ever created. The parent is verified before the `mkdir` so a
 * redirected parent cannot host the new directory, and the result is verified
 * after it so a redirected `name` cannot be adopted.
 */
async function createPrivateChild(
  root: string,
  parent: string,
  name: string,
  label: string,
): Promise<string> {
  // One component, and a real one: `sep` for this platform, plus a literal
  // "/" so a POSIX separator is rejected wherever this runs.
  const separated = name.includes(sep) || name.includes("/");
  if (name === "" || name === "." || name === ".." || separated) {
    throw new UploadStorageError("unsafe_path", `Unable to derive a safe ${label} path`);
  }
  const canonicalParent = await assertDirectoryWithin(root, parent, label);
  const directory = assertWithin(root, join(canonicalParent, name), label);

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }

  await assertDirectoryWithin(root, directory, label);
  await pinPrivateDirectory(directory, label);
  return directory;
}

/**
 * Creates and canonicalizes the store root.
 *
 * The root is the one path in the store allowed to be a symlink: it is
 * operator configuration, its parents may legitimately not exist yet, and
 * pointing it at another volume is a reasonable deployment. `realpath` is what
 * turns that freedom into the fixed reference every check below it uses.
 */
async function prepareStoreRoot(uploadDataDir: string): Promise<string> {
  const baseDir = resolve(uploadDataDir);
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const canonical = await realpath(baseDir);
  await pinPrivateDirectory(canonical, "upload store");
  return canonical;
}

/**
 * The per-user storage shard key: the same double sha256 that names the Codex
 * runtime directory for this identity. Keep in step with
 * `CodexHarnessAdapter.runtimeKey` and `prepareUserRuntimePaths`.
 */
export function uploadUserDirectoryKey(tenantId: string, userId: string): string {
  const runtimeKey = `${USER_DIRECTORY_PREFIX}${createHash("sha256")
    .update(requireIdentifier(tenantId, "tenantId"))
    .update("\0")
    .update(requireIdentifier(userId, "userId"))
    .digest("hex")}`;
  return createHash("sha256").update(runtimeKey).digest("hex");
}

/**
 * Creates (0700) and returns this user's shard. Idempotent, so callers may
 * invoke it on every request rather than caching a path across requests.
 */
export async function prepareUserUploadPaths(
  uploadDataDir: string,
  identity: UploadUserIdentity,
): Promise<UserUploadPaths> {
  const storeRoot = await prepareStoreRoot(uploadDataDir);
  const userDirectoryKey = uploadUserDirectoryKey(identity.tenantId, identity.userId);

  // One component at a time, each verified before it becomes the next one's
  // parent. A link planted at any level is `EEXIST` on the `mkdir` and then
  // `unsafe_path` on the check — never a traversal, and never a `chmod` that
  // lands outside the store.
  const usersDir = await createPrivateChild(storeRoot, storeRoot, "users", "users");
  const userDir = await createPrivateChild(
    storeRoot,
    usersDir,
    userDirectoryKey,
    "user upload directory",
  );
  const [blobsDir, tmpDir, stagedDir] = await Promise.all([
    createPrivateChild(storeRoot, userDir, "blobs", "blob"),
    createPrivateChild(storeRoot, userDir, "tmp", "scratch"),
    createPrivateChild(storeRoot, userDir, "staged", "staged"),
  ]);

  return { storeRoot, userDirectoryKey, userDir, blobsDir, tmpDir, stagedDir };
}

/**
 * The value stored in `uploads.storage_key`: a store-relative POSIX path, so a
 * row can be resolved without re-deriving the user hash and survives moving
 * `UPLOAD_DATA_DIR`.
 */
export function uploadStorageKey(userDirectoryKey: string, uploadId: string): string {
  requireUserDirectoryKey(userDirectoryKey);
  requireUploadId(uploadId);
  return `users/${userDirectoryKey}/blobs/${uploadId.slice(0, 2)}/${uploadId}`;
}

/**
 * Turns a stored `storage_key` back into an absolute path, shape-checked.
 *
 * The result is `resolve`d, not `realpath`ed, so it opens the right file but is
 * only string-equal to `blobPath` when `uploadDataDir` is already canonical.
 * Pass a realpath'd base when comparing the two.
 */
export function resolveStorageKey(uploadDataDir: string, storageKey: string): string {
  if (typeof storageKey !== "string" || !STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new UploadStorageError("unsafe_path", "storageKey is not a valid upload storage key");
  }
  const baseDir = resolve(uploadDataDir);
  return assertWithin(baseDir, join(baseDir, ...storageKey.split("/")), "blob");
}

/** Absolute path of an upload's ciphertext. Does not touch the filesystem. */
export function blobPath(paths: UserUploadPaths, uploadId: string): string {
  requireUploadId(uploadId);
  return assertWithin(
    paths.blobsDir,
    join(paths.blobsDir, uploadId.slice(0, 2), uploadId),
    "blob",
  );
}

/** `blobPath` plus the 0700 shard directory it lives in. */
export async function prepareBlobPath(
  paths: UserUploadPaths,
  uploadId: string,
): Promise<string> {
  const path = blobPath(paths, uploadId);
  await createPrivateChild(paths.storeRoot, paths.blobsDir, uploadId.slice(0, 2), "blob");
  return path;
}

/**
 * Re-asserts that a blob's shard directory is still a real directory inside
 * the store. `prepareBlobPath` proves this when the shard is created; a 20 MiB
 * upload then runs, and `rename` follows directory components, so the proof is
 * taken again immediately before the publish.
 */
export async function assertBlobShardWithin(
  paths: UserUploadPaths,
  uploadId: string,
): Promise<void> {
  requireUploadId(uploadId);
  await assertDirectoryWithin(
    paths.storeRoot,
    join(paths.blobsDir, uploadId.slice(0, 2)),
    "blob",
  );
}

/**
 * A fresh in-flight scratch name. Random rather than derived: it only reduces
 * predictability — the actual hard-link guard is the `nlink` assertion in
 * `blob.ts`.
 *
 * Does not touch the filesystem, so it makes no claim about `tmp/` itself;
 * callers that are about to *open* the result use `prepareTemporaryPartPath`.
 */
export function temporaryPartPath(paths: UserUploadPaths): string {
  return join(paths.tmpDir, `${randomUUID()}.part`);
}

/**
 * `temporaryPartPath` plus the proof that `tmp/` is still a real directory
 * inside the store. `open(…, "wx")` refuses a symlink at the scratch *name*,
 * but would happily create the file through a symlinked `tmp/`.
 */
export async function prepareTemporaryPartPath(paths: UserUploadPaths): Promise<string> {
  await assertDirectoryWithin(paths.storeRoot, paths.tmpDir, "scratch");
  return temporaryPartPath(paths);
}

/** The single path component a thread's staged plaintext lives under. */
function stagedThreadComponent(threadId: string): string {
  return createHash("sha256").update(requireIdentifier(threadId, "threadId")).digest("hex");
}

/** Staged plaintext lives under a hash of the thread id, never the id itself. */
export function stagedThreadDirectory(paths: UserUploadPaths, threadId: string): string {
  return assertWithin(
    paths.stagedDir,
    join(paths.stagedDir, stagedThreadComponent(threadId)),
    "staged",
  );
}

/**
 * Re-asserts that a thread's staged directory is a real directory inside the
 * store, returning `false` when it simply does not exist — the ordinary state
 * for a thread that has staged nothing, and for a second settle after
 * `unlinkStagedThread` removed it. Throws `unsafe_path` when it resolves
 * anywhere else.
 */
export async function assertStagedThreadDirectory(
  paths: UserUploadPaths,
  threadId: string,
): Promise<boolean> {
  const resolved = await resolveDirectoryWithin(
    paths.storeRoot,
    stagedThreadDirectory(paths, threadId),
  );
  if (resolved.ok) return true;
  if (resolved.reason === "missing") return false;
  throw new UploadStorageError("unsafe_path", "Unable to derive a safe staged path");
}

/**
 * The extension for a *sniffed* content type. Never call this with a client
 * label or a client-declared type: the argument is the server's own
 * classification, and an unknown value is a hard failure rather than a
 * fallback, so no untrusted string can select an extension.
 */
export function extensionForUploadContentType(contentType: string): string {
  const extension = EXTENSION_BY_CONTENT_TYPE.get(contentType);
  if (extension === undefined) {
    throw new UploadStorageError(
      "unsupported_content_type",
      "No staged-file extension is defined for that content type",
    );
  }
  return extension;
}

/** Absolute path of a turn's staged plaintext. Does not touch the filesystem. */
export function stagedPath(
  paths: UserUploadPaths,
  threadId: string,
  uploadId: string,
  contentType: string,
): string {
  const directory = stagedThreadDirectory(paths, threadId);
  requireUploadId(uploadId);
  const extension = extensionForUploadContentType(contentType);
  return assertWithin(directory, join(directory, `${uploadId}.${extension}`), "staged");
}

/** `stagedPath` plus the 0700 per-thread directory it lives in. */
export async function prepareStagedPath(
  paths: UserUploadPaths,
  threadId: string,
  uploadId: string,
  contentType: string,
): Promise<string> {
  const path = stagedPath(paths, threadId, uploadId, contentType);
  await createPrivateChild(
    paths.storeRoot,
    paths.stagedDir,
    stagedThreadComponent(threadId),
    "staged",
  );
  return path;
}

/**
 * Absolute paths of every user shard in the store, for boot sweeps and the
 * janitor. Entries that are not a well-formed shard key are ignored rather
 * than walked. A store with no `users` directory yields an empty list.
 */
export async function listUserUploadDirectories(uploadDataDir: string): Promise<string[]> {
  const usersDir = join(resolve(uploadDataDir), "users");
  try {
    const entries = await readdir(usersDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && USER_DIRECTORY_KEY_PATTERN.test(entry.name))
      .map((entry) => join(usersDir, entry.name));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}
