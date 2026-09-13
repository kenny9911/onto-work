import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { AgentsApiError, type AgentsApiEvent, type AgentsApiItem, type AgentsApiSession, type AgentsApiTurn } from "./client.js";
import type { AgentsApiExecutorExit, AgentsApiExecutorLaunch } from "./executor.js";
import { ManagedAgentsRuntime, type ManagedAgentsRuntimeOptions } from "./service.js";

class Queue {
  private readonly values: AgentsApiEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: AgentsApiEvent) { this.values.push(value); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *events() {
    while (!this.ended) {
      if (!this.values.length) await new Promise<void>((resolve) => { this.wake = resolve; });
      while (this.values.length && !this.ended) yield this.values.shift()!;
    }
  }
}

class FakeClient {
  session: AgentsApiSession = { id: "sess_test", status: "idle", environment: { id: "env_test", type: "self_hosted", remote_url: "https://api.openai.com/test", status: "pending" } };
  items: AgentsApiItem[] = [];
  turns: AgentsApiTurn[] = [];
  streams = new Set<Queue>();
  created = 0;
  messages = 0;
  cancellations = 0;
  deletions = 0;
  openings = 0;
  failMessage = false;
  acknowledgeCancelOnly = false;
  deletedAlready = false;
  onOpen?: (queue: Queue) => void;
  async createSession() { this.created++; return structuredClone(this.session); }
  async retrieveSession() { return structuredClone(this.session); }
  async listItems() { return structuredClone(this.items); }
  async listTurns() { return structuredClone(this.turns); }
  async retrieveTurn(_session: string, turnId: string) {
    const turn = this.turns.find((value) => value.id === turnId);
    if (!turn) throw new AgentsApiError("http", 404);
    return structuredClone(turn);
  }
  async openEventStream(_session: string, signal?: AbortSignal) {
    this.openings++;
    const queue = new Queue();
    this.streams.add(queue);
    const close = () => { queue.close(); this.streams.delete(queue); signal?.removeEventListener("abort", close); };
    if (signal?.aborted) close(); else signal?.addEventListener("abort", close, { once: true });
    this.onOpen?.(queue);
    return { events: queue.events(), close };
  }
  emit(event: AgentsApiEvent) { for (const queue of this.streams) queue.push(structuredClone(event)); }
  async sendMessage(_session: string, text: string) {
    this.messages++;
    this.items.push({ id: `user_${this.messages}`, type: "message", role: "user", status: "completed", content: [{ type: "input_text", text }] });
    const previous = this.turns.at(-1);
    const turn = previous?.status === "in_progress" ? previous : { id: `turn_${this.messages}`, status: "in_progress", subagent_id: null };
    if (turn !== previous) this.turns.push(turn);
    this.session.status = "in_progress";
    this.emit({ type: "agent.session.turn.started", turn });
    if (this.failMessage) throw new AgentsApiError("network");
  }
  async cancel() {
    this.cancellations++;
    if (!this.acknowledgeCancelOnly && this.turns.at(-1)?.status === "in_progress") this.finish("cancelled", "Partial review", 20, 4);
  }
  async deleteSession() { this.deletions++; if (this.deletedAlready) throw new AgentsApiError("http", 404); }
  finish(status = "completed", text = "Final review", input = 100, output = 20) {
    const turn = this.turns.at(-1)!;
    Object.assign(turn, { status, usage: { input_tokens: input, output_tokens: output } });
    this.items.push({ id: `answer_${turn.id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
    this.session.status = "idle";
    // Deliberately omit the final text event: the service must recover saved content.
    this.emit({ type: `agent.session.turn.${status}`, turn });
  }
}

class FakeExecutor {
  starts = 0;
  stops = 0;
  private readonly running = new Map<string, (exit: AgentsApiExecutorExit) => void>();
  constructor(private readonly client: FakeClient) {}
  async start(input: AgentsApiExecutorLaunch) {
    this.starts++;
    if (this.running.has(input.sessionId)) throw new Error("Duplicate executor");
    const closed = new Promise<AgentsApiExecutorExit>((resolve) => this.running.set(input.sessionId, resolve));
    this.client.session.environment.status = "connected";
    this.client.emit({ type: "agent.session.environment.connected" });
    return { sessionId: input.sessionId, closed, snapshot: () => ({ sessionId: input.sessionId, state: "running" as const, pid: this.starts, stdoutBytes: 0, stderrBytes: 0 }) };
  }
  async stop(sessionId: string) {
    const resolve = this.running.get(sessionId);
    if (!resolve) return;
    this.stops++;
    this.running.delete(sessionId);
    this.client.session.environment.status = "pending";
    resolve({ sessionId, expected: true, code: 0, signal: null, reason: "stopped" });
  }
  async close() { for (const id of this.running.keys()) await this.stop(id); }
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("Managed service did not reach its expected state.");
}

async function fixture(t: TestContext, customize: Partial<ManagedAgentsRuntimeOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "managed-service-")));
  const workspacePath = join(directory, "repository");
  await mkdir(workspacePath);
  const store = new HarnessStore(join(directory, "db.sqlite"));
  const tenantId = randomUUID();
  const userId = randomUUID();
  const timestamp = new Date().toISOString();
  store.db.prepare("INSERT INTO tenants(id,name,slug,created_at) VALUES (?,?,?,?)").run(tenantId, "Fixture", tenantId, timestamp);
  store.db.prepare("INSERT INTO users(id,tenant_id,username,display_name,password_hash,role,status,must_change_password,created_at) VALUES (?,?,?,'Fixture','unused','admin','active',0,?)").run(userId, tenantId, userId, timestamp);
  store.db.prepare("INSERT INTO subscriptions(tenant_id,plan,status,seats,created_at,updated_at) VALUES (?,'free','none',1,?,?)").run(tenantId, timestamp, timestamp);
  store.createEntitlementSnapshot({ tenantId, plan: "free", status: "active", seatLimit: 5, activeRunLimit: 4, requestLimit: 100, periodStart: timestamp, allowedRouteIds: ["*"] });
  const user = store.getUserSummary(userId)!;
  store.grantWorkspace({ tenantId, rootPath: workspacePath, createdByUserId: userId });
  const grant = store.findWorkspaceGrantForPath(tenantId, workspacePath)!;
  const project = store.registerSavedProject({ tenantId, name: "Fixture", workspacePath, workspaceGrantId: grant.id, createdByUserId: userId });
  const config: HarnessConfig = {
    host: "127.0.0.1", port: 0, webOrigin: "http://127.0.0.1:3500", databasePath: join(directory, "db.sqlite"), runtimeDataDir: join(directory, "runtime"), uploadDataDir: join(directory, "uploads"),
    sessionTtlMs: 3600000, sessionSecret: "test-session-secret", credentialEncryptionKey: "test-encryption-secret", codexBinary: "codex", codexExperimentalApi: false,
    allowedWorkspaceRoots: [workspacePath], stripeSecretKey: null, stripeWebhookSecret: null, stripePricePro: null, stripePriceTeam: null, publicAppUrl: "http://127.0.0.1:3500", litellmBaseUrl: "http://localhost:4000/v1", litellmMasterKey: null,
    agentsApi: { enabled: true, apiKey: "test-application-secret", executorKey: "test-restricted-secret", executorImage: `fixture@sha256:${"a".repeat(64)}`,
      model: "gpt-6-astra", skillIds: [], maxConcurrentSessions: 2, maxTurnSeconds: 600, allowedTenantIds: [tenantId] },
  };
  const client = new FakeClient();
  const executor = new FakeExecutor(client);
  const prepare: NonNullable<ManagedAgentsRuntimeOptions["prepareWorkspace"]> = async (input) => {
    const root = join(input.runtimeDataDir, "managed-agents");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(root, input.taskId, "workspace");
    const homeDirectory = join(root, input.taskId, "home");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    await mkdir(directory, { recursive: true });
    await mkdir(codexHomeDirectory, { recursive: true });
    return { directory, homeDirectory, codexHomeDirectory, sourceRevision: "a".repeat(40), excludedFiles: 0, capabilityDirectories: [], skillsFingerprint: null };
  };
  const options = { store, config, client, executor, prepareWorkspace: prepare, cleanupContainer: async () => undefined, ...customize };
  const runtime = new ManagedAgentsRuntime(options);
  t.after(async () => { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const create = () => runtime.create(user, { projectId: project.id, agentId: "repository-reviewer", message: "Review the repository" });
  return { runtime, client, executor, store, config, options, prepare, create, user, project };
}

test("terminal root events fetch saved findings and usage before stopping the executor", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  f.client.emit({ type: "agent.session.turn.completed", turn: { id: "child", status: "completed", subagent_id: "child", usage: { input_tokens: 5, output_tokens: 1 } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.runtime.repository.get(task.id)!.detail.status, "running");
  f.client.finish("completed", "Final finding test-restricted-secret");
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "idle");
  await until(() => f.executor.stops === 1);
  const result = await f.runtime.detail(f.user, task.id);
  assert.ok(result.items.some((item) => item.text === "Final finding [redacted]"));
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, reported: true });
  assert.equal(result.items.filter((item) => item.role === "user").length, 1);
  assert.equal(f.store.getUsageSummary(f.user.tenantId).inputTokens, 100);
  assert.equal(f.runtime.repository.get(task.id)!.reservationId, null);
});

test("cancellation acknowledgement stays interrupted until a confirmed outcome settles late usage", async (t) => {
  const f = await fixture(t);
  f.client.acknowledgeCancelOnly = true;
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  const cancelled = await f.runtime.cancel(f.user, task.id, "turn_1");
  assert.equal(cancelled.status, "interrupted");
  const reservationId = f.runtime.repository.get(task.id)!.reservationId;
  assert.ok(reservationId);
  await assert.rejects(f.runtime.message(f.user, task.id, { message: "Again", mode: "follow_up" }), { code: "managed_outcome_unconfirmed" });
  f.store.db.prepare("UPDATE usage_reservations SET status='expired' WHERE id=?").run(reservationId);
  f.client.finish("cancelled", "Partial review", 23, 7);
  const recovered = await f.runtime.detail(f.user, task.id);
  assert.equal(recovered.status, "cancelled");
  assert.equal(f.runtime.repository.get(task.id)!.reservationId, null);
  assert.equal(f.store.getUsageSummary(f.user.tenantId).inputTokens, 23);
  await f.runtime.detail(f.user, task.id);
  assert.equal(f.store.getUsageSummary(f.user.tenantId).inputTokens, 23);
});

test("cancelling during snapshot preparation prevents session creation and paid input", async (t) => {
  let release!: () => void;
  let preparing = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, { prepareWorkspace: async (input) => { preparing = true; await gate; return f.prepare(input); } });
  const task = await f.create();
  await until(() => preparing);
  const cancelled = await f.runtime.cancel(f.user, task.id, null);
  assert.equal(cancelled.status, "cancelled");
  release();
  await f.runtime.delete(f.user, task.id);
  assert.equal(f.client.created, 0);
  assert.equal(f.client.messages, 0);
  assert.equal(f.executor.starts, 0);
  assert.equal(f.runtime.repository.get(task.id)!.detail.status, "deleted");
});

test("uncertain input is never replayed, including server restart recovery", async (t) => {
  const f = await fixture(t);
  f.client.failMessage = true;
  f.client.acknowledgeCancelOnly = true;
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "interrupted");
  assert.equal(f.client.messages, 1);
  await f.runtime.close();
  const restarted = new ManagedAgentsRuntime({ ...f.options, executor: new FakeExecutor(f.client) });
  try {
    await restarted.initialize();
    assert.equal(f.client.messages, 1);
    assert.equal(f.client.created, 1);
    f.client.finish("completed", "Recovered after restart", 31, 9);
    const recovered = await restarted.detail(f.user, task.id);
    assert.equal(recovered.status, "idle");
    assert.ok(recovered.items.some((item) => item.text === "Recovered after restart"));
    assert.equal(f.store.getUsageSummary(f.user.tenantId).inputTokens, 31);
  } finally { await restarted.close(); }
});

test("follow-up reuses the session and ignores the preceding completed turn during connection", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  f.client.finish();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "idle");
  await f.runtime.message(f.user, task.id, { message: "Review another concern", mode: "follow_up" });
  await until(() => f.runtime.repository.get(task.id)?.detail.turnId === "turn_2");
  assert.equal(f.client.created, 1);
  assert.equal(f.client.messages, 2);
  f.client.emit({ type: "agent.session.turn.completed", turn: structuredClone(f.client.turns[0]!) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.runtime.repository.get(task.id)!.detail.status, "running");
  f.client.finish("completed", "Second answer", 50, 10);
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "idle");
  assert.deepEqual((await f.runtime.detail(f.user, task.id)).usage, { inputTokens: 150, outputTokens: 30, reported: true });
  assert.equal(f.store.getUsageSummary(f.user.tenantId).inputTokens, 150);
});

test("stream recovery restores authoritative items before draining buffered stale deltas", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  f.client.items.push({ id: "saved", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Saved complete text" }] });
  f.client.onOpen = (queue) => queue.push({ type: "agent.session.turn.output_text.delta", item_id: "saved", delta: " stale suffix" });
  for (const queue of f.client.streams) queue.close();
  await until(() => f.client.openings >= 2);
  await until(() => f.runtime.repository.get(task.id)!.detail.items.some((item) => item.text === "Saved complete text"));
  const result = await f.runtime.detail(f.user, task.id);
  assert.doesNotMatch(JSON.stringify(result.items), /stale suffix/);
  assert.equal(f.client.messages, 1);
  f.client.finish();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "idle");
});

test("delete retries local cleanup after remote 404 without repeating the remote deletion", async (t) => {
  let cleanupAttempts = 0;
  const f = await fixture(t, { cleanupContainer: async () => { if (++cleanupAttempts === 1) throw new Error("Docker unavailable"); } });
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  f.client.finish();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "idle");
  f.client.deletedAlready = true;
  await assert.rejects(f.runtime.delete(f.user, task.id), { code: "managed_delete_incomplete" });
  assert.equal(f.runtime.repository.get(task.id)!.sessionId, null);
  const deleted = await f.runtime.delete(f.user, task.id);
  assert.equal(deleted.status, "deleted");
  assert.deepEqual(deleted.items, []);
  assert.equal(f.client.deletions, 1);
  assert.equal(cleanupAttempts, 2);
});

test("authorization revocation stops a running executor and retains unconfirmed accounting", async (t) => {
  const f = await fixture(t);
  f.client.acknowledgeCancelOnly = true;
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  f.store.db.prepare("UPDATE projects SET enabled=0 WHERE id=?").run(f.project.id);
  await until(() => f.executor.stops === 1);
  const stopped = f.runtime.repository.get(task.id)!;
  assert.equal(stopped.detail.status, "interrupted");
  assert.match(stopped.detail.error!, /authorization was revoked/);
  assert.ok(stopped.reservationId);
  await assert.rejects(f.runtime.detail(f.user, task.id), { code: "project_unavailable" });
});

test("a session created after local cancellation is deleted without sending any input", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.client.createSession = async () => { f.client.created++; await gate; return structuredClone(f.client.session); };
  const task = await f.create();
  await until(() => f.client.created === 1);
  assert.equal((await f.runtime.cancel(f.user, task.id, null)).status, "cancelled");
  release();
  await until(() => f.client.deletions === 1);
  assert.equal(f.client.messages, 0);
  assert.equal(f.executor.starts, 0);
  assert.equal(f.runtime.repository.get(task.id)!.sessionId, null);
});

test("unsupported steering sends no input even when the remote turn can finish before a local status check", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  const before = f.runtime.repository.get(task.id)!.detail;
  let turnLookups = 0;
  f.client.retrieveTurn = async () => {
    turnLookups++;
    const running = structuredClone(f.client.turns[0]!);
    // A previously used read-then-send check would see running, then send its
    // input after the remote session became idle and start an unadmitted turn.
    f.client.turns[0]!.status = "completed";
    return running;
  };
  for (const expectedTurnId of ["turn_1", "other", undefined]) {
    await assert.rejects(f.runtime.message(f.user, task.id, { message: "Include permissions", mode: "steer", expectedTurnId }), { code: "managed_steering_unavailable" });
  }
  assert.equal(turnLookups, 0);
  assert.equal(f.client.messages, 1);
  assert.equal(f.client.turns.length, 1);
  assert.deepEqual(f.runtime.repository.get(task.id)!.detail, before);
  assert.equal(f.store.getUsageSummary(f.user.tenantId).requestsUsed, 1);
});

test("missing usage is recorded as unknown rather than a zero-token report", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  const turn = f.client.turns.at(-1)!;
  turn.status = "completed";
  f.client.emit({ type: "agent.session.turn.completed", turn });
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "idle");
  assert.equal((await f.runtime.detail(f.user, task.id)).usage.reported, false);
  const usage = f.store.db.prepare("SELECT input_tokens, output_tokens FROM usage_events WHERE tenant_id=?").get(f.user.tenantId);
  assert.deepEqual({ ...usage }, { input_tokens: null, output_tokens: null });
});

test("late session allocation stays durably bound when cancellation cleanup fails", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.client.createSession = async () => { f.client.created++; await gate; return structuredClone(f.client.session); };
  let failCleanup = true;
  f.client.deleteSession = async () => { f.client.deletions++; if (failCleanup) throw new AgentsApiError("network"); };
  const task = await f.create();
  await until(() => f.client.created === 1);
  await f.runtime.cancel(f.user, task.id, null);
  release();
  await until(() => f.client.deletions === 1);
  const retained = f.runtime.repository.get(task.id)!;
  assert.equal(retained.sessionId, "sess_test");
  assert.equal(retained.environmentId, "env_test");
  assert.match(retained.detail.error!, /cleanup is incomplete/);
  assert.equal(f.client.messages, 0);
  await assert.rejects(f.runtime.message(f.user, task.id, { message: "Resume too soon", mode: "follow_up" }), { code: "managed_cleanup_pending" });
  failCleanup = false;
  assert.equal((await f.runtime.delete(f.user, task.id)).status, "deleted");
  assert.equal(f.client.deletions, 2);
});

test("deleting a running task preserves confirmed cancellation usage before removing remote history", async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await until(() => f.runtime.repository.get(task.id)?.detail.status === "running");
  const deleted = await f.runtime.delete(f.user, task.id);
  assert.equal(deleted.status, "deleted");
  assert.equal(f.store.getUsageSummary(f.user.tenantId).inputTokens, 20);
  assert.equal(f.store.getUsageSummary(f.user.tenantId).outputTokens, 4);
  assert.equal(f.client.deletions, 1);
});

test("invalid optional managed credentials leave runtime construction and native startup available", async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected network request"); };
  try {
    for (const enabled of [false, true]) {
      const config = { ...f.config, agentsApi: { ...f.config.agentsApi!, enabled, apiKey: "invalid\napplication-key" } };
      const runtime = new ManagedAgentsRuntime({ store: f.store, config });
      try {
        assert.equal(runtime.catalog(f.user).available, false);
        await assert.rejects(runtime.create(f.user, { projectId: f.project.id, agentId: "repository-reviewer", message: "Review" }), { code: "managed_agents_unavailable" });
      } finally { await runtime.close(); }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
