import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
import type { Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { decryptSecret, encryptSecret } from "../security.js";
import {
  UploadStorageError,
  assertBlobShardWithin,
  assertStagedThreadDirectory,
  blobPath,
  isWithinDirectory,
  listUserUploadDirectories,
  prepareBlobPath,
  prepareStagedPath,
  prepareTemporaryPartPath,
  resolveDirectoryWithin,
  stagedThreadDirectory,
  uploadStorageKey,
} from "./paths.js";
import type { UserUploadPaths } from "./paths.js";

/**
 * Encrypted blob I/O for the upload store: streaming AES-256-GCM in, streaming
 * AES-256-GCM out, atomic publish, staged-plaintext lifecycle.
 *
 * Nothing here buffers a file. `createCipheriv` / `createDecipheriv` are
 * Transform streams, so a 20 MiB upload costs one stream's worth of memory,
 * and the authentication tag is read after `final()` — after every byte has
 * passed through.
 *
 * ## What encryption at rest buys, and what it does not
 *
 * The Codex child has unconditional full-disk read on every platform
 * (`SandboxPolicy::has_full_disk_read_access()` returns `true` regardless of
 * policy). An injected agent can therefore walk `<UPLOAD_DATA_DIR>` and list
 * every user's shard. Directory mode 0700 is not a barrier: the child runs as
 * the same OS uid as the control plane.
 *
 * Encrypting blobs bounds steady-state exposure to ciphertext plus *one turn's*
 * staged plaintext in the reading user's own shard, and it keeps operator
 * backups and disk images from holding a plaintext corpus of customer
 * documents.
 *
 * It does **not** solve cross-tenant read, and this module should not be cited
 * as if it did. The per-upload data key is wrapped with the process-wide
 * `credentialEncryptionKey` that every request already holds, so anything able
 * to read the database and the process's key reads every blob. That gap is
 * pre-existing and wider than uploads — rollout transcripts and the SQLite file
 * are already readable by the same child — and it is ADR-0001 invariant 3,
 * whose real fix is a per-tenant OS uid or container. This module provides
 * confidentiality at rest, not tenant isolation.
 */

const DATA_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
/** OpenSSL's GCM tag failure, as surfaced by `decipher.final()`. */
const AUTHENTICATION_FAILURE = /unable to authenticate|bad decrypt/i;

export interface EncryptedBlobRecord {
  /** Store-relative key for `uploads.storage_key`. */
  storageKey: string;
  /** Absolute path of the published ciphertext. */
  path: string;
  /** Plaintext byte count, as counted on the way in. */
  sizeBytes: number;
  /** Plaintext sha256, hex, for `uploads.content_sha256`. */
  contentSha256: string;
  /** base64url, for `uploads.encryption_iv`. */
  encryptionIv: string;
  /** base64url, for `uploads.encryption_tag`. */
  encryptionTag: string;
  /** `encryptSecret`-wrapped data key, for `uploads.wrapped_data_key`. */
  wrappedDataKey: string;
}

export interface WriteEncryptedBlobInput {
  paths: UserUploadPaths;
  /** Server-generated upload UUID; also the blob's filename. */
  uploadId: string;
  source: Readable;
  /** `config.credentialEncryptionKey`. */
  encryptionSecret: string;
  /**
   * Extra streams spliced between `source` and the cipher, in order. The
   * upload route puts its byte-limit guard and its sniff tee here so a single
   * pipeline does all the work; see the design's
   * `pipeline(body, byteCounter, sha256Hasher, sniffTee, cipher, tmpFile)`.
   */
  transforms?: readonly Duplex[];
}

export interface StagedFile {
  path: string;
  sizeBytes: number;
  /**
   * Plaintext sha256 of what was staged. The GCM tag already proves the
   * ciphertext was not modified, so this is free defence in depth: comparing
   * it to `uploads.content_sha256` catches a row paired with the wrong blob,
   * which a partial restore could produce.
   */
  contentSha256: string;
}

export interface DecryptToStagedInput {
  paths: UserUploadPaths;
  uploadId: string;
  threadId: string;
  /** The **server-sniffed** type; it selects the staged file's extension. */
  contentType: string;
  /** `uploads.storage_key`; must name a blob in this user's own shard. */
  storageKey: string;
  encryptionSecret: string;
  encryptionIv: string;
  encryptionTag: string;
  wrappedDataKey: string;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * `fstat` the descriptor — never the path. A path `stat` reintroduces the
 * TOCTOU window that `O_EXCL` just closed.
 *
 * `nlink === 1` is the real hard-link guard: it proves nobody else holds a
 * name for the inode we are about to fill.
 */
export async function assertExclusiveFile(handle: FileHandle, path: string): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile()) {
    throw new UploadStorageError(
      "not_a_regular_file",
      `${basename(path)} is not a regular file`,
    );
  }
  if (info.nlink !== 1) {
    throw new UploadStorageError(
      "hard_link",
      `${basename(path)} has ${info.nlink} hard links; expected exactly 1`,
    );
  }
}

/**
 * Creates a scratch file that provably did not exist a moment ago.
 *
 * `open(path, "wx", 0o600)` is `O_CREAT|O_EXCL|O_WRONLY`, which refuses an
 * existing name and does not follow a final symlink — a symlink planted at the
 * target fails with `EEXIST` and its victim is never touched. The descriptor
 * is then `fstat`ed for `nlink === 1` and `isFile()`.
 *
 * That covers the **leaf name only**. Every directory component above it is
 * still followed, so callers must have proved the parent is a real directory
 * inside the store first — `prepareTemporaryPartPath` and `prepareBlobPath`
 * are what do that.
 */
export async function openExclusive(path: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      throw new UploadStorageError(
        "target_exists",
        `Refusing to write ${basename(path)}: the target name already exists`,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    await assertExclusiveFile(handle, path);
    // open's mode argument is masked by umask; pin it explicitly.
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    // Ours to remove: O_EXCL succeeded, so this name is one we just created.
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

interface DigestCounter {
  readonly stream: Duplex;
  /** Finalizes the digest; call exactly once, after the pipeline settles. */
  result(): { sizeBytes: number; contentSha256: string };
}

function digestCounter(): DigestCounter {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  // decodeStrings defaults to true, so chunks always arrive as Buffers.
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    result: () => ({ sizeBytes, contentSha256: hash.digest("hex") }),
  };
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new UploadStorageError("staging_failed", "The upload store accepted no bytes");
    }
    offset += bytesWritten;
  }
}

/**
 * A sink that writes through a descriptor we keep.
 *
 * Deliberately not `handle.createWriteStream()`: that stream owns the
 * FileHandle and closes it when it is destroyed — on the success path as well
 * as on error — which would take away the descriptor needed for the
 * `fstat`/`fsync`/`chmod` sequence that follows. Ownership stays with the
 * caller, which closes the handle exactly once.
 */
function fileHandleSink(handle: FileHandle): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeAll(handle, chunk).then(() => callback(), callback);
    },
  });
}

function unwrapDataKey(wrappedDataKey: string, encryptionSecret: string): Buffer {
  let dataKey: Buffer;
  try {
    dataKey = Buffer.from(decryptSecret(wrappedDataKey, encryptionSecret), "base64");
  } catch (error) {
    throw new UploadStorageError(
      "integrity",
      "The wrapped upload data key failed to decrypt",
      { cause: error },
    );
  }
  if (dataKey.byteLength !== DATA_KEY_BYTES) {
    dataKey.fill(0);
    throw new UploadStorageError("integrity", "The unwrapped upload data key has the wrong length");
  }
  return dataKey;
}

function asStagingError(error: unknown): Error {
  if (error instanceof UploadStorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (AUTHENTICATION_FAILURE.test(message)) {
    return new UploadStorageError(
      "integrity",
      "The stored upload failed its authentication tag; it was modified or truncated",
      { cause: error },
    );
  }
  return new UploadStorageError("staging_failed", "Failed to stage an upload for this turn", {
    cause: error,
  });
}

/**
 * Streams `source` into the upload's blob under AES-256-GCM and publishes it
 * atomically.
 *
 * The data key is fresh 32 random bytes per upload, wrapped with
 * `encryptSecret` under `config.credentialEncryptionKey`; the caller stores the
 * wrapped key, the IV, and the tag on the row. Finalization mirrors
 * `writeCodexConfig`: re-assert exclusivity, `fsync`, `chmod 0400`, atomic
 * `rename`. On any failure the scratch file is unlinked and nothing is
 * published.
 */
export async function writeEncryptedBlob(
  input: WriteEncryptedBlobInput,
): Promise<EncryptedBlobRecord> {
  const { paths, uploadId, source, encryptionSecret } = input;
  const destination = await prepareBlobPath(paths, uploadId);
  const temporaryPath = await prepareTemporaryPartPath(paths);

  const handle = await openExclusive(temporaryPath);
  const dataKey = randomBytes(DATA_KEY_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  let closed = false;

  try {
    const counter = digestCounter();
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    await pipeline([
      source,
      ...(input.transforms ?? []),
      counter.stream,
      cipher,
      fileHandleSink(handle),
    ]);
    const authTag = cipher.getAuthTag();

    // A hard link created while the write was in flight would leave someone
    // else holding this inode. They cannot guess the UUID, so this is a
    // theoretical race — but the row must not be committed if it happened.
    await assertExclusiveFile(handle, temporaryPath);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.close();
    closed = true;
    // `rename` follows directory components. The shard was proved real when it
    // was created, but 20 MiB of upload has flowed since; prove it again
    // rather than publishing into whatever now answers to that name.
    await assertBlobShardWithin(paths, uploadId);
    await rename(temporaryPath, destination);

    const { sizeBytes, contentSha256 } = counter.result();
    return {
      storageKey: uploadStorageKey(paths.userDirectoryKey, uploadId),
      path: destination,
      sizeBytes,
      contentSha256,
      encryptionIv: iv.toString("base64url"),
      encryptionTag: authTag.toString("base64url"),
      wrappedDataKey: encryptSecret(dataKey.toString("base64"), encryptionSecret),
    };
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => undefined);
      closed = true;
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    dataKey.fill(0);
  }
}

/**
 * Decrypts one blob into this turn's staged plaintext.
 *
 * The plaintext is written to a scratch file first, so `decipher.final()`
 * verifies the GCM tag **before** the staged name exists. A tampered or
 * truncated blob therefore fails with no path for anything to read. Only after
 * the tag verifies is the file `fsync`ed, `chmod 0400`ed, and renamed into
 * `staged/<sha256(threadId)>/<uploadId>.<ext>`.
 *
 * `storageKey` must be the key this user's own shard would produce for
 * `uploadId`. A row naming another shard is rejected before a byte is read,
 * so a confused-deputy row cannot pull a different user's blob into this
 * user's staging directory.
 *
 * Re-staging the same upload is idempotent: the rename replaces an identical
 * plaintext.
 */
export async function decryptToStaged(input: DecryptToStagedInput): Promise<StagedFile> {
  const { paths, uploadId, threadId, contentType, encryptionSecret } = input;

  if (input.storageKey !== uploadStorageKey(paths.userDirectoryKey, uploadId)) {
    throw new UploadStorageError(
      "unsafe_path",
      "storageKey does not belong to this user's upload shard",
    );
  }

  const source = blobPath(paths, uploadId);
  const destination = await prepareStagedPath(paths, threadId, uploadId, contentType);
  const temporaryPath = await prepareTemporaryPartPath(paths);
  const dataKey = unwrapDataKey(input.wrappedDataKey, encryptionSecret);

  let handle: FileHandle;
  try {
    handle = await openExclusive(temporaryPath);
  } catch (error) {
    dataKey.fill(0);
    throw asStagingError(error);
  }
  let closed = false;

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey,
      Buffer.from(input.encryptionIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(input.encryptionTag, "base64url"));
    const counter = digestCounter();
    await pipeline([
      createReadStream(source),
      decipher,
      counter.stream,
      fileHandleSink(handle),
    ]);

    await assertExclusiveFile(handle, temporaryPath);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.close();
    closed = true;
    // This is the one path that publishes readable customer bytes, so a
    // `rename` redirected by a directory component is plaintext disclosure.
    // Re-prove the staged directory immediately before it: a redirected one
    // throws `unsafe_path`, and one that simply vanished (a concurrent
    // reclaim) is an ordinary staging failure, not an escape.
    if (!(await assertStagedThreadDirectory(paths, threadId))) {
      throw new UploadStorageError(
        "staging_failed",
        "The staged directory no longer exists",
      );
    }
    await rename(temporaryPath, destination);

    const { sizeBytes, contentSha256 } = counter.result();
    return { path: destination, sizeBytes, contentSha256 };
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => undefined);
      closed = true;
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw asStagingError(error);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    dataKey.fill(0);
  }
}

/**
 * Removes one staged plaintext file. Returns `false` when it was already gone,
 * so a double settle is not an error. Refuses a path outside this user's
 * `staged` tree, which keeps a mis-wired caller from unlinking a blob.
 *
 * Containment is checked on the **resolved** parent, not on the joined string:
 * `unlink` does not follow a final symlink but does follow every directory
 * component above it, so a link planted at `staged/<hash>` would otherwise
 * turn a string that looks contained into a deletion anywhere on the disk.
 * This is the same sequence `janitor.ts` uses before every unlink, and for the
 * same reason.
 */
export async function unlinkStaged(
  paths: UserUploadPaths,
  stagedFilePath: string,
): Promise<boolean> {
  const name = basename(stagedFilePath);
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes(sep) ||
    !isWithinDirectory(paths.stagedDir, stagedFilePath)
  ) {
    throw new UploadStorageError("unsafe_path", "Refusing to unlink outside the staged directory");
  }

  const parent = await resolveDirectoryWithin(paths.storeRoot, dirname(stagedFilePath));
  if (!parent.ok) {
    // A thread whose staged directory is already gone has nothing staged; one
    // that resolves elsewhere is a plant, and is refused rather than followed.
    if (parent.reason === "missing") return false;
    throw new UploadStorageError("unsafe_path", "Refusing to unlink outside the staged directory");
  }

  const target = join(parent.path, name);
  if (!isWithinDirectory(paths.stagedDir, target)) {
    throw new UploadStorageError("unsafe_path", "Refusing to unlink outside the staged directory");
  }

  try {
    // lstat, not stat: a symlink here must read as a symlink, not as whatever
    // it points at. Staged plaintext is a regular file this module wrote.
    if (!(await lstat(target)).isFile()) {
      throw new UploadStorageError(
        "unsafe_path",
        "Refusing to unlink a staged entry that is not a regular file",
      );
    }
  } catch (error) {
    if (error instanceof UploadStorageError) throw error;
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }

  try {
    await unlink(target);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

interface TreeRemoval {
  removed: number;
  /** The directory resolved outside `root`, so nothing was walked or removed. */
  refused: boolean;
}

/**
 * Removes a staged directory, having first required it to resolve to itself
 * inside `root`.
 *
 * `rm` unlinks a symlink rather than following it, but `readdir(recursive)`
 * *does* follow one, so an unchecked call would report files outside the store
 * as reclaimed. A redirected directory is left exactly where it is: refusing
 * is not licence to delete what this module did not create.
 */
async function removeTree(root: string, directory: string): Promise<TreeRemoval> {
  const resolved = await resolveDirectoryWithin(root, directory);
  if (!resolved.ok) {
    return { removed: 0, refused: resolved.reason === "escaped" };
  }
  let removed: number;
  try {
    const entries = await readdir(resolved.path, { recursive: true, withFileTypes: true });
    removed = entries.filter((entry) => entry.isFile()).length;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { removed: 0, refused: false };
    throw error;
  }
  await rm(resolved.path, { recursive: true, force: true });
  return { removed, refused: false };
}

/**
 * Removes every staged plaintext for one thread and returns how many files
 * went. This is what `stopWatching` calls: it already runs on settle, on lease
 * expiry, and in the dispatch `catch`, and one thread has one live turn.
 *
 * Throws `unsafe_path` when the thread's staged directory resolves outside the
 * store — the caller logs it, and the residue is the janitor's problem, not
 * something to follow.
 */
export async function unlinkStagedThread(
  paths: UserUploadPaths,
  threadId: string,
): Promise<number> {
  const outcome = await removeTree(paths.storeRoot, stagedThreadDirectory(paths, threadId));
  if (outcome.refused) {
    throw new UploadStorageError(
      "unsafe_path",
      "Refusing to remove a staged directory that resolves outside the store",
    );
  }
  return outcome.removed;
}

/**
 * Boot sweep: removes the `staged` tree of every shard in the store and
 * returns the number of plaintext files reclaimed.
 *
 * Staged plaintext is never durable — it exists for exactly one turn, and the
 * Codex child cannot write, so it can never clean up after itself. Anything
 * still staged when the process starts is by definition orphaned by a process
 * that died mid-turn. Scratch `tmp/*.part` files are the janitor's business,
 * not this function's.
 */
export async function sweepStaged(uploadDataDir: string): Promise<number> {
  let root: string;
  try {
    root = await realpath(resolve(uploadDataDir));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const userDir of await listUserUploadDirectories(root)) {
    // A shard whose `staged` resolves outside the store is skipped, not thrown
    // on: this runs at boot across every shard, and one plant must not cost
    // the sweep of all the others.
    removed += (await removeTree(root, join(userDir, "staged"))).removed;
  }
  return removed;
}
