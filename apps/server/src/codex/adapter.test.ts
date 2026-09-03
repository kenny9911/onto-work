import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { encryptSecret } from "../security.js";
import { CodexHarnessAdapter } from "./adapter.js";
import { CodexRuntimeManager, type JsonObject } from "./runtime.js";

const FAKE_DASHBOARD_APP_SERVER = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const thread = {
  id: "thread-1",
  name: "Runtime bridge",
  preview: process.env.AGENT_HARNESS_PROVIDER_API_KEY === "provider-secret"
    ? "Build the runtime bridge"
    : "Credential missing",
  projectId: null,
  cwd: process.env.TEST_WORKSPACE,
  modelProvider: "agent_harness",
  model: process.env.TEST_THREAD_MODEL || null,
  reasoningEffort: process.env.TEST_THREAD_EFFORT || null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  recencyAt: 1_700_000_100,
  status: { type: "idle" },
  gitInfo: { sha: "abc", branch: "main", originUrl: null },
  turns: [],
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {
      userAgent: "fake", codexHome: process.env.CODEX_HOME,
      platformFamily: "test", platformOs: process.platform,
    }});
    return;
  }
  if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [thread], nextCursor: null, backwardsCursor: null } });
    return;
  }
  if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: { ...thread, turns: [{
      id: "turn-1", status: "completed", startedAt: 1_700_000_000,
      completedAt: 1_700_000_001, error: null, items: [
        { type: "userMessage", id: "user-item", content: [{ type: "text", text: "Build it" }] },
        { type: "agentMessage", id: "agent-item", text: "Done", phase: "final_answer" },
      ],
    }] } } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: message.params });
    return;
  }
  if (message.method === "echo") {
    send({ method: "test/event", params: message.params });
    send({ id: message.id, result: message.params });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;

test("adapts tenant provider and Codex threads for dashboard and route consumers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-adapter-"));
  const workspace = join(root, "projects", "sample");
  const runtimeDataDir = join(root, "runtimes");
  await mkdir(workspace, { recursive: true });
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 4310,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(root, "harness.db"),
    runtimeDataDir,
    uploadDataDir: join(root, "uploads"),
    sessionTtlMs: 60_000,
    sessionSecret: "test-session-secret-value",
    credentialEncryptionKey: "test-credential-encryption-key",
    codexBinary: process.execPath,
    codexExperimentalApi: false,
    allowedWorkspaceRoots: [join(root, "projects")],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "http://127.0.0.1:4000/v1",
    litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run("tenant-1", "Tenant", "tenant", new Date().toISOString());
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
    `)
    .run("user-1", "tenant-1", "admin", "Admin", "unused", new Date().toISOString());
  store.saveProvider({
    tenantId: "tenant-1",
    catalogId: "openrouter",
    name: "Router",
    adapter: "responses",
    baseUrl: "https://router.example.test/v1",
    defaultModel: "vendor/model",
    credentialCiphertext: encryptSecret(
      "provider-secret",
      config.credentialEncryptionKey,
    ),
    enabled: true,
    isDefault: true,
  });
  store.grantWorkspace({
    tenantId: "tenant-1",
    rootPath: await realpath(workspace),
    createdByUserId: "user-1",
  });
  const manager = new CodexRuntimeManager({
    runtimeDataDir,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_DASHBOARD_APP_SERVER],
    runtimeEnvironment: { TEST_WORKSPACE: workspace },
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  const adapter = new CodexHarnessAdapter({ store, config, manager });
  t.after(async () => {
    await adapter.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const identity = { tenantId: "tenant-1", userId: "user-1" };
  const snapshot = await adapter.dashboardSnapshot(identity);
  assert.deepEqual(snapshot.projects, [
    {
      id: snapshot.projects[0]?.id,
      name: "sample",
      path: await realpath(workspace),
      branch: "main",
      isGitRepository: true,
    },
  ]);
  assert.match(snapshot.projects[0]?.id ?? "", /^path-[0-9a-f]{64}$/);
  assert.deepEqual(snapshot.threads, [
    {
      id: "thread-1",
      title: "Runtime bridge",
      projectId: snapshot.projects[0]?.id ?? null,
      projectName: "sample",
      status: "idle",
      model: "vendor/model",
      updatedAt: "2023-11-14T22:15:00.000Z",
      preview: "Build the runtime bridge",
    },
  ]);
  assert.deepEqual(
    snapshot.featuredThread?.timeline.map(({ kind, title, body }) => ({ kind, title, body })),
    [
      { kind: "user", title: "You", body: "Build it" },
      { kind: "assistant", title: "Agent response", body: "Done" },
    ],
  );
  const detail = await adapter.threadSnapshot({ ...identity, threadId: "thread-1" });
  assert.equal(detail?.thread.id, "thread-1");
  assert.deepEqual(
    detail?.timeline.map(({ kind, body }) => ({ kind, body })),
    [
      { kind: "user", body: "Build it" },
      { kind: "assistant", body: "Done" },
    ],
  );
  assert.equal(
    store.getThreadWorkspaceBinding("tenant-1", "user-1", "thread-1")?.workspacePath,
    await realpath(workspace),
  );

  const workspaceGrant = store.findWorkspaceGrantForPath(
    identity.tenantId,
    await realpath(workspace),
  );
  assert.ok(workspaceGrant);
  const savedProject = store.registerSavedProject({
    tenantId: identity.tenantId,
    name: "Saved harness project",
    workspacePath: await realpath(workspace),
    workspaceGrantId: workspaceGrant.id,
    createdByUserId: identity.userId,
  });
  const savedProjectSnapshot = await adapter.dashboardSnapshot(identity);
  assert.equal(savedProjectSnapshot.projects.length, 1);
  assert.equal(savedProjectSnapshot.projects[0]?.id, savedProject.id);
  assert.equal(savedProjectSnapshot.projects[0]?.name, "Saved harness project");
  assert.equal(savedProjectSnapshot.threads[0]?.projectId, savedProject.id);
  assert.equal(savedProjectSnapshot.threads[0]?.projectName, "Saved harness project");
  const savedProjectDetail = await adapter.threadSnapshot({
    ...identity,
    threadId: "thread-1",
  });
  assert.equal(savedProjectDetail?.thread.projectId, savedProject.id);
  assert.equal(savedProjectDetail?.thread.projectName, "Saved harness project");

  const bridge = await adapter.forUser(identity);
  const events: string[] = [];
  const unsubscribe = bridge.subscribe((event) => {
    assert.equal(event.userId, "user-1");
    events.push(event.method);
  });
  assert.deepEqual(await bridge.request<JsonObject>("echo", { ok: true }), { ok: true });
  unsubscribe();
  assert.deepEqual(events, ["test/event"]);
  assert.deepEqual(
    await bridge.startThread<JsonObject>(workspace, { ephemeral: true }),
    { ephemeral: true, cwd: await realpath(workspace) },
  );
  assert.equal(manager.activeUserIds().length, 1);
  assert.doesNotMatch(manager.activeUserIds()[0] ?? "", /tenant-1|user-1/);

  store.db.prepare("DELETE FROM workspace_grants WHERE tenant_id = ?").run("tenant-1");
  const revoked = await adapter.dashboardSnapshot(identity);
  assert.deepEqual(revoked, { projects: [], threads: [], featuredThread: null });
  assert.equal(await adapter.threadSnapshot({ ...identity, threadId: "thread-1" }), null);
});

test("prefers the model and reasoning effort the runtime reports for a thread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-thread-model-"));
  const workspace = join(root, "projects", "sample");
  const runtimeDataDir = join(root, "runtimes");
  await mkdir(workspace, { recursive: true });
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 4310,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(root, "harness.db"),
    runtimeDataDir,
    uploadDataDir: join(root, "uploads"),
    sessionTtlMs: 60_000,
    sessionSecret: "test-session-secret-value",
    credentialEncryptionKey: "test-credential-encryption-key",
    codexBinary: process.execPath,
    codexExperimentalApi: false,
    allowedWorkspaceRoots: [join(root, "projects")],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "http://127.0.0.1:4000/v1",
    litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run("tenant-1", "Tenant", "tenant", new Date().toISOString());
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
    `)
    .run("user-1", "tenant-1", "admin", "Admin", "unused", new Date().toISOString());
  store.saveProvider({
    tenantId: "tenant-1",
    catalogId: "openrouter",
    name: "Router",
    adapter: "responses",
    baseUrl: "https://router.example.test/v1",
    defaultModel: "vendor/model",
    credentialCiphertext: encryptSecret(
      "provider-secret",
      config.credentialEncryptionKey,
    ),
    enabled: true,
    isDefault: true,
  });
  store.grantWorkspace({
    tenantId: "tenant-1",
    rootPath: await realpath(workspace),
    createdByUserId: "user-1",
  });

  const manager = new CodexRuntimeManager({
    runtimeDataDir,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_DASHBOARD_APP_SERVER],
    runtimeEnvironment: {
      TEST_WORKSPACE: workspace,
      TEST_THREAD_MODEL: "runtime/reported-model",
      TEST_THREAD_EFFORT: "high",
    },
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  const adapter = new CodexHarnessAdapter({ store, config, manager });
  t.after(async () => {
    await adapter.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = await adapter.dashboardSnapshot({
    tenantId: "tenant-1",
    userId: "user-1",
  });
  const thread = snapshot.threads[0];
  assert.ok(thread, "expected the runtime thread to be adapted");
  // The tenant route still resolves to vendor/model; the thread's own model wins.
  assert.equal(thread.model, "runtime/reported-model");
  assert.equal(thread.reasoningEffort, "high");
});
