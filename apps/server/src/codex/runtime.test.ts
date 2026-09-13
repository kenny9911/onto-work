import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexRpcError,
  CodexRuntimeManager,
  type CodexRuntimeEvent,
  type JsonObject,
} from "./runtime.js";

const FAKE_APP_SERVER = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let serverRequestProbe = null;
let unsupportedResponse = null;
let approvalResponse = null;
let extraSkillRoots = [];
const requestMethods = [];
const finishServerRequestProbe = () => {
  if (!serverRequestProbe || !unsupportedResponse || !approvalResponse) return;
  send({
    id: serverRequestProbe,
    result: {
      unsupportedError: unsupportedResponse.error || null,
      approvalResult: approvalResponse.result || null,
    },
  });
  serverRequestProbe = null;
  unsupportedResponse = null;
  approvalResponse = null;
};
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) requestMethods.push(message.method);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "test",
        platformOs: process.platform,
        receivedExperimentalApi: message.params.capabilities.experimentalApi,
      },
    });
    return;
  }
  if (message.method === "echo") {
    const delay = Number(message.params && message.params.delay) || 0;
    setTimeout(() => {
      send({ method: "test/echoed", params: message.params });
      send({ id: message.id, result: message.params });
    }, delay);
    return;
  }
  if (message.method === "skills/extraRoots/set") {
    if (process.env.TEST_SKILLS_RPC_FAIL === "true") {
      send({ id: message.id, error: { code: -32601, message: "unsupported skills catalog" } });
    } else {
      extraSkillRoots = message.params.extraRoots;
      send({ id: message.id, result: {} });
    }
    return;
  }
  if (message.method === "probe/skills") {
    send({ id: message.id, result: { extraSkillRoots, requestMethods, codexHome: process.env.CODEX_HOME, home: process.env.HOME } });
    return;
  }
  if (message.method === "fail") {
    send({ id: message.id, error: { code: 4321, message: "expected failure" } });
    return;
  }
  if (message.method === "probe/server-requests") {
    serverRequestProbe = message.id;
    send({
      id: "unsupported-server-request",
      method: "item/tool/requestUserInput",
      params: { prompt: "must be rejected" },
    });
    send({
      id: "supported-approval-request",
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd" },
    });
    return;
  }
  if (message.id === "unsupported-server-request") {
    unsupportedResponse = message;
    finishServerRequestProbe();
    return;
  }
  if (message.id === "supported-approval-request") {
    approvalResponse = message;
    finishServerRequestProbe();
  }
});
process.on("SIGTERM", () => process.exit(0));
`;

test("isolates users, correlates requests, and publishes JSONL notifications", async (t) => {
  const runtimeDataDir = await mkdtemp(join(tmpdir(), "agent-harness-manager-"));
  const manager = new CodexRuntimeManager({
    runtimeDataDir,
    allowedWorkspaceRoots: [],
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER],
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(runtimeDataDir, { recursive: true, force: true });
  });

  const launch = {
    provider: { adapter: "ollama" as const, model: "qwen3-coder" },
  };
  const first = await manager.startUser("user-one", launch);
  const same = await manager.startUser("user-one", launch);
  const second = await manager.startUser("user-two", launch);

  assert.equal(same, first);
  assert.notEqual(first.processId, second.processId);
  assert.notEqual(first.paths.codexHome, second.paths.codexHome);
  assert.equal(first.initializeResult?.codexHome, first.paths.codexHome);
  assert.equal(first.initializeResult?.receivedExperimentalApi, false);

  const events: CodexRuntimeEvent[] = [];
  const unsubscribe = manager.subscribe("user-one", (event) => events.push(event));
  const [slow, fast] = await Promise.all([
    manager.request<JsonObject>("user-one", "echo", { value: "slow", delay: 20 }),
    manager.request<JsonObject>("user-one", "echo", { value: "fast", delay: 1 }),
  ]);
  unsubscribe();

  assert.deepEqual(slow, { value: "slow", delay: 20 });
  assert.deepEqual(fast, { value: "fast", delay: 1 });
  assert.deepEqual(
    events.map((event) => event.params),
    [
      { value: "fast", delay: 1 },
      { value: "slow", delay: 20 },
    ],
  );

  await assert.rejects(manager.request("user-one", "fail"), (error: unknown) => {
    assert.ok(error instanceof CodexRpcError);
    assert.equal(error.code, 4321);
    return true;
  });

  const config = await readFile(first.paths.configPath, "utf8");
  assert.match(config, /model_provider = "ollama"/);
  await manager.stopUser("user-one");
  assert.equal(first.state, "closed");
  assert.equal(manager.has("user-one"), false);
});

test("opts into the experimental App Server API only when explicitly enabled", async (t) => {
  const runtimeDataDir = await mkdtemp(join(tmpdir(), "agent-harness-experimental-"));
  const manager = new CodexRuntimeManager({
    runtimeDataDir,
    allowedWorkspaceRoots: [],
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER],
    experimentalApi: true,
    initializeTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(runtimeDataDir, { recursive: true, force: true });
  });

  const runtime = await manager.startUser("experimental-user", {
    provider: { adapter: "ollama", model: "qwen3-coder" },
  });

  assert.equal(runtime.initializeResult?.receivedExperimentalApi, true);
});

test("rejects unknown server requests while approvals remain observable", async (t) => {
  const runtimeDataDir = await mkdtemp(join(tmpdir(), "agent-harness-server-request-"));
  const manager = new CodexRuntimeManager({
    runtimeDataDir,
    allowedWorkspaceRoots: [],
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER],
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(runtimeDataDir, { recursive: true, force: true });
  });

  await manager.startUser("approval-user", {
    provider: { adapter: "ollama", model: "qwen3-coder" },
  });
  const events: CodexRuntimeEvent[] = [];
  let approvalWrite: Promise<void> | null = null;
  const unsubscribe = manager.subscribe("approval-user", (event) => {
    events.push(event);
    if (event.requestId !== undefined) {
      approvalWrite = manager.respond("approval-user", event.requestId, { decision: "accept" });
    }
  });

  const probe = await manager.request<JsonObject>("approval-user", "probe/server-requests");
  unsubscribe();
  if (approvalWrite) await approvalWrite;

  assert.deepEqual(probe, {
    unsupportedError: {
      code: -32_601,
      message: "App Server request is not supported by Agent Harness",
    },
    approvalResult: { decision: "accept" },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "server-request");
  assert.equal(events[0]?.method, "item/commandExecution/requestApproval");
  assert.equal(events[0]?.requestId, "supported-approval-request");
});

async function sharedCatalogFixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-harness-shared-skills-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sharedSkillsDir = join(directory, "shared");
  const skillRoot = join(sharedSkillsDir, "skills", "openai-example");
  await mkdir(skillRoot, { recursive: true });
  const content = "---\nname: example\ndescription: Example skill\n---\nUse this skill.\n";
  await writeFile(join(skillRoot, "SKILL.md"), content);
  await writeFile(join(sharedSkillsDir, "skill-catalog.json"), JSON.stringify({
    schemaVersion: 1,
    skills: [{
      name: "openai-example", sourceId: "openai", sourceUrl: "https://github.com/openai/skills",
      revision: "a".repeat(40), license: "Apache-2.0",
      files: [{ path: "SKILL.md", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }],
    }],
  }));
  return { directory, sharedSkillsDir, skillRoot };
}

test("registers only verified shared bundles before ready while preserving per-user homes", async (t) => {
  const f = await sharedCatalogFixture(t);
  const project = join(f.directory, "project");
  await mkdir(join(project, ".agents", "skills", "project-only"), { recursive: true });
  const manager = new CodexRuntimeManager({
    runtimeDataDir: join(f.directory, "runtimes"),
    sharedSkillsDir: f.sharedSkillsDir,
    allowedWorkspaceRoots: [project],
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER],
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(() => manager.shutdown());
  const launch = { provider: { adapter: "ollama" as const, model: "qwen3-coder" }, workspacePath: project };
  const first = await manager.startUser("tenant-one-user", launch);
  const second = await manager.startUser("tenant-two-user", launch);
  for (const runtime of [first, second]) {
    const probe = await runtime.request<JsonObject>("probe/skills");
    assert.deepEqual(probe.extraSkillRoots, [f.skillRoot]);
    assert.deepEqual(probe.requestMethods, ["initialize", "initialized", "skills/extraRoots/set", "probe/skills"]);
    assert.equal(probe.codexHome, runtime.paths.codexHome);
    assert.equal(probe.home, runtime.paths.processHome);
    assert.equal(runtime.state, "ready");
    const config = await readFile(runtime.paths.configPath, "utf8");
    assert.match(config, /project_root_markers = \[\]/);
    assert.match(config, /\.agents\/skills\/\<skill-name\>/);
    assert.match(config, /operator-reviewed catalog updates/);
  }
  assert.notEqual(first.paths.codexHome, second.paths.codexHome);
  assert.notEqual(first.processId, second.processId);
  assert.equal(await manager.startUser("tenant-one-user", launch), first);
});

test("closes a startup process if registering shared skills fails", async (t) => {
  const f = await sharedCatalogFixture(t);
  const manager = new CodexRuntimeManager({
    runtimeDataDir: join(f.directory, "runtimes"),
    sharedSkillsDir: f.sharedSkillsDir,
    allowedWorkspaceRoots: [],
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER],
    runtimeEnvironment: { TEST_SKILLS_RPC_FAIL: "true" },
    initializeTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(() => manager.shutdown());
  await assert.rejects(manager.startUser("user", { provider: { adapter: "ollama", model: "qwen3-coder" } }), CodexRpcError);
  assert.equal(manager.has("user"), false);
  assert.deepEqual(manager.activeUserIds(), []);
});

test("refuses catalog tampering before spawn and closes existing runtimes on revalidation", async (t) => {
  const f = await sharedCatalogFixture(t);
  const manager = new CodexRuntimeManager({
    runtimeDataDir: join(f.directory, "runtimes"),
    sharedSkillsDir: f.sharedSkillsDir,
    allowedWorkspaceRoots: [],
    codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER],
    initializeTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(() => manager.shutdown());
  const launch = { provider: { adapter: "ollama" as const, model: "qwen3-coder" } };
  const runtime = await manager.startUser("existing-user", launch);
  await writeFile(join(f.skillRoot, "SKILL.md"), "Tampered skill");
  await assert.rejects(manager.startUser("new-user", launch), /Shared skills catalog/);
  assert.equal(manager.has("new-user"), false);
  await assert.rejects(manager.startUser("existing-user", launch), /Shared skills catalog/);
  assert.equal(manager.has("existing-user"), false);
  assert.equal(runtime.state, "closed");
});

test("cancels expired approvals even without a browser subscriber", async (t) => {
  const runtimeDataDir = await mkdtemp(join(tmpdir(), "agent-harness-approval-expiry-"));
  const manager = new CodexRuntimeManager({
    runtimeDataDir, allowedWorkspaceRoots: [], codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER], approvalTimeoutMs: 40, requestTimeoutMs: 2_000,
  });
  t.after(async () => { await manager.shutdown(); await rm(runtimeDataDir, { recursive: true, force: true }); });
  const runtime = await manager.startUser("expiry-user", { provider: { adapter: "ollama", model: "test" } });
  const result = await runtime.request<JsonObject>("probe/server-requests");
  assert.deepEqual(result.approvalResult, { decision: "cancel" });
  const replay: CodexRuntimeEvent[] = [];
  const unsubscribe = runtime.subscribe((event) => replay.push(event));
  unsubscribe();
  assert.equal(replay.length, 0);
  await assert.rejects(runtime.respond("supported-approval-request", { decision: "accept" }), /no longer pending/);
});

test("replays pending approvals across browser reconnects without extending their deadline", async (t) => {
  const runtimeDataDir = await mkdtemp(join(tmpdir(), "agent-harness-approval-replay-"));
  const manager = new CodexRuntimeManager({
    runtimeDataDir, allowedWorkspaceRoots: [], codexBinary: process.execPath,
    codexArgs: ["-e", FAKE_APP_SERVER], requestTimeoutMs: 2_000,
  });
  t.after(async () => { await manager.shutdown(); await rm(runtimeDataDir, { recursive: true, force: true }); });
  const runtime = await manager.startUser("replay-user", { provider: { adapter: "ollama", model: "test" } });
  const probe = runtime.request<JsonObject>("probe/server-requests");
  // The echo reply proves the preceding approval was read, without answering it.
  await runtime.request("echo", {});
  const first: CodexRuntimeEvent[] = [];
  runtime.subscribe((event) => first.push(event))();
  const second: CodexRuntimeEvent[] = [];
  runtime.subscribe((event) => second.push(event))();
  assert.equal(first.length, 1);
  assert.deepEqual(second, first);
  assert.ok(first[0]!.expiresAt! > Date.now());
  await runtime.respond("supported-approval-request", { decision: "decline" });
  assert.deepEqual((await probe).approvalResult, { decision: "decline" });
  const after: CodexRuntimeEvent[] = [];
  runtime.subscribe((event) => after.push(event))();
  assert.equal(after.length, 0);
});
