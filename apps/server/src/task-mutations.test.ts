import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HarnessStore } from "./database.js";
import { TaskMutationLedger } from "./task-mutations.js";

interface Principal {
  tenantId: string;
  userId: string;
}

interface LedgerFixture {
  databasePath: string;
  getStore(): HarnessStore;
  reopen(): HarnessStore;
  tenantAUserA: Principal;
  tenantAUserB: Principal;
  tenantBUserA: Principal;
}

function insertPrincipal(
  store: HarnessStore,
  input: { tenantId: string; tenantSlug: string; userId: string; username: string },
): void {
  const timestamp = new Date().toISOString();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(input.tenantId, input.tenantSlug, input.tenantSlug, timestamp);
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, 'test-hash', 'member', 'active', 0, ?)
    `)
    .run(input.userId, input.tenantId, input.username, input.username, timestamp);
}

async function createLedgerFixture(t: TestContext): Promise<LedgerFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-task-mutations-"));
  const databasePath = join(directory, "harness.db");
  let store = new HarnessStore(databasePath);

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantAUserA = { tenantId: tenantA, userId: randomUUID() };
  const tenantAUserB = { tenantId: tenantA, userId: randomUUID() };
  const tenantBUserA = { tenantId: tenantB, userId: randomUUID() };

  insertPrincipal(store, {
    ...tenantAUserA,
    tenantSlug: `tenant-a-${randomUUID()}`,
    username: `tenant-a-user-a-${randomUUID()}`,
  });
  insertPrincipal(store, {
    ...tenantAUserB,
    tenantSlug: `tenant-a-${randomUUID()}`,
    username: `tenant-a-user-b-${randomUUID()}`,
  });
  insertPrincipal(store, {
    ...tenantBUserA,
    tenantSlug: `tenant-b-${randomUUID()}`,
    username: `tenant-b-user-a-${randomUUID()}`,
  });

  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    databasePath,
    getStore: () => store,
    reopen: () => {
      store.close();
      store = new HarnessStore(databasePath);
      return store;
    },
    tenantAUserA,
    tenantAUserB,
    tenantBUserA,
  };
}

function reservationInput(
  principal: Principal,
  overrides: Partial<Parameters<TaskMutationLedger["reserve"]>[0]> = {},
): Parameters<TaskMutationLedger["reserve"]>[0] {
  return {
    ...principal,
    idempotencyKey: randomUUID(),
    action: "task.archive",
    targetId: "thread-123",
    requestHash: "a".repeat(64),
    ...overrides,
  };
}

test("completed mutations replay their response after the SQLite store is reopened", async (t) => {
  const fixture = await createLedgerFixture(t);
  const input = reservationInput(fixture.tenantAUserA);
  const firstLedger = new TaskMutationLedger(fixture.getStore().db);
  const first = firstLedger.reserve(input);

  assert.equal(first.state, "started");
  if (first.state !== "started") return;
  assert.equal(
    firstLedger.complete({
      id: first.id,
      ...fixture.tenantAUserA,
      response: {
        task: { id: "thread-123", archived: true },
        status: "completed",
      },
    }),
    true,
  );

  const reopenedStore = fixture.reopen();
  const replay = new TaskMutationLedger(reopenedStore.db).reserve(input);

  assert.deepEqual(replay, {
    state: "replayed",
    id: first.id,
    response: {
      task: { id: "thread-123", archived: true },
      status: "completed",
    },
  });
  const count = reopenedStore.db
    .prepare("SELECT COUNT(*) AS count FROM task_mutations")
    .get() as { count: number };
  assert.equal(count.count, 1);
});

test("an idempotency key cannot be reused for a different mutation", async (t) => {
  const fixture = await createLedgerFixture(t);
  const ledger = new TaskMutationLedger(fixture.getStore().db);
  const key = randomUUID();
  const original = reservationInput(fixture.tenantAUserA, { idempotencyKey: key });
  const started = ledger.reserve(original);

  assert.equal(started.state, "started");
  for (const changed of [
    { ...original, action: "task.unarchive" },
    { ...original, targetId: "thread-456" },
    { ...original, requestHash: "b".repeat(64) },
  ]) {
    const conflict = ledger.reserve(changed);
    assert.equal(conflict.state, "conflict");
    assert.equal(conflict.id, started.id);
  }
});

test("an identical mutation remains in progress while its lease is active", async (t) => {
  const fixture = await createLedgerFixture(t);
  const ledger = new TaskMutationLedger(fixture.getStore().db);
  const input = reservationInput(fixture.tenantAUserA);
  const started = ledger.reserve(input);
  const duplicate = ledger.reserve(input);

  assert.equal(started.state, "started");
  assert.deepEqual(duplicate, { state: "in_progress", id: started.id });
});

test("failed mutations are closed and cannot later be completed", async (t) => {
  const fixture = await createLedgerFixture(t);
  const ledger = new TaskMutationLedger(fixture.getStore().db);
  const input = reservationInput(fixture.tenantAUserA);
  const started = ledger.reserve(input);

  assert.equal(started.state, "started");
  if (started.state !== "started") return;
  assert.equal(
    ledger.fail({
      id: started.id,
      ...fixture.tenantAUserA,
      errorCode: "runtime_unavailable",
    }),
    true,
  );
  assert.deepEqual(ledger.reserve(input), { state: "closed", id: started.id });
  assert.equal(
    ledger.complete({
      id: started.id,
      ...fixture.tenantAUserA,
      response: { ok: true },
    }),
    false,
  );
  assert.equal(
    ledger.fail({
      id: started.id,
      ...fixture.tenantAUserA,
      errorCode: "second_failure",
    }),
    false,
  );
});

test("expired pending mutations fail closed instead of being executed again", async (t) => {
  const fixture = await createLedgerFixture(t);
  const store = fixture.getStore();
  const ledger = new TaskMutationLedger(store.db);
  const input = reservationInput(fixture.tenantAUserA);
  const started = ledger.reserve(input);

  assert.equal(started.state, "started");
  store.db
    .prepare("UPDATE task_mutations SET expires_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", started.id);

  assert.deepEqual(ledger.reserve(input), { state: "closed", id: started.id });
  const row = store.db
    .prepare("SELECT status, error_code FROM task_mutations WHERE id = ?")
    .get(started.id) as { status: string; error_code: string | null };
  assert.deepEqual({ ...row }, { status: "failed", error_code: "lease_expired" });
});

test("idempotency keys are isolated by both tenant and user", async (t) => {
  const fixture = await createLedgerFixture(t);
  const store = fixture.getStore();
  const ledger = new TaskMutationLedger(store.db);
  const idempotencyKey = randomUUID();
  const reservations = [
    ledger.reserve(reservationInput(fixture.tenantAUserA, { idempotencyKey })),
    ledger.reserve(reservationInput(fixture.tenantAUserB, { idempotencyKey })),
    ledger.reserve(reservationInput(fixture.tenantBUserA, { idempotencyKey })),
  ];

  assert.deepEqual(
    reservations.map((reservation) => reservation.state),
    ["started", "started", "started"],
  );
  assert.equal(new Set(reservations.map((reservation) => reservation.id)).size, 3);
  const rows = store.db
    .prepare(`
      SELECT tenant_id, user_id FROM task_mutations
      WHERE idempotency_key = ? ORDER BY tenant_id, user_id
    `)
    .all(idempotencyKey) as unknown as Array<{ tenant_id: string; user_id: string }>;
  assert.equal(rows.length, 3);
  assert.deepEqual(
    new Set(rows.map((row) => `${row.tenant_id}:${row.user_id}`)),
    new Set([
      `${fixture.tenantAUserA.tenantId}:${fixture.tenantAUserA.userId}`,
      `${fixture.tenantAUserB.tenantId}:${fixture.tenantAUserB.userId}`,
      `${fixture.tenantBUserA.tenantId}:${fixture.tenantBUserA.userId}`,
    ]),
  );
});
