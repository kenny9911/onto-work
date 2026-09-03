import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { RunAdmissionPolicy } from "../admission.js";
import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { UnconfiguredHarnessRuntime } from "../runtime.js";

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

function responseCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  assert.ok(setCookie);
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

test("protects control-plane mutations and never returns provider credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-http-"));
  const config = testConfig(directory);
  const store = new HarnessStore(config.databasePath);
  const bootstrapUser = await store.bootstrapAdmin("test-admin", "temporary-test-password");
  const bootstrapEntitlement = store.getLatestEntitlementSnapshot(bootstrapUser.tenantId)!;
  store.createEntitlementSnapshot({
    tenantId: bootstrapUser.tenantId,
    plan: bootstrapEntitlement.plan,
    status: bootstrapEntitlement.status,
    seatLimit: 2,
    activeRunLimit: bootstrapEntitlement.activeRunLimit,
    requestLimit: bootstrapEntitlement.requestLimit,
    periodStart: bootstrapEntitlement.periodStart,
    periodEnd: bootstrapEntitlement.periodEnd,
    allowedRouteIds: bootstrapEntitlement.allowedRouteIds,
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
    await rm(`${directory}-uploads`, { recursive: true, force: true });
  });

  const rejectedOrigin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "test-admin", password: "temporary-test-password" },
  });
  assert.equal(rejectedOrigin.statusCode, 403);
  assert.equal(rejectedOrigin.json().error, "invalid_origin");

  const localhostLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "http://localhost:4173" },
    payload: { username: "test-admin", password: "temporary-test-password" },
  });
  assert.equal(localhostLogin.statusCode, 200);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username: "test-admin", password: "temporary-test-password" },
  });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers["set-cookie"] as string, /HttpOnly/i);
  const temporaryCookie = responseCookie(login);

  const blockedDashboard = await app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: { cookie: temporaryCookie },
  });
  assert.equal(blockedDashboard.statusCode, 403);
  assert.equal(blockedDashboard.json().error, "password_change_required");

  const passwordChange = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { cookie: temporaryCookie, origin: config.webOrigin },
    payload: {
      currentPassword: "temporary-test-password",
      newPassword: "different-long-test-password",
    },
  });
  assert.equal(passwordChange.statusCode, 200);
  const authenticatedCookie = responseCookie(passwordChange);

  const createUser = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: authenticatedCookie, origin: config.webOrigin },
    payload: {
      username: "member-one",
      displayName: "Member One",
      password: "member-temporary-password",
      role: "member",
    },
  });
  assert.equal(createUser.statusCode, 201);
  assert.equal(createUser.json().user.tenantId, passwordChange.json().user.tenantId);

  const memberId = createUser.json().user.id as string;
  const suspended = await app.inject({
    method: "PATCH",
    url: `/api/users/${memberId}/status`,
    headers: { cookie: authenticatedCookie, origin: config.webOrigin },
    payload: { status: "suspended" },
  });
  assert.equal(suspended.statusCode, 200);
  const currentEntitlement = store.getLatestEntitlementSnapshot(bootstrapUser.tenantId)!;
  store.createEntitlementSnapshot({
    tenantId: bootstrapUser.tenantId,
    plan: currentEntitlement.plan,
    status: currentEntitlement.status,
    seatLimit: 1,
    activeRunLimit: currentEntitlement.activeRunLimit,
    requestLimit: currentEntitlement.requestLimit,
    periodStart: currentEntitlement.periodStart,
    periodEnd: currentEntitlement.periodEnd,
    allowedRouteIds: currentEntitlement.allowedRouteIds,
  });
  const blockedReactivation = await app.inject({
    method: "PATCH",
    url: `/api/users/${memberId}/status`,
    headers: { cookie: authenticatedCookie, origin: config.webOrigin },
    payload: { status: "active" },
  });
  assert.equal(blockedReactivation.statusCode, 409);
  assert.equal(blockedReactivation.json().error, "seat_limit_reached");

  const providerSecret = "test-provider-secret-canary";
  const createProvider = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: { cookie: authenticatedCookie, origin: config.webOrigin },
    payload: {
      catalogId: "openai",
      name: "Test OpenAI",
      credential: providerSecret,
      enabled: true,
      isDefault: true,
    },
  });
  assert.equal(createProvider.statusCode, 201);
  assert.equal(createProvider.json().provider.hasCredential, true);
  assert.doesNotMatch(createProvider.body, new RegExp(providerSecret));

  const providers = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(providers.statusCode, 200);
  assert.doesNotMatch(providers.body, new RegExp(providerSecret));
  const storedProvider = store.getProviderRow(
    passwordChange.json().user.tenantId,
    createProvider.json().provider.id,
  );
  assert.ok(storedProvider?.credential_ciphertext);
  assert.notEqual(storedProvider.credential_ciphertext, providerSecret);

  const audit = await app.inject({
    method: "GET",
    url: "/api/audit?limit=50",
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(audit.statusCode, 200);
  assert.ok(
    audit.json().events.some((event: { action: string }) => event.action === "provider.created"),
  );
  assert.doesNotMatch(audit.body, new RegExp(providerSecret));
});

test("single-host startup fails orphaned reserved leases closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-restart-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-uploads`, { recursive: true, force: true });
  });
  const config = testConfig(directory);
  const seedStore = new HarnessStore(config.databasePath);
  const user = await seedStore.bootstrapAdmin("restart-admin", "restart-test-password");
  const workspace = await realpath(directory);
  seedStore.grantWorkspace({
    tenantId: user.tenantId,
    rootPath: workspace,
    createdByUserId: user.id,
  });
  seedStore.saveProvider({
    tenantId: user.tenantId,
    catalogId: "openai",
    name: "Restart route",
    adapter: "responses",
    baseUrl: "https://api.openai.test/v1",
    defaultModel: "server/model",
    enabled: true,
    isDefault: true,
  });
  const admitted = new RunAdmissionPolicy(seedStore).admit({
    tenantId: user.tenantId,
    userId: user.id,
    operation: "thread_start",
    workspacePath: workspace,
    idempotencyKey: "orphaned-before-restart",
    requestPayload: { method: "thread/start" },
  });
  seedStore.close();

  const app = await buildApp({
    config,
    runtime: new UnconfiguredHarnessRuntime(),
    logger: false,
  });
  await app.close();

  const checkStore = new HarnessStore(config.databasePath);
  const reservation = checkStore.getUsageReservation(admitted.reservationId);
  assert.deepEqual(
    reservation ? { status: reservation.status, errorCode: reservation.errorCode } : null,
    { status: "failed", errorCode: "server_restarted" },
  );
  checkStore.close();
});
