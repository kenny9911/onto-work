import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { get as httpGet, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { LightMyRequestResponse } from "fastify";

import type { CodexUserRouteBridge } from "../codex/adapter.js";
import type {
  CodexRequestOptions,
  CodexRuntimeEvent,
  CodexRuntimeListener,
  CodexSubscriptionOptions,
  JsonObject,
  JsonRpcId,
  JsonValue,
} from "../codex/runtime.js";
import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore, type SavedProjectRecord } from "../database.js";
import type {
  HarnessRuntime,
  RuntimeDashboardSnapshot,
  RuntimeHealth,
} from "../runtime.js";

interface RequestCall {
  method: string;
  params?: JsonValue;
  options?: CodexRequestOptions;
}

interface StartThreadCall {
  workspacePath: string;
  params?: JsonObject;
  options?: CodexRequestOptions;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class FakeBridge implements CodexUserRouteBridge {
  readonly requestCalls: RequestCall[] = [];
  readonly startThreadCalls: StartThreadCall[] = [];
  readonly respondCalls: Array<{ requestId: JsonRpcId; result: JsonValue }> = [];
  readonly listeners = new Set<CodexRuntimeListener>();
  unsubscribeCount = 0;
  legacyWorkspacePath: string | null = null;
  requestHandler:
    | ((method: string, params?: JsonValue) => Promise<JsonValue> | JsonValue)
    | null = null;
  startThreadHandler:
    | ((workspacePath: string, params?: JsonObject) => Promise<JsonValue> | JsonValue)
    | null = null;
  private turnSequence = 0;
  private unsubscribeWaiters: Array<() => void> = [];

  async request<Result extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    options?: CodexRequestOptions,
  ): Promise<Result> {
    this.requestCalls.push({ method, params, options });
    if (this.requestHandler) {
      return (await this.requestHandler(method, params)) as Result;
    }
    if (method === "thread/read") {
      const threadId = objectString(params, "threadId") ?? "legacy-thread";
      return {
        thread: { id: threadId, cwd: this.legacyWorkspacePath },
      } as unknown as Result;
    }
    if (method === "turn/start") {
      this.turnSequence += 1;
      return { turn: { id: `turn-${this.turnSequence}` } } as unknown as Result;
    }
    return { method, params: params ?? null } as unknown as Result;
  }

  async notify(): Promise<void> {}

  async respond(requestId: JsonRpcId, result: JsonValue = null): Promise<void> {
    this.respondCalls.push({ requestId, result });
  }

  async respondError(): Promise<void> {}

  subscribe(
    listener: CodexRuntimeListener,
    options: CodexSubscriptionOptions = {},
  ): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
      this.unsubscribeCount += 1;
      for (const resolve of this.unsubscribeWaiters.splice(0)) resolve();
    };
    options.signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  }

  async resolveWorkspacePath(requestedPath: string): Promise<string> {
    return requestedPath;
  }

  async startThread<Result extends JsonValue = JsonValue>(
    workspacePath: string,
    params?: JsonObject,
    options?: CodexRequestOptions,
  ): Promise<Result> {
    this.startThreadCalls.push({ workspacePath, params, options });
    if (this.startThreadHandler) {
      return (await this.startThreadHandler(workspacePath, params)) as Result;
    }
    return {
      thread: { id: "thread-created", cwd: workspacePath },
      cwd: workspacePath,
      model: typeof params?.model === "string" ? params.model : "vendor/model",
    } as unknown as Result;
  }

  emit(event: CodexRuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  waitForUnsubscribe(): Promise<void> {
    if (this.unsubscribeCount > 0) return Promise.resolve();
    return new Promise((resolve) => this.unsubscribeWaiters.push(resolve));
  }
}

class FakeInteractiveRuntime implements HarnessRuntime {
  readonly bridge = new FakeBridge();
  readonly identities: Array<{ tenantId: string; userId: string }> = [];

  async forUser(identity: { tenantId: string; userId: string }): Promise<CodexUserRouteBridge> {
    this.identities.push(identity);
    return this.bridge;
  }

  async dashboardSnapshot(): Promise<RuntimeDashboardSnapshot> {
    return { projects: [], threads: [], featuredThread: null };
  }

  async threadSnapshot(input: { tenantId: string; userId: string; threadId: string }) {
    this.identities.push({ tenantId: input.tenantId, userId: input.userId });
    return {
      thread: {
        id: input.threadId,
        title: "Hydrated task",
        projectId: null,
        projectName: null,
        status: "idle" as const,
        model: "vendor/model",
        updatedAt: new Date(0).toISOString(),
        preview: "Hydrated history",
      },
      timeline: [
        {
          id: "history-item",
          kind: "assistant" as const,
          title: "Agent response",
          body: "Persisted response",
          status: "completed" as const,
          timestamp: new Date(0).toISOString(),
        },
      ],
    };
  }

  async health(): Promise<RuntimeHealth> {
    return { status: "ready" };
  }
}

function objectString(value: JsonValue | undefined, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

interface RouteFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  config: HarnessConfig;
  cookie: string;
  runtime: FakeInteractiveRuntime;
  store: HarnessStore;
  project: SavedProjectRecord;
  user: { id: string; tenantId: string };
}

function responseCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  assert.ok(setCookie);
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function routeFixture(t: TestContext): Promise<RouteFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-codex-route-"));
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(directory, "harness.db"),
    runtimeDataDir: join(directory, "runtimes"),
    sessionTtlMs: 60 * 60 * 1_000,
    sessionSecret: "test-session-secret-that-is-long-enough",
    credentialEncryptionKey: "test-credential-key-that-is-long-enough",
    codexBinary: "codex",
    codexExperimentalApi: false,
    allowedWorkspaceRoots: [directory],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "http://127.0.0.1:4000/v1",
    litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  const user = await store.bootstrapAdmin("route-admin", "route-test-password");
  store.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(user.id);
  store.saveProvider({
    tenantId: user.tenantId,
    catalogId: "openai",
    name: "Test route",
    adapter: "responses",
    baseUrl: "https://api.openai.test/v1",
    defaultModel: "vendor/model",
    enabled: true,
    isDefault: true,
  });
  const runtime = new FakeInteractiveRuntime();
  const workspacePath = await realpath(directory);
  runtime.bridge.legacyWorkspacePath = workspacePath;
  store.grantWorkspace({
    tenantId: user.tenantId,
    rootPath: workspacePath,
    createdByUserId: user.id,
  });
  const grant = store.findWorkspaceGrantForPath(user.tenantId, workspacePath);
  assert.ok(grant);
  const project = store.registerSavedProject({
    tenantId: user.tenantId,
    name: "Route fixture",
    workspacePath,
    workspaceGrantId: grant.id,
    createdByUserId: user.id,
  });
  const app = await buildApp({ config, store, runtime, logger: false });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username: "route-admin", password: "route-test-password" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = responseCookie(login);

  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, config, cookie, project, runtime, store, user };
}

function postHeaders(fixture: RouteFixture): Record<string, string> {
  return {
    cookie: fixture.cookie,
    origin: fixture.config.webOrigin,
  };
}

async function waitForStreamText(
  response: IncomingMessage,
  expected: string,
  timeoutMs = 2_000,
): Promise<string> {
  let received = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for SSE text: ${expected}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes(expected)) {
        cleanup();
        resolve(received);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`SSE stream closed before receiving: ${expected}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      response.off("data", onData);
      response.off("close", onClose);
    };
    response.on("data", onData);
    response.once("close", onClose);
  });
}

test("Codex routes require authentication and reject unconstrained methods", async (t) => {
  const fixture = await routeFixture(t);
  const unauthenticated = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { origin: fixture.config.webOrigin },
    payload: { method: "thread/resume", params: { threadId: "thread-1" } },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const unauthenticatedApproval = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/approval",
    headers: { origin: fixture.config.webOrigin },
    payload: {
      requestId: "approval-1",
      method: "item/commandExecution/requestApproval",
      decision: "decline",
    },
  });
  assert.equal(unauthenticatedApproval.statusCode, 401);

  const unauthenticatedEvents = await fixture.app.inject({
    method: "GET",
    url: "/api/codex/events",
  });
  assert.equal(unauthenticatedEvents.statusCode, 401);
  const unauthenticatedHistory = await fixture.app.inject({
    method: "GET",
    url: "/api/codex/threads/thread-1",
  });
  assert.equal(unauthenticatedHistory.statusCode, 401);

  const missingIdempotencyKey = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: postHeaders(fixture),
    payload: { projectId: fixture.project.id },
  });
  assert.equal(missingIdempotencyKey.statusCode, 400);
  assert.equal(missingIdempotencyKey.json().error, "invalid_idempotency_key");

  const arbitraryMethod = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/shellCommand", params: { threadId: "thread-1" } },
  });
  assert.equal(arbitraryMethod.statusCode, 400);
  assert.equal(arbitraryMethod.json().error, "validation_error");

  const relativeWorkspace = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/start", params: { cwd: "../outside" } },
  });
  assert.equal(relativeWorkspace.statusCode, 400);

  const extraTurnSetting = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: {
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
        sandbox: "danger-full-access",
      },
    },
  });
  assert.equal(extraTurnSetting.statusCode, 400);
  assert.deepEqual(fixture.runtime.identities, []);
});

test("task creation resolves a saved project and allowed methods stay typed", async (t) => {
  const fixture = await routeFixture(t);
  const start = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "typed-thread-start" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().result.thread.id, "thread-created");
  const canonicalWorkspace = await realpath(fixture.config.allowedWorkspaceRoots[0]!);
  assert.deepEqual(fixture.runtime.bridge.startThreadCalls, [
    {
      workspacePath: canonicalWorkspace,
      params: { model: "vendor/model" },
      options: undefined,
    },
  ]);
  assert.deepEqual(fixture.runtime.bridge.requestCalls, []);

  const turn = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { ...postHeaders(fixture), "idempotency-key": "typed-turn-start" },
    payload: {
      method: "turn/start",
      params: { threadId: "thread-created", input: [{ type: "text", text: "Continue" }] },
    },
  });
  assert.equal(turn.statusCode, 200);

  const resume = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/resume", params: { threadId: "thread-created" } },
  });
  assert.equal(resume.statusCode, 200);
  const history = await fixture.app.inject({
    method: "GET",
    url: "/api/codex/threads/thread-created",
    headers: { cookie: fixture.cookie },
  });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().thread.id, "thread-created");
  assert.equal(history.json().timeline[0].body, "Persisted response");
  assert.deepEqual(
    fixture.runtime.bridge.requestCalls.map(({ method, params }) => ({ method, params })),
    [
      {
        method: "turn/start",
        params: {
          threadId: "thread-created",
          input: [{ type: "text", text: "Continue" }],
        },
      },
      { method: "thread/resume", params: { threadId: "thread-created" } },
    ],
  );
});

test("the generic browser bridge rejects thread/start without dispatch or admission", async (t) => {
  const fixture = await routeFixture(t);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: {
      ...postHeaders(fixture),
      "idempotency-key": "browser-thread-start-must-stay-closed",
    },
    payload: {
      method: "thread/start",
      params: {
        cwd: fixture.project.workspacePath,
        model: "vendor/model",
        sandbox: "danger-full-access",
        config: { approval_policy: "never" },
      },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "validation_error");
  assert.deepEqual(fixture.runtime.identities, []);
  assert.deepEqual(fixture.runtime.bridge.startThreadCalls, []);
  assert.deepEqual(fixture.runtime.bridge.requestCalls, []);
  assert.equal(
    fixture.store.findUsageReservation(
      fixture.user.tenantId,
      "browser-thread-start-must-stay-closed",
    ),
    null,
  );
});

test("task creation rejects unverifiable runtime workspace and model responses", async (t) => {
  const fixture = await routeFixture(t);
  const differentWorkspacePath = join(
    fixture.config.allowedWorkspaceRoots[0]!,
    "different-runtime-workspace",
  );
  const outsideWorkspacePath = await mkdtemp(join(tmpdir(), "agent-harness-outside-runtime-"));
  await mkdir(differentWorkspacePath, { recursive: true });
  const differentWorkspace = await realpath(differentWorkspacePath);
  const outsideWorkspace = await realpath(outsideWorkspacePath);
  t.after(() => rm(outsideWorkspacePath, { recursive: true, force: true }));

  const cases: Array<{
    key: string;
    threadId: string;
    result: JsonValue;
    statusCode: number;
    error: string;
  }> = [
    {
      key: "runtime-missing-cwd",
      threadId: "thread-missing-cwd",
      result: { thread: { id: "thread-missing-cwd" }, model: "vendor/model" },
      statusCode: 502,
      error: "codex_response_invalid",
    },
    {
      key: "runtime-missing-model",
      threadId: "thread-missing-model",
      result: {
        thread: { id: "thread-missing-model" },
        cwd: fixture.project.workspacePath,
      },
      statusCode: 502,
      error: "codex_response_invalid",
    },
    {
      key: "runtime-outside-cwd",
      threadId: "thread-outside-cwd",
      result: {
        thread: { id: "thread-outside-cwd" },
        cwd: outsideWorkspace,
        model: "vendor/model",
      },
      statusCode: 403,
      error: "workspace_not_allowed",
    },
    {
      key: "runtime-mismatched-cwd",
      threadId: "thread-mismatched-cwd",
      result: {
        thread: { id: "thread-mismatched-cwd" },
        cwd: differentWorkspace,
        model: "vendor/model",
      },
      statusCode: 409,
      error: "thread_workspace_conflict",
    },
    {
      key: "runtime-mismatched-model",
      threadId: "thread-mismatched-model",
      result: {
        thread: { id: "thread-mismatched-model" },
        cwd: fixture.project.workspacePath,
        model: "attacker/other-model",
      },
      statusCode: 409,
      error: "model_route_changed",
    },
  ];

  for (const candidate of cases) {
    fixture.runtime.bridge.startThreadHandler = () => candidate.result;
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { ...postHeaders(fixture), "idempotency-key": candidate.key },
      payload: { projectId: fixture.project.id },
    });

    assert.equal(response.statusCode, candidate.statusCode, candidate.key);
    assert.equal(response.json().error, candidate.error, candidate.key);
    assert.equal(
      fixture.store.getThreadWorkspaceBinding(
        fixture.user.tenantId,
        fixture.user.id,
        candidate.threadId,
      ),
      null,
      candidate.key,
    );
    const reservation = fixture.store.findUsageReservation(
      fixture.user.tenantId,
      candidate.key,
    );
    assert.equal(reservation?.status, "failed", candidate.key);
    assert.equal(reservation?.responseJson, null, candidate.key);
    assert.equal(reservation?.errorCode, "dispatch_failed", candidate.key);
    const usageEvents = fixture.store.db
      .prepare("SELECT COUNT(*) AS count FROM usage_events WHERE reservation_id = ?")
      .get(reservation?.id) as { count: number };
    assert.equal(usageEvents.count, 0, candidate.key);
  }

  const successTargets = fixture.store
    .listAuditEvents(fixture.user.tenantId, 100)
    .filter((event) => event.action === "codex.thread_started")
    .map((event) => event.targetId);
  assert.deepEqual(successTargets, []);
  assert.equal(fixture.runtime.bridge.startThreadCalls.length, cases.length);
});

test("task creation rejects disabled and foreign-tenant saved projects before dispatch", async (t) => {
  const fixture = await routeFixture(t);
  const disabled = fixture.store.updateSavedProject({
    tenantId: fixture.user.tenantId,
    projectId: fixture.project.id,
    actorUserId: fixture.user.id,
    enabled: false,
  });
  assert.equal(disabled?.enabled, false);

  const disabledResponse = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "disabled-project-start" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(disabledResponse.statusCode, 409);
  assert.equal(disabledResponse.json().error, "project_disabled");

  const foreignTenantId = randomUUID();
  const foreignUserId = randomUUID();
  const timestamp = new Date().toISOString();
  fixture.store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run(foreignTenantId, "Foreign tenant", `foreign-${foreignTenantId}`, timestamp);
  fixture.store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, 'Foreign user', 'unused', 'admin', 'active', 0, ?)
    `)
    .run(foreignUserId, foreignTenantId, `foreign-${foreignUserId}`, timestamp);
  fixture.store.grantWorkspace({
    tenantId: foreignTenantId,
    rootPath: fixture.project.workspacePath,
    createdByUserId: foreignUserId,
  });
  const foreignGrant = fixture.store.findWorkspaceGrantForPath(
    foreignTenantId,
    fixture.project.workspacePath,
  );
  assert.ok(foreignGrant);
  const foreignProject = fixture.store.registerSavedProject({
    tenantId: foreignTenantId,
    name: "Foreign project",
    workspacePath: fixture.project.workspacePath,
    workspaceGrantId: foreignGrant.id,
    createdByUserId: foreignUserId,
  });

  const foreignResponse = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "foreign-project-start" },
    payload: { projectId: foreignProject.id },
  });
  assert.equal(foreignResponse.statusCode, 404);
  assert.equal(foreignResponse.json().error, "project_not_found");
  assert.deepEqual(fixture.runtime.identities, []);
  assert.deepEqual(fixture.runtime.bridge.startThreadCalls, []);
});

test("task creation replays the durable response without dispatching twice", async (t) => {
  const fixture = await routeFixture(t);
  const headers = { ...postHeaders(fixture), "idempotency-key": "durable-task-replay" };
  const first = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers,
    payload: { projectId: fixture.project.id },
  });
  assert.equal(first.statusCode, 200);

  // Exercise a newly registered route closure so replay cannot depend on
  // handler-local state from the first request.
  const replayApp = await buildApp({
    config: fixture.config,
    store: fixture.store,
    runtime: fixture.runtime,
    logger: false,
  });
  t.after(() => replayApp.close());
  const replay = await replayApp.inject({
    method: "POST",
    url: "/api/tasks",
    headers,
    payload: { projectId: fixture.project.id },
  });

  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().result, first.json().result);
  assert.equal(fixture.runtime.bridge.startThreadCalls.length, 1);
  assert.equal(fixture.runtime.identities.length, 1);
  assert.equal(
    fixture.store
      .listAuditEvents(fixture.user.tenantId, 100)
      .filter((event) => event.action === "codex.thread_started").length,
    1,
  );
  const reservation = fixture.store.findUsageReservation(
    fixture.user.tenantId,
    "durable-task-replay",
  );
  assert.equal(reservation?.status, "completed");
  assert.equal(reservation?.threadId, "thread-created");
  const eventCount = fixture.store.db
    .prepare("SELECT COUNT(*) AS count FROM usage_events WHERE reservation_id = ?")
    .get(reservation?.id) as { count: number };
  assert.equal(eventCount.count, 1);
});

test("an expired thread-start lease rolls back binding, receipt, usage, and audit", async (t) => {
  const fixture = await routeFixture(t);
  const key = "expired-thread-start-commit";
  fixture.runtime.bridge.startThreadHandler = (workspacePath, params) => {
    fixture.store.db
      .prepare(`
        UPDATE usage_reservations SET expires_at = ?
        WHERE tenant_id = ? AND idempotency_key = ?
      `)
      .run("2000-01-01T00:00:00.000Z", fixture.user.tenantId, key);
    return {
      thread: { id: "thread-expired-at-commit" },
      cwd: workspacePath,
      model: typeof params?.model === "string" ? params.model : "vendor/model",
    };
  };

  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": key },
    payload: { projectId: fixture.project.id },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "run_reservation_closed");
  assert.equal(
    fixture.store.getThreadWorkspaceBinding(
      fixture.user.tenantId,
      fixture.user.id,
      "thread-expired-at-commit",
    ),
    null,
  );
  const reservation = fixture.store.findUsageReservation(fixture.user.tenantId, key);
  assert.equal(reservation?.status, "failed");
  assert.equal(reservation?.responseJson, null);
  assert.equal(reservation?.threadId, null);
  const eventCount = fixture.store.db
    .prepare("SELECT COUNT(*) AS count FROM usage_events WHERE reservation_id = ?")
    .get(reservation?.id) as { count: number };
  assert.equal(eventCount.count, 0);
  assert.equal(
    fixture.store
      .listAuditEvents(fixture.user.tenantId, 100)
      .filter(
        (event) =>
          event.action === "codex.thread_started"
          && event.targetId === "thread-expired-at-commit",
      ).length,
    0,
  );
});

test("review/start is inline-only, metered, and bound to the authorized task", async (t) => {
  const fixture = await routeFixture(t);
  const created = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "review-thread-start" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(created.statusCode, 200);

  fixture.runtime.bridge.requestHandler = (method): JsonValue => {
    if (method === "review/start") {
      return {
        turn: { id: "review-turn", status: "inProgress", items: [] },
        reviewThreadId: "thread-created",
      };
    }
    return {};
  };
  const review = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { ...postHeaders(fixture), "idempotency-key": "inline-review" },
    payload: {
      method: "review/start",
      params: {
        threadId: "thread-created",
        target: { type: "uncommittedChanges" },
      },
    },
  });
  assert.equal(review.statusCode, 200);
  assert.equal(review.json().result.reviewThreadId, "thread-created");
  assert.deepEqual(
    fixture.runtime.bridge.requestCalls.at(-1),
    {
      method: "review/start",
      params: {
        threadId: "thread-created",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      },
      options: undefined,
    },
  );
  const reservation = fixture.store.findUsageReservation(
    fixture.user.tenantId,
    "inline-review",
  );
  assert.equal(reservation?.operation, "turn_start");
  assert.equal(reservation?.threadId, "thread-created");
  assert.equal(reservation?.turnId, "review-turn");
  assert.ok(
    fixture.store
      .listAuditEvents(fixture.user.tenantId, 20)
      .some((event) => event.action === "codex.review_started"),
  );

  const detached = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { ...postHeaders(fixture), "idempotency-key": "detached-review" },
    payload: {
      method: "review/start",
      params: {
        threadId: "thread-created",
        target: { type: "uncommittedChanges" },
        delivery: "detached",
      },
    },
  });
  assert.equal(detached.statusCode, 400);
  assert.equal(detached.json().error, "validation_error");
});

test("named task actions authorize, constrain, audit, and deduplicate stable Codex RPCs", async (t) => {
  const fixture = await routeFixture(t);
  const workspacePath = await realpath(fixture.config.allowedWorkspaceRoots[0]!);
  const start = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "actions-thread-start" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(start.statusCode, 200);

  fixture.runtime.bridge.requestHandler = (method, params): JsonValue => {
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-created",
          cwd: workspacePath,
          turns: [{ id: "turn-live", status: "inProgress", items: [] }],
        },
      };
    }
    if (method === "thread/fork") {
      return {
        thread: { id: "thread-forked", cwd: workspacePath },
        cwd: workspacePath,
      };
    }
    if (method === "turn/steer") return { turnId: objectString(params, "expectedTurnId") };
    return {};
  };

  const rename = await fixture.app.inject({
    method: "PATCH",
    url: "/api/tasks/thread-created/name",
    headers: { ...postHeaders(fixture), "idempotency-key": "rename-task" },
    payload: { name: "Provider resilience" },
  });
  assert.equal(rename.statusCode, 200);

  const forkHeaders = { ...postHeaders(fixture), "idempotency-key": "fork-task" };
  const firstFork = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-created/actions/fork",
    headers: forkHeaders,
    payload: {},
  });
  const replayedFork = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-created/actions/fork",
    headers: forkHeaders,
    payload: {},
  });
  assert.equal(firstFork.statusCode, 200);
  assert.deepEqual(replayedFork.json(), firstFork.json());
  assert.equal(
    fixture.runtime.bridge.requestCalls.filter(({ method }) => method === "thread/fork").length,
    1,
  );
  assert.equal(
    fixture.store.getThreadWorkspaceBinding(
      fixture.user.tenantId,
      fixture.user.id,
      "thread-forked",
    )?.workspacePath,
    workspacePath,
  );

  const steer = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-created/turns/turn-live/actions/steer",
    headers: { ...postHeaders(fixture), "idempotency-key": "steer-task" },
    payload: { input: [{ type: "text", text: "Also cover reconnects" }] },
  });
  const interrupt = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-created/turns/turn-live/actions/interrupt",
    headers: { ...postHeaders(fixture), "idempotency-key": "interrupt-task" },
  });
  assert.equal(steer.statusCode, 200);
  assert.equal(interrupt.statusCode, 200);

  const archive = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-created/actions/archive",
    headers: { ...postHeaders(fixture), "idempotency-key": "archive-task" },
  });
  const restore = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-created/actions/unarchive",
    headers: { ...postHeaders(fixture), "idempotency-key": "restore-task" },
  });
  assert.equal(archive.statusCode, 200);
  assert.equal(restore.statusCode, 200);

  assert.deepEqual(
    fixture.runtime.bridge.requestCalls
      .filter(({ method }) => method !== "thread/read")
      .map(({ method, params }) => ({ method, params })),
    [
      {
        method: "thread/name/set",
        params: { threadId: "thread-created", name: "Provider resilience" },
      },
      {
        method: "thread/fork",
        params: { threadId: "thread-created", lastTurnId: null, excludeTurns: true },
      },
      {
        method: "turn/steer",
        params: {
          threadId: "thread-created",
          expectedTurnId: "turn-live",
          input: [{ type: "text", text: "Also cover reconnects" }],
        },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thread-created", turnId: "turn-live" },
      },
      { method: "thread/archive", params: { threadId: "thread-created" } },
      { method: "thread/unarchive", params: { threadId: "thread-created" } },
    ],
  );

  const auditActions = fixture.store
    .listAuditEvents(fixture.user.tenantId, 50)
    .map((event) => event.action);
  for (const action of [
    "codex.thread_renamed",
    "codex.thread_forked",
    "codex.turn_steered",
    "codex.turn_interrupted",
    "codex.thread_archived",
    "codex.thread_unarchived",
  ]) {
    assert.ok(auditActions.includes(action), `missing audit action ${action}`);
  }
});

test("turn actions fail closed when the expected turn is no longer active", async (t) => {
  const fixture = await routeFixture(t);
  const workspacePath = await realpath(fixture.config.allowedWorkspaceRoots[0]!);
  fixture.store.bindThreadWorkspace({
    tenantId: fixture.user.tenantId,
    userId: fixture.user.id,
    threadId: "thread-stale",
    workspacePath,
  });
  fixture.runtime.bridge.requestHandler = (method): JsonValue => {
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-stale",
          cwd: workspacePath,
          turns: [{ id: "turn-finished", status: "completed", items: [] }],
        },
      };
    }
    return {};
  };

  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks/thread-stale/turns/turn-finished/actions/interrupt",
    headers: { ...postHeaders(fixture), "idempotency-key": "stale-interrupt" },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "active_turn_mismatch");
  assert.equal(
    fixture.runtime.bridge.requestCalls.filter(({ method }) => method === "turn/interrupt").length,
    0,
  );
});

test("task creation rejects revoked project grants and arbitrary model overrides", async (t) => {
  const fixture = await routeFixture(t);
  fixture.store.db
    .prepare("DELETE FROM workspace_grants WHERE tenant_id = ?")
    .run(fixture.user.tenantId);

  const ungranted = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "ungranted-workspace" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(ungranted.statusCode, 403);
  assert.equal(ungranted.json().error, "workspace_grant_revoked");

  const modelOverride = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "model-override" },
    payload: { projectId: fixture.project.id, model: "attacker/expensive-model" },
  });
  assert.equal(modelOverride.statusCode, 400);
  assert.equal(modelOverride.json().error, "validation_error");
  assert.deepEqual(fixture.runtime.identities, []);
  assert.deepEqual(fixture.runtime.bridge.startThreadCalls, []);
});

test("revoking a workspace grant blocks turns and resume for an existing thread", async (t) => {
  const fixture = await routeFixture(t);
  const start = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "revocation-thread-start" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(
    fixture.store.getThreadWorkspaceBinding(
      fixture.user.tenantId,
      fixture.user.id,
      "thread-created",
    )?.workspacePath,
    await realpath(fixture.config.allowedWorkspaceRoots[0]!),
  );

  fixture.store.db
    .prepare("DELETE FROM workspace_grants WHERE tenant_id = ?")
    .run(fixture.user.tenantId);
  const turn = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { ...postHeaders(fixture), "idempotency-key": "revoked-turn" },
    payload: {
      method: "turn/start",
      params: {
        threadId: "thread-created",
        input: [{ type: "text", text: "Continue" }],
      },
    },
  });
  const resume = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/resume", params: { threadId: "thread-created" } },
  });

  assert.equal(turn.statusCode, 403);
  assert.equal(turn.json().error, "workspace_not_granted");
  assert.equal(resume.statusCode, 403);
  assert.equal(resume.json().error, "workspace_not_granted");
  assert.deepEqual(fixture.runtime.bridge.requestCalls, []);
});

test("recovers a legacy thread binding only from its granted runtime workspace", async (t) => {
  const fixture = await routeFixture(t);
  const resume = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/resume", params: { threadId: "legacy-thread" } },
  });

  assert.equal(resume.statusCode, 200);
  assert.equal(
    fixture.store.getThreadWorkspaceBinding(
      fixture.user.tenantId,
      fixture.user.id,
      "legacy-thread",
    )?.workspacePath,
    await realpath(fixture.config.allowedWorkspaceRoots[0]!),
  );
  assert.deepEqual(
    fixture.runtime.bridge.requestCalls.map(({ method }) => method),
    ["thread/read", "thread/resume"],
  );

  fixture.store.db
    .prepare("DELETE FROM workspace_grants WHERE tenant_id = ?")
    .run(fixture.user.tenantId);
  const revoked = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/resume", params: { threadId: "legacy-thread" } },
  });
  assert.equal(revoked.statusCode, 403);
  assert.deepEqual(
    fixture.runtime.bridge.requestCalls.map(({ method }) => method),
    ["thread/read", "thread/resume"],
  );
});

test("refuses to bind a legacy thread outside its tenant workspace grant", async (t) => {
  const fixture = await routeFixture(t);
  const grantedPath = join(fixture.config.allowedWorkspaceRoots[0]!, "granted-legacy");
  const deniedPath = join(fixture.config.allowedWorkspaceRoots[0]!, "denied-legacy");
  await Promise.all([
    mkdir(grantedPath, { recursive: true }),
    mkdir(deniedPath, { recursive: true }),
  ]);
  const [granted, denied] = await Promise.all([
    realpath(grantedPath),
    realpath(deniedPath),
  ]);
  fixture.store.db
    .prepare("DELETE FROM workspace_grants WHERE tenant_id = ?")
    .run(fixture.user.tenantId);
  fixture.store.grantWorkspace({
    tenantId: fixture.user.tenantId,
    rootPath: granted,
    createdByUserId: fixture.user.id,
  });
  fixture.runtime.bridge.legacyWorkspacePath = denied;

  const resume = await fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: postHeaders(fixture),
    payload: { method: "thread/resume", params: { threadId: "ungranted-legacy" } },
  });
  assert.equal(resume.statusCode, 403);
  assert.equal(resume.json().error, "workspace_not_granted");
  assert.equal(
    fixture.store.getThreadWorkspaceBinding(
      fixture.user.tenantId,
      fixture.user.id,
      "ungranted-legacy",
    ),
    null,
  );
  assert.deepEqual(
    fixture.runtime.bridge.requestCalls.map(({ method }) => method),
    ["thread/read"],
  );
});

test("correlates concurrent turns and meters tokenUsage.last across response races", async (t) => {
  const fixture = await routeFixture(t);
  const start = await fixture.app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { ...postHeaders(fixture), "idempotency-key": "correlation-thread-start" },
    payload: { projectId: fixture.project.id },
  });
  assert.equal(start.statusCode, 200);

  const current = fixture.store.getLatestEntitlementSnapshot(fixture.user.tenantId)!;
  fixture.store.createEntitlementSnapshot({
    tenantId: fixture.user.tenantId,
    plan: current.plan,
    status: current.status,
    seatLimit: current.seatLimit,
    activeRunLimit: 2,
    requestLimit: current.requestLimit,
    periodStart: current.periodStart,
    periodEnd: current.periodEnd,
    allowedRouteIds: current.allowedRouteIds,
  });

  const turnA = deferred<JsonValue>();
  const turnB = deferred<JsonValue>();
  const bothDispatched = deferred<void>();
  let dispatches = 0;
  fixture.runtime.bridge.requestHandler = (method, params) => {
    assert.equal(method, "turn/start");
    const input = params && typeof params === "object" && !Array.isArray(params)
      ? params.input
      : null;
    const first = Array.isArray(input) ? input[0] : null;
    const text = first && typeof first === "object" && !Array.isArray(first)
      ? first.text
      : null;
    dispatches += 1;
    if (dispatches === 2) bothDispatched.resolve();
    return text === "A" ? turnA.promise : turnB.promise;
  };

  const requestA = fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { ...postHeaders(fixture), "idempotency-key": "same-thread-turn-a" },
    payload: {
      method: "turn/start",
      params: { threadId: "thread-created", input: [{ type: "text", text: "A" }] },
    },
  });
  const requestB = fixture.app.inject({
    method: "POST",
    url: "/api/codex/request",
    headers: { ...postHeaders(fixture), "idempotency-key": "same-thread-turn-b" },
    payload: {
      method: "turn/start",
      params: { threadId: "thread-created", input: [{ type: "text", text: "B" }] },
    },
  });
  await bothDispatched.promise;

  fixture.runtime.bridge.emit({
    sequence: 10,
    userId: fixture.user.id,
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-created",
      turnId: "turn-b",
      tokenUsage: {
        total: { inputTokens: 1000, outputTokens: 1000 },
        last: { inputTokens: 3, outputTokens: 2 },
      },
    },
  });
  fixture.runtime.bridge.emit({
    sequence: 11,
    userId: fixture.user.id,
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-created",
      turnId: "turn-b",
      tokenUsage: {
        total: { inputTokens: 2000, outputTokens: 2000 },
        last: { inputTokens: 4, outputTokens: 1 },
      },
    },
  });
  fixture.runtime.bridge.emit({
    sequence: 12,
    userId: fixture.user.id,
    kind: "notification",
    method: "turn/completed",
    params: {
      threadId: "thread-created",
      turn: {
        id: "turn-b",
        status: "completed",
        tokenUsage: { inputTokens: 9999, outputTokens: 9999 },
      },
    },
  });
  turnB.resolve({ turn: { id: "turn-b" } });
  assert.equal((await requestB).statusCode, 200);

  const midway = fixture.store.db
    .prepare(`
      SELECT idempotency_key, status, turn_id
      FROM usage_reservations
      WHERE idempotency_key IN ('same-thread-turn-a', 'same-thread-turn-b')
      ORDER BY idempotency_key
    `)
    .all() as unknown as Array<{
      idempotency_key: string;
      status: string;
      turn_id: string | null;
    }>;
  assert.deepEqual(midway.map((row) => ({ ...row })), [
    { idempotency_key: "same-thread-turn-a", status: "reserved", turn_id: null },
    { idempotency_key: "same-thread-turn-b", status: "completed", turn_id: "turn-b" },
  ]);

  // A thread-level completion without an exact turn id cannot settle A.
  fixture.runtime.bridge.emit({
    sequence: 13,
    userId: fixture.user.id,
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-created", turn: { status: "completed" } },
  });
  fixture.runtime.bridge.emit({
    sequence: 14,
    userId: fixture.user.id,
    kind: "notification",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-created",
      turnId: "turn-a",
      tokenUsage: {
        total: { inputTokens: 5000, outputTokens: 6000 },
        last: { inputTokens: 5, outputTokens: 6 },
      },
    },
  });
  fixture.runtime.bridge.emit({
    sequence: 15,
    userId: fixture.user.id,
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "thread-created", turn: { id: "turn-a", status: "completed" } },
  });
  turnA.resolve({ turn: { id: "turn-a" } });
  assert.equal((await requestA).statusCode, 200);

  const metered = fixture.store.db
    .prepare(`
      SELECT r.turn_id, r.status, e.input_tokens, e.output_tokens
      FROM usage_reservations AS r
      JOIN usage_events AS e ON e.reservation_id = r.id
      WHERE r.idempotency_key IN ('same-thread-turn-a', 'same-thread-turn-b')
      ORDER BY r.turn_id
    `)
    .all() as unknown as Array<{
      turn_id: string;
      status: string;
      input_tokens: number;
      output_tokens: number;
    }>;
  assert.deepEqual(metered.map((row) => ({ ...row })), [
    { turn_id: "turn-a", status: "completed", input_tokens: 5, output_tokens: 6 },
    { turn_id: "turn-b", status: "completed", input_tokens: 7, output_tokens: 3 },
  ]);
});

test(
  "SSE streams user events, cleans up, and binds approval responses to pending requests",
  { timeout: 8_000 },
  async (t) => {
    const fixture = await routeFixture(t);
    const invalidOrigin = await fixture.app.inject({
      method: "GET",
      url: "/api/codex/events",
      headers: { cookie: fixture.cookie, origin: "https://attacker.example" },
    });
    assert.equal(invalidOrigin.statusCode, 403);

    const guessedApproval = await fixture.app.inject({
      method: "POST",
      url: "/api/codex/approval",
      headers: postHeaders(fixture),
      payload: {
        requestId: "approval-1",
        method: "item/commandExecution/requestApproval",
        decision: "accept",
      },
    });
    assert.equal(guessedApproval.statusCode, 409);

    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const streamRequest = httpGet(
      new URL("/api/codex/events", address),
      {
        headers: {
          accept: "text/event-stream",
          cookie: fixture.cookie,
          origin: "http://localhost:4173",
        },
      },
    );
    const streamResponse = await new Promise<IncomingMessage>((resolve, reject) => {
      streamRequest.once("response", resolve);
      streamRequest.once("error", reject);
    });
    assert.equal(streamResponse.statusCode, 200);
    assert.match(streamResponse.headers["content-type"] ?? "", /text\/event-stream/);
    await waitForStreamText(streamResponse, "runtime/connected");

    fixture.runtime.bridge.emit({
      sequence: 1,
      userId: fixture.user.id,
      kind: "server-request",
      method: "item/commandExecution/requestApproval",
      requestId: "approval-1",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "pnpm test",
      },
    });
    await waitForStreamText(streamResponse, "approval-1");

    const mismatchedMethod = await fixture.app.inject({
      method: "POST",
      url: "/api/codex/approval",
      headers: postHeaders(fixture),
      payload: {
        requestId: "approval-1",
        method: "item/fileChange/requestApproval",
        decision: "accept",
      },
    });
    assert.equal(mismatchedMethod.statusCode, 409);
    assert.deepEqual(fixture.runtime.bridge.respondCalls, []);

    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/api/codex/approval",
      headers: postHeaders(fixture),
      payload: {
        requestId: "approval-1",
        method: "item/commandExecution/requestApproval",
        decision: "acceptForSession",
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(fixture.runtime.bridge.respondCalls, [
      { requestId: "approval-1", result: { decision: "acceptForSession" } },
    ]);
    const auditRow = fixture.store.db
      .prepare(
        "SELECT metadata_json FROM audit_logs WHERE action = 'codex.approval_resolved' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { metadata_json: string } | undefined;
    assert.ok(auditRow);
    const auditMetadata = JSON.parse(auditRow.metadata_json) as Record<string, unknown>;
    assert.deepEqual(
      {
        method: auditMetadata.method,
        decision: auditMetadata.decision,
        threadId: auditMetadata.threadId,
        turnId: auditMetadata.turnId,
        itemId: auditMetadata.itemId,
      },
      {
        method: "item/commandExecution/requestApproval",
        decision: "acceptForSession",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
    );
    assert.match(String(auditMetadata.actionDigest), /^[a-f0-9]{64}$/);

    const replay = await fixture.app.inject({
      method: "POST",
      url: "/api/codex/approval",
      headers: postHeaders(fixture),
      payload: {
        requestId: "approval-1",
        method: "item/commandExecution/requestApproval",
        decision: "decline",
      },
    });
    assert.equal(replay.statusCode, 409);

    const closed = new Promise<void>((resolve) => streamResponse.once("close", resolve));
    streamRequest.destroy();
    streamResponse.destroy();
    await closed;
    await fixture.runtime.bridge.waitForUnsubscribe();
    assert.equal(fixture.runtime.bridge.unsubscribeCount, 1);
  },
);
