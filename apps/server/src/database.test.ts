import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HarnessStore, uploadSummary, type UploadRecord } from "./database.js";

test("finds a saved project by exact canonical workspace path within its tenant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-project-lookup-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const store = new HarnessStore(join(directory, "harness.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const firstAdmin = await store.bootstrapAdmin(
    "project-lookup-admin-one",
    "project-lookup-password-one",
  );
  const secondAdmin = { id: "project-lookup-user-two", tenantId: "project-lookup-tenant-two" };
  const createdAt = new Date().toISOString();
  store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run(secondAdmin.tenantId, "Second tenant", "project-lookup-second", createdAt);
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
    `)
    .run(
      secondAdmin.id,
      secondAdmin.tenantId,
      "project-lookup-admin-two",
      "Second tenant admin",
      "unused",
      createdAt,
    );
  store.grantWorkspace({
    tenantId: firstAdmin.tenantId,
    rootPath: canonicalWorkspace,
    createdByUserId: firstAdmin.id,
  });
  store.grantWorkspace({
    tenantId: secondAdmin.tenantId,
    rootPath: canonicalWorkspace,
    createdByUserId: secondAdmin.id,
  });
  const firstGrant = store.findWorkspaceGrantForPath(
    firstAdmin.tenantId,
    canonicalWorkspace,
  );
  const secondGrant = store.findWorkspaceGrantForPath(
    secondAdmin.tenantId,
    canonicalWorkspace,
  );
  assert.ok(firstGrant);
  assert.ok(secondGrant);

  const firstProject = store.registerSavedProject({
    tenantId: firstAdmin.tenantId,
    name: "First tenant project",
    workspacePath: canonicalWorkspace,
    workspaceGrantId: firstGrant.id,
    createdByUserId: firstAdmin.id,
  });
  const secondProject = store.registerSavedProject({
    tenantId: secondAdmin.tenantId,
    name: "Second tenant project",
    workspacePath: canonicalWorkspace,
    workspaceGrantId: secondGrant.id,
    createdByUserId: secondAdmin.id,
  });

  assert.equal(
    store.findSavedProjectByWorkspacePath(firstAdmin.tenantId, canonicalWorkspace)?.id,
    firstProject.id,
  );
  assert.equal(
    store.findSavedProjectByWorkspacePath(secondAdmin.tenantId, canonicalWorkspace)?.id,
    secondProject.id,
  );
  assert.equal(
    store.findSavedProjectByWorkspacePath(
      firstAdmin.tenantId,
      join(canonicalWorkspace, "nested"),
    ),
    null,
  );
  assert.equal(
    store.findSavedProjectByWorkspacePath("unknown-tenant", canonicalWorkspace),
    null,
  );
});

interface UploadTenantFixture {
  tenantId: string;
  userId: string;
  projectId: string;
  workspacePath: string;
  threadId: string;
}

interface UploadFixture {
  store: HarnessStore;
  primary: UploadTenantFixture;
  secondary: UploadTenantFixture;
}

const PAYLOAD_SHA256 = createHash("sha256").update("id,amount\n1,2\n").digest("hex");

function storageKeyFor(uploadId: string): string {
  return `blobs/${uploadId.slice(0, 2)}/${uploadId}`;
}

function reserveUpload(
  store: HarnessStore,
  scope: UploadTenantFixture,
  overrides: {
    id?: string;
    threadId?: string | null;
    projectId?: string | null;
    workspacePath?: string;
    filename?: string;
    sizeBytes?: number;
    expiresAt?: string;
  } = {},
): UploadRecord {
  const id = overrides.id ?? randomUUID();
  const result = store.createUploadReservation({
    id,
    tenantId: scope.tenantId,
    userId: scope.userId,
    threadId: overrides.threadId === undefined ? scope.threadId : overrides.threadId,
    projectId: overrides.projectId === undefined ? scope.projectId : overrides.projectId,
    workspacePath: overrides.workspacePath ?? scope.workspacePath,
    filename: overrides.filename ?? "Q3-invoices.csv",
    sizeBytes: overrides.sizeBytes ?? 1_000,
    storageKey: storageKeyFor(id),
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
  });
  assert.equal(result.outcome, "reserved");
  assert.ok(result.outcome === "reserved");
  return result.upload;
}

function settleUpload(
  store: HarnessStore,
  scope: UploadTenantFixture,
  reservation: UploadRecord,
  overrides: { sizeBytes?: number; expiresAt?: string } = {},
): UploadRecord {
  const settled = store.commitUpload({
    tenantId: scope.tenantId,
    userId: scope.userId,
    uploadId: reservation.id,
    sizeBytes: overrides.sizeBytes ?? reservation.sizeBytes,
    contentType: "text/csv",
    contentSha256: PAYLOAD_SHA256,
    encryptionIv: "aXY=",
    encryptionTag: "dGFn",
    wrappedDataKey: "d3JhcHBlZA==",
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
  });
  assert.ok(settled);
  return settled;
}

async function createUploadFixture(t: TestContext): Promise<UploadFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-uploads-"));
  const store = new HarnessStore(join(directory, "harness.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const admin = await store.bootstrapAdmin("upload-admin-one", "upload-password-one");
  const bootstrapEntitlement = store.getLatestEntitlementSnapshot(admin.tenantId)!;
  // The free plan seats exactly one user; the fixture needs a second member to
  // prove that ownership is `(tenant_id, user_id)` and not tenant alone.
  store.createEntitlementSnapshot({
    tenantId: admin.tenantId,
    plan: bootstrapEntitlement.plan,
    status: bootstrapEntitlement.status,
    seatLimit: 4,
    activeRunLimit: bootstrapEntitlement.activeRunLimit,
    requestLimit: bootstrapEntitlement.requestLimit,
    periodStart: bootstrapEntitlement.periodStart,
    periodEnd: bootstrapEntitlement.periodEnd,
    allowedRouteIds: bootstrapEntitlement.allowedRouteIds,
  });

  const createdAt = new Date().toISOString();
  const secondTenantId = "upload-tenant-two";
  const secondUserId = "upload-user-two";
  store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run(secondTenantId, "Second tenant", "upload-second", createdAt);
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
    `)
    .run(secondUserId, secondTenantId, "upload-admin-two", "Second admin", "unused", createdAt);
  store.createEntitlementSnapshot({
    tenantId: secondTenantId,
    plan: "free",
    status: "active",
    seatLimit: 4,
    activeRunLimit: 1,
    requestLimit: 1_000,
    periodStart: createdAt,
    periodEnd: null,
    allowedRouteIds: ["*"],
  });

  const scopes: UploadTenantFixture[] = [];
  for (const [index, owner] of [
    { tenantId: admin.tenantId, userId: admin.id },
    { tenantId: secondTenantId, userId: secondUserId },
  ].entries()) {
    const workspace = join(directory, `workspace-${index}`);
    await mkdir(workspace, { recursive: true });
    const workspacePath = await realpath(workspace);
    store.grantWorkspace({
      tenantId: owner.tenantId,
      rootPath: workspacePath,
      createdByUserId: owner.userId,
    });
    const grant = store.findWorkspaceGrantForPath(owner.tenantId, workspacePath)!;
    const project = store.registerSavedProject({
      tenantId: owner.tenantId,
      name: `Project ${index}`,
      workspacePath,
      workspaceGrantId: grant.id,
      createdByUserId: owner.userId,
    });
    const threadId = `upload-thread-${index}`;
    store.bindThreadWorkspace({
      tenantId: owner.tenantId,
      userId: owner.userId,
      threadId,
      workspacePath,
    });
    scopes.push({
      tenantId: owner.tenantId,
      userId: owner.userId,
      projectId: project.id,
      workspacePath,
      threadId,
    });
  }

  const [primary, secondary] = scopes;
  assert.ok(primary && secondary);
  return { store, primary, secondary };
}

test("an upload row is absent for every reader but its owning tenant and user", async (t) => {
  const { store, primary, secondary } = await createUploadFixture(t);
  const upload = settleUpload(store, primary, reserveUpload(store, primary));

  const member = await store.createUser({
    tenantId: primary.tenantId,
    username: "upload-member-one",
    displayName: "Member",
    password: "upload-member-password",
    role: "member",
  });

  assert.equal(store.getUpload(primary.tenantId, primary.userId, upload.id)?.id, upload.id);
  // Another tenant, and another member of the same tenant, both read as
  // absent: the route answers 404, never 403, so ids are not oracle-able.
  assert.equal(store.getUpload(secondary.tenantId, secondary.userId, upload.id), null);
  assert.equal(store.getUpload(secondary.tenantId, primary.userId, upload.id), null);
  assert.equal(store.getUpload(primary.tenantId, member.id, upload.id), null);
  assert.deepEqual(
    store.listThreadUploads(secondary.tenantId, secondary.userId, primary.threadId),
    [],
  );
  assert.deepEqual(store.listThreadUploads(primary.tenantId, member.id, primary.threadId), []);
  assert.equal(
    store.listThreadUploads(primary.tenantId, primary.userId, primary.threadId).length,
    1,
  );

  // Writes are scoped identically: a foreign reader can neither claim nor
  // delete a row it cannot see.
  assert.deepEqual(
    store.claimUploadForThread({
      tenantId: secondary.tenantId,
      userId: secondary.userId,
      uploadId: upload.id,
      threadId: secondary.threadId,
      workspacePath: secondary.workspacePath,
    }),
    { outcome: "not_found" },
  );
  assert.equal(
    store.deleteUpload({
      tenantId: secondary.tenantId,
      userId: secondary.userId,
      uploadId: upload.id,
    }),
    null,
  );
  assert.equal(
    store.failUpload({
      tenantId: primary.tenantId,
      userId: member.id,
      uploadId: upload.id,
      errorCode: "upload_staging_failed",
    }).outcome,
    "missing",
  );
  assert.equal(store.getUpload(primary.tenantId, primary.userId, upload.id)?.status, "stored");

  // A reservation cannot name a user or a project from another tenant: the
  // composite FKs make it unrepresentable, and the pre-insert check refuses it
  // by name rather than surfacing a raw constraint failure.
  assert.throws(
    () =>
      store.createUploadReservation({
        tenantId: primary.tenantId,
        userId: secondary.userId,
        threadId: null,
        projectId: primary.projectId,
        workspacePath: primary.workspacePath,
        filename: "borrowed.csv",
        sizeBytes: 8,
        storageKey: "blobs/aa/borrowed",
      }),
    /must belong to the supplied tenant/,
  );
  assert.throws(
    () =>
      store.createUploadReservation({
        tenantId: primary.tenantId,
        userId: primary.userId,
        threadId: null,
        projectId: secondary.projectId,
        workspacePath: secondary.workspacePath,
        filename: "borrowed.csv",
        sizeBytes: 8,
        storageKey: "blobs/ab/borrowed",
      }),
    /must belong to the supplied tenant/,
  );
  assert.equal(store.getUploadStorageUsage(primary.tenantId), upload.sizeBytes);
});

test("the scope guard refuses a workspace path that disagrees with the thread binding", async (t) => {
  const { store, primary, secondary } = await createUploadFixture(t);

  assert.throws(
    () =>
      reserveUpload(store, primary, {
        workspacePath: secondary.workspacePath,
      }),
    /upload scope or workspace mismatch/,
  );
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 0);

  // A row with neither scope is equally unrepresentable.
  assert.throws(
    () => reserveUpload(store, primary, { threadId: null, projectId: null }),
    /scoped to a thread or to a saved project/,
  );

  // The label never reaches the filesystem, but the store is still the last
  // gate before it becomes a durable row: separators, control characters and
  // the relative-path names are refused here too.
  for (const filename of [
    "quarter/invoices.csv",
    "quarter\\invoices.csv",
    "invoices\u0000.csv",
    "invoices\n.csv",
    "invoices\u007f.csv",
    ".",
    "..",
    "",
    "x".repeat(256),
  ]) {
    assert.throws(
      () => reserveUpload(store, primary, { filename }),
      /not a storable display label/,
      `expected ${JSON.stringify(filename)} to be refused`,
    );
  }
  assert.equal(
    reserveUpload(store, primary, { filename: "reçu 2025.csv" }).filename,
    "reçu 2025.csv",
  );
  assert.throws(
    () =>
      store.createUploadReservation({
        id: "not-a-uuid",
        tenantId: primary.tenantId,
        userId: primary.userId,
        threadId: primary.threadId,
        projectId: primary.projectId,
        workspacePath: primary.workspacePath,
        filename: "notes.md",
        sizeBytes: 4,
        storageKey: "blobs/aa/not-a-uuid",
      }),
    /server-generated UUIDs/,
  );

  // The update trigger is the backstop for the claim path: even a direct
  // rebinding of `thread_id` to a thread bound somewhere else is aborted.
  const upload = settleUpload(store, primary, reserveUpload(store, primary, { threadId: null }));
  const foreignThreadId = "upload-thread-elsewhere";
  const elsewhere = join(primary.workspacePath, "nested");
  await mkdir(elsewhere, { recursive: true });
  store.bindThreadWorkspace({
    tenantId: primary.tenantId,
    userId: primary.userId,
    threadId: foreignThreadId,
    workspacePath: await realpath(elsewhere),
  });
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE uploads SET thread_id = ? WHERE id = ?")
        .run(foreignThreadId, upload.id),
    /upload scope or workspace mismatch/,
  );
  assert.equal(store.getUpload(primary.tenantId, primary.userId, upload.id)?.threadId, null);
});

test("deleting a thread workspace binding cascades its upload rows away", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const upload = settleUpload(store, primary, reserveUpload(store, primary));
  assert.equal(store.getUploadStorageUsage(primary.tenantId), upload.sizeBytes);

  store.db
    .prepare(`
      DELETE FROM thread_workspace_bindings
      WHERE tenant_id = ? AND user_id = ? AND thread_id = ?
    `)
    .run(primary.tenantId, primary.userId, primary.threadId);

  assert.equal(store.getUpload(primary.tenantId, primary.userId, upload.id), null);
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 0);
});

test("a reservation holds quota before it settles and releases it on failure", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const epoch = "1970-01-01T00:00:00.000Z";
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 0);

  // Bytes count from the moment the reservation exists, before a single one
  // has been accepted — that is what stops two concurrent uploads from each
  // passing a pre-check against the same remaining allowance.
  const reservation = reserveUpload(store, primary, { sizeBytes: 1_000 });
  assert.equal(reservation.status, "reserving");
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 1_000);
  assert.equal(store.getUploadBytesSince(primary.tenantId, epoch), 1_000);

  const settled = settleUpload(store, primary, reservation, { sizeBytes: 640 });
  assert.equal(settled.status, "stored");
  assert.equal(settled.sizeBytes, 640);
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 640);

  const abandoned = reserveUpload(store, primary, { sizeBytes: 2_000 });
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 2_640);

  const released = store.failUpload({
    tenantId: primary.tenantId,
    userId: primary.userId,
    uploadId: abandoned.id,
    errorCode: "upload_length_mismatch",
  });
  assert.equal(released.outcome, "released");
  assert.equal(released.upload?.storageKey, storageKeyFor(abandoned.id));
  assert.equal(store.getUpload(primary.tenantId, primary.userId, abandoned.id), null);
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 640);
  assert.equal(store.getUploadBytesSince(primary.tenantId, epoch), 640);

  // A settle may shrink the reservation but never raise it.
  const ceiling = reserveUpload(store, primary, { sizeBytes: 512 });
  assert.throws(
    () => settleUpload(store, primary, ceiling, { sizeBytes: 513 }),
    /cannot exceed its reserved byte count/,
  );
});

test("a reservation that would cross a tenant ceiling is refused in both dimensions", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const snapshot = store.getLatestEntitlementSnapshot(primary.tenantId)!;
  // The durable per-tenant columns override the plan default; NULL would fall
  // back to `UPLOAD_PLAN_LIMITS`.
  store.db
    .prepare(`
      UPDATE entitlement_snapshots
      SET storage_bytes_limit = 4096, upload_bytes_period_limit = 6144
      WHERE tenant_id = ? AND version = ?
    `)
    .run(primary.tenantId, snapshot.version);
  const limits = store.getLatestEntitlementSnapshot(primary.tenantId)!;
  assert.equal(limits.storageBytesLimit, 4_096);
  assert.equal(limits.uploadBytesPeriodLimit, 6_144);

  // The comparison happens against reservations, not against settled rows, so
  // a second concurrent upload cannot slip past the ceiling the first is
  // already holding.
  const held = reserveUpload(store, primary, { sizeBytes: 4_000 });
  const overStorage = store.createUploadReservation({
    tenantId: primary.tenantId,
    userId: primary.userId,
    threadId: primary.threadId,
    projectId: primary.projectId,
    workspacePath: primary.workspacePath,
    filename: "second.csv",
    sizeBytes: 200,
    storageKey: "blobs/ab/00000000-0000-4000-8000-00000000beef",
  });
  assert.deepEqual(overStorage, {
    outcome: "storage_quota_exhausted",
    usedBytes: 4_000,
    limitBytes: 4_096,
  });
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 4_000);

  // Deleting the file frees the storage meter but not the ingest meter: those
  // bytes really were accepted in this period.
  settleUpload(store, primary, held, { sizeBytes: 4_000 });
  store.deleteUpload({
    tenantId: primary.tenantId,
    userId: primary.userId,
    uploadId: held.id,
  });
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 0);
  assert.equal(store.getUploadBytesSince(primary.tenantId, limits.periodStart), 4_000);

  const overPeriod = store.createUploadReservation({
    tenantId: primary.tenantId,
    userId: primary.userId,
    threadId: primary.threadId,
    projectId: primary.projectId,
    workspacePath: primary.workspacePath,
    filename: "third.csv",
    sizeBytes: 4_000,
    storageKey: "blobs/cd/00000000-0000-4000-8000-00000000cafe",
  });
  assert.deepEqual(overPeriod, {
    outcome: "upload_quota_exhausted",
    usedBytes: 4_000,
    limitBytes: 6_144,
  });

  // A tenant with no durable entitlement cannot reserve at all.
  store.db.prepare("DELETE FROM entitlement_snapshots WHERE tenant_id = ?").run(primary.tenantId);
  assert.deepEqual(
    store.createUploadReservation({
      tenantId: primary.tenantId,
      userId: primary.userId,
      threadId: primary.threadId,
      projectId: primary.projectId,
      workspacePath: primary.workspacePath,
      filename: "fourth.csv",
      sizeBytes: 8,
      storageKey: "blobs/ef/00000000-0000-4000-8000-00000000f00d",
    }),
    { outcome: "entitlement_missing" },
  );
});

test("expireUploads reclaims only rows whose deadline has already passed", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const past = "2000-01-01T00:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";

  const abandoned = reserveUpload(store, primary, { sizeBytes: 1_000, expiresAt: past });
  const live = reserveUpload(store, primary, { sizeBytes: 2_000, expiresAt: future });
  const stale = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { sizeBytes: 4_000, expiresAt: future }),
    { expiresAt: past },
  );
  const fresh = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { sizeBytes: 8_000, expiresAt: future }),
  );
  // An upload the agent has already read is still on a retention clock.
  const read = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { sizeBytes: 16_000, expiresAt: future }),
    { expiresAt: past },
  );
  assert.equal(
    store.markUploadExtracted({
      tenantId: primary.tenantId,
      userId: primary.userId,
      uploadId: read.id,
      threadId: primary.threadId,
      turnId: "turn-expired",
    }),
    true,
  );
  // A durable row that failed stops counting toward storage the moment it is
  // marked, but its blob is still on disk. Expiry is the only thing that can
  // ever hand that key back, so it has to be reclaimable.
  const broken = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { sizeBytes: 32_000, expiresAt: future }),
    { expiresAt: past },
  );
  assert.equal(
    store.failUpload({
      tenantId: primary.tenantId,
      userId: primary.userId,
      uploadId: broken.id,
      errorCode: "upload_staging_failed",
    }).outcome,
    "failed",
  );
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 31_000);

  const expired = store.expireUploads({ timestamp: new Date().toISOString() });
  assert.deepEqual(
    expired.map((entry) => [entry.id, entry.outcome, entry.previousStatus]).sort(),
    [
      [abandoned.id, "released", "reserving"],
      [stale.id, "deleted", "stored"],
      [read.id, "deleted", "extracted"],
      [broken.id, "deleted", "failed"],
    ].sort(),
  );
  assert.equal(
    expired.find((entry) => entry.id === broken.id)?.storageKey,
    storageKeyFor(broken.id),
  );
  // The reclaimed failure keeps its diagnosis; only its bytes are released.
  const reclaimed = store.getUpload(primary.tenantId, primary.userId, broken.id);
  assert.equal(reclaimed?.status, "deleted");
  assert.equal(reclaimed?.errorCode, "upload_staging_failed");
  assert.equal(
    expired.find((entry) => entry.id === abandoned.id)?.storageKey,
    storageKeyFor(abandoned.id),
  );

  // The expired reservation is gone entirely; the expired durable row is a
  // tombstone the janitor can still resolve to a blob.
  assert.equal(store.getUpload(primary.tenantId, primary.userId, abandoned.id), null);
  assert.equal(store.getUpload(primary.tenantId, primary.userId, stale.id)?.status, "deleted");
  assert.equal(store.getUpload(primary.tenantId, primary.userId, live.id)?.status, "reserving");
  assert.equal(store.getUpload(primary.tenantId, primary.userId, fresh.id)?.status, "stored");
  assert.equal(store.getUpload(primary.tenantId, primary.userId, read.id)?.status, "deleted");
  assert.equal(store.getUploadStorageUsage(primary.tenantId), 10_000);

  // A second sweep at the same instant finds nothing left to reclaim.
  assert.deepEqual(store.expireUploads({ timestamp: new Date().toISOString() }), []);
});

test("a project upload is claimed by one thread and refused to any other", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const upload = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { threadId: null }),
  );
  assert.equal(upload.threadId, null);
  assert.equal(uploadSummary(upload).scope, "project");

  const claim = {
    tenantId: primary.tenantId,
    userId: primary.userId,
    uploadId: upload.id,
    threadId: primary.threadId,
    workspacePath: primary.workspacePath,
  };
  const claimed = store.claimUploadForThread(claim);
  assert.equal(claimed.outcome, "claimed");
  assert.ok(claimed.outcome === "claimed");
  assert.equal(claimed.upload.threadId, primary.threadId);
  assert.equal(claimed.upload.status, "attached");
  assert.equal(uploadSummary(claimed.upload).scope, "thread");

  // Re-claiming by the same thread is a no-op, not a conflict.
  assert.equal(store.claimUploadForThread(claim).outcome, "claimed");

  const rivalThreadId = "upload-thread-rival";
  store.bindThreadWorkspace({
    tenantId: primary.tenantId,
    userId: primary.userId,
    threadId: rivalThreadId,
    workspacePath: primary.workspacePath,
  });
  assert.equal(
    store.claimUploadForThread({ ...claim, threadId: rivalThreadId }).outcome,
    "already_bound",
  );

  // A claim whose trusted binding path disagrees with the row is a conflict,
  // never a silent rebinding.
  assert.equal(
    store.claimUploadForThread({ ...claim, workspacePath: join(primary.workspacePath, "other") })
      .outcome,
    "workspace_conflict",
  );

  assert.equal(
    store.markUploadExtracted({
      tenantId: primary.tenantId,
      userId: primary.userId,
      uploadId: upload.id,
      threadId: rivalThreadId,
      turnId: "turn-1",
    }),
    false,
  );
  assert.equal(
    store.markUploadExtracted({
      tenantId: primary.tenantId,
      userId: primary.userId,
      uploadId: upload.id,
      threadId: primary.threadId,
      turnId: "turn-1",
    }),
    true,
  );
  const extracted = store.getUpload(primary.tenantId, primary.userId, upload.id);
  assert.equal(extracted?.status, "extracted");
  assert.equal(extracted?.extractionTurnId, "turn-1");
});

test("a multi-upload thread claim validates and commits the whole set atomically", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const first = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { filename: "first.csv", threadId: null }),
  );
  const second = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { filename: "second.csv", threadId: null }),
  );
  const claim = {
    tenantId: primary.tenantId,
    userId: primary.userId,
    uploadIds: [first.id, second.id],
    threadId: primary.threadId,
    workspacePath: primary.workspacePath,
  };

  const inspected = store.inspectUploadsForThread(claim);
  assert.equal(inspected.outcome, "claimed");
  assert.equal(store.getUpload(primary.tenantId, primary.userId, first.id)?.threadId, null);
  assert.equal(store.getUpload(primary.tenantId, primary.userId, second.id)?.threadId, null);

  const rejected = store.claimUploadsForThread({
    ...claim,
    uploadIds: [first.id, "01ffffffffffffffffffffffff"],
  });
  assert.equal(rejected.outcome, "not_found");
  // The valid first row must not be stranded when a later sibling is invalid.
  assert.equal(store.getUpload(primary.tenantId, primary.userId, first.id)?.status, "stored");
  assert.equal(store.getUpload(primary.tenantId, primary.userId, first.id)?.threadId, null);

  const claimed = store.claimUploadsForThread(claim);
  assert.equal(claimed.outcome, "claimed");
  assert.ok(claimed.outcome === "claimed");
  assert.deepEqual(
    claimed.uploads.map((upload) => [upload.id, upload.status, upload.threadId]),
    [
      [first.id, "attached", primary.threadId],
      [second.id, "attached", primary.threadId],
    ],
  );
});

test("upload audit rows carry no filename, no path and no bytes", async (t) => {
  const { store, primary } = await createUploadFixture(t);
  const filename = "salary-review-Q3.csv";
  const upload = settleUpload(
    store,
    primary,
    reserveUpload(store, primary, { filename, threadId: null }),
  );
  store.claimUploadForThread({
    tenantId: primary.tenantId,
    userId: primary.userId,
    uploadId: upload.id,
    threadId: primary.threadId,
    workspacePath: primary.workspacePath,
  });
  store.deleteUpload({
    tenantId: primary.tenantId,
    userId: primary.userId,
    uploadId: upload.id,
  });

  const events = store
    .listAuditEvents(primary.tenantId, 100)
    .filter((event) => event.targetType === "upload");
  assert.deepEqual(
    events.map((event) => event.action).sort(),
    ["upload.attached", "upload.created", "upload.deleted"],
  );
  for (const event of events) {
    assert.equal(event.targetId, upload.id);
    assert.equal(event.actorUserId, primary.userId);
    assert.deepEqual(Object.keys(event.metadata).sort(), [
      "contentType",
      "projectId",
      "sha256Prefix",
      "sizeBytes",
      "threadId",
    ]);
    // `sanitizedAuditMetadata` redacts by key name, so a filename would pass
    // through verbatim. It is never handed to it in the first place.
    const serialized = JSON.stringify(event.metadata);
    assert.equal(serialized.includes(filename), false);
    assert.equal(serialized.includes(primary.workspacePath), false);
    assert.equal(serialized.includes(upload.storageKey), false);
    assert.equal(serialized.includes(PAYLOAD_SHA256), false);
  }
});
