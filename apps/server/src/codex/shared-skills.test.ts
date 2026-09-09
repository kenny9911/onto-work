import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSharedSkillsCatalog, SharedSkillsCatalogError } from "./shared-skills.js";

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "shared-skills-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "skills", "openai-example");
  await mkdir(join(root, "references"), { recursive: true });
  const files = [
    { path: "SKILL.md", content: "---\nname: example\ndescription: Example skill\n---\nRead references/example.md.\n" },
    { path: "references/example.md", content: "Example reference\n" },
  ];
  for (const file of files) await writeFile(join(root, file.path), file.content);
  const manifest = {
    schemaVersion: 1,
    skills: [{
      name: "openai-example", sourceId: "openai", sourceUrl: "https://github.com/openai/skills",
      revision: "a".repeat(40), license: "Apache-2.0",
      files: files.map((file) => ({
        path: file.path, sha256: createHash("sha256").update(file.content).digest("hex"), bytes: Buffer.byteLength(file.content),
      })),
    }],
  };
  const save = () => writeFile(join(directory, "skill-catalog.json"), JSON.stringify(manifest));
  await save();
  return { directory, root, manifest, save };
}

test("validates a complete catalog without modifying its original bundles", async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, "SKILL.md"));
  const first = await loadSharedSkillsCatalog(f.directory);
  const second = await loadSharedSkillsCatalog(f.directory);
  assert.deepEqual(first.roots, [f.root]);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(await readFile(join(f.root, "SKILL.md")), before);
});

test("refuses modified, missing, and unlisted bundle files", async (t) => {
  for (const action of ["modified", "missing", "unlisted"] as const) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      if (action === "modified") await writeFile(join(f.root, "references/example.md"), "Tampered reference\n");
      if (action === "missing") await rm(join(f.root, "references/example.md"));
      if (action === "unlisted") await writeFile(join(f.root, "unapproved.sh"), "echo unexpected");
      await assert.rejects(loadSharedSkillsCatalog(f.directory), SharedSkillsCatalogError);
    });
  }
});

test("refuses symbolic links and hard links inside a catalog", async (t) => {
  for (const target of ["directory", "file", "hardlink", "manifest"] as const) {
    await t.test(target, async (t) => {
      const f = await fixture(t);
      const outside = join(f.directory, "outside");
      await mkdir(outside);
      if (target === "directory") {
        await rm(join(f.root, "references"), { recursive: true });
        await symlink(outside, join(f.root, "references"));
      } else if (target === "manifest") {
        await link(join(f.directory, "skill-catalog.json"), join(outside, "manifest.json"));
      } else {
        const skillPath = join(f.root, "SKILL.md");
        if (target === "hardlink") await link(skillPath, join(outside, "SKILL.md"));
        else {
          const content = await readFile(skillPath);
          await writeFile(join(outside, "SKILL.md"), content);
          await rm(skillPath);
          await symlink(join(outside, "SKILL.md"), skillPath);
        }
      }
      await assert.rejects(loadSharedSkillsCatalog(f.directory), SharedSkillsCatalogError);
    });
  }
});

test("rejects unsafe manifest paths, mutable revisions, duplicates, and excess sizes", async (t) => {
  for (const mutation of ["traversal", "absolute", "revision", "duplicate", "bytes", "empty"] as const) {
    await t.test(mutation, async (t) => {
      const f = await fixture(t);
      const skill = f.manifest.skills[0]!;
      if (mutation === "traversal") skill.files[0]!.path = "../SKILL.md";
      if (mutation === "absolute") skill.files[0]!.path = "/SKILL.md";
      if (mutation === "revision") skill.revision = "main";
      if (mutation === "duplicate") skill.files.push({ ...skill.files[0]! });
      if (mutation === "bytes") skill.files[0]!.bytes = 100_000_000;
      if (mutation === "empty") f.manifest.skills = [];
      await f.save();
      await assert.rejects(loadSharedSkillsCatalog(f.directory), SharedSkillsCatalogError);
    });
  }
});

test("rejects unlisted sibling skills rather than scanning them into the runtime", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "skills", "unapproved"));
  await assert.rejects(loadSharedSkillsCatalog(f.directory), /unlisted bundle/);
});
