import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  prepareUserRuntimePaths,
  renderCodexConfig,
  resolveAllowedWorkspacePath,
} from "./config.js";

test("renders a Responses provider without persisting its credential", () => {
  const rendered = renderCodexConfig({
    adapter: "responses",
    name: 'Router "primary"',
    baseUrl: "https://router.example.test/v1/",
    model: "vendor/model",
    apiKey: "sensitive-provider-key",
  });

  assert.match(rendered.toml, /model_provider = "agent_harness"/);
  assert.match(rendered.toml, /wire_api = "responses"/);
  assert.match(rendered.toml, /base_url = "https:\/\/router\.example\.test\/v1"/);
  assert.match(rendered.toml, /\[shell_environment_policy\]/);
  assert.match(rendered.toml, /inherit = "core"/);
  assert.match(rendered.toml, /ignore_default_excludes = false/);
  assert.match(rendered.toml, /exclude = \["AGENT_HARNESS_PROVIDER_API_KEY", "CODEX_OSS_BASE_URL"\]/);
  assert.doesNotMatch(rendered.toml, /sensitive-provider-key/);
  assert.deepEqual(rendered.environment, {
    AGENT_HARNESS_PROVIDER_API_KEY: "sensitive-provider-key",
  });
});

test("renders Ollama through Codex's built-in Responses provider", () => {
  const rendered = renderCodexConfig({
    adapter: "ollama",
    model: "qwen3-coder",
  });

  assert.match(rendered.toml, /^model = "qwen3-coder"/);
  assert.match(rendered.toml, /\[shell_environment_policy\]/);
  assert.match(rendered.toml, /inherit = "core"/);
  assert.deepEqual(rendered.environment, {
    CODEX_OSS_BASE_URL: "http://127.0.0.1:11434/v1",
  });
});

test("derives opaque per-user paths and resolves only allowed workspaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-harness-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowedRoot = join(root, "projects");
  const workspace = join(allowedRoot, "project-a");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);

  const paths = await prepareUserRuntimePaths(join(root, "runtimes"), "../../tenant/user");
  assert.match(basename(paths.runtimeDir), /^[a-f0-9]{64}$/);
  assert.notEqual(paths.codexHome, paths.processHome);
  assert.equal(
    await resolveAllowedWorkspacePath(workspace, [allowedRoot]),
    await realpath(workspace),
  );
  await assert.rejects(
    resolveAllowedWorkspacePath(outside, [allowedRoot]),
    /outside the configured workspace roots/,
  );
});
