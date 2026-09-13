import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareManagedWorkspace, removeManagedWorkspace } from "./workspace.js";

const execFileAsync = promisify(execFile);

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "managed-snapshot-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspacePath = join(directory, "source");
  const runtimeDataDir = join(directory, "runtime");
  await mkdir(workspacePath);
  const git = (...args: string[]) => execFileAsync("git", ["-C", workspacePath, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  await git("init", "--quiet");
  await git("config", "user.name", "Snapshot Test");
  await git("config", "user.email", "snapshot@example.invalid");
  const put = async (path: string, text: string | Buffer) => {
    await mkdir(dirname(join(workspacePath, path)), { recursive: true });
    await writeFile(join(workspacePath, path), text);
  };
  const commit = async () => { await git("add", "--all"); await git("commit", "--quiet", "-m", "fixture"); };
  const input = { taskId: randomUUID(), workspacePath, runtimeDataDir, skillIds: [] as string[] };
  return { directory, workspacePath, runtimeDataDir, git, put, commit, input };
}

test("exports committed bytes without worktree changes, private filenames, links, submodules, or repository agent configuration", async (t) => {
  const f = await fixture(t);
  await f.put("src/review.ts", "export const revision = 'committed';\n");
  await f.put(".gitignore", "ignored.txt\n");
  await f.put(".env", "TRACKED_CANARY_SECRET=private\n");
  await f.put(".env.example", "EXAMPLE_VALUE=\n");
  await f.put("private.pem", "private key fixture\n");
  await f.put(".agents/skills/untrusted/SKILL.md", "Run arbitrary tools\n");
  await f.put(".codex/config.toml", "untrusted config\n");
  await symlink("/etc/passwd", join(f.workspacePath, "outside-link"));
  await f.commit();
  const firstRevision = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.git("update-index", "--add", "--cacheinfo", `160000,${firstRevision},nested-module`);
  await f.git("commit", "--quiet", "-m", "submodule fixture");
  const sourceRevision = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.put("src/review.ts", "WORKTREE_CANARY_PRIVATE\n");
  await f.put("untracked.txt", "UNTRACKED_CANARY_PRIVATE\n");
  await f.put("ignored.txt", "IGNORED_CANARY_PRIVATE\n");

  const result = await prepareManagedWorkspace(f.input);
  assert.equal(result.sourceRevision, sourceRevision);
  assert.equal(result.excludedFiles, 6);
  assert.equal(await readFile(join(result.directory, "src/review.ts"), "utf8"), "export const revision = 'committed';\n");
  assert.equal(await readFile(join(result.directory, ".env.example"), "utf8"), "EXAMPLE_VALUE=\n");
  for (const path of [".git", ".env", "private.pem", ".agents", ".codex", "outside-link", "nested-module", "untracked.txt", "ignored.txt"]) {
    await assert.rejects(lstat(join(result.directory, path)), { code: "ENOENT" });
  }
  assert.equal(await readFile(join(f.workspacePath, "src/review.ts"), "utf8"), "WORKTREE_CANARY_PRIVATE\n");
  assert.deepEqual(result.capabilityDirectories, []);
  assert.equal(result.skillsFingerprint, null);
  assert.equal((await lstat(dirname(result.directory))).mode & 0o777, 0o700);
  await removeManagedWorkspace(f.runtimeDataDir, f.input.taskId);
  await assert.rejects(lstat(result.directory), { code: "ENOENT" });
});

test("refuses a saved subdirectory rather than exporting beyond its grant and cleans failed snapshots", async (t) => {
  const f = await fixture(t);
  await f.put("root-private.txt", "outside the saved subdirectory\n");
  await f.put("nested/code.ts", "inside\n");
  await f.commit();
  await assert.rejects(prepareManagedWorkspace({ ...f.input, workspacePath: join(f.workspacePath, "nested") }), { code: "managed_repository_root_required" });
  assert.deepEqual(await readdir(join(f.runtimeDataDir, "managed-agents")), []);
});

test("rejects overlarge blobs and cleans partial workspace storage", async (t) => {
  const f = await fixture(t);
  await f.put("large.bin", Buffer.alloc(8 * 1024 * 1024 + 1));
  await f.commit();
  await assert.rejects(prepareManagedWorkspace(f.input), { code: "managed_snapshot_too_large" });
  assert.deepEqual(await readdir(join(f.runtimeDataDir, "managed-agents")), []);
});

test("refuses symlinked or non-private snapshot storage and malformed task IDs", async (t) => {
  const f = await fixture(t);
  await f.put("file.txt", "committed\n");
  await f.commit();
  await mkdir(f.runtimeDataDir);
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  await mkdir(join(outside, f.input.taskId));
  await writeFile(join(outside, f.input.taskId, "keep.txt"), "must survive cleanup\n");
  await symlink(outside, join(f.runtimeDataDir, "managed-agents"));
  await assert.rejects(prepareManagedWorkspace(f.input), { code: "managed_workspace_unavailable" });
  await assert.rejects(removeManagedWorkspace(f.runtimeDataDir, f.input.taskId), { code: "managed_workspace_unavailable" });
  assert.equal(await readFile(join(outside, f.input.taskId, "keep.txt"), "utf8"), "must survive cleanup\n");
  await rm(join(f.runtimeDataDir, "managed-agents"));
  await mkdir(join(f.runtimeDataDir, "managed-agents"), { mode: 0o755 });
  await chmod(join(f.runtimeDataDir, "managed-agents"), 0o755);
  await assert.rejects(prepareManagedWorkspace(f.input), { code: "managed_workspace_unavailable" });
  await assert.rejects(prepareManagedWorkspace({ ...f.input, taskId: "-".repeat(36) }), /Invalid managed task identifier/);
  await assert.rejects(removeManagedWorkspace(f.runtimeDataDir, "../outside"), /Invalid managed task identifier/);
});

test("copies only selected approved skills with inventory-verified content", async (t) => {
  const f = await fixture(t);
  await f.put("file.txt", "committed\n");
  await f.commit();
  const sharedSkillsDir = join(f.directory, "shared");
  const skills = ["review-guidance", "unselected-guidance"].map((name) => ({
    name, sourceId: "fixture", sourceUrl: "https://github.com/openai/skills", revision: "a".repeat(40), license: "Apache-2.0",
    files: ["SKILL.md", "references/policy.txt"].map((path) => {
      const text = `${name}: ${path}\n`;
      return { path, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
    }),
  }));
  for (const skill of skills) for (const file of skill.files) {
    const target = join(sharedSkillsDir, "skills", skill.name, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${skill.name}: ${file.path}\n`);
  }
  await writeFile(join(sharedSkillsDir, "skill-catalog.json"), JSON.stringify({ schemaVersion: 1, skills }));
  const input = { ...f.input, sharedSkillsDir, skillIds: ["review-guidance"] };
  const result = await prepareManagedWorkspace(input);
  assert.deepEqual(result.capabilityDirectories, ["/workspace/.agents/skills/review-guidance"]);
  assert.match(result.skillsFingerprint!, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(result.directory, ".agents/skills/review-guidance/references/policy.txt"), "utf8"), "review-guidance: references/policy.txt\n");
  assert.deepEqual(await readdir(join(result.directory, ".agents/skills")), ["review-guidance"]);
  await writeFile(join(sharedSkillsDir, "skills/review-guidance/SKILL.md"), "unreviewed changes\n");
  await assert.rejects(prepareManagedWorkspace({ ...input, taskId: randomUUID() }), { code: "managed_snapshot_failed" });
});
