import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("../../../../scripts/agents-api-executor-docker.sh", import.meta.url));
const image = `registry.example.invalid/reviewed/codex@sha256:${"a".repeat(64)}`;

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "managed-launcher-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskId = randomUUID();
  const snapshot = join(directory, taskId, "workspace");
  const bin = join(directory, "bin");
  const log = join(directory, "docker.jsonl");
  await mkdir(snapshot, { recursive: true });
  await mkdir(bin);
  // This executable records the Docker CLI contract without starting containers
  // or contacting any external service. The run child also checks stdin lifetime.
  const docker = join(bin, "docker");
  await writeFile(docker, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst stdin = args[0] === 'run' ? fs.readFileSync(0, 'utf8') : null;\nfs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args, stdin }) + '\\n');\nif (args[0] === 'image' && process.env.FAKE_DOCKER_INSPECT_FAIL === '1') process.exit(1);\n`);
  await chmod(docker, 0o755);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, FAKE_DOCKER_LOG: log,
    HARNESS_WORKSPACE_DIRECTORY: snapshot, CODEX_API_KEY: "restricted-executor-canary",
    AGENTS_API_KEY: "application-secret-must-not-be-passed",
  };
  const invoke = (ref: string, overrides: Record<string, string | undefined> = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("/bin/bash", [launcher, ref, "exec-server", "--remote", "https://api.openai.com/v1/environments", "--environment-id", "env_fixture", "--exit-on-stdin-close"], {
      env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Launcher fixture timed out")); }, 5_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdin.on("error", () => { /* a rejected launcher may close stdin early */ });
    child.once("close", (code) => { clearTimeout(timeout); resolve({ code, output }); });
    child.stdin.end("supervisor input\n");
  });
  const calls = async (): Promise<Array<{ args: string[]; stdin: string | null }>> => {
    try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { snapshot, taskId, invoke, calls };
}

test("launcher preserves supervisor stdin and enforces the isolated Docker contract", async (t) => {
  const f = await fixture(t);
  const result = await f.invoke(image);
  assert.equal(result.code, 0, result.output);
  const calls = await f.calls();
  assert.deepEqual(calls[0]?.args, ["image", "inspect", image]);
  const run = calls.find((call) => call.args[0] === "run")!;
  assert.equal(run.stdin, "supervisor input\n", "background Docker must retain supervisor stdin");
  for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pull=never", "--interactive", "--rm", "--init"]) {
    assert.ok(run.args.includes(flag), `missing containment flag ${flag}`);
  }
  const value = (flag: string) => run.args[run.args.indexOf(flag) + 1];
  assert.equal(value("--user"), "10001:10001");
  assert.equal(value("--pids-limit"), "128");
  assert.equal(value("--memory"), "2g");
  assert.equal(value("--cpus"), "2");
  assert.equal(value("--mount"), `type=bind,source=${f.snapshot},target=/workspace,readonly`);
  assert.equal(run.args.filter((arg) => arg === "--mount").length, 1);
  assert.ok(run.args.includes("/home/codex:rw,nosuid,nodev,mode=700,uid=10001,gid=10001,size=268435456"));
  const passedEnv = run.args.flatMap((arg, i) => arg === "--env" ? [run.args[i + 1]] : []);
  assert.deepEqual(passedEnv, ["CODEX_API_KEY", "HOME=/home/codex", "CODEX_HOME=/home/codex/.codex"]);
  assert.ok(!run.args.some((arg) => /secret|restricted-executor-canary|docker\.sock|privileged/.test(arg)));
  assert.equal(value("--entrypoint"), "codex");
  assert.deepEqual(run.args.slice(run.args.indexOf(image) + 1), ["exec-server", "--remote", "https://api.openai.com/v1/environments", "--environment-id", "env_fixture", "--exit-on-stdin-close"]);
  assert.deepEqual(calls.at(-1)?.args, ["rm", "--force", `harness-agent-${f.taskId}`]);
});

test("launcher rejects mutable images, missing executor keys, and invalid mount paths before Docker", async (t) => {
  for (const scenario of ["mutable", "missing-key", "mount-delimiter"] as const) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const result = await f.invoke(scenario === "mutable" ? "codex:latest" : image,
        scenario === "missing-key" ? { CODEX_API_KEY: "" } : scenario === "mount-delimiter" ? { HARNESS_WORKSPACE_DIRECTORY: `${f.snapshot},target=/` } : {});
      assert.equal(result.code, 64);
      assert.deepEqual(await f.calls(), []);
    });
  }
});

test("launcher refuses an unavailable digest instead of pulling it", async (t) => {
  const f = await fixture(t);
  const result = await f.invoke(image, { FAKE_DOCKER_INSPECT_FAIL: "1" });
  assert.equal(result.code, 1);
  assert.deepEqual((await f.calls()).map((call) => call.args), [["image", "inspect", image]]);
});

test("launcher accepts a complete local SHA-256 image ID without a registry push", async (t) => {
  const f = await fixture(t);
  const imageId = `sha256:${"b".repeat(64)}`;
  assert.equal((await f.invoke(imageId)).code, 0);
  const calls = await f.calls();
  assert.deepEqual(calls[0]?.args, ["image", "inspect", imageId]);
  assert.ok(calls.find((call) => call.args[0] === "run")?.args.includes(imageId));
});
