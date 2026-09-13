import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadSharedSkillsCatalog } from "../codex/shared-skills.js";
import { ApiHttpError } from "../http.js";

const execFileAsync = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const gitEnv = () => ({ PATH: process.env.PATH || "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" });

export interface ManagedWorkspace {
  directory: string;
  homeDirectory: string;
  codexHomeDirectory: string;
  sourceRevision: string;
  excludedFiles: number;
  capabilityDirectories: string[];
  skillsFingerprint: string | null;
}

/** Export blobs directly, without checkout hooks, filters, Git configuration or worktree files. */
export async function prepareManagedWorkspace(input: {
  taskId: string;
  workspacePath: string;
  runtimeDataDir: string;
  sharedSkillsDir?: string;
  skillIds: string[];
}): Promise<ManagedWorkspace> {
  if (!TASK_ID.test(input.taskId)) throw new Error("Invalid managed task identifier");
  const root = resolve(input.runtimeDataDir, "managed-agents");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o777) !== 0o700) {
    throw new ApiHttpError(503, "managed_workspace_unavailable", "Managed workspace storage must be a private directory.");
  }
  const taskRoot = join(await realpath(root), input.taskId);
  await mkdir(taskRoot, { mode: 0o700 });
  const directory = join(taskRoot, "workspace");
  try {
    await mkdir(directory, { mode: 0o755 });
    const revision = (await execFileAsync("git", ["-C", input.workspacePath, "rev-parse", "--verify", "HEAD^{commit}"], { env: gitEnv(), timeout: 5_000 })).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid source revision");
    // Refuse a saved subdirectory: exporting the repository root would exceed its workspace grant.
    const top = (await execFileAsync("git", ["-C", input.workspacePath, "rev-parse", "--show-toplevel"], { env: gitEnv(), timeout: 5_000 })).stdout.trim();
    if (await realpath(top) !== input.workspacePath) {
      throw new ApiHttpError(409, "managed_repository_root_required", "Register the repository root to review its committed snapshot.");
    }
    const tree = await execFileAsync("git", ["-C", input.workspacePath, "ls-tree", "-r", "-l", "-z", revision], { env: gitEnv(), timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const entries: Array<{ id: string; size: number; path: string }> = [];
    let total = 0;
    let excludedFiles = 0;
    const treeEntries = tree.stdout.split("\0").filter(Boolean);
    if (treeEntries.length > MAX_FILES) {
      throw new ApiHttpError(413, "managed_snapshot_too_large", "The committed snapshot exceeds the reviewer file or size limit.");
    }
    for (const line of treeEntries) {
      const match = /^(\d+) (\w+) ([a-f0-9]{40,64})\s+(-|\d+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("Invalid Git tree entry");
      const [, mode, type, id, sizeText, path] = match;
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git")) throw new Error("Invalid snapshot path");
      // A reviewed skill bundle is added separately; repository-local executable agent config is excluded.
      const parts = path.split("/");
      const name = basename(path);
      const excluded = parts.some((p) => [".agents", ".codex", ".ssh", ".aws", ".azure"].includes(p))
        || (/^\.env(?:\.|$)/i.test(name) && !/\.(?:example|sample|template)$/i.test(name))
        || /\.(?:pem|key|p12|pfx)$/i.test(name) || /^(?:credentials|id_rsa|id_ed25519)(?:\.|$)/i.test(name);
      if (excluded || type !== "blob" || !["100644", "100755"].includes(mode!)) { excludedFiles++; continue; }
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || total + size > MAX_BYTES || entries.length >= MAX_FILES) {
        throw new ApiHttpError(413, "managed_snapshot_too_large", "The committed snapshot exceeds the reviewer file or size limit.");
      }
      entries.push({ id: id!, size, path });
      total += size;
    }
    const bytes = await gitBlobs(input.workspacePath, entries.map((e) => e.id), total + entries.length * 100);
    let offset = 0;
    for (const entry of entries) {
      const newline = bytes.indexOf(10, offset);
      if (newline < 0 || bytes.subarray(offset, newline).toString() !== `${entry.id} blob ${entry.size}`) throw new Error("Git blob changed during snapshot export");
      offset = newline + 1;
      const content = bytes.subarray(offset, offset + entry.size);
      if (content.length !== entry.size || bytes[offset + entry.size] !== 10) throw new Error("Incomplete Git blob");
      const target = join(directory, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, content, { mode: 0o644, flag: "wx" });
      offset += entry.size + 1;
    }
    let skillsFingerprint: string | null = null;
    const capabilityDirectories: string[] = [];
    if (input.skillIds.length) {
      if (!input.sharedSkillsDir) throw new Error("Shared skill catalog not configured");
      const catalog = await loadSharedSkillsCatalog(input.sharedSkillsDir);
      skillsFingerprint = catalog.fingerprint;
      // Reuse the verified manifest's finite inventory. Never recursively follow a
      // live source directory that may have been replaced since catalog validation.
      const manifestBytes = await boundedRegularFile(join(catalog.directory, "skill-catalog.json"), 4 * 1024 * 1024);
      if (createHash("sha256").update(catalog.directory).update("\0").update(manifestBytes).digest("hex") !== skillsFingerprint) {
        throw new Error("Shared skills manifest changed during snapshot preparation");
      }
      // Its bytes are identical to the manifest already schema-validated above.
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
        skills: Array<{ name: string; files: Array<{ path: string; sha256: string; bytes: number }> }>;
      };
      for (const id of input.skillIds) {
        const source = catalog.roots.find((path) => basename(path) === id);
        const inventory = manifest.skills.find((skill) => skill.name === id);
        if (!source || !inventory) throw new ApiHttpError(503, "managed_skill_unavailable", "A configured reviewer skill is absent from the approved catalog.");
        const target = join(directory, ".agents", "skills", id);
        for (const file of inventory.files) {
          const from = join(source, file.path);
          if (await realpath(dirname(from)) !== dirname(from)) throw new Error("Skill source directory changed during copy");
          const content = await boundedRegularFile(from, Math.min(file.bytes, MAX_FILE_BYTES));
          if (content.length !== file.bytes || createHash("sha256").update(content).digest("hex") !== file.sha256) {
            throw new Error("Skill content changed during copy");
          }
          const to = join(target, file.path);
          await mkdir(dirname(to), { recursive: true, mode: 0o755 });
          await writeFile(to, content, { mode: 0o644, flag: "wx" });
        }
        capabilityDirectories.push(`/workspace/.agents/skills/${id}`);
      }
      // Detect deployment updates while copying; source permissions must also exclude agent writes.
      if ((await loadSharedSkillsCatalog(input.sharedSkillsDir)).fingerprint !== skillsFingerprint) throw new Error("Shared skills changed during snapshot preparation");
    }
    const homeDirectory = join(taskRoot, "home");
    const codexHomeDirectory = join(homeDirectory, ".codex");
    await mkdir(codexHomeDirectory, { recursive: true, mode: 0o700 });
    return { directory, homeDirectory, codexHomeDirectory, sourceRevision: revision, excludedFiles, capabilityDirectories, skillsFingerprint };
  } catch (error) {
    await rm(taskRoot, { recursive: true, force: true });
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError(409, "managed_snapshot_failed", "The repository snapshot could not be prepared. Use an accessible Git repository with a committed HEAD and approved skills.");
  }
}

function gitBlobs(workspace: string, ids: string[], maxBytes: number): Promise<Buffer> {
  if (!ids.length) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", workspace, "cat-file", "--batch"], { env: gitEnv(), stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Git export timed out")); }, 30_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => { /* exit determines export outcome */ });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { child.kill("SIGKILL"); reject(new Error("Git export limit exceeded")); }
      else chunks.push(chunk);
    });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(Buffer.concat(chunks)); else reject(new Error("Git export failed")); });
    child.stdin.end(ids.join("\n") + "\n");
  });
}

async function boundedRegularFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error("Invalid skill file");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Skill file changed during copy");
    }
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function removeManagedWorkspace(runtimeDataDir: string, taskId: string): Promise<void> {
  if (!TASK_ID.test(taskId)) throw new Error("Invalid managed task identifier");
  const root = resolve(runtimeDataDir, "managed-agents");
  let info;
  try { info = await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw new ApiHttpError(503, "managed_workspace_unavailable", "Managed workspace storage must be a private directory.");
  }
  await rm(join(await realpath(root), taskId), { recursive: true, force: true });
}
