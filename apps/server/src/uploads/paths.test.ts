import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { UPLOAD_ALLOWED_CONTENT_TYPES } from "@agent-harness/contracts";

import { prepareUserRuntimePaths } from "../codex/config.js";
import {
  UPLOAD_FILE_EXTENSIONS,
  UploadStorageError,
  blobPath,
  extensionForUploadContentType,
  listUserUploadDirectories,
  prepareBlobPath,
  prepareStagedPath,
  prepareUserUploadPaths,
  resolveStorageKey,
  stagedPath,
  stagedThreadDirectory,
  temporaryPartPath,
  uploadStorageKey,
  uploadUserDirectoryKey,
} from "./paths.js";
import type { UserUploadPaths } from "./paths.js";

const TENANT_ID = "tenant-alpha";
const USER_ID = "user-42";
const THREAD_ID = "thread-abc";

function hasReason(reason: string) {
  return (error: unknown): true => {
    assert.ok(error instanceof UploadStorageError, `expected UploadStorageError, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  };
}

async function storeRoot(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-uploads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "uploads");
}

async function shard(t: { after(fn: () => unknown): void }): Promise<{
  store: string;
  paths: UserUploadPaths;
}> {
  const store = await storeRoot(t);
  const paths = await prepareUserUploadPaths(store, { tenantId: TENANT_ID, userId: USER_ID });
  return { store: await realpath(store), paths };
}

test("derives the same per-user shard key as the Codex runtime tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Step 1 is `CodexHarnessAdapter.runtimeKey`; step 2 is the hash
  // `prepareUserRuntimePaths` applies to whatever key it is handed. Pinning
  // against the real implementation catches drift in either half.
  const runtimeKey = `tenant-user-${createHash("sha256")
    .update(TENANT_ID)
    .update("\0")
    .update(USER_ID)
    .digest("hex")}`;
  const runtimePaths = await prepareUserRuntimePaths(join(root, "runtimes"), runtimeKey);

  assert.equal(uploadUserDirectoryKey(TENANT_ID, USER_ID), basename(runtimePaths.runtimeDir));
  assert.equal(uploadUserDirectoryKey(TENANT_ID, USER_ID), runtimePaths.userDirectoryKey);
  // The separator matters: it is what keeps ("ab","c") and ("a","bc") apart.
  assert.notEqual(
    uploadUserDirectoryKey("ab", "c"),
    uploadUserDirectoryKey("a", "bc"),
  );
});

test("lays out a 0700 shard whose paths contain no raw identifier", async (t) => {
  const { paths } = await shard(t);
  const uploadId = randomUUID();

  assert.match(basename(paths.userDir), /^[0-9a-f]{64}$/);
  for (const directory of [paths.userDir, paths.blobsDir, paths.tmpDir, paths.stagedDir]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  }

  const blob = await prepareBlobPath(paths, uploadId);
  assert.equal(blob, join(paths.blobsDir, uploadId.slice(0, 2), uploadId));
  assert.equal((await stat(dirname(blob))).mode & 0o777, 0o700);

  const staged = await prepareStagedPath(paths, THREAD_ID, uploadId, "text/csv");
  assert.equal(basename(staged), `${uploadId}.csv`);
  assert.equal(
    basename(dirname(staged)),
    createHash("sha256").update(THREAD_ID).digest("hex"),
  );
  assert.equal((await stat(dirname(staged))).mode & 0o777, 0o700);

  assert.match(basename(temporaryPartPath(paths)), /^[0-9a-f-]{36}\.part$/);

  for (const path of [paths.userDir, blob, staged, temporaryPartPath(paths)]) {
    assert.doesNotMatch(path, new RegExp(`${TENANT_ID}|${USER_ID}|${THREAD_ID}`));
  }
});

test("refuses identifiers that could escape the store", async (t) => {
  const { store, paths } = await shard(t);

  assert.throws(() => uploadUserDirectoryKey("", USER_ID), hasReason("invalid_identifier"));
  assert.throws(() => uploadUserDirectoryKey(TENANT_ID, "   "), hasReason("invalid_identifier"));
  assert.throws(
    () => uploadUserDirectoryKey(TENANT_ID, "u".repeat(513)),
    hasReason("invalid_identifier"),
  );

  for (const uploadId of [
    "../../etc/passwd",
    "..",
    "not-a-uuid",
    `${randomUUID()}/x`,
    randomUUID().toUpperCase(),
    "",
  ]) {
    assert.throws(() => blobPath(paths, uploadId), hasReason("invalid_identifier"), uploadId);
  }

  assert.throws(() => stagedThreadDirectory(paths, ""), hasReason("invalid_identifier"));
  assert.throws(
    () => uploadStorageKey("not-a-digest", randomUUID()),
    hasReason("invalid_identifier"),
  );

  for (const storageKey of [
    "users/../../etc/passwd",
    `users/${paths.userDirectoryKey}/blobs/ab/${randomUUID()}/../../../../etc/passwd`,
    `users/${paths.userDirectoryKey}/blobs/ab/not-a-uuid`,
    `/etc/${paths.userDirectoryKey}`,
    "",
  ]) {
    assert.throws(() => resolveStorageKey(store, storageKey), hasReason("unsafe_path"), storageKey);
  }
});

/**
 * A directory outside the store, mode 0755, standing in for whatever a
 * same-uid attacker points a planted link at. 0755 rather than 0700 so that a
 * `chmod` which followed the link is visible afterwards.
 */
async function outsideDirectory(enclosing: string, name: string): Promise<string> {
  const outside = join(enclosing, name);
  await mkdir(outside, { recursive: true });
  // mkdir's mode is masked by umask; pin it so the assertion means something.
  await chmod(outside, 0o755);
  return outside;
}

test("refuses a symlinked directory component instead of following it", async (t) => {
  // Finding 6: `mkdir -p` + `chmod` follow a symlink already sitting where a
  // store directory belongs, and a containment test on the *joined string*
  // cannot see that. Every level of the tree the shard walk creates is planted
  // in turn; each must be refused before anything outside is touched.
  const key = uploadUserDirectoryKey(TENANT_ID, USER_ID);
  const levels: ReadonlyArray<{ label: string; parents: readonly string[] }> = [
    { label: "users", parents: [] },
    { label: "user shard", parents: ["users"] },
    { label: "blobs", parents: ["users", key] },
    { label: "tmp", parents: ["users", key] },
    { label: "staged", parents: ["users", key] },
  ];
  const leaf: Readonly<Record<string, string>> = {
    users: "users",
    "user shard": key,
    blobs: "blobs",
    tmp: "tmp",
    staged: "staged",
  };

  for (const level of levels) {
    const enclosing = await mkdtemp(join(tmpdir(), "agent-harness-uploads-"));
    t.after(() => rm(enclosing, { recursive: true, force: true }));
    const store = join(enclosing, "uploads");
    await mkdir(join(store, ...level.parents), { recursive: true, mode: 0o700 });
    const outside = await outsideDirectory(enclosing, "outside");
    const planted = leaf[level.label];
    assert.ok(planted !== undefined);
    await symlink(outside, join(store, ...level.parents, planted));

    await assert.rejects(
      prepareUserUploadPaths(store, { tenantId: TENANT_ID, userId: USER_ID }),
      hasReason("unsafe_path"),
      level.label,
    );
    // Nothing outside the store was created, and nothing outside was chmod'ed.
    assert.deepEqual(await readdir(outside), [], level.label);
    assert.equal((await stat(outside)).mode & 0o777, 0o755, level.label);
  }
});

test("refuses a symlinked blob shard and a symlinked staged thread directory", async (t) => {
  // Finding 6, the two directories created per request rather than per shard:
  // `blobs/<xx>` on the way to a blob and `staged/<sha256(threadId)>` on the
  // way to a turn's plaintext.
  const enclosing = await mkdtemp(join(tmpdir(), "agent-harness-uploads-"));
  t.after(() => rm(enclosing, { recursive: true, force: true }));
  const store = join(enclosing, "uploads");
  const paths = await prepareUserUploadPaths(store, { tenantId: TENANT_ID, userId: USER_ID });
  const uploadId = randomUUID();

  const outsideShard = await outsideDirectory(enclosing, "outside-shard");
  await symlink(outsideShard, join(paths.blobsDir, uploadId.slice(0, 2)));
  await assert.rejects(prepareBlobPath(paths, uploadId), hasReason("unsafe_path"));
  assert.deepEqual(await readdir(outsideShard), []);
  assert.equal((await stat(outsideShard)).mode & 0o777, 0o755);

  const outsideStaged = await outsideDirectory(enclosing, "outside-staged");
  await symlink(outsideStaged, stagedThreadDirectory(paths, THREAD_ID));
  await assert.rejects(
    prepareStagedPath(paths, THREAD_ID, uploadId, "text/csv"),
    hasReason("unsafe_path"),
  );
  assert.deepEqual(await readdir(outsideStaged), []);
  assert.equal((await stat(outsideStaged)).mode & 0o777, 0o755);
});

test("maps only server-sniffed content types onto a fixed extension", async (t) => {
  const { paths } = await shard(t);

  assert.deepEqual(
    Object.keys(UPLOAD_FILE_EXTENSIONS).sort(),
    [...UPLOAD_ALLOWED_CONTENT_TYPES].sort(),
  );
  for (const contentType of UPLOAD_ALLOWED_CONTENT_TYPES) {
    assert.match(extensionForUploadContentType(contentType), /^[a-z]+$/);
  }

  // Nothing outside the allow-list can name a file, including inherited
  // Object properties, a client label, or a shell-executable extension.
  for (const contentType of [
    "application/zip",
    "application/x-sh",
    "constructor",
    "__proto__",
    "toString",
    "TEXT/CSV",
    "",
  ]) {
    assert.throws(
      () => extensionForUploadContentType(contentType),
      hasReason("unsupported_content_type"),
      contentType,
    );
  }

  const uploadId = randomUUID();
  assert.throws(
    () => stagedPath(paths, THREAD_ID, uploadId, "application/zip"),
    hasReason("unsupported_content_type"),
  );
  await assert.rejects(
    prepareStagedPath(paths, THREAD_ID, uploadId, "application/zip"),
    hasReason("unsupported_content_type"),
  );
});

test("round-trips a storage key back to the blob path", async (t) => {
  const { store, paths } = await shard(t);
  const uploadId = randomUUID();

  const storageKey = uploadStorageKey(paths.userDirectoryKey, uploadId);
  assert.equal(
    storageKey,
    `users/${paths.userDirectoryKey}/blobs/${uploadId.slice(0, 2)}/${uploadId}`,
  );
  assert.equal(resolveStorageKey(store, storageKey), blobPath(paths, uploadId));
});

test("lists only well-formed shards, and tolerates a store with none", async (t) => {
  const store = await storeRoot(t);
  assert.deepEqual(await listUserUploadDirectories(store), []);

  const paths = await prepareUserUploadPaths(store, { tenantId: TENANT_ID, userId: USER_ID });
  await mkdir(join(await realpath(store), "users", "not-a-shard-key"), { recursive: true });

  assert.deepEqual(await listUserUploadDirectories(await realpath(store)), [paths.userDir]);
});
