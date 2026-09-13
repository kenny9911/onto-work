import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import type { ManagedTaskDetail, UserSummary } from "@agent-harness/contracts";
import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { UnconfiguredHarnessRuntime } from "../runtime.js";
import { reviewerDefinition } from "../agents-api/catalog.js";
import { ManagedTaskRepository } from "../agents-api/repository.js";
import { ManagedAgentsRuntime, type ManagedAgentsRuntimeOptions } from "../agents-api/service.js";
import { ApiHttpError } from "../http.js";

function responseCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function fixture(t: TestContext, options: { executor?: ManagedAgentsRuntimeOptions["executor"] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-managed-http-"));
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory);
  const workspace = await realpath(workspaceDirectory);
  const config: HarnessConfig = {
    host: "127.0.0.1", port: 0, webOrigin: "http://127.0.0.1:3590",
    databasePath: join(directory, "harness.db"), runtimeDataDir: join(directory, "runtime"), uploadDataDir: join(directory, "uploads"),
    sessionTtlMs: 60 * 60 * 1000, sessionSecret: "test-managed-session-secret-long-enough", credentialEncryptionKey: "test-managed-credential-key-long-enough",
    codexBinary: "codex", codexExperimentalApi: false, allowedWorkspaceRoots: [workspace],
    stripeSecretKey: null, stripeWebhookSecret: null, stripePricePro: null, stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:3590", litellmBaseUrl: "http://127.0.0.1:4000/v1", litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  const admin = await store.bootstrapAdmin("managed-admin", "managed-test-password");
  store.db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(admin.id);
  const entitlement = store.getLatestEntitlementSnapshot(admin.tenantId)!;
  store.createEntitlementSnapshot({ ...entitlement, seatLimit: 2 });
  const member = await store.createUser({ tenantId: admin.tenantId, username: "managed-member", displayName: "Managed Member", password: "managed-test-password", role: "member" });
  store.db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(member.id);
  const managedAgents = new ManagedAgentsRuntime({ store, config, ...options });
  const app = await buildApp({ config, store, runtime: new UnconfiguredHarnessRuntime(), managedAgents, logger: false });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function login(username: string) {
    const result = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: config.webOrigin }, payload: { username, password: "managed-test-password" } });
    assert.equal(result.statusCode, 200);
    return responseCookie(result);
  }
  const cookie = await login("managed-admin");
  const memberCookie = await login("managed-member");
  const grant = store.findWorkspaceGrantForPath(admin.tenantId, workspace)!;
  const project = store.registerSavedProject({ tenantId: admin.tenantId, name: "Managed fixture project", workspacePath: workspace, workspaceGrantId: grant.id, createdByUserId: admin.id });
  return { app, store, config, directory, workspace, admin, member, cookie, memberCookie, project, login, managedAgents };
}

function mutationHeaders(f: Awaited<ReturnType<typeof fixture>>, cookie = f.cookie) {
  return { cookie, origin: f.config.webOrigin, "idempotency-key": randomUUID() };
}

function seedTask(f: Awaited<ReturnType<typeof fixture>>, owner: UserSummary = f.admin): ManagedTaskDetail {
  const definition = reviewerDefinition();
  const task: ManagedTaskDetail = {
    id: randomUUID(), projectId: f.project.id, projectName: f.project.name,
    agentId: definition.id, agentVersion: definition.version, title: "Review fixture authorization", status: "idle", turnId: null,
    revision: 1, sourceRevision: "a".repeat(40), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null,
    items: [{ id: "public-item", role: "assistant", status: "completed", text: "Task output visible only to its owner.", subagentId: null }],
    usage: { inputTokens: 100, outputTokens: 10, reported: true },
  };
  new ManagedTaskRepository(f.store).insert({ tenantId: owner.tenantId, userId: owner.id, workspacePath: f.workspace,
    definition, detail: task, sessionId: `private-session-${randomUUID()}`, environmentId: "private-environment", remoteUrl: "https://private-executor.example/register?token=canary",
    reservationId: null, deadlineAt: null });
  return task;
}

test("deleting a user cannot orphan managed sessions through database cascade", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f, f.member);
  const blocked = await f.app.inject({ method: "DELETE", url: `/api/users/${f.member.id}`, headers: mutationHeaders(f) });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, "user_managed_sessions_exist");
  assert.ok(f.store.getUserById(f.member.id));
  new ManagedTaskRepository(f.store).update(task.id, (record) => {
    record.detail.status = "deleted"; record.detail.items = []; record.sessionId = null; record.environmentId = null; record.remoteUrl = null;
  });
  const removed = await f.app.inject({ method: "DELETE", url: `/api/users/${f.member.id}`, headers: mutationHeaders(f) });
  assert.equal(removed.statusCode, 204);
  assert.equal(f.store.getUserById(f.member.id), undefined);
});

test("managed routes require authentication, including history and event streams", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const routes = [
    { method: "GET" as const, url: "/api/managed-agents" },
    { method: "GET" as const, url: "/api/managed-tasks" },
    { method: "GET" as const, url: `/api/managed-tasks/${task.id}` },
    { method: "GET" as const, url: `/api/managed-tasks/${task.id}/events` },
    { method: "POST" as const, url: "/api/managed-tasks", payload: { projectId: f.project.id, agentId: "repository-reviewer", message: "Review" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/messages`, payload: { message: "Review", mode: "follow_up" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/cancel`, payload: { expectedTurnId: null } },
    { method: "DELETE" as const, url: `/api/managed-tasks/${task.id}` },
  ];
  for (const request of routes) {
    const response = await f.app.inject({ ...request, headers: { origin: f.config.webOrigin, "idempotency-key": randomUUID() } });
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.json().error, "unauthenticated");
  }
});

test("disabled managed runtime reports its configuration state and preserves owned history without leaking executor details", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const catalog = await f.app.inject({ method: "GET", url: "/api/managed-agents", headers: { cookie: f.cookie } });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().available, false);
  assert.match(catalog.json().reason, /disabled|operator|not enabled/i);
  assert.equal(catalog.json().agents[0].id, "repository-reviewer");
  assert.equal(catalog.json().agents[0].capabilities.writeActions, false);
  assert.equal(catalog.json().agents[0].instructions, undefined);

  for (const url of ["/api/managed-tasks", `/api/managed-tasks/${task.id}`]) {
    const result = await f.app.inject({ method: "GET", url, headers: { cookie: f.cookie } });
    assert.equal(result.statusCode, 200);
    assert.doesNotMatch(result.body, /private-session|private-environment|private-executor|token=canary|workspacePath|skillIds|instructions/);
    assert.ok(result.body.includes(task.id));
  }
  const create = await f.app.inject({ method: "POST", url: "/api/managed-tasks", headers: mutationHeaders(f), payload: { projectId: f.project.id, agentId: "repository-reviewer", message: "Review permissions" } });
  assert.equal(create.statusCode, 503);
  assert.equal(new ManagedTaskRepository(f.store).list(f.admin).length, 1);
});

test("managed task reads and mutations hide another user's task, even in the same tenant", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const list = await f.app.inject({ method: "GET", url: "/api/managed-tasks", headers: { cookie: f.memberCookie } });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { tasks: [] });
  const requests = [
    { method: "GET" as const, url: `/api/managed-tasks/${task.id}` },
    { method: "GET" as const, url: `/api/managed-tasks/${task.id}/events` },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/messages`, payload: { message: "Read this task", mode: "follow_up" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/cancel`, payload: { expectedTurnId: null } },
    { method: "DELETE" as const, url: `/api/managed-tasks/${task.id}` },
  ];
  for (const request of requests) {
    const response = await f.app.inject({ ...request, headers: mutationHeaders(f, f.memberCookie) });
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
    assert.equal(response.json().error, "managed_task_not_found");
    assert.doesNotMatch(response.body, /Task output visible|private-session|private-environment/);
  }
});

test("all managed mutations require an allowed Origin", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const requests = [
    { method: "POST" as const, url: "/api/managed-tasks", payload: { projectId: f.project.id, agentId: "repository-reviewer", message: "Review" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/messages`, payload: { message: "Review", mode: "follow_up" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/cancel`, payload: { expectedTurnId: null } },
    { method: "DELETE" as const, url: `/api/managed-tasks/${task.id}` },
  ];
  for (const request of requests) {
    for (const origin of [undefined, "https://untrusted.example"]) {
      const response = await f.app.inject({ ...request, headers: { cookie: f.cookie, "idempotency-key": randomUUID(), ...(origin ? { origin } : {}) } });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
      assert.equal(response.json().error, "invalid_origin");
    }
  }
});

test("managed schemas reject browser-supplied runtime authority and unsupported actions", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const base = { projectId: f.project.id, agentId: "repository-reviewer", message: "Review" };
  for (const extra of [{ cwd: "/etc" }, { model: "other-model" }, { tools: [] }, { attachments: [] }, { environment: { type: "none" } }, { tenantId: "other-tenant" }]) {
    const result = await f.app.inject({ method: "POST", url: "/api/managed-tasks", headers: mutationHeaders(f), payload: { ...base, ...extra } });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error, "validation_error");
  }
  for (const payload of [{ message: "Review", mode: "follow_up", attachments: [] }, { message: "Review", mode: "spawn" }, { message: " " }]) {
    const result = await f.app.inject({ method: "POST", url: `/api/managed-tasks/${task.id}/messages`, headers: mutationHeaders(f), payload });
    assert.equal(result.statusCode, 400);
  }
  const badCancel = await f.app.inject({ method: "POST", url: `/api/managed-tasks/${task.id}/cancel`, headers: mutationHeaders(f), payload: { expectedTurnId: 42 } });
  assert.equal(badCancel.statusCode, 400);
});

test("managed mutations require explicit idempotency keys", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const requests = [
    { method: "POST" as const, url: "/api/managed-tasks", payload: { projectId: f.project.id, agentId: "repository-reviewer", message: "Review" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/messages`, payload: { message: "Review", mode: "follow_up" } },
    { method: "POST" as const, url: `/api/managed-tasks/${task.id}/cancel`, payload: { expectedTurnId: null } },
    { method: "DELETE" as const, url: `/api/managed-tasks/${task.id}` },
  ];
  for (const request of requests) {
    for (const key of [undefined, "contains space", "a".repeat(256)]) {
      const response = await f.app.inject({ ...request, headers: { cookie: f.cookie, origin: f.config.webOrigin, ...(key ? { "idempotency-key": key } : {}) } });
      assert.equal(response.statusCode, 400, `${request.method} ${request.url}`);
      assert.equal(response.json().error, "invalid_idempotency_key");
    }
  }
});

test("concurrent managed create requests share one durable operation and replay current authorized state", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const create = t.mock.method(f.managedAgents, "create", async () => {
    signalStarted();
    await gate;
    return seedTask(f);
  });
  const request = {
    method: "POST" as const, url: "/api/managed-tasks", headers: mutationHeaders(f),
    payload: { projectId: f.project.id, agentId: "repository-reviewer", message: "Review permission checks" },
  };
  // Calling then starts LightMyRequest's lazy injection before the second request.
  const first = f.app.inject(request).then((response) => response);
  await started;
  const concurrent = await f.app.inject(request);
  assert.equal(concurrent.statusCode, 409);
  assert.equal(concurrent.json().error, "request_in_progress");
  assert.equal(create.mock.callCount(), 1);
  release();
  const completed = await first;
  assert.equal(completed.statusCode, 202);
  const taskId = completed.json().task.id as string;

  const latest = f.managedAgents.repository.update(taskId, (record) => {
    record.detail.items.push({ id: "later-output", role: "assistant", text: "Latest persisted finding", status: "completed", subagentId: null });
  });
  const replayed = await f.app.inject(request);
  assert.equal(replayed.statusCode, 202);
  assert.equal(replayed.json().task.revision, latest.detail.revision);
  assert.match(replayed.body, /Latest persisted finding/);
  assert.equal(create.mock.callCount(), 1);

  const conflict = await f.app.inject({ ...request, payload: { ...request.payload, message: "A different review" } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "idempotency_conflict");
  assert.equal(create.mock.callCount(), 1);
  const receipt = f.store.db.prepare("SELECT response_json FROM task_mutations WHERE idempotency_key=?").get(request.headers["idempotency-key"]) as { response_json: string };
  assert.deepEqual(JSON.parse(receipt.response_json), { taskId });

  f.managedAgents.repository.update(taskId, (record) => {
    record.detail.status = "deleted";
    record.detail.title = "Deleted managed task";
    record.detail.items = [];
    record.sessionId = null;
    record.environmentId = null;
    record.remoteUrl = null;
  });
  const afterDeletion = await f.app.inject(request);
  assert.equal(afterDeletion.statusCode, 202);
  assert.equal(afterDeletion.json().task.status, "deleted");
  assert.deepEqual(afterDeletion.json().task.items, []);
  assert.doesNotMatch(afterDeletion.body, /Task output visible|Latest persisted finding/);
  assert.equal(create.mock.callCount(), 1);
});

test("an uncertain managed input receipt cannot dispatch the same input again", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const message = t.mock.method(f.managedAgents, "message", async () => {
    throw new ApiHttpError(502, "managed_input_uncertain", "Input delivery is uncertain. Refresh the history before sending another message.");
  });
  const request = { method: "POST" as const, url: `/api/managed-tasks/${task.id}/messages`, headers: mutationHeaders(f), payload: { mode: "follow_up", message: "Review authorization" } };
  const first = await f.app.inject(request);
  assert.equal(first.statusCode, 502);
  const retry = await f.app.inject(request);
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().error, "idempotent_request_closed");
  assert.equal(message.mock.callCount(), 1);
});

test("managed receipt replay rechecks a revoked project grant", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.managedAgents, "create", async () => seedTask(f));
  const request = { method: "POST" as const, url: "/api/managed-tasks", headers: mutationHeaders(f), payload: { projectId: f.project.id, agentId: "repository-reviewer", message: "Review" } };
  assert.equal((await f.app.inject(request)).statusCode, 202);
  f.store.db.prepare("DELETE FROM workspace_grants WHERE tenant_id=?").run(f.admin.tenantId);
  const replayed = await f.app.inject(request);
  assert.equal(replayed.statusCode, 403);
  assert.doesNotMatch(replayed.body, /Task output visible/);
});

test("managed SSE starts with an owned authoritative snapshot and rejects query authority", async (t) => {
  const f = await fixture(t);
  const task = seedTask(f);
  const rejectedQuery = await f.app.inject({ method: "GET", url: `/api/managed-tasks/${task.id}/events?tenantId=foreign`, headers: { cookie: f.cookie } });
  assert.equal(rejectedQuery.statusCode, 400);
  const baseUrl = await f.app.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${baseUrl}/api/managed-tasks/${task.id}/events`, { headers: { cookie: f.cookie }, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /^text\/event-stream/);
  const reader = response.body!.getReader();
  try {
    const first = await reader.read();
    const event = new TextDecoder().decode(first.value);
    assert.match(event, /^event: snapshot\ndata: /);
    const payload = JSON.parse(event.split("\ndata: ")[1]!.trim()) as { task: ManagedTaskDetail };
    assert.equal(payload.task.id, task.id);
    assert.equal(payload.task.revision, task.revision);
    assert.doesNotMatch(event, /private-session|private-environment|private-executor|workspacePath/);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
});

test("app.close shuts down an open real managed SSE connection and reaches executor cleanup", async (t) => {
  let executorClosed = false;
  const f = await fixture(t, { executor: {
    start: async () => { throw new Error("This HTTP fixture must not start an executor"); },
    stop: async () => undefined,
    close: async () => { executorClosed = true; },
  } });
  const task = seedTask(f);
  let subscriptions = 0;
  const subscribe = f.managedAgents.subscribe.bind(f.managedAgents);
  t.mock.method(f.managedAgents, "subscribe", (id: string, listener: (task: ManagedTaskDetail) => void) => {
    subscriptions++;
    const unsubscribe = subscribe(id, listener);
    return () => { subscriptions--; unsubscribe(); };
  });
  const baseUrl = await f.app.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/api/managed-tasks/${task.id}/events`, { headers: { cookie: f.cookie }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(subscriptions, 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closing = f.app.close();
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Open SSE prevented app shutdown")), 2_000); }),
    ]);
    assert.equal(executorClosed, true, "onClose must reach managed executor shutdown");
    assert.equal(subscriptions, 0, "preClose must remove stream subscriptions and their timers");
    // The server closes the transport itself; the client has not aborted it.
    assert.equal(abort.signal.aborted, false);
    const end = await reader.read().catch(() => ({ done: true }));
    assert.equal(end.done, true);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await closing;
  }
});
