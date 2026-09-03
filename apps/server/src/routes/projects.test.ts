import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { UnconfiguredHarnessRuntime } from "../runtime.js";
import { hashPassword } from "../security.js";

const execFileAsync = promisify(execFile);

interface ProjectFixture {
  app: FastifyInstance;
  config: HarnessConfig;
  store: HarnessStore;
  adminCookie: string;
  memberCookie: string;
  adminId: string;
  tenantId: string;
  workspace: string;
  workspaceLink: string;
  ungrantedWorkspace: string;
  outsideWorkspace: string;
}

function responseCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  assert.ok(setCookie);
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function login(
  app: FastifyInstance,
  config: HarnessConfig,
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username, password },
  });
  assert.equal(response.statusCode, 200);
  return responseCookie(response);
}

function mutationHeaders(
  config: HarnessConfig,
  cookie: string,
): Record<string, string> {
  return { cookie, origin: config.webOrigin };
}

async function initializeGitWorkspace(path: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", path], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 5_000,
  });
  await execFileAsync("git", ["-C", path, "config", "user.email", "tests@example.test"]);
  await execFileAsync("git", ["-C", path, "config", "user.name", "Project Tests"]);
  await writeFile(join(path, "README.md"), "# Saved project\n", "utf8");
  await execFileAsync("git", ["-C", path, "add", "README.md"]);
  await execFileAsync("git", ["-C", path, "commit", "-m", "Initial commit"], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 5_000,
  });
  await execFileAsync("git", [
    "-C",
    path,
    "remote",
    "add",
    "origin",
    "https://remote-user:remote-secret@example.test/org/repository.git?access_token=canary",
  ]);
}

async function projectFixture(t: TestContext): Promise<ProjectFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-projects-"));
  const allowedRoot = join(directory, "allowed");
  const workspace = join(allowedRoot, "workspace");
  const ungrantedWorkspace = join(allowedRoot, "ungranted");
  const workspaceLink = join(allowedRoot, "workspace-link");
  const outsideWorkspace = join(directory, "outside");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(ungrantedWorkspace, { recursive: true }),
    mkdir(outsideWorkspace, { recursive: true }),
  ]);
  await symlink(workspace, workspaceLink, "dir");
  await initializeGitWorkspace(workspace);

  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(directory, "harness.db"),
    runtimeDataDir: join(directory, "runtimes"),
    uploadDataDir: join(directory, "uploads"),
    sessionTtlMs: 60 * 60 * 1_000,
    sessionSecret: "test-session-secret-that-is-long-enough",
    credentialEncryptionKey: "test-credential-key-that-is-long-enough",
    codexBinary: "codex",
    codexExperimentalApi: false,
    allowedWorkspaceRoots: [allowedRoot],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "https://gateway.operator.example/v1",
    litellmMasterKey: null,
    allowPrivateProviderEndpoints: false,
  };
  const store = new HarnessStore(config.databasePath);
  const admin = await store.bootstrapAdmin("project-admin", "temporary-project-password");
  await store.changePassword(admin.id, "durable-project-admin-password");
  const currentEntitlement = store.getLatestEntitlementSnapshot(admin.tenantId)!;
  store.createEntitlementSnapshot({
    tenantId: admin.tenantId,
    plan: currentEntitlement.plan,
    status: currentEntitlement.status,
    seatLimit: 2,
    activeRunLimit: currentEntitlement.activeRunLimit,
    requestLimit: currentEntitlement.requestLimit,
    periodStart: currentEntitlement.periodStart,
    periodEnd: currentEntitlement.periodEnd,
    allowedRouteIds: currentEntitlement.allowedRouteIds,
  });
  const member = await store.createUser({
    tenantId: admin.tenantId,
    username: "project-member",
    displayName: "Project Member",
    password: "temporary-project-member-password",
    role: "member",
  });
  await store.changePassword(member.id, "durable-project-member-password");

  const app = await buildApp({
    config,
    store,
    runtime: new UnconfiguredHarnessRuntime(),
    logger: false,
  });
  // Development bootstrap grants the configured root. Replace that broad grant
  // with the exact fixture workspace so the authorization boundary is exercised.
  store.db.prepare("DELETE FROM workspace_grants WHERE tenant_id = ?").run(admin.tenantId);
  store.grantWorkspace({
    tenantId: admin.tenantId,
    rootPath: await realpath(workspace),
    createdByUserId: admin.id,
  });

  const adminCookie = await login(
    app,
    config,
    "project-admin",
    "durable-project-admin-password",
  );
  const memberCookie = await login(
    app,
    config,
    "project-member",
    "durable-project-member-password",
  );
  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    app,
    config,
    store,
    adminCookie,
    memberCookie,
    adminId: admin.id,
    tenantId: admin.tenantId,
    workspace,
    workspaceLink,
    ungrantedWorkspace,
    outsideWorkspace,
  };
}

async function registerProject(
  fixture: ProjectFixture,
  workspacePath = fixture.workspaceLink,
  name = "Harness repository",
): Promise<LightMyRequestResponse> {
  return fixture.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: mutationHeaders(fixture.config, fixture.adminCookie),
    payload: { name, workspacePath },
  });
}

test("registers, lists, and reads a canonical Git workspace without returning credentials", async (t) => {
  const fixture = await projectFixture(t);

  const unauthenticated = await fixture.app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(unauthenticated.statusCode, 401);

  const response = await registerProject(fixture);
  assert.equal(response.statusCode, 201);
  const created = response.json().project as Record<string, unknown>;
  assert.equal(created.name, "Harness repository");
  assert.equal(created.path, await realpath(fixture.workspace));
  assert.equal(created.enabled, true);
  assert.equal(created.availability, "available");
  assert.equal(created.repositoryStatus, "repository");
  assert.equal(created.isGitRepository, true);
  assert.equal(created.branch, "main");
  assert.equal(created.dirty, false);
  assert.match(String(created.headCommit), /^[0-9a-f]{40,64}$/);
  assert.equal(created.remoteUrl, "https://example.test/org/repository.git");
  assert.doesNotMatch(response.body, /remote-user|remote-secret|access_token|canary/);

  const projectId = String(created.id);
  const detail = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${projectId}`,
    headers: { cookie: fixture.memberCookie },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().project.id, projectId);

  const list = await fixture.app.inject({
    method: "GET",
    url: "/api/projects?limit=10",
    headers: { cookie: fixture.memberCookie },
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().projects.map((project: { id: string }) => project.id),
    [projectId],
  );
  assert.equal(list.json().nextCursor, null);

  const storedAudit = fixture.store.db
    .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'project.registered'")
    .get() as { metadata_json: string };
  const auditMetadata = JSON.parse(storedAudit.metadata_json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(auditMetadata).sort(), ["kind", "workspaceId"]);
  assert.doesNotMatch(storedAudit.metadata_json, /remote-secret|access_token|canary/);
});

test("project mutations are admin-only and rename or disable without changing the workspace", async (t) => {
  const fixture = await projectFixture(t);
  const memberCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: mutationHeaders(fixture.config, fixture.memberCookie),
    payload: { name: "Denied", workspacePath: fixture.workspace },
  });
  assert.equal(memberCreate.statusCode, 403);

  const created = await registerProject(fixture);
  assert.equal(created.statusCode, 201);
  const projectId = created.json().project.id as string;
  const originalPath = created.json().project.path as string;

  const memberPatch = await fixture.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: mutationHeaders(fixture.config, fixture.memberCookie),
    payload: { enabled: false },
  });
  assert.equal(memberPatch.statusCode, 403);

  const updated = await fixture.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: mutationHeaders(fixture.config, fixture.adminCookie),
    payload: { name: "Renamed repository", enabled: false },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().project.name, "Renamed repository");
  assert.equal(updated.json().project.enabled, false);
  assert.equal(updated.json().project.path, originalPath);

  const invalidUpdate = await fixture.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: mutationHeaders(fixture.config, fixture.adminCookie),
    payload: { workspacePath: fixture.ungrantedWorkspace },
  });
  assert.equal(invalidUpdate.statusCode, 400);
});

test("registration requires both a configured root and an active tenant workspace grant", async (t) => {
  const fixture = await projectFixture(t);

  const ungranted = await registerProject(
    fixture,
    fixture.ungrantedWorkspace,
    "Ungranted workspace",
  );
  assert.equal(ungranted.statusCode, 403);
  assert.equal(ungranted.json().error, "workspace_not_granted");

  fixture.store.grantWorkspace({
    tenantId: fixture.tenantId,
    rootPath: await realpath(fixture.outsideWorkspace),
    createdByUserId: fixture.adminId,
  });
  const outside = await registerProject(
    fixture,
    fixture.outsideWorkspace,
    "Outside workspace",
  );
  assert.equal(outside.statusCode, 400);
  assert.equal(outside.json().error, "workspace_not_allowed");

  const relative = await registerProject(fixture, "relative/workspace", "Relative workspace");
  assert.equal(relative.statusCode, 400);
  assert.equal(relative.json().error, "workspace_not_allowed");
});

test("revoking a backing grant fails closed and an explicit re-enable rebinds a new grant", async (t) => {
  const fixture = await projectFixture(t);
  const created = await registerProject(fixture);
  assert.equal(created.statusCode, 201);
  const projectId = created.json().project.id as string;

  const disabled = await fixture.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: mutationHeaders(fixture.config, fixture.adminCookie),
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);

  fixture.store.db
    .prepare("DELETE FROM workspace_grants WHERE tenant_id = ?")
    .run(fixture.tenantId);
  const revoked = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${projectId}`,
    headers: { cookie: fixture.memberCookie },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().project.availability, "workspace_grant_revoked");
  assert.equal(revoked.json().project.repositoryStatus, "unavailable");
  assert.equal(revoked.json().project.remoteUrl, null);

  const blockedEnable = await fixture.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: mutationHeaders(fixture.config, fixture.adminCookie),
    payload: { enabled: true },
  });
  assert.equal(blockedEnable.statusCode, 403);
  assert.equal(blockedEnable.json().error, "workspace_not_granted");

  fixture.store.grantWorkspace({
    tenantId: fixture.tenantId,
    rootPath: await realpath(fixture.workspace),
    createdByUserId: fixture.adminId,
  });
  const enabled = await fixture.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: mutationHeaders(fixture.config, fixture.adminCookie),
    payload: { enabled: true },
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().project.enabled, true);
  assert.equal(enabled.json().project.availability, "available");
});

test("project reads and writes stay within the authenticated tenant", async (t) => {
  const fixture = await projectFixture(t);
  const foreignTenantId = randomUUID();
  const foreignUserId = randomUUID();
  const foreignGrantId = randomUUID();
  const timestamp = new Date().toISOString();
  const foreignPasswordHash = await hashPassword("foreign-project-password");
  fixture.store.db.exec("BEGIN IMMEDIATE");
  try {
    fixture.store.db
      .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
      .run(foreignTenantId, "Foreign tenant", `foreign-${foreignTenantId}`, timestamp);
    fixture.store.db
      .prepare(`
        INSERT INTO users (
          id, tenant_id, username, display_name, password_hash, role, status,
          must_change_password, created_at
        ) VALUES (?, ?, ?, 'Foreign Admin', ?, 'admin', 'active', 0, ?)
      `)
      .run(
        foreignUserId,
        foreignTenantId,
        `foreign-${foreignUserId}`,
        foreignPasswordHash,
        timestamp,
      );
    fixture.store.db
      .prepare(`
        INSERT INTO workspace_grants (id, tenant_id, root_path, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        foreignGrantId,
        foreignTenantId,
        await realpath(fixture.ungrantedWorkspace),
        foreignUserId,
        timestamp,
      );
    fixture.store.db.exec("COMMIT");
  } catch (error) {
    fixture.store.db.exec("ROLLBACK");
    throw error;
  }
  const foreign = fixture.store.registerSavedProject({
    tenantId: foreignTenantId,
    name: "Foreign project",
    workspacePath: await realpath(fixture.ungrantedWorkspace),
    workspaceGrantId: foreignGrantId,
    createdByUserId: foreignUserId,
  });

  const hidden = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${foreign.id}`,
    headers: { cookie: fixture.adminCookie },
  });
  assert.equal(hidden.statusCode, 404);

  const list = await fixture.app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { cookie: fixture.adminCookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().projects.length, 0);

  assert.throws(
    () =>
      fixture.store.registerSavedProject({
        tenantId: fixture.tenantId,
        name: "Cross-tenant grant",
        workspacePath: "/not/covered/by/the/foreign/grant",
        workspaceGrantId: foreignGrantId,
        createdByUserId: fixture.adminId,
      }),
    /supplied tenant grant/,
  );
});

test("project listing is bounded and cursor-paginated", async (t) => {
  const fixture = await projectFixture(t);
  const firstWorkspace = join(fixture.workspace, "first-project");
  const secondWorkspace = join(fixture.workspace, "second-project");
  await Promise.all([
    mkdir(firstWorkspace, { recursive: true }),
    mkdir(secondWorkspace, { recursive: true }),
  ]);
  assert.equal((await registerProject(fixture, firstWorkspace, "First project")).statusCode, 201);
  assert.equal((await registerProject(fixture, secondWorkspace, "Second project")).statusCode, 201);

  const firstPage = await fixture.app.inject({
    method: "GET",
    url: "/api/projects?limit=1",
    headers: { cookie: fixture.memberCookie },
  });
  assert.equal(firstPage.statusCode, 200);
  assert.equal(firstPage.json().projects.length, 1);
  assert.match(firstPage.json().nextCursor, /^[0-9a-f-]{36}$/);

  const secondPage = await fixture.app.inject({
    method: "GET",
    url: `/api/projects?limit=1&cursor=${firstPage.json().nextCursor}`,
    headers: { cookie: fixture.memberCookie },
  });
  assert.equal(secondPage.statusCode, 200);
  assert.equal(secondPage.json().projects.length, 1);
  assert.notEqual(secondPage.json().projects[0].id, firstPage.json().projects[0].id);
  assert.equal(secondPage.json().nextCursor, null);
});
