import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
