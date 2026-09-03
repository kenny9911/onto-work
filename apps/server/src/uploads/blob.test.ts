import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, linkSync, readdirSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import test from "node:test";

import {
  assertExclusiveFile,
  decryptToStaged,
  openExclusive,
  sweepStaged,
  unlinkStaged,
  unlinkStagedThread,
  writeEncryptedBlob,
} from "./blob.js";
import type { EncryptedBlobRecord } from "./blob.js";
import {
  UploadStorageError,
  blobPath,
  prepareUserUploadPaths,
  stagedPath,
  stagedThreadDirectory,
  uploadStorageKey,
} from "./paths.js";
import type { UserUploadPaths } from "./paths.js";

const ENCRYPTION_SECRET = "development-only-credential_encryption_key-agent-harness";
const THREAD_ID = "thread-1";

interface Fixture {
  root: string;
  store: string;
  paths: UserUploadPaths;
}

function hasReason(reason: string) {
  return (error: unknown): true => {
    assert.ok(error instanceof UploadStorageError, `expected UploadStorageError, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  };
}

async function fixture(t: { after(fn: () => unknown): void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-blob-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, "uploads");
  const paths = await prepareUserUploadPaths(store, { tenantId: "tenant-a", userId: "user-a" });
  return { root: await realpath(root), store: await realpath(store), paths };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function storeBlob(
  paths: UserUploadPaths,
  uploadId: string,
  chunks: readonly Buffer[],
): Promise<EncryptedBlobRecord> {
  return writeEncryptedBlob({
    paths,
    uploadId,
    source: Readable.from(chunks),
    encryptionSecret: ENCRYPTION_SECRET,
  });
}

function stageInput(paths: UserUploadPaths, uploadId: string, record: EncryptedBlobRecord) {
  return {
    paths,
    uploadId,
    threadId: THREAD_ID,
    contentType: "text/csv",
    storageKey: record.storageKey,
    encryptionSecret: ENCRYPTION_SECRET,
    encryptionIv: record.encryptionIv,
    encryptionTag: record.encryptionTag,
    wrappedDataKey: record.wrappedDataKey,
  };
}

test("refuses a symlink planted at the scratch path and leaves its victim intact", async (t) => {
  const { root, paths } = await fixture(t);
  const victim = join(root, "victim.txt");
  await writeFile(victim, "victim-content");
  const target = join(paths.tmpDir, "planted.part");
  await symlink(victim, target);

  // O_CREAT|O_EXCL does not follow a final symlink: EEXIST, not a write
  // through the link.
  await assert.rejects(openExclusive(target), hasReason("target_exists"));
  assert.equal(await readFile(victim, "utf8"), "victim-content");
  // We did not create the planted name, so we must not remove it either.
  assert.ok((await lstat(target)).isSymbolicLink());
});

test("refuses a hard link planted at the scratch path", async (t) => {
  const { root, paths } = await fixture(t);
  const existing = join(root, "existing.txt");
  await writeFile(existing, "existing-content");
  const target = join(paths.tmpDir, "planted.part");
  await link(existing, target);

  await assert.rejects(openExclusive(target), hasReason("target_exists"));
  assert.equal(await readFile(existing, "utf8"), "existing-content");
});

test("assertExclusiveFile rejects a descriptor that gained a hard link", async (t) => {
  const { root, paths } = await fixture(t);
  const target = join(paths.tmpDir, "fresh.part");
  const handle = await openExclusive(target);

  try {
    const created = await handle.stat();
    assert.equal(created.nlink, 1);
    assert.equal(created.isFile(), true);
    assert.equal(created.mode & 0o777, 0o600);
    await assertExclusiveFile(handle, target);

    await link(target, join(root, "attacker-link"));
    assert.equal((await handle.stat()).nlink, 2);
    await assert.rejects(assertExclusiveFile(handle, target), (error: unknown): true => {
      hasReason("hard_link")(error);
      assert.ok(error instanceof Error);
      assert.match(error.message, /2 hard links/);
      // Messages carry a basename only; upload failures get logged.
      assert.doesNotMatch(error.message, /\//);
      return true;
    });
  } finally {
    await handle.close();
  }
});

test("aborts and publishes nothing when the scratch file is hard-linked mid-write", async (t) => {
  const { root, paths } = await fixture(t);
  const uploadId = randomUUID();
  const stolen = join(root, "stolen");
  let linked = false;

  // The scratch file exists before the first byte flows, so a transform in the
  // same pipeline can race it the way a same-uid attacker would — except that
  // the attacker cannot guess the UUID, which is why this is theoretical.
  const sabotage = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!linked) {
        const parts = readdirSync(paths.tmpDir).filter((name) => name.endsWith(".part"));
        const first = parts[0];
        if (parts.length === 1 && first !== undefined) {
          linkSync(join(paths.tmpDir, first), stolen);
          linked = true;
        }
      }
      callback(null, chunk);
    },
  });

  await assert.rejects(
    writeEncryptedBlob({
      paths,
      uploadId,
      source: Readable.from([Buffer.from("a".repeat(4096))]),
      encryptionSecret: ENCRYPTION_SECRET,
      transforms: [sabotage],
    }),
    hasReason("hard_link"),
  );

  assert.equal(linked, true);
  // Our scratch name was unlinked, so the attacker's link is all that is left
  // of the inode — and the upload itself never became a blob.
  assert.equal((await stat(stolen)).nlink, 1);
  assert.equal(existsSync(blobPath(paths, uploadId)), false);
  assert.deepEqual(await readdir(paths.tmpDir), []);
});

test("round-trips a 20 MiB stream through encryption and staging", async (t) => {
  const { paths } = await fixture(t);
  const uploadId = randomUUID();
  const megabyte = randomBytes(1024 * 1024);
  const chunks = Array.from({ length: 20 }, () => megabyte);
  const expected = createHash("sha256");
  for (const chunk of chunks) expected.update(chunk);
  const expectedSha256 = expected.digest("hex");

  const record = await storeBlob(paths, uploadId, chunks);

  assert.equal(record.sizeBytes, 20 * 1024 * 1024);
  assert.equal(record.contentSha256, expectedSha256);
  assert.equal(record.storageKey, uploadStorageKey(paths.userDirectoryKey, uploadId));
  assert.equal(record.path, blobPath(paths, uploadId));
  assert.equal((await stat(record.path)).mode & 0o777, 0o400);
  // AES-GCM is a stream cipher: same length, different bytes.
  assert.equal((await stat(record.path)).size, 20 * 1024 * 1024);
  assert.notEqual(await sha256File(record.path), expectedSha256);
  const head = Buffer.alloc(64);
  const blob = await open(record.path, "r");
  await blob.read(head, 0, 64, 0);
  await blob.close();
  assert.notDeepEqual(head, megabyte.subarray(0, 64));
  // The wrapped key is ciphertext too, never the raw key.
  assert.match(record.wrappedDataKey, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const staged = await decryptToStaged(stageInput(paths, uploadId, record));

  assert.equal(staged.sizeBytes, 20 * 1024 * 1024);
  assert.equal(staged.contentSha256, record.contentSha256);
  assert.equal(staged.path, stagedPath(paths, THREAD_ID, uploadId, "text/csv"));
  assert.equal(basename(staged.path), `${uploadId}.csv`);
  assert.equal((await stat(staged.path)).mode & 0o777, 0o400);
  assert.equal(await sha256File(staged.path), expectedSha256);
  assert.deepEqual(await readdir(paths.tmpDir), []);
});

test("a single tampered ciphertext byte fails the tag before a staged path exists", async (t) => {
  const { paths } = await fixture(t);
  const uploadId = randomUUID();
  const record = await storeBlob(paths, uploadId, [Buffer.from("column,value\n1,2\n", "utf8")]);

  await chmod(record.path, 0o600);
  const handle = await open(record.path, "r+");
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, 0);
  byte.writeUInt8(byte.readUInt8(0) ^ 0x01, 0);
  await handle.write(byte, 0, 1, 0);
  await handle.close();

  await assert.rejects(decryptToStaged(stageInput(paths, uploadId, record)), hasReason("integrity"));

  assert.equal(existsSync(stagedPath(paths, THREAD_ID, uploadId, "text/csv")), false);
  assert.deepEqual(await readdir(stagedThreadDirectory(paths, THREAD_ID)), []);
  assert.deepEqual(await readdir(paths.tmpDir), []);
});

test("rejects a forged authentication tag and an unusable wrapped key", async (t) => {
  const { paths } = await fixture(t);
  const uploadId = randomUUID();
  const record = await storeBlob(paths, uploadId, [Buffer.from("a,b\n1,2\n", "utf8")]);

  const tag = Buffer.from(record.encryptionTag, "base64url");
  tag.writeUInt8(tag.readUInt8(0) ^ 0x01, 0);
  await assert.rejects(
    decryptToStaged({
      ...stageInput(paths, uploadId, record),
      encryptionTag: tag.toString("base64url"),
    }),
    hasReason("integrity"),
  );

  await assert.rejects(
    decryptToStaged({
      ...stageInput(paths, uploadId, record),
      encryptionSecret: "a-different-credential-encryption-key",
    }),
    hasReason("integrity"),
  );

  assert.equal(existsSync(stagedPath(paths, THREAD_ID, uploadId, "text/csv")), false);
  assert.deepEqual(await readdir(paths.tmpDir), []);
});

test("refuses to stage a blob whose storage key names another user's shard", async (t) => {
  const { store, paths } = await fixture(t);
  const other = await prepareUserUploadPaths(store, { tenantId: "tenant-a", userId: "user-b" });
  const uploadId = randomUUID();
  const record = await storeBlob(paths, uploadId, [Buffer.from("a,b\n", "utf8")]);

  await assert.rejects(
    decryptToStaged({
      ...stageInput(paths, uploadId, record),
      storageKey: uploadStorageKey(other.userDirectoryKey, uploadId),
    }),
    hasReason("unsafe_path"),
  );

  // Rejected before anything was created on disk.
  assert.equal(existsSync(stagedThreadDirectory(paths, THREAD_ID)), false);
  assert.deepEqual(await readdir(paths.tmpDir), []);
});

/**
 * A directory outside the store, mode 0755 so that a `chmod` which followed a
 * planted link into it is visible afterwards.
 */
async function outsideDirectory(root: string, name: string): Promise<string> {
  const outside = join(root, name);
  await mkdir(outside, { recursive: true });
  await chmod(outside, 0o755);
  return outside;
}

test("a symlinked blob shard cannot publish ciphertext outside the store", async (t) => {
  // Finding 6. `openExclusive`'s O_EXCL protects the leaf name only; the
  // directory components above it were `mkdir -p`ed and `chmod`ed straight
  // through whatever link was already there, and `rename` then published into
  // it.
  const { root, paths } = await fixture(t);
  const uploadId = randomUUID();
  const outside = await outsideDirectory(root, "outside-shard");
  await symlink(outside, join(paths.blobsDir, uploadId.slice(0, 2)));

  await assert.rejects(
    storeBlob(paths, uploadId, [Buffer.from("column,value\n1,2\n", "utf8")]),
    hasReason("unsafe_path"),
  );

  assert.deepEqual(await readdir(outside), []);
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(paths.tmpDir), []);
  // The planted link is left where it is: refusing is not licence to delete.
  assert.equal((await lstat(join(paths.blobsDir, uploadId.slice(0, 2)))).isSymbolicLink(), true);
});

test("a symlinked staged directory cannot publish plaintext outside the store", async (t) => {
  // Finding 6, on the decrypt side: this is the one path that writes readable
  // customer bytes, so a redirected `rename` here is plaintext disclosure.
  const { root, paths } = await fixture(t);
  const uploadId = randomUUID();
  const record = await storeBlob(paths, uploadId, [Buffer.from("secret,value\n1,2\n", "utf8")]);
  const outside = await outsideDirectory(root, "outside-staged");
  await symlink(outside, stagedThreadDirectory(paths, THREAD_ID));

  await assert.rejects(decryptToStaged(stageInput(paths, uploadId, record)), hasReason("unsafe_path"));

  assert.deepEqual(await readdir(outside), []);
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(paths.tmpDir), []);
});

test("unlinkStaged refuses a path that reaches outside through a symlinked directory", async (t) => {
  // Finding 6. `isWithinDirectory` compares strings, so a path whose *string*
  // sits under `staged/` passes while `unlink` follows the symlinked directory
  // component above the leaf and removes the victim instead.
  const { root, paths } = await fixture(t);
  const uploadId = randomUUID();
  const outside = await outsideDirectory(root, "outside-victim");
  const victim = join(outside, `${uploadId}.csv`);
  await writeFile(victim, "victim-content");
  await symlink(outside, stagedThreadDirectory(paths, THREAD_ID));

  const redirected = stagedPath(paths, THREAD_ID, uploadId, "text/csv");
  await assert.rejects(unlinkStaged(paths, redirected), hasReason("unsafe_path"));
  await assert.rejects(unlinkStagedThread(paths, THREAD_ID), hasReason("unsafe_path"));

  assert.equal(await readFile(victim, "utf8"), "victim-content");
  assert.equal((await lstat(stagedThreadDirectory(paths, THREAD_ID))).isSymbolicLink(), true);
});

test("unlinks staged plaintext per file, per thread, and across the whole store", async (t) => {
  const { store, paths } = await fixture(t);
  const other = await prepareUserUploadPaths(store, { tenantId: "tenant-a", userId: "user-b" });

  const first = randomUUID();
  const second = randomUUID();
  const firstRecord = await storeBlob(paths, first, [Buffer.from("a,b\n", "utf8")]);
  const secondRecord = await storeBlob(paths, second, [Buffer.from("c,d\n", "utf8")]);
  const staged = await decryptToStaged(stageInput(paths, first, firstRecord));
  await decryptToStaged(stageInput(paths, second, secondRecord));

  assert.equal(await unlinkStaged(paths, staged.path), true);
  // A second settle for the same turn is not an error.
  assert.equal(await unlinkStaged(paths, staged.path), false);
  // A blob is not a staged file; a mis-wired caller must not delete one.
  await assert.rejects(
    unlinkStaged(paths, blobPath(paths, second)),
    hasReason("unsafe_path"),
  );

  assert.equal(await unlinkStagedThread(paths, THREAD_ID), 1);
  assert.equal(await unlinkStagedThread(paths, THREAD_ID), 0);
  assert.equal(existsSync(stagedThreadDirectory(paths, THREAD_ID)), false);

  // A second shard's staged plaintext is swept too, and durable blobs survive.
  const third = randomUUID();
  const thirdRecord = await storeBlob(other, third, [Buffer.from("e,f\n", "utf8")]);
  await decryptToStaged(stageInput(other, third, thirdRecord));

  assert.equal(await sweepStaged(store), 1);
  assert.equal(await sweepStaged(store), 0);
  assert.equal(await sweepStaged(join(store, "does-not-exist")), 0);
  assert.equal(existsSync(firstRecord.path), true);
  assert.equal(existsSync(secondRecord.path), true);
  assert.equal(existsSync(thirdRecord.path), true);
});
