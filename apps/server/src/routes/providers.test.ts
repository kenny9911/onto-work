import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import { UnconfiguredHarnessRuntime } from "../runtime.js";

function responseCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  assert.ok(setCookie);
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function providerTestContext(
  t: TestContext,
  overrides: Partial<HarnessConfig> = {},
): Promise<{ app: FastifyInstance; config: HarnessConfig; cookie: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-providers-"));
  const config: HarnessConfig = {
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
    litellmBaseUrl: "https://gateway.operator.example/v1",
    litellmMasterKey: null,
    allowPrivateProviderEndpoints: false,
    ...overrides,
  };
  const store = new HarnessStore(config.databasePath);
  await store.bootstrapAdmin("provider-admin", "temporary-test-password");
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

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username: "provider-admin", password: "temporary-test-password" },
  });
  assert.equal(login.statusCode, 200);
  const passwordChange = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { cookie: responseCookie(login), origin: config.webOrigin },
    payload: {
      currentPassword: "temporary-test-password",
      newPassword: "different-long-test-password",
    },
  });
  assert.equal(passwordChange.statusCode, 200);
  return { app, config, cookie: responseCookie(passwordChange) };
}

function mutationHeaders(config: HarnessConfig, cookie: string): Record<string, string> {
  return { cookie, origin: config.webOrigin };
}

test("blocks private, metadata, and downgraded remote provider URLs on create", async (t) => {
  const { app, config, cookie } = await providerTestContext(t);
  const blocked = [
    { baseUrl: "https://169.254.169.254/latest", error: "invalid_provider_url" },
    { baseUrl: "https://0.0.0.0/v1", error: "invalid_provider_url" },
    { baseUrl: "https://224.0.0.1/v1", error: "invalid_provider_url" },
    { baseUrl: "https://[fe80::1]/v1", error: "invalid_provider_url" },
    { baseUrl: "https://192.168.1.40/v1", error: "private_provider_url_disabled" },
    { baseUrl: "https://2130706433/v1", error: "private_provider_url_disabled" },
    { baseUrl: "https://[::1]/v1", error: "private_provider_url_disabled" },
    { baseUrl: "https://[::ffff:127.0.0.1]/v1", error: "private_provider_url_disabled" },
    { baseUrl: "https://[fc00::1]/v1", error: "private_provider_url_disabled" },
    { baseUrl: "http://router.example.com/v1", error: "invalid_provider_url" },
    { baseUrl: "https://user:pass@router.example.com/v1", error: "invalid_provider_url" },
    { baseUrl: "https://router.example.com/v1?redirect=local", error: "invalid_provider_url" },
    { baseUrl: "https://router.example.com/v1#fragment", error: "invalid_provider_url" },
  ];

  for (const [index, candidate] of blocked.entries()) {
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: mutationHeaders(config, cookie),
      payload: {
        catalogId: "newapi",
        name: `Blocked route ${index}`,
        baseUrl: candidate.baseUrl,
        credential: "tenant-scoped-test-token",
        enabled: true,
      },
    });
    assert.equal(response.statusCode, 400, candidate.baseUrl);
    assert.equal(response.json().error, candidate.error, candidate.baseUrl);
  }
});

test("reapplies endpoint policy when a provider URL is updated", async (t) => {
  const { app, config, cookie } = await providerTestContext(t);
  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: mutationHeaders(config, cookie),
    payload: {
      catalogId: "openai",
      name: "Public OpenAI",
      credential: "test-openai-token",
      enabled: true,
    },
  });
  assert.equal(created.statusCode, 201);
  const providerId = created.json().provider.id as string;

  for (const baseUrl of ["http://api.example.com/v1", "https://10.0.0.8/v1", "https://metadata.google.internal/v1"]) {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/providers/${providerId}`,
      headers: mutationHeaders(config, cookie),
      payload: { baseUrl },
    });
    assert.equal(response.statusCode, 400, baseUrl);
  }

  const unchanged = await app.inject({
    method: "GET",
    url: `/api/providers/${providerId}`,
    headers: { cookie },
  });
  assert.equal(unchanged.statusCode, 200);
  assert.equal(unchanged.json().provider.baseUrl, "https://api.openai.com/v1");
});

test("pins gateway-backed providers to the operator-configured LiteLLM base URL", async (t) => {
  const { app, config, cookie } = await providerTestContext(t);
  const rejected = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: mutationHeaders(config, cookie),
    payload: {
      catalogId: "anthropic",
      name: "Invalid Claude gateway route",
      baseUrl: "https://tenant-controlled.example/v1?redirect=local",
      credential: "tenant-scoped-gateway-token",
      enabled: true,
    },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error, "invalid_provider_url");

  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: mutationHeaders(config, cookie),
    payload: {
      catalogId: "anthropic",
      name: "Claude gateway route",
      baseUrl: "https://tenant-controlled.example/v1",
      credential: "tenant-scoped-gateway-token",
      enabled: true,
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().provider.baseUrl, "https://gateway.operator.example/v1");

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/providers/${created.json().provider.id as string}`,
    headers: mutationHeaders(config, cookie),
    payload: { baseUrl: "https://another-tenant-controlled.example/v1" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().provider.baseUrl, "https://gateway.operator.example/v1");
});

test("permits server-local Ollama only after deployment opt-in", async (t) => {
  const blockedContext = await providerTestContext(t);
  const blocked = await blockedContext.app.inject({
    method: "POST",
    url: "/api/providers",
    headers: mutationHeaders(blockedContext.config, blockedContext.cookie),
    payload: { catalogId: "ollama", name: "Local Ollama", enabled: true },
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error, "private_provider_url_disabled");

  const allowedContext = await providerTestContext(t, {
    allowPrivateProviderEndpoints: true,
  });
  const allowed = await allowedContext.app.inject({
    method: "POST",
    url: "/api/providers",
    headers: mutationHeaders(allowedContext.config, allowedContext.cookie),
    payload: { catalogId: "ollama", name: "Local Ollama", enabled: true },
  });
  assert.equal(allowed.statusCode, 201);
  assert.equal(allowed.json().provider.baseUrl, "http://127.0.0.1:11434/v1");
});
