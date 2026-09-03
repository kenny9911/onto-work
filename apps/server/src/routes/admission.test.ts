import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { RunAdmissionError, RunAdmissionPolicy } from "../admission.js";
import { HarnessStore } from "../database.js";
import { DATABASE_MIGRATIONS } from "../migrations.js";
import { applyDatabaseMigrations } from "../migrations.js";
import { hashPassword } from "../security.js";

const execFile = promisify(execFileCallback);

function migrationChecksum(migration: (typeof DATABASE_MIGRATIONS)[number]): string {
  return createHash("sha256")
    .update(String(migration.version))
    .update("\0")
    .update(migration.name)
    .update("\0")
    .update(migration.sql)
    .digest("hex");
}

interface TenantFixture {
  tenantId: string;
  userId: string;
  workspace: string;
}

async function createTenant(
  store: HarnessStore,
  input: { slug: string; username: string; workspace: string; model?: string },
): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const timestamp = new Date().toISOString();
  const passwordHash = await hashPassword("admission-test-password");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db
      .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
      .run(tenantId, input.slug, input.slug, timestamp);
    store.db
      .prepare(`
        INSERT INTO users (
          id, tenant_id, username, display_name, password_hash, role, status,
          must_change_password, created_at
        ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
      `)
      .run(userId, tenantId, input.username, input.username, passwordHash, timestamp);
    store.db
      .prepare(`
        INSERT INTO subscriptions (
          tenant_id, plan, status, seats, created_at, updated_at
        ) VALUES (?, 'free', 'none', 1, ?, ?)
      `)
      .run(tenantId, timestamp, timestamp);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  store.createEntitlementSnapshot({
    tenantId,
    plan: "free",
    status: "active",
    seatLimit: 1,
    activeRunLimit: 1,
    requestLimit: 10,
    periodStart: timestamp,
    allowedRouteIds: ["*"],
  });
  store.saveProvider({
    tenantId,
    catalogId: "openai",
    name: `${input.slug} route`,
    adapter: "responses",
    baseUrl: "https://api.openai.test/v1",
    defaultModel: input.model ?? "server/model",
    enabled: true,
    isDefault: true,
  });
  store.grantWorkspace({ tenantId, rootPath: input.workspace, createdByUserId: userId });
  return { tenantId, userId, workspace: input.workspace };
}

async function admissionFixture(t: TestContext): Promise<{
  directory: string;
  store: HarnessStore;
  tenantA: TenantFixture;
  tenantB: TenantFixture;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-admission-"));
  const workspaceAPath = join(directory, "tenant-a");
  const workspaceBPath = join(directory, "tenant-b");
  await Promise.all([
    mkdir(workspaceAPath, { recursive: true }),
    mkdir(workspaceBPath, { recursive: true }),
  ]);
  const [workspaceA, workspaceB] = await Promise.all([
    realpath(workspaceAPath),
    realpath(workspaceBPath),
  ]);
  const store = new HarnessStore(join(directory, "harness.db"));
  const tenantA = await createTenant(store, {
    slug: "tenant-a",
    username: "tenant-a-admin",
    workspace: workspaceA,
  });
  const tenantB = await createTenant(store, {
    slug: "tenant-b",
    username: "tenant-b-admin",
    workspace: workspaceB,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, tenantA, tenantB };
}

function admissionInput(
  tenant: TenantFixture,
  overrides: Partial<Parameters<RunAdmissionPolicy["admit"]>[0]> = {},
): Parameters<RunAdmissionPolicy["admit"]>[0] {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    operation: "thread_start",
    workspacePath: tenant.workspace,
    idempotencyKey: randomUUID(),
    requestPayload: { method: "thread/start" },
    ...overrides,
  };
}

test("ordered migrations preserve a legacy database and record immutable versions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-migration-"));
  const databasePath = join(directory, "legacy.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run("legacy-tenant", "Legacy", "legacy", new Date().toISOString());
  legacy.close();

  const store = new HarnessStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tenant = store.db
    .prepare("SELECT id FROM tenants WHERE slug = 'legacy'")
    .get() as { id: string } | undefined;
  assert.equal(tenant?.id, "legacy-tenant");
  const versions = store.db
    .prepare("SELECT version, name, length(checksum) AS checksum_length FROM schema_migrations ORDER BY version")
    .all() as unknown as Array<{ version: number; name: string; checksum_length: number }>;
  assert.deepEqual(versions.map((version) => ({ ...version })), [
    { version: 1, name: "initial_control_plane", checksum_length: 64 },
    { version: 2, name: "production_foundation", checksum_length: 64 },
    { version: 3, name: "thread_ownership_and_usage_safety", checksum_length: 64 },
    { version: 4, name: "billing_durability", checksum_length: 64 },
    { version: 5, name: "billing_uniqueness", checksum_length: 64 },
    { version: 6, name: "saved_projects", checksum_length: 64 },
    { version: 7, name: "task_mutation_idempotency", checksum_length: 64 },
    { version: 8, name: "uploads", checksum_length: 64 },
  ]);
  assert.equal(
    migrationChecksum(DATABASE_MIGRATIONS.find((migration) => migration.version === 4)!),
    "52d42699463dde12ba8a5c4859e686917c420a27f90ab27d12be54fb82d5cdf7",
  );
});

test("an existing billing durability database advances through the follow-up migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-v4-migration-"));
  const databasePath = join(directory, "v4.db");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of DATABASE_MIGRATIONS.filter((candidate) => candidate.version <= 4)) {
    database.exec(migration.sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        new Date().toISOString(),
      );
  }

  applyDatabaseMigrations(database);
  const applied = database
    .prepare("SELECT name FROM schema_migrations WHERE version = 5")
    .get() as { name: string } | undefined;
  assert.equal(applied?.name, "billing_uniqueness");
  const indexes = database
    .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'subscriptions_stripe_%_unique'
      ORDER BY name
    `)
    .all() as unknown as Array<{ name: string }>;
  assert.deepEqual(
    indexes.map((index) => index.name),
    ["subscriptions_stripe_customer_unique", "subscriptions_stripe_subscription_unique"],
  );
  database.close();
});

test("migration runner rejects a database created by a newer build", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-newer-migration-"));
  const databasePath = join(directory, "newer.db");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  applyDatabaseMigrations(database);
  database
    .prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'future', ?, ?)",
    )
    .run("f".repeat(64), new Date().toISOString());
  assert.throws(
    () => applyDatabaseMigrations(database),
    /migration 999 is newer than or unknown/i,
  );
  database.close();
});

test("an existing task-mutation database advances through the uploads migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-v7-migration-"));
  const databasePath = join(directory, "v7.db");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of DATABASE_MIGRATIONS.filter((candidate) => candidate.version <= 7)) {
    database.exec(migration.sql);
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        new Date().toISOString(),
      );
  }

  applyDatabaseMigrations(database);
  const applied = database
    .prepare("SELECT name FROM schema_migrations WHERE version = 8")
    .get() as { name: string } | undefined;
  assert.equal(applied?.name, "uploads");

  const objects = database
    .prepare(`
      SELECT name FROM sqlite_master
      WHERE name = 'uploads' OR name LIKE 'uploads\\_%' ESCAPE '\\'
      ORDER BY name
    `)
    .all() as unknown as Array<{ name: string }>;
  assert.deepEqual(objects.map((object) => object.name), [
    "uploads",
    "uploads_accounting",
    "uploads_expiry",
    "uploads_project",
    "uploads_scope_guard_insert",
    "uploads_scope_guard_update",
    "uploads_thread",
  ]);

  const entitlementColumns = (
    database
      .prepare("SELECT name FROM pragma_table_info('entitlement_snapshots')")
      .all() as unknown as Array<{ name: string }>
  ).map((column) => column.name);
  assert.ok(entitlementColumns.includes("storage_bytes_limit"));
  assert.ok(entitlementColumns.includes("upload_bytes_period_limit"));
  database.close();
});

test("the uploads schema binds a row to its thread or project scope", async (t) => {
  const { store, tenantA, tenantB } = await admissionFixture(t);
  const timestamp = new Date().toISOString();
  const grant = store.findWorkspaceGrantForPath(tenantA.tenantId, tenantA.workspace);
  assert.ok(grant);
  const project = store.registerSavedProject({
    tenantId: tenantA.tenantId,
    name: "uploads-scope",
    workspacePath: tenantA.workspace,
    workspaceGrantId: grant.id,
    createdByUserId: tenantA.userId,
  });
  store.db
    .prepare(`
      INSERT INTO thread_workspace_bindings (
        tenant_id, user_id, thread_id, workspace_path, created_at, updated_at
      ) VALUES (?, ?, 'thread-uploads', ?, ?, ?)
    `)
    .run(tenantA.tenantId, tenantA.userId, tenantA.workspace, timestamp, timestamp);

  const insertUpload = (values: {
    id: string;
    tenantId: string;
    userId: string;
    threadId: string | null;
    projectId: string | null;
    workspacePath: string;
  }): void => {
    store.db
      .prepare(`
        INSERT INTO uploads (
          id, tenant_id, user_id, thread_id, project_id, workspace_path, filename,
          content_type, size_bytes, content_sha256, storage_key, encryption_iv,
          encryption_tag, wrapped_data_key, status, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'notes.md', 'text/markdown', 11, ?, ?, 'iv', 'tag', 'key',
                  'stored', ?, ?, ?)
      `)
      .run(
        values.id,
        values.tenantId,
        values.userId,
        values.threadId,
        values.projectId,
        values.workspacePath,
        "a".repeat(64),
        `blobs/aa/${values.id}`,
        timestamp,
        timestamp,
        timestamp,
      );
  };

  // Both composite foreign keys resolve: SQLite reports a parent-index mismatch
  // at insert time, not when the table is created.
  insertUpload({
    id: "upload-thread",
    tenantId: tenantA.tenantId,
    userId: tenantA.userId,
    threadId: "thread-uploads",
    projectId: null,
    workspacePath: tenantA.workspace,
  });
  // A NULL thread leaves the binding foreign key vacuously satisfied, which is
  // what lets a project-scoped upload live in the same table.
  insertUpload({
    id: "upload-project",
    tenantId: tenantA.tenantId,
    userId: tenantA.userId,
    threadId: null,
    projectId: project.id,
    workspacePath: tenantA.workspace,
  });

  assert.throws(
    () =>
      insertUpload({
        id: "upload-scopeless",
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        threadId: null,
        projectId: null,
        workspacePath: tenantA.workspace,
      }),
    /upload scope or workspace mismatch/,
  );
  assert.throws(
    () =>
      insertUpload({
        id: "upload-wrong-workspace",
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        threadId: "thread-uploads",
        projectId: null,
        workspacePath: tenantB.workspace,
      }),
    /upload scope or workspace mismatch/,
  );
  assert.throws(
    () =>
      insertUpload({
        id: "upload-dangling-thread",
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        threadId: "thread-that-was-never-bound",
        projectId: null,
        workspacePath: tenantA.workspace,
      }),
    /upload scope or workspace mismatch/,
  );

  const stored = store.db
    .prepare("SELECT id FROM uploads ORDER BY id")
    .all() as unknown as Array<{ id: string }>;
  assert.deepEqual(stored.map((row) => row.id), ["upload-project", "upload-thread"]);
});

test("a database carrying the uploads migration is refused by a build that predates it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-downgrade-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(directory, "v8.db"));
  applyDatabaseMigrations(database);

  // Stand up the previous build by loading a copy of this module with the
  // uploads migration removed; the runner reads its list from module scope, so
  // there is no other way to observe a downgrade.
  const source = await readFile(new URL("../migrations.ts", import.meta.url), "utf8");
  const olderSource = source.replace(/\n {2}\{\n {4}version: 8,\n[\s\S]*?\n {2}\},/, "");
  const olderPath = join(directory, "migrations-v7.ts");
  await writeFile(olderPath, olderSource);
  const olderBuild = (await import(pathToFileURL(olderPath).href)) as {
    DATABASE_MIGRATIONS: readonly { version: number }[];
    applyDatabaseMigrations: (database: DatabaseSync) => void;
  };
  assert.equal(
    olderBuild.DATABASE_MIGRATIONS.some((migration) => migration.version === 8),
    false,
  );

  assert.throws(
    () => olderBuild.applyDatabaseMigrations(database),
    /migration 8 is newer than or unknown/i,
  );
  database.close();
});

test(
  "database files use owner-only permissions",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-harness-db-mode-"));
    const databasePath = join(directory, "secure.db");
    const store = new HarnessStore(databasePath);
    t.after(async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    const databaseStat = await stat(databasePath);
    assert.equal(databaseStat.mode & 0o777, 0o600);
    for (const candidate of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      const candidateStat = await stat(candidate).catch(() => null);
      if (candidateStat) assert.equal(candidateStat.mode & 0o777, 0o600);
    }
  },
);

test("run admission isolates tenants and rejects client model overrides", async (t) => {
  const { store, tenantA, tenantB } = await admissionFixture(t);
  const policy = new RunAdmissionPolicy(store);

  assert.throws(
    () =>
      policy.admit(
        admissionInput(tenantA, {
          workspacePath: tenantB.workspace,
          idempotencyKey: "cross-tenant-workspace",
        }),
      ),
    (error: unknown) =>
      error instanceof RunAdmissionError && error.code === "workspace_not_granted",
  );
  assert.equal(store.countUsageReservationsSince(tenantA.tenantId, "1970-01-01"), 0);

  assert.throws(
    () =>
      policy.admit(
        admissionInput(tenantA, {
          requestedModel: "client/override",
          idempotencyKey: "model-override",
        }),
      ),
    (error: unknown) =>
      error instanceof RunAdmissionError && error.code === "model_override_forbidden",
  );

  const admitted = policy.admit(
    admissionInput(tenantA, { idempotencyKey: "server-selected-model" }),
  );
  assert.equal(admitted.model, "server/model");
  assert.equal(admitted.provider.tenant_id, tenantA.tenantId);
  assert.equal(admitted.workspacePath, tenantA.workspace);
});

test("idempotency and active/request quotas are enforced in the reservation transaction", async (t) => {
  const { store, tenantA } = await admissionFixture(t);
  const policyA = new RunAdmissionPolicy(store);
  const sameRequest = admissionInput(tenantA, { idempotencyKey: "same-run" });
  const first = policyA.admit(sameRequest);
  assert.throws(
    () => policyA.admit(sameRequest),
    (error: unknown) => error instanceof RunAdmissionError && error.code === "request_in_progress",
  );

  assert.throws(
    () =>
      policyA.admit(
        admissionInput(tenantA, { idempotencyKey: "concurrent-run" }),
      ),
    (error: unknown) =>
      error instanceof RunAdmissionError && error.code === "active_run_limit_reached",
  );

  store.recordUsageReservationResponse({
    reservationId: first.reservationId,
    tenantId: tenantA.tenantId,
    response: { thread: { id: "thread-1" } },
    completesReservation: false,
  });
  store.completeUsageReservation({
    reservationId: first.reservationId,
    tenantId: tenantA.tenantId,
    eventKey: "thread-started:thread-1",
    eventType: "thread_started",
  });
  const replay = policyA.admit(sameRequest);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.replayResult, { thread: { id: "thread-1" } });

  const latest = store.getLatestEntitlementSnapshot(tenantA.tenantId)!;
  store.createEntitlementSnapshot({
    tenantId: tenantA.tenantId,
    plan: latest.plan,
    status: latest.status,
    seatLimit: latest.seatLimit,
    activeRunLimit: 2,
    requestLimit: 1,
    periodStart: latest.periodStart,
    periodEnd: latest.periodEnd,
    allowedRouteIds: latest.allowedRouteIds,
  });
  assert.throws(
    () =>
      policyA.admit(
        admissionInput(tenantA, { idempotencyKey: "request-over-quota" }),
      ),
    (error: unknown) =>
      error instanceof RunAdmissionError && error.code === "request_quota_exhausted",
  );
});

test("turn admission derives the owned binding and rechecks current grants", async (t) => {
  const { store, tenantA, tenantB } = await admissionFixture(t);
  const policy = new RunAdmissionPolicy(store);
  store.bindThreadWorkspace({
    tenantId: tenantA.tenantId,
    userId: tenantA.userId,
    threadId: "shared-looking-thread-id",
    workspacePath: tenantA.workspace,
  });
  store.bindThreadWorkspace({
    tenantId: tenantB.tenantId,
    userId: tenantB.userId,
    threadId: "shared-looking-thread-id",
    workspacePath: tenantB.workspace,
  });

  const admitted = policy.admit(
    admissionInput(tenantA, {
      operation: "turn_start",
      workspacePath: undefined,
      threadId: "shared-looking-thread-id",
      idempotencyKey: "bound-turn",
      requestPayload: { method: "turn/start" },
    }),
  );
  assert.equal(admitted.workspacePath, tenantA.workspace);
  assert.equal(store.getUsageReservation(admitted.reservationId)?.workspacePath, tenantA.workspace);
  store.failUsageReservation(admitted.reservationId, tenantA.tenantId, "test_cleanup");

  store.db
    .prepare("DELETE FROM workspace_grants WHERE tenant_id = ?")
    .run(tenantA.tenantId);
  assert.throws(
    () =>
      policy.admit(
        admissionInput(tenantA, {
          operation: "turn_start",
          workspacePath: undefined,
          threadId: "shared-looking-thread-id",
          idempotencyKey: "revoked-bound-turn",
        }),
      ),
    (error: unknown) =>
      error instanceof RunAdmissionError && error.code === "workspace_not_granted",
  );
});

test("usage settlement rejects tenant mismatch and restart reconciliation closes leases", async (t) => {
  const { store, tenantA, tenantB } = await admissionFixture(t);
  const policy = new RunAdmissionPolicy(store);
  const admitted = policy.admit(
    admissionInput(tenantA, { idempotencyKey: "tenant-safe-settlement" }),
  );

  assert.throws(
    () =>
      store.completeUsageReservation({
        reservationId: admitted.reservationId,
        tenantId: tenantB.tenantId,
        eventKey: "cross-tenant-event",
        eventType: "thread_started",
      }),
    /does not belong to the supplied tenant/,
  );
  assert.throws(
    () =>
      store.db
        .prepare(`
          INSERT INTO usage_events (
            id, tenant_id, reservation_id, event_key, event_type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          tenantB.tenantId,
          admitted.reservationId,
          "direct-cross-tenant-event",
          "thread_started",
          new Date().toISOString(),
        ),
    /usage event tenant mismatch/,
  );
  const eventCount = store.db
    .prepare("SELECT COUNT(*) AS count FROM usage_events WHERE reservation_id = ?")
    .get(admitted.reservationId) as { count: number };
  assert.equal(eventCount.count, 0);
  assert.equal(store.getUsageReservation(admitted.reservationId)?.status, "reserved");

  assert.equal(store.reconcileOrphanedUsageReservations(), 1);
  assert.deepEqual(
    (() => {
      const reservation = store.getUsageReservation(admitted.reservationId)!;
      return { status: reservation.status, errorCode: reservation.errorCode };
    })(),
    { status: "failed", errorCode: "server_restarted" },
  );
});

test("correlated activity renews only the matching active turn lease", async (t) => {
  const { store, tenantA } = await admissionFixture(t);
  const policy = new RunAdmissionPolicy(store);
  store.bindThreadWorkspace({
    tenantId: tenantA.tenantId,
    userId: tenantA.userId,
    threadId: "lease-thread",
    workspacePath: tenantA.workspace,
  });
  const admitted = policy.admit(
    admissionInput(tenantA, {
      operation: "turn_start",
      workspacePath: undefined,
      threadId: "lease-thread",
      idempotencyKey: "renewed-turn",
    }),
  );
  assert.equal(
    store.recordUsageReservationResponse({
      reservationId: admitted.reservationId,
      tenantId: tenantA.tenantId,
      response: { turn: { id: "turn-lease" } },
      completesReservation: false,
      threadId: "lease-thread",
      turnId: "turn-lease",
    }),
    true,
  );
  assert.equal(
    store.recordUsageReservationResponse({
      reservationId: admitted.reservationId,
      tenantId: tenantA.tenantId,
      response: { turn: { id: "wrong-turn" } },
      completesReservation: false,
      threadId: "lease-thread",
      turnId: "wrong-turn",
    }),
    false,
  );
  assert.throws(
    () =>
      store.completeUsageReservation({
        reservationId: admitted.reservationId,
        tenantId: tenantA.tenantId,
        eventKey: "uncorrelated-completion",
        eventType: "turn_completed",
      }),
    /requires exact thread and turn correlation/,
  );
  assert.equal(
    store.renewUsageReservation({
      reservationId: admitted.reservationId,
      tenantId: tenantA.tenantId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      threadId: "lease-thread",
      turnId: "wrong-turn",
    }),
    false,
  );
  assert.equal(
    store.renewUsageReservation({
      reservationId: admitted.reservationId,
      tenantId: tenantA.tenantId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      threadId: "lease-thread",
      turnId: "turn-lease",
    }),
    true,
  );
  assert.equal(
    store.getUsageReservation(admitted.reservationId)?.expiresAt,
    "2099-01-01T00:00:00.000Z",
  );
});

test("two server processes cannot race past the final active-run quota", async (t) => {
  const { directory, tenantA } = await admissionFixture(t);
  const databasePath = join(directory, "harness.db");
  const databaseModule = pathToFileURL(join(process.cwd(), "src/database.ts")).href;
  const admissionModule = pathToFileURL(join(process.cwd(), "src/admission.ts")).href;
  const worker = `
    import { HarnessStore } from ${JSON.stringify(databaseModule)};
    import { RunAdmissionPolicy } from ${JSON.stringify(admissionModule)};
    const workerInput = JSON.parse(process.env.AGENT_HARNESS_ADMISSION_RACE_INPUT);
    const workerStore = new HarnessStore(process.env.AGENT_HARNESS_ADMISSION_RACE_DATABASE);
    try {
      const result = new RunAdmissionPolicy(workerStore).admit(workerInput);
      process.stdout.write(JSON.stringify({ ok: true, reservationId: result.reservationId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "unknown" }));
    } finally {
      workerStore.close();
    }
  `;
  const runWorker = (key: string) =>
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", worker],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENT_HARNESS_ADMISSION_RACE_DATABASE: databasePath,
          AGENT_HARNESS_ADMISSION_RACE_INPUT: JSON.stringify(
            admissionInput(tenantA, { idempotencyKey: key }),
          ),
        },
      },
    );

  // Independent server processes contend for the same SQLite write lock,
  // matching horizontal-start behavior.
  const outcomes = await Promise.all([runWorker("race-a"), runWorker("race-b")]);
  const parsed = outcomes.map(({ stdout }) => JSON.parse(stdout) as { ok: boolean; code?: string });
  assert.equal(parsed.filter((outcome) => outcome.ok).length, 1);
  assert.deepEqual(
    parsed.filter((outcome) => !outcome.ok).map((outcome) => outcome.code),
    ["active_run_limit_reached"],
  );

});
