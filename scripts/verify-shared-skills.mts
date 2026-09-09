import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CodexRuntimeManager } from "../apps/server/src/codex/runtime.js";
import { loadSharedSkillsCatalog } from "../apps/server/src/codex/shared-skills.js";

// Read-only native protocol verification: initialize, register approved roots,
// and list skills. This never starts a turn or makes a model call.
const binary = process.env.CODEX_BINARY || "codex";
const sharedDirectory = fileURLToPath(new URL("../shared", import.meta.url));
const catalog = await loadSharedSkillsCatalog(sharedDirectory);
const version = (await promisify(execFile)(binary, ["--version"])).stdout.trim();
const base = await realpath(await mkdtemp(join(tmpdir(), "onto-work-skills-smoke-")));
const parent = join(base, "parent-repository");
const project = join(parent, "nested-project");
const other = join(base, "other-project");
const manager = new CodexRuntimeManager({
  runtimeDataDir: join(base, "runtimes"),
  allowedWorkspaceRoots: [project, other],
  sharedSkillsDir: sharedDirectory,
  codexBinary: binary,
  initializeTimeoutMs: 20_000,
  requestTimeoutMs: 20_000,
});

interface InventoryEntry {
  cwd: string;
  skills: Array<{ name: string; scope: string; path: string }>;
  errors: unknown[];
}

try {
  await mkdir(join(parent, ".git"), { recursive: true });
  for (const [cwd, name] of [
    [parent, "parent-canary"],
    [project, "project-canary"],
    [other, "other-canary"],
  ] as const) {
    const root = join(cwd, ".agents", "skills", name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Scope verification skill\n---\nScope verification.\n`);
  }
  const first = await manager.startUser("smoke-tenant-one-user", {
    provider: { adapter: "ollama", model: "unused-no-model-call" },
  });
  const second = await manager.startUser("smoke-tenant-two-user", {
    provider: { adapter: "ollama", model: "unused-no-model-call" },
  });
  assert.notEqual(first.processId, second.processId);
  assert.notEqual(first.paths.codexHome, second.paths.codexHome);
  assert.notEqual(first.paths.processHome, second.paths.processHome);
  const expectedNames = catalog.roots.map((root) => basename(root)).sort();
  for (const runtime of [first, second]) {
    const response = await runtime.request("skills/list", { cwds: [project, other], forceReload: true });
    assert.ok(response && !Array.isArray(response) && typeof response === "object");
    assert.ok(Array.isArray(response.data));
    const inventory = response.data as unknown as InventoryEntry[];
    assert.equal(inventory.length, 2);
    for (const [index, cwd, own, absent] of [
      [0, project, "project-canary", "other-canary"],
      [1, other, "other-canary", "project-canary"],
    ] as const) {
      const entry = inventory[index];
      assert.ok(entry);
      assert.equal(entry.cwd, cwd);
      assert.deepEqual(entry.errors, []);
      assert.ok(entry.skills.some((skill) => skill.name === own && skill.scope === "repo"));
      assert.ok(!entry.skills.some((skill) => [absent, "parent-canary"].includes(skill.name)));
      const sharedNames = entry.skills
        .filter((skill) => catalog.roots.some((root) => skill.path === join(root, "SKILL.md")))
        .map((skill) => skill.name)
        .sort();
      assert.deepEqual(sharedNames, expectedNames);
    }
  }
  console.log(JSON.stringify({
    status: "passed",
    binary: version,
    sharedSkills: expectedNames.length,
    runtimes: 2,
    projectsPerRuntime: 2,
    projectScope: "own skills visible; sibling and parent skills absent",
    modelCalls: 0,
  }, null, 2));
} finally {
  await manager.shutdown();
  await rm(base, { recursive: true, force: true });
}
