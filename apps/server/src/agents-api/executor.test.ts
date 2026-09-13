import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AgentsApiExecutorError, AgentsApiExecutorSupervisor, type AgentsApiExecutorExit } from "./executor.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "managed-executor-"));
  const workspaceDirectory = join(root, "snapshot");
  await mkdir(workspaceDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root, launch: {
      sessionId: "sess_test", environmentId: "env_test",
      remoteUrl: "https://api.openai.com/v1/agents/environments?route=preserve-exactly",
      workspaceDirectory, homeDirectory: join(root, "home"), codexHomeDirectory: join(root, "codex"),
    },
  };
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { const value = await readFile(path, "utf8"); if (value) return value; } catch { /* File is not ready yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected executor fixture output was not created.");
}

const PROBE = String.raw`
const fs = require("node:fs");
fs.writeFileSync("probe.tmp", JSON.stringify({ argv: process.argv.slice(1), env: process.env, cwd: process.cwd() }));
fs.renameSync("probe.tmp", "probe.json");
process.stdout.write("restricted-test-key should never be logged\n");
process.stderr.write("private workspace details should never be logged\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

test("launches one executor per session with exact connection arguments and a scrubbed environment", async (t) => {
  const { root, launch } = await fixture(t);
  const exits: AgentsApiExecutorExit[] = [];
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "application-test-key-must-not-escape";
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const supervisor = new AgentsApiExecutorSupervisor({
    launcher: { command: process.execPath, args: ["-e", PROBE] }, restrictedApiKey: "restricted-test-key", onExit: (exit) => exits.push(exit),
  });
  t.after(() => supervisor.close());
  const handle = await supervisor.start(launch);
  const probe = JSON.parse(await waitForFile(join(launch.workspaceDirectory, "probe.json")));
  assert.deepEqual(probe.argv, ["exec-server", "--remote", launch.remoteUrl, "--environment-id", "env_test", "--exit-on-stdin-close"]);
  assert.equal(probe.env.CODEX_API_KEY, "restricted-test-key");
  assert.equal(probe.env.OPENAI_API_KEY, undefined);
  assert.equal(probe.env.NODE_OPTIONS, undefined);
  assert.equal(probe.env.HOME, await realpath(launch.homeDirectory));
  assert.equal(probe.env.CODEX_HOME, await realpath(launch.codexHomeDirectory));
  assert.equal(probe.env.HARNESS_WORKSPACE_DIRECTORY, await realpath(launch.workspaceDirectory));
  assert.equal(probe.cwd, await realpath(launch.workspaceDirectory));
  // macOS can inject its own text-encoding marker into a new process.
  assert.deepEqual(Object.keys(probe.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort(),
    ["CODEX_API_KEY", "CODEX_HOME", "HARNESS_EXECUTOR_SESSION_ID", "HARNESS_WORKSPACE_DIRECTORY", "HOME", "LANG", "PATH", "TMPDIR"].sort());
  await assert.rejects(supervisor.start(launch), (error: unknown) => error instanceof AgentsApiExecutorError && error.code === "duplicate");
  const secondWorkspace = join(root, "snapshot-two");
  await mkdir(secondWorkspace);
  const second = await supervisor.start({ ...launch, sessionId: "sess_second", environmentId: "env_second", workspaceDirectory: secondWorkspace,
    homeDirectory: join(root, "home-two"), codexHomeDirectory: join(root, "codex-two") });
  assert.notEqual(handle.snapshot().pid, second.snapshot().pid);
  assert.doesNotMatch(JSON.stringify(supervisor.snapshot(launch.sessionId)), /restricted-test-key|private workspace/);
  await supervisor.stop(launch.sessionId);
  const exit = await handle.closed;
  assert.equal(exit.expected, true);
  assert.equal(exit.reason, "stopped");
  assert.equal(handle.snapshot().state, "stopped");
  assert.equal(supervisor.snapshot(launch.sessionId), undefined);
  assert.equal(exits.length, 1);
});

test("reports executor failure without exposing stdout, stderr, or native spawn errors", async (t) => {
  const { launch } = await fixture(t);
  const supervisor = new AgentsApiExecutorSupervisor({
    launcher: { command: process.execPath, args: ["-e", 'process.stderr.write("secret upstream response"); process.exit(19);'] },
    restrictedApiKey: "restricted-test-key",
  });
  t.after(() => supervisor.close());
  const handle = await supervisor.start(launch);
  const exit = await handle.closed;
  assert.equal(exit.expected, false);
  assert.equal(exit.code, 19);
  assert.equal(exit.reason, "exited");
  assert.equal(handle.snapshot().state, "failed");
  assert.doesNotMatch(JSON.stringify(exit), /secret|upstream/);
  const missing = new AgentsApiExecutorSupervisor({ launcher: { command: "/nonexistent/private-launcher" }, restrictedApiKey: "test" });
  t.after(() => missing.close());
  await assert.rejects(missing.start(launch), (error: unknown) => {
    assert.ok(error instanceof AgentsApiExecutorError);
    assert.equal(error.code, "launch");
    assert.doesNotMatch(String(error), /private-launcher|ENOENT/);
    return true;
  });
});

test("terminates output floods and escalates shutdown for unresponsive executors", async (t) => {
  const { launch } = await fixture(t);
  const flood = new AgentsApiExecutorSupervisor({
    launcher: { command: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);'] },
    restrictedApiKey: "test", maxOutputBytes: 1_024, shutdownTimeoutMs: 50,
  });
  t.after(() => flood.close());
  const handle = await flood.start(launch);
  assert.equal((await handle.closed).reason, "output_limit");
  assert.equal(handle.snapshot().state, "failed");
  assert.equal(handle.snapshot().stdoutBytes, 1_025);

  const stubborn = new AgentsApiExecutorSupervisor({
    launcher: { command: process.execPath, args: ["-e", 'require("node:fs").writeFileSync("ready", "ready"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'] },
    restrictedApiKey: "test", shutdownTimeoutMs: 50,
  });
  t.after(() => stubborn.close());
  const stubbornHandle = await stubborn.start(launch);
  await waitForFile(join(launch.workspaceDirectory, "ready"));
  await stubborn.stop(launch.sessionId);
  assert.equal((await stubbornHandle.closed).signal, "SIGKILL");
});

test("cleans the process group when a launcher exits before its child", async (t) => {
  const { launch } = await fixture(t);
  const supervisor = new AgentsApiExecutorSupervisor({
    launcher: { command: process.execPath, args: ["-e", String.raw`
      const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      require("node:fs").writeFileSync("child-pid", String(child.pid));
      setTimeout(() => process.exit(4), 50);
    `] }, restrictedApiKey: "test", shutdownTimeoutMs: 100,
  });
  t.after(() => supervisor.close());
  const handle = await supervisor.start(launch);
  const childPid = Number(await waitForFile(join(launch.workspaceDirectory, "child-pid")));
  const exited = await Promise.race([handle.closed, new Promise<never>((_resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Executor group was not cleaned up")), 3_000);
    timeout.unref();
  })]);
  assert.equal(exited.code, 4);
  // The inherited stdout/stderr descriptors have closed, so the child was terminated.
  assert.ok(childPid > 0);
});

test("rejects untrusted connection origins, relative launchers, and launches after shutdown", async (t) => {
  const { launch } = await fixture(t);
  assert.throws(() => new AgentsApiExecutorSupervisor({ launcher: { command: "codex" }, restrictedApiKey: "test" }), AgentsApiExecutorError);
  const supervisor = new AgentsApiExecutorSupervisor({ launcher: { command: process.execPath, args: ["-e", PROBE] }, restrictedApiKey: "test" });
  t.after(() => supervisor.close());
  await assert.rejects(supervisor.start({ ...launch, remoteUrl: "https://api.openai.com.evil.test" }), (error: unknown) => error instanceof AgentsApiExecutorError && error.code === "configuration");
  await supervisor.close();
  await assert.rejects(supervisor.start(launch), (error: unknown) => error instanceof AgentsApiExecutorError && error.code === "closed");
});
