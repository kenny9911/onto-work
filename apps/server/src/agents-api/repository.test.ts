import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { UserSummary } from "@agent-harness/contracts";
import { RunAdmissionPolicy } from "../admission.js";
import { HarnessStore } from "../database.js";
import { reviewerDefinition } from "./catalog.js";
import { ManagedTaskRepository, type ManagedTaskRecord } from "./repository.js";

const execFileAsync = promisify(execFile);

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "managed-repository-")));
  const databasePath = join(directory, "harness.db");
  const store = new HarnessStore(databasePath);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  async function tenant(name: string) {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const timestamp = new Date().toISOString();
    const workspacePath = join(directory, name);
    await mkdir(workspacePath);
    store.db.prepare("INSERT INTO tenants (id,name,slug,created_at) VALUES (?,?,?,?)").run(tenantId, name, name, timestamp);
    store.db.prepare("INSERT INTO users (id,tenant_id,username,display_name,password_hash,role,status,must_change_password,created_at) VALUES (?,?,?,?,?,'admin','active',0,?)").run(userId, tenantId, name, name, "unused-test-hash", timestamp);
    store.db.prepare("INSERT INTO subscriptions (tenant_id,plan,status,seats,created_at,updated_at) VALUES (?,'free','none',1,?,?)").run(tenantId, timestamp, timestamp);
    store.createEntitlementSnapshot({ tenantId, plan: "free", status: "active", seatLimit: 10, activeRunLimit: 4, requestLimit: 100,
      periodStart: timestamp, allowedRouteIds: ["*"] });
    store.grantWorkspace({ tenantId, rootPath: workspacePath, createdByUserId: userId });
    const grant = store.findWorkspaceGrantForPath(tenantId, workspacePath)!;
    const project = store.registerSavedProject({ tenantId, name, workspacePath, workspaceGrantId: grant.id, createdByUserId: userId });
    store.saveProvider({ tenantId, catalogId: "openai", name: "Native test route", adapter: "responses", baseUrl: "https://api.openai.test/v1",
      defaultModel: "native-model", enabled: true, isDefault: true });
    return { user: store.getUserSummary(userId)!, project, workspacePath };
  }
  const a = await tenant("tenant-a");
  const b = await tenant("tenant-b");
  const allowed = [a.user.tenantId, b.user.tenantId];
  const repository = new ManagedTaskRepository(store, allowed);
  const input = (which = a) => ({ user: which.user, taskId: randomUUID(), projectId: which.project.id,
    workspacePath: which.workspacePath, model: "gpt-6-astra", maxConcurrentSessions: 2, maxTurnSeconds: 600 });
  const saved = (which = a): ManagedTaskRecord => {
    const timestamp = new Date().toISOString();
    const definition = reviewerDefinition();
    return {
      tenantId: which.user.tenantId, userId: which.user.id, workspacePath: which.workspacePath, definition,
      sessionId: "session-private-" + randomUUID(), environmentId: "env-private", remoteUrl: "https://api.openai.com/private-executor", reservationId: null, deadlineAt: null,
      detail: { id: randomUUID(), projectId: which.project.id, projectName: which.project.name, agentId: definition.id, agentVersion: definition.version,
        title: "Review fixture", status: "idle", turnId: null, revision: 1, createdAt: timestamp, updatedAt: timestamp,
        sourceRevision: "a".repeat(40), error: null, items: [], usage: { inputTokens: 0, outputTokens: 0, reported: false } },
    };
  };
  return { directory, databasePath, store, a, b, allowed, repository, input, saved };
}

function limits(store: HarnessStore, user: UserSummary, override: Partial<Parameters<HarnessStore["createEntitlementSnapshot"]>[0]>) {
  const latest = store.getLatestEntitlementSnapshot(user.tenantId)!;
  store.createEntitlementSnapshot({ tenantId: user.tenantId, plan: latest.plan, status: latest.status, seatLimit: latest.seatLimit,
    activeRunLimit: latest.activeRunLimit, requestLimit: latest.requestLimit, periodStart: latest.periodStart, periodEnd: latest.periodEnd,
    allowedRouteIds: latest.allowedRouteIds, ...override });
}

test("managed task ownership is bound to both tenant and user and cannot be changed by updates", async (t) => {
  const f = await fixture(t);
  const task = f.saved();
  f.repository.insert(task);
  const teammateId = randomUUID();
  f.store.db.prepare("INSERT INTO users (id,tenant_id,username,display_name,password_hash,role,status,must_change_password,created_at) VALUES (?,?,?,'Teammate','unused','member','active',0,?)").run(teammateId, f.a.user.tenantId, teammateId, new Date().toISOString());
  for (const other of [f.b.user, f.store.getUserSummary(teammateId)!]) {
    assert.throws(() => f.repository.owned(other, task.detail.id), { code: "managed_task_not_found" });
    assert.deepEqual(f.repository.list(other), []);
  }
  assert.equal(f.repository.owned(f.a.user, task.detail.id).sessionId, task.sessionId);
  assert.ok(!JSON.stringify(f.repository.owned(f.a.user, task.detail.id).detail).includes("private"));
  assert.throws(() => f.repository.update(task.detail.id, (record) => { record.detail.projectId = f.b.project.id; }), /immutable/);
  assert.throws(() => f.repository.update(task.detail.id, (record) => { record.definition.model = "overridden"; }), /immutable/);
  assert.equal(f.repository.get(task.detail.id)!.detail.projectId, f.a.project.id);
});

test("managed admission requires explicit tenant enablement and current user/project/grant authority", async (t) => {
  const cases = ["not-enabled", "cross-tenant-project", "wrong-workspace", "suspended-user", "password-rotation", "disabled-project", "wrong-specific-grant"] as const;
  for (const scenario of cases) await t.test(scenario, async (t) => {
    const f = await fixture(t);
    const input = f.input();
    const expected: Record<typeof scenario, string> = {
      "not-enabled": "managed_tenant_not_enabled", "cross-tenant-project": "project_unavailable", "wrong-workspace": "workspace_not_granted",
      "suspended-user": "run_not_authorized", "password-rotation": "run_not_authorized", "disabled-project": "project_unavailable", "wrong-specific-grant": "workspace_not_granted",
    };
    let repository = f.repository;
    if (scenario === "not-enabled") repository = new ManagedTaskRepository(f.store);
    if (scenario === "cross-tenant-project") input.projectId = f.b.project.id;
    if (scenario === "wrong-workspace") input.workspacePath = f.b.workspacePath;
    if (scenario === "suspended-user") f.store.db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(f.a.user.id);
    if (scenario === "password-rotation") f.store.db.prepare("UPDATE users SET must_change_password=1 WHERE id=?").run(f.a.user.id);
    if (scenario === "disabled-project") f.store.db.prepare("UPDATE projects SET enabled=0 WHERE id=?").run(f.a.project.id);
    if (scenario === "wrong-specific-grant") {
      f.store.grantWorkspace({ tenantId: f.a.user.tenantId, rootPath: f.b.workspacePath });
      const wrongGrant = f.store.findWorkspaceGrantForPath(f.a.user.tenantId, f.b.workspacePath)!;
      // The correct grant still exists: matching any tenant grant must not rescue
      // a saved project's stale or tampered explicit grant binding.
      f.store.db.prepare("UPDATE project_workspaces SET workspace_grant_id=? WHERE project_id=?").run(wrongGrant.id, f.a.project.id);
    }
    assert.throws(() => repository.reserveTurn(input), { code: expected[scenario] });
    assert.equal(f.store.countUsageReservationsSince(f.a.user.tenantId, "1970-01-01"), 0);
  });
});

test("existing task turns cannot change owner, project, model, or reuse unresolved admission", async (t) => {
  const f = await fixture(t);
  const task = f.saved();
  f.repository.insert(task);
  assert.throws(() => f.repository.reserveTurn({ ...f.input(f.b), taskId: task.detail.id }), { code: "managed_task_not_found" });
  assert.throws(() => f.repository.reserveTurn({ ...f.input(), taskId: task.detail.id, model: "other-model" }), { code: "managed_task_not_found" });
  const reservation = f.repository.reserveTurn({ ...f.input(), taskId: task.detail.id });
  f.repository.update(task.detail.id, (record) => { Object.assign(record, reservation); record.detail.status = "interrupted"; });
  assert.throws(() => f.repository.reserveTurn({ ...f.input(), taskId: task.detail.id }), { code: "managed_task_not_ready" });
  assert.equal(f.repository.unfinished().find((item) => item.detail.id === task.detail.id)?.reservationId, reservation.reservationId);
  f.repository.update(task.detail.id, (record) => { record.reservationId = null; });
  assert.ok(!f.repository.unfinished().some((item) => item.detail.id === task.detail.id));
});

test("native and managed work share active-run and request quotas", async (t) => {
  const f = await fixture(t);
  const native = new RunAdmissionPolicy(f.store);
  const nativeInput = () => ({ tenantId: f.a.user.tenantId, userId: f.a.user.id, operation: "thread_start" as const,
    workspacePath: f.a.workspacePath, idempotencyKey: randomUUID(), requestPayload: { method: "thread/start" } });
  limits(f.store, f.a.user, { activeRunLimit: 1 });
  const first = native.admit(nativeInput());
  assert.throws(() => f.repository.reserveTurn(f.input()), { code: "active_run_limit_reached" });
  f.store.failUsageReservation(first.reservationId, f.a.user.tenantId, "fixture_finished");
  const second = f.repository.reserveTurn(f.input());
  assert.throws(() => native.admit(nativeInput()), { code: "active_run_limit_reached" });
  f.store.failUsageReservation(second.reservationId, f.a.user.tenantId, "fixture_finished");
  limits(f.store, f.a.user, { activeRunLimit: 4, requestLimit: 2 });
  assert.throws(() => f.repository.reserveTurn(f.input()), { code: "request_quota_exhausted" });
  assert.throws(() => native.admit(nativeInput()), { code: "request_quota_exhausted" });
});

test("managed admission enforces entitlement validity and numeric limits transactionally", async (t) => {
  for (const scenario of ["route", "expired", "inactive", "bad-limit"] as const) await t.test(scenario, async (t) => {
    const f = await fixture(t);
    const input = f.input();
    if (scenario === "route") limits(f.store, f.a.user, { allowedRouteIds: ["openai"] });
    if (scenario === "expired") limits(f.store, f.a.user, { periodEnd: "2000-01-01T00:00:00.000Z" });
    if (scenario === "inactive") f.store.db.prepare("UPDATE subscriptions SET status='canceled' WHERE tenant_id=?").run(f.a.user.tenantId);
    if (scenario === "bad-limit") input.maxTurnSeconds = Number.NaN;
    assert.throws(() => f.repository.reserveTurn(input), { code: { route: "route_not_entitled", expired: "entitlement_expired", inactive: "subscription_inactive", "bad-limit": "managed_limits_invalid" }[scenario] });
    assert.equal(f.store.countUsageReservationsSince(f.a.user.tenantId, "1970-01-01"), 0);
  });
});

test("independent processes cannot race beyond global managed capacity across tenants", async (t) => {
  const f = await fixture(t);
  const worker = `
    import { HarnessStore } from ${JSON.stringify(new URL("../database.ts", import.meta.url).href)};
    import { ManagedTaskRepository } from ${JSON.stringify(new URL("./repository.ts", import.meta.url).href)};
    const input = JSON.parse(process.env.MANAGED_RESERVATION_FIXTURE);
    const store = new HarnessStore(process.env.MANAGED_DATABASE_FIXTURE);
    try {
      const result = new ManagedTaskRepository(store, JSON.parse(process.env.MANAGED_ALLOWED_FIXTURE)).reserveTurn(input);
      process.stdout.write(JSON.stringify({ ok: true, id: result.reservationId }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })); }
    finally { store.close(); }
  `;
  const outcomes = await Promise.all([f.a, f.b].map((tenant) => execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", worker], {
    env: { PATH: process.env.PATH, MANAGED_RESERVATION_FIXTURE: JSON.stringify({ ...f.input(tenant), maxConcurrentSessions: 1 }),
      MANAGED_DATABASE_FIXTURE: f.databasePath, MANAGED_ALLOWED_FIXTURE: JSON.stringify(f.allowed) },
  })));
  const results = outcomes.map(({ stdout }) => JSON.parse(stdout) as { ok: boolean; code?: string });
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.code), ["managed_capacity_reached"]);
});

test("late terminal usage settles expired leases once and preserves unknown counts until reported", async (t) => {
  const f = await fixture(t);
  const task = f.saved();
  f.repository.insert(task);
  const reservation = f.repository.reserveTurn({ ...f.input(), taskId: task.detail.id });
  const pending = f.repository.update(task.detail.id, (record) => { Object.assign(record, reservation); record.detail.status = "interrupted"; });
  f.store.db.prepare("UPDATE usage_reservations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(reservation.reservationId);
  f.store.expireUsageReservations(task.tenantId, new Date().toISOString());
  assert.equal(f.store.getUsageReservation(reservation.reservationId)?.status, "expired");
  assert.equal(f.repository.settleTurn(pending, "turn-late", "cancelled", null, null), true);
  let events = f.store.db.prepare("SELECT input_tokens,output_tokens FROM usage_events WHERE reservation_id=?").all(reservation.reservationId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.input_tokens, null);
  assert.equal(f.repository.settleTurn(pending, "turn-late", "cancelled", 120, 35), true);
  assert.equal(f.repository.settleTurn(pending, "turn-late", "cancelled", 999, 999), true);
  events = f.store.db.prepare("SELECT input_tokens,output_tokens FROM usage_events WHERE reservation_id=?").all(reservation.reservationId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.input_tokens, 120);
  assert.equal(events[0]!.output_tokens, 35);
  assert.equal(f.store.getUsageReservation(reservation.reservationId)?.status, "completed");
  assert.equal(f.store.getUsageReservation(reservation.reservationId)?.turnId, "turn-late");
  assert.equal(f.store.countUsageReservationsSince(task.tenantId, "1970-01-01"), 1);
});

test("usage settlement rejects wrong tenant, task, route, turn, or current reservation without recording usage", async (t) => {
  for (const scenario of ["tenant", "user", "session", "route", "turn", "stale", "failed"] as const) await t.test(scenario, async (t) => {
    const f = await fixture(t);
    const task = f.saved();
    f.repository.insert(task);
    const reservation = f.repository.reserveTurn({ ...f.input(), taskId: task.detail.id });
    const pending = f.repository.update(task.detail.id, (record) => { Object.assign(record, reservation); record.detail.status = "interrupted"; });
    if (scenario === "tenant") pending.tenantId = f.b.user.tenantId;
    if (scenario === "user") pending.userId = f.b.user.id;
    if (scenario === "session") pending.sessionId = "other-session";
    if (scenario === "route") f.store.db.prepare("UPDATE usage_reservations SET route_catalog_id='openai' WHERE id=?").run(reservation.reservationId);
    if (scenario === "turn") f.store.db.prepare("UPDATE usage_reservations SET turn_id='different-turn' WHERE id=?").run(reservation.reservationId);
    if (scenario === "stale") f.repository.update(task.detail.id, (record) => { record.reservationId = null; });
    if (scenario === "failed") f.store.failUsageReservation(reservation.reservationId, task.tenantId, "never_submitted");
    assert.equal(f.repository.settleTurn(pending, "turn-late", "completed", 20, 10), false);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()!.count, 0);
  });
});

test("usage settlement rejects invalid token counts without closing admission", async (t) => {
  const f = await fixture(t);
  const task = f.saved();
  f.repository.insert(task);
  const reservation = f.repository.reserveTurn({ ...f.input(), taskId: task.detail.id });
  const pending = f.repository.update(task.detail.id, (record) => { Object.assign(record, reservation); });
  for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.repository.settleTurn(pending, "turn-test", "completed", count, 0), /non-negative safe integers/);
  }
  assert.equal(f.store.getUsageReservation(reservation.reservationId)?.status, "reserved");
});
