import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { UnconfiguredHarnessRuntime } from "../runtime.js";
import { hashPassword } from "../security.js";

interface AuditFixture {
  app: FastifyInstance;
  config: HarnessConfig;
  store: HarnessStore;
  adminId: string;
  adminTenantId: string;
  memberId: string;
  foreignTenantId: string;
  foreignUserId: string;
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

async function auditFixture(t: TestContext): Promise<AuditFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-audit-"));
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:4173",
    databasePath: join(directory, "harness.db"),
    runtimeDataDir: join(directory, "runtimes"),
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
  const store = new HarnessStore(config.databasePath);
  const admin = await store.bootstrapAdmin("audit-admin", "temporary-audit-password");
  await store.changePassword(admin.id, "durable-audit-admin-password");
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
    username: "audit-member",
    displayName: "Audit Member",
    password: "temporary-member-password",
    role: "member",
  });
  await store.changePassword(member.id, "durable-audit-member-password");

  const foreignTenantId = randomUUID();
  const foreignUserId = randomUUID();
  const timestamp = new Date().toISOString();
  const passwordHash = await hashPassword("foreign-audit-password");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db
      .prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
      .run(foreignTenantId, "Foreign", `foreign-${foreignTenantId}`, timestamp);
    store.db
      .prepare(`
        INSERT INTO users (
          id, tenant_id, username, display_name, password_hash, role, status,
          must_change_password, created_at
        ) VALUES (?, ?, ?, 'Foreign Admin', ?, 'admin', 'active', 0, ?)
      `)
      .run(foreignUserId, foreignTenantId, `foreign-${foreignUserId}`, passwordHash, timestamp);
    store.db
      .prepare(`
        INSERT INTO subscriptions (
          tenant_id, plan, status, seats, current_period_start, created_at, updated_at
        ) VALUES (?, 'free', 'none', 1, ?, ?, ?)
      `)
      .run(foreignTenantId, timestamp, timestamp, timestamp);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  store.createEntitlementSnapshot({
    tenantId: foreignTenantId,
    plan: "free",
    status: "active",
    seatLimit: 1,
    activeRunLimit: 1,
    requestLimit: 1_000,
    periodStart: timestamp,
    allowedRouteIds: ["*"],
  });

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
  });
  return {
    app,
    config,
    store,
    adminId: admin.id,
    adminTenantId: admin.tenantId,
    memberId: member.id,
    foreignTenantId,
    foreignUserId,
  };
}

test("audit API is admin-only, tenant-scoped, redacted, bounded, and cursor-paginated", async (t) => {
  const fixture = await auditFixture(t);
  const adminCookie = await login(
    fixture.app,
    fixture.config,
    "audit-admin",
    "durable-audit-admin-password",
  );
  const memberCookie = await login(
    fixture.app,
    fixture.config,
    "audit-member",
    "durable-audit-member-password",
  );

  const memberResponse = await fixture.app.inject({
    method: "GET",
    url: "/api/audit",
    headers: { cookie: memberCookie },
  });
  assert.equal(memberResponse.statusCode, 403);

  const secretCanary = "audit-secret-canary-value";
  fixture.store.audit({
    tenantId: fixture.adminTenantId,
    userId: fixture.adminId,
    action: "audit.sanitization_test",
    targetType: "test",
    metadata: {
      safe: "visible",
      apiKey: secretCanary,
      authorization: `Bearer ${secretCanary}`,
      secretSet: secretCanary,
      credentialConfigured: true,
      nested: { password: secretCanary },
      longValue: "x".repeat(2_000),
    },
  });
  for (let index = 0; index < 4; index += 1) {
    fixture.store.audit({
      tenantId: fixture.adminTenantId,
      userId: fixture.adminId,
      action: `audit.page_${index}`,
      targetType: "test",
    });
  }
  fixture.store.audit({
    tenantId: fixture.foreignTenantId,
    userId: fixture.foreignUserId,
    action: "audit.foreign_tenant_only",
    targetType: "test",
  });

  const storedMetadata = fixture.store.db
    .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'audit.sanitization_test'")
    .get() as { metadata_json: string };
  assert.doesNotMatch(storedMetadata.metadata_json, new RegExp(secretCanary));

  const invalidLimit = await fixture.app.inject({
    method: "GET",
    url: "/api/audit?limit=501",
    headers: { cookie: adminCookie },
  });
  assert.equal(invalidLimit.statusCode, 400);

  const seen = new Map<string, { action: string; metadata: Record<string, unknown> }>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const pageResponse: LightMyRequestResponse = await fixture.app.inject({
      method: "GET",
      url: `/api/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(pageResponse.statusCode, 200);
    const payload = pageResponse.json() as {
      events: Array<{ id: string; action: string; metadata: Record<string, unknown> }>;
      nextCursor: string | null;
    };
    assert.ok(payload.events.length <= 2);
    for (const event of payload.events) seen.set(event.id, event);
    cursor = payload.nextCursor;
    if (cursor === null) break;
  }
  assert.equal(cursor, null);
  assert.ok([...seen.values()].some((event) => event.action === "audit.page_0"));
  assert.ok(![...seen.values()].some((event) => event.action === "audit.foreign_tenant_only"));
  const sanitized = [...seen.values()].find(
    (event) => event.action === "audit.sanitization_test",
  );
  assert.ok(sanitized);
  assert.equal(sanitized.metadata.safe, "visible");
  assert.equal(sanitized.metadata.apiKey, "[REDACTED]");
  assert.equal(sanitized.metadata.authorization, "[REDACTED]");
  assert.equal(sanitized.metadata.secretSet, "[REDACTED]");
  assert.equal(sanitized.metadata.credentialConfigured, true);
  assert.equal(sanitized.metadata.nested, undefined);
  assert.equal(String(sanitized.metadata.longValue).length, 1_024);

  const foreignCursor = fixture.store.db
    .prepare("SELECT id FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(fixture.foreignTenantId) as { id: string };
  const isolatedCursor = await fixture.app.inject({
    method: "GET",
    url: `/api/audit?limit=2&cursor=${foreignCursor.id}`,
    headers: { cookie: adminCookie },
  });
  assert.equal(isolatedCursor.statusCode, 200);
  assert.deepEqual(isolatedCursor.json(), { events: [], nextCursor: null });
});

test("usage and audit store methods reject cross-tenant references and invalid token totals", async (t) => {
  const fixture = await auditFixture(t);
  const providerA = fixture.store.saveProvider({
    tenantId: fixture.adminTenantId,
    catalogId: "openai",
    name: "Tenant A route",
    adapter: "responses",
    baseUrl: "https://api.openai.test/v1",
    defaultModel: "server/model-a",
    enabled: true,
    isDefault: true,
  });
  const providerB = fixture.store.saveProvider({
    tenantId: fixture.foreignTenantId,
    catalogId: "openai",
    name: "Tenant B route",
    adapter: "responses",
    baseUrl: "https://api.openai.test/v1",
    defaultModel: "server/model-b",
    enabled: true,
    isDefault: true,
  });

  assert.throws(
    () =>
      fixture.store.audit({
        tenantId: fixture.adminTenantId,
        userId: fixture.foreignUserId,
        action: "audit.cross_tenant_actor",
        targetType: "test",
      }),
    /does not belong to the supplied tenant/i,
  );

  const timestamp = new Date().toISOString();
  const reservationInput = {
    tenantId: fixture.adminTenantId,
    userId: fixture.adminId,
    providerConnectionId: providerA.id,
    routeCatalogId: "openai",
    model: "server/model-a",
    operation: "thread_start" as const,
    idempotencyKey: randomUUID(),
    requestHash: "a".repeat(64),
    createdAt: timestamp,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.throws(
    () =>
      fixture.store.createUsageReservation({
        ...reservationInput,
        userId: fixture.foreignUserId,
      }),
    /references must belong to the supplied tenant/i,
  );
  assert.throws(
    () =>
      fixture.store.createUsageReservation({
        ...reservationInput,
        providerConnectionId: providerB.id,
      }),
    /references must belong to the supplied tenant/i,
  );

  const reservationA = fixture.store.createUsageReservation(reservationInput);
  assert.throws(
    () =>
      fixture.store.completeUsageReservation({
        reservationId: reservationA.id,
        tenantId: fixture.adminTenantId,
        eventKey: "invalid-token-count",
        eventType: "turn_completed",
        inputTokens: -1,
      }),
    /non-negative safe integers/i,
  );
  assert.equal(fixture.store.getUsageReservation(reservationA.id)?.status, "reserved");
  fixture.store.completeUsageReservation({
    reservationId: reservationA.id,
    tenantId: fixture.adminTenantId,
    eventKey: "valid-token-count",
    eventType: "thread_started",
    inputTokens: 7,
    outputTokens: 3,
  });

  const reservationB = fixture.store.createUsageReservation({
    ...reservationInput,
    tenantId: fixture.foreignTenantId,
    userId: fixture.foreignUserId,
    providerConnectionId: providerB.id,
    model: "server/model-b",
    idempotencyKey: randomUUID(),
    requestHash: "b".repeat(64),
  });
  fixture.store.completeUsageReservation({
    reservationId: reservationB.id,
    tenantId: fixture.foreignTenantId,
    eventKey: "foreign-token-count",
    eventType: "thread_started",
    inputTokens: 70,
    outputTokens: 30,
  });

  const tenantAUsage = fixture.store.getUsageSummary(fixture.adminTenantId);
  const tenantBUsage = fixture.store.getUsageSummary(fixture.foreignTenantId);
  assert.deepEqual(
    { input: tenantAUsage.inputTokens, output: tenantAUsage.outputTokens },
    { input: 7, output: 3 },
  );
  assert.deepEqual(
    { input: tenantBUsage.inputTokens, output: tenantBUsage.outputTokens },
    { input: 70, output: 30 },
  );
});
