import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SKILLS = 256;
const MAX_FILES = 16_384;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 16;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface SharedSkillsCatalog {
  directory: string;
  roots: string[];
  fingerprint: string;
}

export class SharedSkillsCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Shared skills catalog: ${message}`, options);
    this.name = "SharedSkillsCatalogError";
  }
}

function invalid(message: string): never {
  throw new SharedSkillsCatalogError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("expected an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0-\x1f]/.test(value)) {
    return invalid("invalid text metadata");
  }
  return value;
}

function filePath(value: unknown): string {
  const path = string(value, 1_024);
  const parts = path.split("/");
  if (isAbsolute(path) || path.includes("\\") || parts.length > MAX_DEPTH ||
      parts.some((part) => part === "" || part === "." || part === "..")) {
    return invalid("file paths must remain inside their skill directory");
  }
  return path;
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    invalid("directories must be real directories without symbolic links");
  }
}

async function readRegularFile(path: string, maximum: number): Promise<Buffer> {
  // Non-blocking also prevents a replaced catalog FIFO from hanging startup.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) {
      return invalid("files must be bounded regular files without hard links");
    }
    // Read at most the observed size plus one byte, even if another process is
    // concurrently growing the file. readFile() would allocate without this cap.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    if (bytes.length > maximum || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return invalid("file changed during validation");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Validate operator-owned bundles before they enter any per-user Codex runtime.
 * This is integrity checking, not an OS sandbox: deployment permissions must
 * prevent agents from editing the shared source while it is mounted.
 */
export async function loadSharedSkillsCatalog(configuredDirectory: string): Promise<SharedSkillsCatalog> {
  try {
    const configuredPath = resolve(configuredDirectory);
    if ((await lstat(configuredPath)).isSymbolicLink()) invalid("shared directory cannot be a symbolic link");
    const sharedDirectory = await realpath(configuredPath);
    await directory(sharedDirectory);
    const manifestBytes = await readRegularFile(join(sharedDirectory, "skill-catalog.json"), MAX_MANIFEST_BYTES);
    const manifest = record(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills) ||
        manifest.skills.length === 0 || manifest.skills.length > MAX_SKILLS) {
      return invalid("unsupported schema or invalid skill count");
    }
    const skillsDirectory = join(sharedDirectory, "skills");
    await directory(skillsDirectory);
    const names = new Set<string>();
    const roots: string[] = [];
    let fileCount = 0;
    let directoryCount = 0;
    let totalBytes = 0;
    for (const value of manifest.skills) {
      const skill = record(value);
      const name = string(skill.name, 128);
      if (!NAME.test(name) || names.has(name)) invalid("invalid or duplicate skill name");
      names.add(name);
      string(skill.sourceId, 256);
      string(skill.license, 256);
      const revision = string(skill.revision, 64);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) invalid("source revisions must be immutable commit hashes");
      const source = new URL(string(skill.sourceUrl, 2_048));
      if (source.protocol !== "https:" || source.username || source.password) invalid("source URL must use HTTPS without credentials");
      if (!Array.isArray(skill.files) || skill.files.length === 0 || skill.files.length > MAX_FILES) {
        return invalid("invalid file inventory");
      }
      const expected = new Map<string, { sha256: string; bytes: number }>();
      for (const entry of skill.files) {
        const file = record(entry);
        const path = filePath(file.path);
        const sha256 = string(file.sha256, 64);
        if (expected.has(path) || !DIGEST.test(sha256) || !Number.isSafeInteger(file.bytes) ||
            typeof file.bytes !== "number" || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) {
          return invalid("invalid or duplicate file inventory entry");
        }
        expected.set(path, { sha256, bytes: file.bytes });
        fileCount += 1;
        totalBytes += file.bytes;
        if (fileCount > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) invalid("catalog exceeds size limits");
      }
      if (!expected.has("SKILL.md")) invalid("each bundle must include SKILL.md");
      const skillDirectory = join(skillsDirectory, name);
      const seen = new Set<string>();
      async function walk(path: string, prefix: string, depth: number): Promise<void> {
        if (depth > MAX_DEPTH || ++directoryCount > MAX_FILES) invalid("bundle directory limits exceeded");
        await directory(path);
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const target = join(path, entry.name);
          if (entry.isSymbolicLink()) invalid("symbolic links are not allowed in skill bundles");
          if (entry.isDirectory()) {
            await walk(target, relativePath, depth + 1);
            continue;
          }
          const approved = expected.get(relativePath);
          if (!entry.isFile() || !approved) invalid("bundle contains an unlisted file");
          const bytes = await readRegularFile(target, approved.bytes);
          if (bytes.length !== approved.bytes || createHash("sha256").update(bytes).digest("hex") !== approved.sha256) {
            return invalid(`integrity check failed for ${name}/${relativePath}`);
          }
          seen.add(relativePath);
        }
      }
      await walk(skillDirectory, "", 0);
      if (seen.size !== expected.size) invalid("bundle is missing a listed file");
      roots.push(skillDirectory);
    }
    const actualNames = await readdir(skillsDirectory);
    if (actualNames.length !== names.size || actualNames.some((name) => !names.has(name))) {
      return invalid("skills directory contains an unlisted bundle");
    }
    return {
      directory: sharedDirectory,
      roots,
      fingerprint: createHash("sha256").update(sharedDirectory).update("\0").update(manifestBytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof SharedSkillsCatalogError) throw error;
    throw new SharedSkillsCatalogError("could not validate configured catalog", { cause: error });
  }
}
