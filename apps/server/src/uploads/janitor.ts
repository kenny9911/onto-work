import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { HarnessConfig } from "../config.js";
import { UPLOAD_RESERVATION_LEASE_MS } from "../database.js";
import type { HarnessStore } from "../database.js";
import { sweepStaged } from "./blob.js";
import {
  isWithinDirectory,
  listUserUploadDirectories,
  resolveStorageKey,
  uploadUserDirectoryKey,
} from "./paths.js";
import { uploadErrorReason } from "./redaction.js";

/**
 * Lifecycle reclamation for the durable upload store.
 *
 * Three jobs, all of them about bytes the request path could not remove
 * itself, and none of them able to touch a byte outside `UPLOAD_DATA_DIR`:
 *
 * 1. **Boot sweep** (`sweepStagedOnBoot`) — staged plaintext and in-flight
 *    scratch files are definitionally dead the moment the process starts, so
 *    everything under `staged/` and every `tmp/*.part` goes.
 * 2. **Periodic pass** (`startUploadJanitor` → `runUploadJanitorPass`) —
 *    expired rows and their blobs, blob files no live row names, and scratch
 *    files older than a reservation lease.
 * 3. **Tenant deletion** (`deleteTenantUploadTree`) — removes a tenant's user
 *    shards, and must run *before* the row cascade that would otherwise erase
 *    the user ids the shard keys are derived from.
 *
 * ## Confinement
 *
 * Every unlink in this module is confined to the store, and the confinement is
 * enforced twice over, because a janitor is the one component whose whole
 * purpose is deleting files it did not just create:
 *
 * - **Paths are re-derived, never trusted.** A blob to unlink comes from a
 *   row's `storage_key` through `resolveStorageKey`, which regex-validates the
 *   whole key and then re-joins it onto the canonical store root. Directory
 *   listings only ever contribute a single name component, matched against a
 *   fixed shape.
 * - **A symlink can never redirect an unlink.** `unlink` does not follow a
 *   final symlink but *does* follow every symlink in the directory components
 *   above it, so a symlinked shard directory would otherwise turn a contained
 *   path into an arbitrary one. Before any unlink the parent directory is
 *   `realpath`ed and re-checked for containment, and the entry itself is
 *   `lstat`ed and must be a regular file. Traversal likewise recurses only
 *   into entries that are real directories — a symlink to a directory reports
 *   `isDirectory() === false` from `readdir(withFileTypes)`, so it is never
 *   walked.
 * - **Nothing this module did not create is removed.** A symlink found inside
 *   the tree is left exactly where it is and counted as refused. Following it
 *   would be a data-loss bug; removing it is not the janitor's call.
 *
 * ## Errors
 *
 * A janitor that throws is worse than a janitor that skips a file: an
 * unhandled rejection inside a timer takes the server down, and a sweep
 * failure inside `buildApp` would refuse to boot over garbage collection. Both
 * entry points therefore swallow and log, and a failure on one shard never
 * stops the others.
 */

/** Interval between janitor passes. */
export const UPLOAD_JANITOR_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * How long a `tmp/*.part` may sit before the periodic pass reclaims it.
 *
 * The reservation lease is the ceiling on a legitimate in-flight upload — the
 * route's own wall-clock cap is far shorter — so a scratch file untouched for
 * that long belongs to a request that is gone. The boot sweep needs no such
 * grace: nothing can be in flight before the server accepts connections.
 */
export const UPLOAD_PART_GRACE_MS = UPLOAD_RESERVATION_LEASE_MS;

/**
 * Batches of `expireUploads` a single pass will drain. `expireUploads` caps
 * itself at 200 rows, so this bounds one pass at 2000 rows and lets a backlog
 * clear over successive passes rather than in one long-running transaction
 * loop.
 */
const MAX_EXPIRY_BATCHES = 10;

/** `blobs/<xx>/` shard directory names, and nothing else, are walked. */
const BLOB_SHARD_PATTERN = /^[0-9a-f]{2}$/;
/** Blob filenames are the server-generated upload UUID. */
const BLOB_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART_FILE_SUFFIX = ".part";

export interface UploadStoreDeps {
  store: HarnessStore;
  config: HarnessConfig;
}

export interface UploadJanitorDeps extends UploadStoreDeps {
  logger: FastifyBaseLogger;
}

export interface UploadJanitorHandle {
  stop(): void;
}

/** What one pass reclaimed. Returned for tests and logged when non-zero. */
export interface UploadJanitorReport {
  /** Rows `expireUploads` released or tombstoned. */
  expiredRows: number;
  /** Blobs unlinked because their row expired. */
  expiredBlobs: number;
  /** Blob files no live row named. */
  orphanBlobs: number;
  /** `tmp/*.part` scratch files past the grace period. */
  staleParts: number;
  /** Entries left alone because they were not a contained regular file. */
  refused: number;
}

function emptyReport(): UploadJanitorReport {
  return { expiredRows: 0, expiredBlobs: 0, orphanBlobs: 0, staleParts: 0, refused: 0 };
}

function reportIsEmpty(report: UploadJanitorReport): boolean {
  return (
    report.expiredRows === 0 &&
    report.expiredBlobs === 0 &&
    report.orphanBlobs === 0 &&
    report.staleParts === 0 &&
    report.refused === 0
  );
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The canonical store root, or `null` when the store does not exist yet.
 *
 * `assertUploadStoreIsolated` creates it at boot, so `null` here means a
 * deployment that has never accepted an upload — nothing to reclaim.
 */
async function canonicalStoreRoot(config: HarnessConfig): Promise<string | null> {
  try {
    return await realpath(resolve(config.uploadDataDir));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * `realpath` a directory and require the result to still be inside `root`.
 *
 * This is the check that stops a symlinked directory component from
 * redirecting a later `unlink` out of the store. `escaped` is kept distinct
 * from `missing` because the two mean very different things: an absent
 * directory is the normal state of a store nobody has used yet, while a
 * directory that resolves outside the store is something a caller should
 * refuse loudly rather than skip quietly.
 */
type ResolvedDirectory =
  | { ok: true; path: string }
  | { ok: false; reason: "missing" | "escaped" };

async function canonicalDirectoryWithin(
  root: string,
  directory: string,
): Promise<ResolvedDirectory> {
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    throw error;
  }
  return isWithinDirectory(root, canonical)
    ? { ok: true, path: canonical }
    : { ok: false, reason: "escaped" };
}

type UnlinkOutcome = "unlinked" | "missing" | "refused";

/**
 * Removes one regular file, having first re-derived its directory through
 * `realpath` and confirmed the entry is not a symlink.
 *
 * `refused` means the path was not a contained regular file — a symlink, a
 * directory, a shard reached through a symlink. Refusals are counted and
 * logged, never followed and never forced.
 */
async function unlinkContainedFile(root: string, filePath: string): Promise<UnlinkOutcome> {
  const name = basename(filePath);
  if (name === "" || name === "." || name === ".." || name.includes(sep)) return "refused";

  const parent = await canonicalDirectoryWithin(root, dirname(filePath));
  if (!parent.ok) return parent.reason === "escaped" ? "refused" : "missing";

  const target = join(parent.path, name);
  if (!isWithinDirectory(root, target)) return "refused";

  try {
    // lstat, not stat: a symlink here must be reported as a symlink, not as
    // whatever it points at.
    const info = await lstat(target);
    if (!info.isFile()) return "refused";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "missing";
    throw error;
  }

  try {
    await unlink(target);
    return "unlinked";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

interface DiscoveredBlob {
  /** Absolute path, with every directory component already canonicalized. */
  path: string;
  /** The blob filename, which is the upload id. */
  uploadId: string;
}

/**
 * Every regular file under one shard's `blobs/`, two levels deep and no
 * further. Symlinks, stray directories and oddly named entries are counted as
 * refused rather than walked.
 */
async function listShardBlobs(
  root: string,
  userDir: string,
  report: UploadJanitorReport,
): Promise<DiscoveredBlob[]> {
  const blobsDir = await canonicalDirectoryWithin(root, join(userDir, "blobs"));
  if (!blobsDir.ok) {
    if (blobsDir.reason === "escaped") report.refused += 1;
    return [];
  }

  const found: DiscoveredBlob[] = [];
  const shards = await readdir(blobsDir.path, { withFileTypes: true });
  for (const shard of shards) {
    // A symlink to a directory is not a directory here, so it is never walked.
    if (!shard.isDirectory() || !BLOB_SHARD_PATTERN.test(shard.name)) {
      report.refused += 1;
      continue;
    }
    const shardDir = await canonicalDirectoryWithin(root, join(blobsDir.path, shard.name));
    if (!shardDir.ok) {
      report.refused += 1;
      continue;
    }
    for (const entry of await readdir(shardDir.path, { withFileTypes: true })) {
      if (!entry.isFile() || !BLOB_FILE_PATTERN.test(entry.name)) {
        report.refused += 1;
        continue;
      }
      found.push({ path: join(shardDir.path, entry.name), uploadId: entry.name });
    }
  }
  return found;
}

/**
 * The set of paths — and, as a second belt, upload ids — a live row protects.
 *
 * Matching on the resolved path is the real test. The id set exists because a
 * `storage_key` that does not parse cannot be resolved to a path, and a live
 * row whose key is shaped unexpectedly must still not lose its blob: the blob
 * filename *is* the upload id, so refusing to unlink any file named after a
 * live row is a cheap, strictly conservative backstop.
 */
interface LiveBlobs {
  paths: Set<string>;
  uploadIds: Set<string>;
}

function liveBlobs(store: HarnessStore, root: string): LiveBlobs {
  const paths = new Set<string>();
  const uploadIds = new Set<string>();
  for (const storageKey of store.listLiveUploadStorageKeys()) {
    uploadIds.add(basename(storageKey));
    try {
      paths.add(resolveStorageKey(root, storageKey));
    } catch {
      // Unparseable key: the id set above is what protects this row's blob.
    }
  }
  return { paths, uploadIds };
}

/** Removes `tmp/*.part` files older than `graceMs`; `0` sweeps all of them. */
async function sweepTemporaryParts(
  root: string,
  userDir: string,
  graceMs: number,
  report: UploadJanitorReport,
): Promise<void> {
  const tmpDir = await canonicalDirectoryWithin(root, join(userDir, "tmp"));
  if (!tmpDir.ok) {
    if (tmpDir.reason === "escaped") report.refused += 1;
    return;
  }

  const deadline = Date.now() - graceMs;
  for (const entry of await readdir(tmpDir.path, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(PART_FILE_SUFFIX)) {
      report.refused += 1;
      continue;
    }
    const path = join(tmpDir.path, entry.name);
    if (graceMs > 0) {
      try {
        // A scratch file being written right now has a fresh mtime.
        const info = await lstat(path);
        if (info.mtimeMs > deadline) continue;
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        throw error;
      }
    }
    const outcome = await unlinkContainedFile(root, path);
    if (outcome === "unlinked") report.staleParts += 1;
    else if (outcome === "refused") report.refused += 1;
  }
}

/**
 * One reclamation pass. Exported so tests can drive it deterministically
 * instead of waiting on a timer.
 *
 * Order matters in two places:
 *
 * - Expiry runs first, so rows it releases are already gone from the live
 *   snapshot the orphan sweep takes.
 * - The orphan sweep **lists the filesystem before it snapshots live rows**. A
 *   row is inserted before its blob is written, so a snapshot taken second is
 *   a superset of what the walk saw, and an upload that began mid-pass cannot
 *   be mistaken for an orphan. Taking the snapshot first would make that race
 *   delete a live customer file.
 */
export async function runUploadJanitorPass(
  deps: UploadJanitorDeps,
  options: { signal?: { aborted: boolean } } = {},
): Promise<UploadJanitorReport> {
  const report = emptyReport();
  const root = await canonicalStoreRoot(deps.config);
  if (root === null) return report;

  for (let batch = 0; batch < MAX_EXPIRY_BATCHES; batch += 1) {
    if (options.signal?.aborted) return report;
    const expired = deps.store.expireUploads();
    if (expired.length === 0) break;
    report.expiredRows += expired.length;
    for (const row of expired) {
      let blobPath: string;
      try {
        blobPath = resolveStorageKey(root, row.storageKey);
      } catch (error) {
        // A row whose key does not parse names no file we can safely remove.
        deps.logger.warn(
          { uploadId: row.id, reason: uploadErrorReason(error) },
          "upload storage key could not be resolved for reclamation",
        );
        report.refused += 1;
        continue;
      }
      const outcome = await unlinkContainedFile(root, blobPath);
      if (outcome === "unlinked") report.expiredBlobs += 1;
      else if (outcome === "refused") report.refused += 1;
    }
  }

  // `listUserUploadDirectories` reads `<root>/users` without canonicalizing
  // it; the shard-level checks below would catch an escape anyway, but a
  // redirected `users` is worth refusing outright and saying so.
  const usersDir = await canonicalDirectoryWithin(root, join(root, "users"));
  if (!usersDir.ok) {
    if (usersDir.reason === "escaped") {
      deps.logger.warn("upload store users directory resolves outside the store; sweep refused");
      report.refused += 1;
    }
    return report;
  }

  const userDirs = await listUserUploadDirectories(root);
  const discovered: DiscoveredBlob[] = [];
  for (const userDir of userDirs) {
    if (options.signal?.aborted) return report;
    try {
      discovered.push(...(await listShardBlobs(root, userDir, report)));
    } catch (error) {
      // One unreadable shard must not cost the sweep of every other one.
      deps.logger.warn(
        { reason: uploadErrorReason(error) },
        "upload blob walk failed for one shard",
      );
    }
  }

  if (discovered.length > 0) {
    const live = liveBlobs(deps.store, root);
    for (const blob of discovered) {
      if (options.signal?.aborted) return report;
      if (live.paths.has(blob.path) || live.uploadIds.has(blob.uploadId)) continue;
      const outcome = await unlinkContainedFile(root, blob.path);
      if (outcome === "unlinked") report.orphanBlobs += 1;
      else if (outcome === "refused") report.refused += 1;
    }
  }

  for (const userDir of userDirs) {
    if (options.signal?.aborted) return report;
    try {
      await sweepTemporaryParts(root, userDir, UPLOAD_PART_GRACE_MS, report);
    } catch (error) {
      deps.logger.warn(
        { reason: uploadErrorReason(error) },
        "upload scratch sweep failed for one shard",
      );
    }
  }

  return report;
}

/**
 * Unlinks staged plaintext and in-flight scratch files left behind by a
 * process that died mid-turn.
 *
 * Staged files are never durable: they exist for exactly one turn, and the
 * Codex child cannot write, so it can never clean up after itself. Anything
 * under any `<uploadDataDir>/users/<key>/staged` directory at boot is, by
 * definition, orphaned — and so is any `tmp/*.part`, since no upload can be in
 * flight before the server accepts connections. That is why this sweep needs
 * no grace period and no database lookup.
 *
 * Called from `buildApp` behind the `ownsStore` guard, alongside
 * `reconcileOrphanedUsageReservations`. It never throws — a sweep failure is a
 * logged warning, not a refusal to start.
 */
export async function sweepStagedOnBoot(deps: UploadJanitorDeps): Promise<void> {
  try {
    const root = await canonicalStoreRoot(deps.config);
    if (root === null) return;

    // `sweepStaged` walks `<root>/users/*` itself, so the one containment
    // check it cannot make is on `users` — verify it here before delegating.
    const usersDir = await canonicalDirectoryWithin(root, join(root, "users"));
    if (!usersDir.ok) {
      if (usersDir.reason === "escaped") {
        deps.logger.warn("upload store users directory resolves outside the store; sweep refused");
      }
      return;
    }

    const stagedFiles = await sweepStaged(root);
    const report = emptyReport();
    for (const userDir of await listUserUploadDirectories(root)) {
      try {
        await sweepTemporaryParts(root, userDir, 0, report);
      } catch (error) {
        // One unreadable shard must not cost the sweep of every other one.
        deps.logger.warn(
          { reason: uploadErrorReason(error) },
          "upload scratch sweep failed for one shard",
        );
      }
    }

    if (stagedFiles > 0 || report.staleParts > 0 || report.refused > 0) {
      deps.logger.info(
        { stagedFiles, scratchFiles: report.staleParts, refused: report.refused },
        "orphaned upload plaintext reclaimed at boot",
      );
    }
  } catch (error) {
    deps.logger.warn({ reason: uploadErrorReason(error) }, "staged upload sweep failed");
  }
}

/**
 * Starts the periodic reclaim pass: expired `reserving` rows and their partial
 * blobs, expired durable rows' blobs, blob files with no live row, and stale
 * scratch files.
 *
 * The timer is `.unref()`d so it never holds the process open, passes never
 * overlap themselves, and every error is swallowed and logged — an unhandled
 * rejection inside a timer takes the server down.
 */
export function startUploadJanitor(deps: UploadJanitorDeps): UploadJanitorHandle {
  const signal = { aborted: false };
  let running = false;

  const tick = async (): Promise<void> => {
    // A pass that outlives its interval must not race the next one.
    if (running || signal.aborted) return;
    running = true;
    try {
      const report = await runUploadJanitorPass(deps, { signal });
      if (!reportIsEmpty(report)) {
        deps.logger.info(report, "upload janitor pass reclaimed storage");
      }
    } catch (error) {
      deps.logger.warn({ reason: uploadErrorReason(error) }, "upload janitor pass failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, UPLOAD_JANITOR_INTERVAL_MS);
  timer.unref();

  return {
    stop() {
      signal.aborted = true;
      clearInterval(timer);
    },
  };
}

/**
 * Removes every upload shard belonging to a tenant.
 *
 * **Call this before the row cascade, never after.** Shard directories are
 * named `sha256("tenant-user-" + sha256(tenantId + "\0" + userId))`, so the
 * only way to find a tenant's shards is to enumerate its users — and
 * `ON DELETE CASCADE` from `users` erases exactly the ids this derivation
 * needs. Deleting the rows first leaves the ciphertext on disk with nothing
 * left that can name it.
 *
 * Returns the number of shards removed. Confined like everything else here:
 * the `users` directory is canonicalized and containment-checked, and a shard
 * that is not a real directory is refused rather than followed.
 */
export async function deleteTenantUploadTree(
  deps: UploadStoreDeps,
  tenantId: string,
): Promise<number> {
  const root = await canonicalStoreRoot(deps.config);
  if (root === null) return 0;
  const usersDir = await canonicalDirectoryWithin(root, join(root, "users"));
  if (!usersDir.ok) return 0;

  let removed = 0;
  for (const user of deps.store.listUsers(tenantId)) {
    const shard = join(usersDir.path, uploadUserDirectoryKey(tenantId, user.id));
    if (!isWithinDirectory(usersDir.path, shard)) continue;
    try {
      // lstat: a symlink standing in for a shard is refused, not followed.
      const info = await lstat(shard);
      if (!info.isDirectory()) continue;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw error;
    }
    // `rm` unlinks symlinks it meets rather than following them, so a link
    // planted inside a shard costs its own entry and nothing outside.
    await rm(shard, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
