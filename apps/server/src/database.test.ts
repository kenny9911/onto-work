import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HarnessStore } from "./database.js";

test("finds a saved project by exact canonical workspace path within its tenant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-project-lookup-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const store = new HarnessStore(join(directory, "harness.db"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const firstAdmin = await store.bootstrapAdmin(
    "project-lookup-admin-one",
    "project-lookup-password-one",
  );
  const secondAdmin = { id: "project-lookup-user-two", tenantId: "project-lookup-tenant-two" };
  const createdAt = new Date().toISOString();
  store.db
    .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run(secondAdmin.tenantId, "Second tenant", "project-lookup-second", createdAt);
  store.db
    .prepare(`
      INSERT INTO users (
        id, tenant_id, username, display_name, password_hash, role, status,
        must_change_password, created_at
      ) VALUES (?, ?, ?, ?, ?, 'admin', 'active', 0, ?)
    `)
    .run(
      secondAdmin.id,
      secondAdmin.tenantId,
      "project-lookup-admin-two",
      "Second tenant admin",
      "unused",
      createdAt,
    );
  store.grantWorkspace({
    tenantId: firstAdmin.tenantId,
    rootPath: canonicalWorkspace,
    createdByUserId: firstAdmin.id,
  });
  store.grantWorkspace({
    tenantId: secondAdmin.tenantId,
    rootPath: canonicalWorkspace,
    createdByUserId: secondAdmin.id,
  });
  const firstGrant = store.findWorkspaceGrantForPath(
    firstAdmin.tenantId,
    canonicalWorkspace,
  );
  const secondGrant = store.findWorkspaceGrantForPath(
    secondAdmin.tenantId,
    canonicalWorkspace,
  );
  assert.ok(firstGrant);
  assert.ok(secondGrant);

  const firstProject = store.registerSavedProject({
    tenantId: firstAdmin.tenantId,
    name: "First tenant project",
    workspacePath: canonicalWorkspace,
    workspaceGrantId: firstGrant.id,
    createdByUserId: firstAdmin.id,
  });
  const secondProject = store.registerSavedProject({
    tenantId: secondAdmin.tenantId,
    name: "Second tenant project",
    workspacePath: canonicalWorkspace,
    workspaceGrantId: secondGrant.id,
    createdByUserId: secondAdmin.id,
  });

  assert.equal(
    store.findSavedProjectByWorkspacePath(firstAdmin.tenantId, canonicalWorkspace)?.id,
    firstProject.id,
  );
  assert.equal(
    store.findSavedProjectByWorkspacePath(secondAdmin.tenantId, canonicalWorkspace)?.id,
    secondProject.id,
  );
  assert.equal(
    store.findSavedProjectByWorkspacePath(
      firstAdmin.tenantId,
      join(canonicalWorkspace, "nested"),
    ),
    null,
  );
  assert.equal(
    store.findSavedProjectByWorkspacePath("unknown-tenant", canonicalWorkspace),
    null,
  );
});
