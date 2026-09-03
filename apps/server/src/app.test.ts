import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import type { HarnessConfig } from "./config.js";
import { HarnessStore } from "./database.js";
import { UnconfiguredHarnessRuntime } from "./runtime.js";

function testConfig(directory: string): HarnessConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(directory, "harness.db"),
    runtimeDataDir: join(directory, "runtimes"),
    uploadDataDir: `${directory}-uploads`,
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
}

async function appFixture(
  t: TestContext,
): Promise<{ app: FastifyInstance; config: HarnessConfig }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-app-"));
  const config = testConfig(directory);
  const store = new HarnessStore(config.databasePath);
  const app = await buildApp({
    config,
    store,
    runtime: new UnconfiguredHarnessRuntime(),
    logger: false,
  });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
    await rm(config.uploadDataDir, { recursive: true, force: true });
  });
  return { app, config };
}

// Every case below reaches the error handler from Fastify's parsing stage,
// before any route handler runs. Without the body-error branch each one
// answers `500 internal_error` and is logged at error level, so an oversized
// paste reads as a server fault.

test("an oversized body is rejected as payload_too_large rather than a server error", async (t) => {
  const { app, config } = await appFixture(t);
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { origin: config.webOrigin, "content-type": "application/json" },
    payload: JSON.stringify({ name: "x".repeat(1_200_000), workspacePath: "/tmp" }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error, "payload_too_large");
});

test("an unparsable media type is rejected as unsupported_media_type", async (t) => {
  const { app, config } = await appFixture(t);
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: {
      origin: config.webOrigin,
      "content-type": "multipart/form-data; boundary=agent-harness",
    },
    payload: "--agent-harness\r\nContent-Disposition: form-data; name=a\r\n\r\nb\r\n--agent-harness--",
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.json().error, "unsupported_media_type");
});

test("a malformed JSON body is rejected as invalid_json", async (t) => {
  const { app, config } = await appFixture(t);
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { origin: config.webOrigin, "content-type": "application/json" },
    payload: '{"name": "unterminated',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "invalid_json");
});

test("raw octet-stream bodies reach the handler instead of failing content negotiation", async (t) => {
  const { app, config } = await appFixture(t);
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { origin: config.webOrigin, "content-type": "application/octet-stream" },
    payload: Buffer.from("raw upload bytes"),
  });
  // The pass-through parser hands the unread stream to the handler, so
  // authentication — not content negotiation — decides the answer. This is what
  // lets an upload route reject an anonymous caller before reading a byte.
  assert.notEqual(response.statusCode, 415);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "unauthenticated");
});

test("a store-owning process starts and stops its upload lifecycle work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-app-owned-"));
  const config = testConfig(directory);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(config.uploadDataDir, { recursive: true, force: true });
  });

  // No `store` option, so `buildApp` owns the database and runs the boot sweep
  // and the janitor. `close()` must tear both down without hanging.
  const app = await buildApp({
    config,
    runtime: new UnconfiguredHarnessRuntime(),
    logger: false,
  });
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  await app.close();

  const uploadStore = await stat(config.uploadDataDir);
  assert.ok(uploadStore.isDirectory());
  if (process.platform !== "win32") assert.equal(uploadStore.mode & 0o777, 0o700);
});

test("a store-owning process finishes its orphaned plaintext sweep before boot returns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-app-boot-sweep-"));
  const config = testConfig(directory);
  const stagedDirectory = join(
    config.uploadDataDir,
    "users",
    "a".repeat(64),
    "staged",
    "orphaned-turn",
  );
  const orphanedPlaintext = join(stagedDirectory, "orphan.txt");
  await mkdir(stagedDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(config.uploadDataDir, 0o700);
  await writeFile(orphanedPlaintext, "must be gone before requests are accepted");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(config.uploadDataDir, { recursive: true, force: true });
  });

  const app = await buildApp({
    config,
    runtime: new UnconfiguredHarnessRuntime(),
    logger: false,
  });
  await assert.rejects(() => stat(orphanedPlaintext), { code: "ENOENT" });
  await app.close();
});

test("the upload store refuses to boot inside an allowed workspace root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-upload-inside-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const canonicalDirectory = await realpath(directory);
  const config: HarnessConfig = {
    ...testConfig(directory),
    uploadDataDir: join(directory, "uploads"),
    allowedWorkspaceRoots: [directory],
  };

  await assert.rejects(
    () => buildApp({ config, runtime: new UnconfiguredHarnessRuntime(), logger: false }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /must not overlap an allowed workspace root/);
      assert.ok(error.message.includes(join(canonicalDirectory, "uploads")));
      assert.ok(error.message.includes(canonicalDirectory));
      return true;
    },
  );
});

test(
  "the upload store resolves a symlinked parent before creating a prospective directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-harness-upload-symlink-"));
    const workspaceRoot = join(directory, "workspace");
    const alias = `${directory}-workspace-alias`;
    const uploadDataDir = join(alias, "uploads");
    await mkdir(workspaceRoot);
    await symlink(workspaceRoot, alias, "dir");
    t.after(async () => {
      await rm(alias, { force: true });
      await rm(directory, { recursive: true, force: true });
    });
    const config: HarnessConfig = {
      ...testConfig(directory),
      uploadDataDir,
      allowedWorkspaceRoots: [workspaceRoot],
    };

    await assert.rejects(
      () => buildApp({ config, runtime: new UnconfiguredHarnessRuntime(), logger: false }),
      /UPLOAD_DATA_DIR must not overlap an allowed workspace root/,
    );
    // The canonical prospective-path check rejected the configuration before
    // mkdir could follow the symlink and create this directory in the workspace.
    await assert.rejects(() => stat(join(workspaceRoot, "uploads")), { code: "ENOENT" });
  },
);

test("the upload store refuses to boot around an allowed workspace root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-upload-around-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  if (process.platform !== "win32") await chmod(directory, 0o755);
  const canonicalDirectory = await realpath(directory);
  const config: HarnessConfig = {
    ...testConfig(directory),
    uploadDataDir: directory,
    allowedWorkspaceRoots: [workspaceRoot],
  };

  await assert.rejects(
    () => buildApp({ config, runtime: new UnconfiguredHarnessRuntime(), logger: false }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /must not overlap an allowed workspace root/);
      assert.ok(error.message.includes(join(canonicalDirectory, "workspace")));
      return true;
    },
  );

  // Validation happens before ownership or permission changes. A bad config
  // that names an existing parent (including `/` or a home directory) must be
  // rejected without chmodding that path on the way out.
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  }
});

test("the upload store never takes ownership of an insecure existing directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-upload-existing-"));
  const uploadDataDir = `${directory}-uploads`;
  await mkdir(uploadDataDir, { mode: 0o755 });
  if (process.platform !== "win32") await chmod(uploadDataDir, 0o755);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(uploadDataDir, { recursive: true, force: true });
  });
  const config: HarnessConfig = { ...testConfig(directory), uploadDataDir };

  if (process.platform === "win32") {
    const app = await buildApp({
      config,
      runtime: new UnconfiguredHarnessRuntime(),
      logger: false,
    });
    await app.close();
    return;
  }

  await assert.rejects(
    () => buildApp({ config, runtime: new UnconfiguredHarnessRuntime(), logger: false }),
    /UPLOAD_DATA_DIR must be private \(mode 0700\)/,
  );
  assert.equal((await stat(uploadDataDir)).mode & 0o777, 0o755);
});
