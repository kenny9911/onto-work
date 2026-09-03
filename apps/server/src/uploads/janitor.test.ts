import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { TestContext } from "node:test";

import type { FastifyBaseLogger } from "fastify";

import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import type { UploadRecord } from "../database.js";
import { writeEncryptedBlob } from "./blob.js";
import type { EncryptedBlobRecord } from "./blob.js";
import {
  UPLOAD_PART_GRACE_MS,
  deleteTenantUploadTree,
  runUploadJanitorPass,
  startUploadJanitor,
  sweepStagedOnBoot,
} from "./janitor.js";
import type { UploadJanitorDeps } from "./janitor.js";
import { prepareStagedPath, prepareUserUploadPaths, temporaryPartPath } from "./paths.js";
import type { UserUploadPaths } from "./paths.js";

const PAYLOAD = Buffer.from("id,amount\n1,2\n");

interface RecordedLog {
  payload: unknown;
  message: string | undefined;
}

interface TestLogger {
  logger: FastifyBaseLogger;
  warnings: RecordedLog[];
}

function testLogger(): TestLogger {
  const warnings: RecordedLog[] = [];
  const record = (sink: RecordedLog[]) => (first: unknown, second?: unknown) => {
    sink.push(
      typeof first === "string"
        ? { payload: undefined, message: first }
        : { payload: first, message: typeof second === "string" ? second : undefined },
    );
  };
  const noop = (): void => {};
  const logger = {
    level: "silent",
    fatal: noop,
    error: noop,
    warn: record(warnings),
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return { logger: logger as unknown as FastifyBaseLogger, warnings };
}

interface JanitorFixture {
  root: string;
  deps: UploadJanitorDeps;
  warnings: RecordedLog[];
  store: HarnessStore;
  config: HarnessConfig;
  tenantId: string;
  userId: string;
  threadId: string;
  projectId: string;
  workspacePath: string;
  paths: UserUploadPaths;
}

async function janitorFixture(t: TestContext): Promise<JanitorFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-janitor-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(directory, "harness.db"),
    runtimeDataDir: join(directory, "runtimes"),
    uploadDataDir: join(directory, "uploads"),
    sessionTtlMs: 60 * 60 * 1_000,
    sessionSecret: "test-session-secret-that-is-long-enough",
    credentialEncryptionKey: "test-credential-key-that-is-long-enough",
    codexBinary: "codex",
    codexExperimentalApi: false,
    allowedWorkspaceRoots: [workspace],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "http://127.0.0.1:4000/v1",
    litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const admin = await store.bootstrapAdmin("janitor-admin", "temporary-janitor-password");
  const workspacePath = await realpath(workspace);
  store.grantWorkspace({
    tenantId: admin.tenantId,
    rootPath: workspacePath,
    createdByUserId: admin.id,
  });
  const grant = store.findWorkspaceGrantForPath(admin.tenantId, workspacePath)!;
  const project = store.registerSavedProject({
    tenantId: admin.tenantId,
    name: "Janitor project",
    workspacePath,
    workspaceGrantId: grant.id,
    createdByUserId: admin.id,
  });
  const threadId = "janitor-thread";
  store.bindThreadWorkspace({
    tenantId: admin.tenantId,
    userId: admin.id,
    threadId,
    workspacePath,
  });

  const paths = await prepareUserUploadPaths(config.uploadDataDir, {
    tenantId: admin.tenantId,
    userId: admin.id,
  });
  const { logger, warnings } = testLogger();
  return {
    root: await realpath(directory),
    deps: { store, config, logger },
    warnings,
    store,
    config,
    tenantId: admin.tenantId,
    userId: admin.id,
    threadId,
    projectId: project.id,
    workspacePath,
    paths,
  };
}

async function storeBlob(fixture: JanitorFixture, uploadId: string): Promise<EncryptedBlobRecord> {
  return writeEncryptedBlob({
    paths: fixture.paths,
    uploadId,
    source: Readable.from([PAYLOAD]),
    encryptionSecret: fixture.config.credentialEncryptionKey,
  });
}

/**
 * Writes a blob and the `reserving` row that names it, as the upload route
 * does — except the route takes the reservation first. Order is irrelevant
 * here because the row is created before the janitor ever runs.
 */
async function reserveWithBlob(
  fixture: JanitorFixture,
  options: { expiresAt?: string } = {},
): Promise<{ upload: UploadRecord; blob: EncryptedBlobRecord }> {
  const uploadId = randomUUID();
  const blob = await storeBlob(fixture, uploadId);
  const result = fixture.store.createUploadReservation({
    id: uploadId,
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    threadId: fixture.threadId,
    projectId: fixture.projectId,
    workspacePath: fixture.workspacePath,
    filename: "Q3-invoices.csv",
    sizeBytes: blob.sizeBytes,
    storageKey: blob.storageKey,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  });
  assert.ok(result.outcome === "reserved", `expected a reservation, got ${result.outcome}`);
  return { upload: result.upload, blob };
}

function settle(fixture: JanitorFixture, upload: UploadRecord, blob: EncryptedBlobRecord): void {
  const settled = fixture.store.commitUpload({
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    uploadId: upload.id,
    sizeBytes: blob.sizeBytes,
    contentType: "text/csv",
    contentSha256: blob.contentSha256,
    encryptionIv: blob.encryptionIv,
    encryptionTag: blob.encryptionTag,
    wrappedDataKey: blob.wrappedDataKey,
  });
  assert.ok(settled, "the reservation should have settled to 'stored'");
}

/** Every regular file under a directory; `[]` when the directory is gone. */
async function filesUnder(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

const PAST = new Date(Date.now() - 60_000).toISOString();

test("an expired reservation is released and its partial blob unlinked", async (t) => {
  const fixture = await janitorFixture(t);
  const { upload, blob } = await reserveWithBlob(fixture, { expiresAt: PAST });
  assert.equal(existsSync(blob.path), true);
  // The reservation holds tenant storage quota until it is released.
  assert.equal(fixture.store.getUploadStorageUsage(fixture.tenantId), blob.sizeBytes);

  const report = await runUploadJanitorPass(fixture.deps);

  assert.equal(report.expiredRows, 1);
  assert.equal(report.expiredBlobs, 1);
  assert.equal(report.orphanBlobs, 0);
  assert.equal(fixture.store.getUpload(fixture.tenantId, fixture.userId, upload.id), null);
  assert.equal(existsSync(blob.path), false);
  // Reserved storage a mid-stream abort left behind is returned to the tenant.
  assert.equal(fixture.store.getUploadStorageUsage(fixture.tenantId), 0);
});

test("a live row's blob survives a pass that reclaims everything around it", async (t) => {
  const fixture = await janitorFixture(t);
  const live = await reserveWithBlob(fixture);
  settle(fixture, live.upload, live.blob);
  const expired = await reserveWithBlob(fixture, { expiresAt: PAST });
  const orphanId = randomUUID();
  const orphan = await storeBlob(fixture, orphanId);

  const report = await runUploadJanitorPass(fixture.deps);

  const survivor = fixture.store.getUpload(fixture.tenantId, fixture.userId, live.upload.id);
  assert.ok(survivor);
  assert.equal(survivor.status, "stored");
  assert.equal(existsSync(live.blob.path), true);
  assert.deepEqual(await readFile(live.blob.path), await readFile(live.blob.path));
  // Exactly the two dead files went, and the live one was never a candidate.
  assert.equal(existsSync(expired.blob.path), false);
  assert.equal(existsSync(orphan.path), false);
  assert.equal(report.expiredBlobs, 1);
  assert.equal(report.orphanBlobs, 1);
  assert.equal(report.refused, 0);

  // A second pass has nothing left to do, so the sweep is not oscillating.
  const second = await runUploadJanitorPass(fixture.deps);
  assert.equal(second.expiredRows, 0);
  assert.equal(second.orphanBlobs, 0);
  assert.equal(existsSync(live.blob.path), true);
});

test("a blob whose durable row was tombstoned is unlinked, and the row is not re-expired", async (t) => {
  const fixture = await janitorFixture(t);
  const { upload, blob } = await reserveWithBlob(fixture);
  settle(fixture, upload, blob);
  // Force the retention deadline past without touching the blob.
  fixture.store.db
    .prepare("UPDATE uploads SET expires_at = ? WHERE id = ?")
    .run(PAST, upload.id);

  const first = await runUploadJanitorPass(fixture.deps);
  assert.equal(first.expiredRows, 1);
  assert.equal(first.expiredBlobs, 1);
  assert.equal(existsSync(blob.path), false);

  const tombstone = fixture.store.getUpload(fixture.tenantId, fixture.userId, upload.id);
  assert.ok(tombstone);
  assert.equal(tombstone.status, "deleted");

  // A tombstone is terminal: expiring it again would rewrite the row and emit
  // an `upload.expired` audit on every pass forever.
  const second = await runUploadJanitorPass(fixture.deps);
  assert.equal(second.expiredRows, 0);
  assert.equal(second.expiredBlobs, 0);
});

test("the boot sweep empties staged and scratch files while leaving blobs alone", async (t) => {
  const fixture = await janitorFixture(t);
  const live = await reserveWithBlob(fixture);
  settle(fixture, live.upload, live.blob);

  const stagedOne = await prepareStagedPath(
    fixture.paths,
    fixture.threadId,
    randomUUID(),
    "text/csv",
  );
  const stagedTwo = await prepareStagedPath(
    fixture.paths,
    "another-thread",
    randomUUID(),
    "application/json",
  );
  await writeFile(stagedOne, PAYLOAD);
  await writeFile(stagedTwo, PAYLOAD);
  // A scratch file is dead at boot however fresh its mtime is: nothing can be
  // in flight before the server accepts connections.
  const part = temporaryPartPath(fixture.paths);
  await writeFile(part, PAYLOAD);

  await sweepStagedOnBoot(fixture.deps);

  assert.deepEqual(await filesUnder(fixture.paths.stagedDir), []);
  assert.equal(existsSync(stagedOne), false);
  assert.equal(existsSync(stagedTwo), false);
  assert.deepEqual(await filesUnder(fixture.paths.tmpDir), []);
  assert.equal(existsSync(part), false);
  // Durable ciphertext is not the boot sweep's business.
  assert.equal(existsSync(live.blob.path), true);
  assert.deepEqual(fixture.warnings, []);
});

test("the boot sweep is a no-op, not a failure, on a store that has never been used", async (t) => {
  const fixture = await janitorFixture(t);
  await rm(fixture.config.uploadDataDir, { recursive: true, force: true });

  await sweepStagedOnBoot(fixture.deps);
  const report = await runUploadJanitorPass(fixture.deps);

  assert.deepEqual(fixture.warnings, []);
  assert.equal(report.expiredRows, 0);
  assert.equal(report.orphanBlobs, 0);
});

test("a scratch file is reclaimed only once it is older than a reservation lease", async (t) => {
  const fixture = await janitorFixture(t);
  const fresh = temporaryPartPath(fixture.paths);
  const stale = temporaryPartPath(fixture.paths);
  await writeFile(fresh, PAYLOAD);
  await writeFile(stale, PAYLOAD);
  const staleTime = new Date(Date.now() - UPLOAD_PART_GRACE_MS - 60_000);
  await utimes(stale, staleTime, staleTime);

  const report = await runUploadJanitorPass(fixture.deps);

  // An upload streaming right now keeps a fresh mtime and must not be cut off.
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(stale), false);
  assert.equal(report.staleParts, 1);
});

test("a symlink planted in the store is refused, never followed out of it", async (t) => {
  const fixture = await janitorFixture(t);
  const outsideDir = join(fixture.root, "outside");
  const outsideFile = join(outsideDir, "victim.txt");
  // Named like a blob, so following the link would delete it.
  const nestedVictim = join(outsideDir, randomUUID());
  await mkdir(outsideDir, { recursive: true });
  await writeFile(outsideFile, "victim-content");
  await writeFile(nestedVictim, "nested-victim-content");

  // A shard-shaped symlink to a directory outside the store: the one shape
  // that could turn a contained path into an arbitrary one, because `unlink`
  // follows every directory component above its final name.
  const shardLink = join(fixture.paths.blobsDir, "cd");
  await symlink(outsideDir, shardLink);
  // A blob-shaped symlink inside a real shard.
  const realShard = join(fixture.paths.blobsDir, "ab");
  await mkdir(realShard, { recursive: true, mode: 0o700 });
  const fileLink = join(realShard, randomUUID());
  await symlink(outsideFile, fileLink);
  // A genuine orphan, so the pass is proven to have swept rather than bailed.
  const orphan = await storeBlob(fixture, randomUUID());

  const report = await runUploadJanitorPass(fixture.deps);

  assert.equal(existsSync(orphan.path), false, "the real orphan should have been swept");
  assert.equal(await readFile(outsideFile, "utf8"), "victim-content");
  assert.equal(await readFile(nestedVictim, "utf8"), "nested-victim-content");
  // Neither link was traversed, and neither was removed: the janitor does not
  // delete what it did not create.
  assert.equal((await lstat(shardLink)).isSymbolicLink(), true);
  assert.equal((await lstat(fileLink)).isSymbolicLink(), true);
  assert.ok(report.refused >= 2, `expected the two links to be refused, got ${report.refused}`);
});

test("a symlinked shard directory cannot redirect an expiry unlink out of the store", async (t) => {
  const fixture = await janitorFixture(t);
  // The expiry path never lists a directory: it re-derives one path from the
  // row's storage key and unlinks it. `unlink` refuses to follow a *final*
  // symlink but follows every directory component above it, so canonicalizing
  // the parent is the only thing standing between a planted shard link and an
  // arbitrary deletion.
  const uploadId = randomUUID();
  const outsideDir = join(fixture.root, "outside");
  const victim = join(outsideDir, uploadId);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(victim, "victim-content");
  await symlink(outsideDir, join(fixture.paths.blobsDir, uploadId.slice(0, 2)));

  const result = fixture.store.createUploadReservation({
    id: uploadId,
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    threadId: fixture.threadId,
    projectId: fixture.projectId,
    workspacePath: fixture.workspacePath,
    filename: "Q3-invoices.csv",
    sizeBytes: PAYLOAD.byteLength,
    storageKey: `users/${fixture.paths.userDirectoryKey}/blobs/${uploadId.slice(0, 2)}/${uploadId}`,
    expiresAt: PAST,
  });
  assert.ok(result.outcome === "reserved");

  const report = await runUploadJanitorPass(fixture.deps);

  assert.equal(await readFile(victim, "utf8"), "victim-content");
  assert.equal(report.expiredRows, 1);
  assert.equal(report.expiredBlobs, 0);
  assert.ok(report.refused >= 1, `expected the redirected unlink to be refused, got ${report.refused}`);
  // The row is still released: quota must not be held hostage by residue on
  // disk that the janitor is right to refuse.
  assert.equal(fixture.store.getUpload(fixture.tenantId, fixture.userId, uploadId), null);
});

test("a redirected users directory refuses the sweep instead of following it", async (t) => {
  const fixture = await janitorFixture(t);
  const outsideDir = join(fixture.root, "elsewhere");
  const decoyShard = join(outsideDir, "a".repeat(64));
  const decoyBlob = join(decoyShard, "ab", randomUUID());
  await mkdir(join(decoyShard, "ab"), { recursive: true });
  await writeFile(decoyBlob, PAYLOAD);
  await rm(join(fixture.config.uploadDataDir, "users"), { recursive: true, force: true });
  await symlink(outsideDir, join(fixture.config.uploadDataDir, "users"));

  const report = await runUploadJanitorPass(fixture.deps);
  await sweepStagedOnBoot(fixture.deps);

  assert.equal(existsSync(decoyBlob), true, "nothing outside the store may be swept");
  assert.equal(report.orphanBlobs, 0);
  assert.equal(fixture.warnings.length >= 1, true);
  assert.ok(
    fixture.warnings.every((entry) => entry.message?.includes("resolves outside the store")),
  );
});

test("deleting a tenant's upload tree removes its shards and no other tenant's", async (t) => {
  const fixture = await janitorFixture(t);
  const live = await reserveWithBlob(fixture);
  settle(fixture, live.upload, live.blob);

  // A second member of the same tenant, and a whole second tenant, inserted
  // directly: the fixture only needs their rows to exist for `listUsers`.
  const createdAt = new Date().toISOString();
  const insertUser = fixture.store.db.prepare(`
    INSERT INTO users (
      id, tenant_id, username, display_name, password_hash, role, status,
      must_change_password, created_at
    ) VALUES (?, ?, ?, ?, 'unused', 'admin', 'active', 0, ?)
  `);
  insertUser.run("janitor-member", fixture.tenantId, "janitor-member", "Member", createdAt);
  fixture.store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run("janitor-tenant-two", "Second tenant", "janitor-second", createdAt);
  insertUser.run("janitor-user-two", "janitor-tenant-two", "janitor-two", "Two", createdAt);

  const memberPaths = await prepareUserUploadPaths(fixture.config.uploadDataDir, {
    tenantId: fixture.tenantId,
    userId: "janitor-member",
  });
  const otherPaths = await prepareUserUploadPaths(fixture.config.uploadDataDir, {
    tenantId: "janitor-tenant-two",
    userId: "janitor-user-two",
  });
  const memberBlob = join(memberPaths.blobsDir, "ab", randomUUID());
  const otherBlob = join(otherPaths.blobsDir, "ab", randomUUID());
  await mkdir(join(memberPaths.blobsDir, "ab"), { recursive: true, mode: 0o700 });
  await mkdir(join(otherPaths.blobsDir, "ab"), { recursive: true, mode: 0o700 });
  await writeFile(memberBlob, PAYLOAD);
  await writeFile(otherBlob, PAYLOAD);
  // A link planted inside a doomed shard must cost its own entry and nothing
  // the link points at.
  const outsideFile = join(fixture.root, "tenant-victim.txt");
  await writeFile(outsideFile, "victim-content");
  await symlink(outsideFile, join(memberPaths.blobsDir, "ab", "escape"));

  const removed = await deleteTenantUploadTree(fixture.deps, fixture.tenantId);

  assert.equal(removed, 2);
  assert.equal(existsSync(fixture.paths.userDir), false);
  assert.equal(existsSync(live.blob.path), false);
  assert.equal(existsSync(memberPaths.userDir), false);
  assert.equal(await readFile(outsideFile, "utf8"), "victim-content");
  // The other tenant is untouched — shards are per user, not per tenant, so
  // this is the only thing standing between one deletion and all of them.
  assert.equal(existsSync(otherPaths.userDir), true);
  assert.equal(existsSync(otherBlob), true);
});

test("a janitor warning names a reason, never the path it failed on", async (t) => {
  const fixture = await janitorFixture(t);
  if (process.getuid?.() === 0) {
    t.skip("root ignores directory permissions, so readdir cannot be made to fail");
    return;
  }
  const uploadId = randomUUID();
  await storeBlob(fixture, uploadId);
  const shard = join(fixture.paths.blobsDir, uploadId.slice(0, 2));
  // An unreadable shard makes `readdir` throw an `fs` error whose `message`,
  // `stack` and `path` all carry the absolute store path.
  await mkdir(join(fixture.paths.stagedDir, "orphan"), { recursive: true });
  await chmod(shard, 0o000);
  try {
    await runUploadJanitorPass(fixture.deps);
    await sweepStagedOnBoot(fixture.deps);
  } finally {
    // Restored here rather than in an `after` hook: the fixture's own cleanup
    // hook runs first and cannot `rm -r` a directory it may not read.
    await chmod(shard, 0o700);
  }

  assert.equal(fixture.warnings.length >= 1, true);
  // The janitor logs through `app.log`, so it is bound by the same §6
  // invariant as the routes: only `uploadId` and a bounded reason. `{ err }`
  // would put the store path in the log through three separate fields.
  const serialized = JSON.stringify(
    fixture.warnings,
    (_key, value: unknown) =>
      value instanceof Error
        ? { message: value.message, stack: value.stack, ...(value as object) }
        : value,
  );
  assert.equal(serialized.includes(fixture.config.uploadDataDir), false, serialized);
  assert.equal(serialized.includes("/blobs/"), false, serialized);
  assert.equal(serialized.includes("/staged/"), false, serialized);
  assert.equal(/"(err|stack|path)"/.test(serialized), false, serialized);
  const walkWarning = fixture.warnings.find((entry) =>
    entry.message?.includes("blob walk failed"),
  );
  assert.ok(walkWarning, serialized);
  assert.deepEqual(walkWarning.payload, { reason: "EACCES" });
});

test("the janitor handle stops cleanly and never holds the process open", async (t) => {
  const fixture = await janitorFixture(t);
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

  const janitor = startUploadJanitor(fixture.deps);
  const during = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  // `.unref()` keeps the interval out of the ref'd resource set entirely.
  assert.equal(during, before);

  janitor.stop();
  janitor.stop();
  assert.deepEqual(fixture.warnings, []);
});
