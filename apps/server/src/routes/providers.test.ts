import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
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
): Promise<{ app: FastifyInstance; config: HarnessConfig; cookie: string; store: HarnessStore }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-providers-"));
  const config: HarnessConfig = {
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1:3590",
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
    publicAppUrl: "http://127.0.0.1:3590",
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
  return { app, config, cookie: responseCookie(passwordChange), store };
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

async function probeServer(t: TestContext) {
  const calls: { url: string | undefined; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const upstream = {
    status: 200,
    body: JSON.stringify({ object: "response", status: "completed", output: [] }),
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(upstream.status, {
      "content-type": "application/json",
      ...(upstream.status === 302 ? { location: "/redirect-target" } : {}),
    });
    response.end(upstream.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, upstream };
}

test("tests saved routes with server-side credentials and draft overrides without changing settings", async (t) => {
  const remote = await probeServer(t);
  const { app, config, cookie, store } = await providerTestContext(t, { allowPrivateProviderEndpoints: true });
  const headers = mutationHeaders(config, cookie);
  const created = await app.inject({ method: "POST", url: "/api/providers", headers, payload: {
    catalogId: "newapi", name: "Saved router", baseUrl: remote.baseUrl,
    defaultModel: "original-model", credential: "saved-secret-token", isDefault: true,
  } });
  assert.equal(created.statusCode, 201);
  const provider = created.json().provider;
  const tenantId = store.getUserByUsername("provider-admin")!.tenant_id;
  const before = store.getProviderRow(tenantId, provider.id);
  const auditBefore = store.listAuditEvents(tenantId);

  const saved = await app.inject({ method: "POST", url: `/api/providers/${provider.id}/test`, headers, payload: {} });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().result.success, true);
  assert.equal(saved.json().result.model, "original-model");
  assert.ok(saved.json().result.latencyMs >= 0);
  assert.equal(remote.calls[0]!.url, "/v1/responses");
  assert.equal(remote.calls[0]!.headers.authorization, "Bearer saved-secret-token");
  assert.deepEqual(remote.calls[0]!.body, { model: "original-model", input: "Reply with OK.", max_output_tokens: 64, stream: false, store: false });
  assert.ok(!saved.body.includes("saved-secret-token"));

  const draft = await app.inject({ method: "POST", url: `/api/providers/${provider.id}/test`, headers, payload: {
    name: "Unsaved name", defaultModel: "draft-model", credential: "draft-secret-token", enabled: false, isDefault: false,
  } });
  assert.equal(draft.statusCode, 200);
  assert.equal(draft.json().result.model, "draft-model");
  assert.equal(remote.calls[1]!.headers.authorization, "Bearer draft-secret-token");
  assert.equal(remote.calls[1]!.body.model, "draft-model");
  assert.deepEqual(store.getProviderRow(tenantId, provider.id), before);
  assert.deepEqual(store.listAuditEvents(tenantId), auditBefore);
});

test("tests a new draft and operator-pinned gateway without creating routes", async (t) => {
  const remote = await probeServer(t);
  const { app, config, cookie, store } = await providerTestContext(t, {
    allowPrivateProviderEndpoints: true, litellmBaseUrl: remote.baseUrl, litellmMasterKey: "operator-secret-token",
  });
  const tenantId = store.getUserByUsername("provider-admin")!.tenant_id;
  const headers = mutationHeaders(config, cookie);
  const native = await app.inject({ method: "POST", url: "/api/providers/test", headers, payload: {
    catalogId: "newapi", name: "Draft router", baseUrl: remote.baseUrl, defaultModel: "test-model", credential: "draft-secret",
  } });
  assert.equal(native.statusCode, 200);
  assert.equal(native.json().result.success, true);
  const gateway = await app.inject({ method: "POST", url: "/api/providers/test", headers, payload: {
    catalogId: "anthropic", name: "Draft gateway", baseUrl: "https://ignored.example/v1",
  } });
  assert.equal(gateway.statusCode, 200);
  assert.equal(gateway.json().result.success, true);
  assert.equal(remote.calls[1]!.headers.authorization, "Bearer operator-secret-token");
  assert.equal(remote.calls[1]!.body.model, "codex-anthropic");
  assert.deepEqual(store.listProviders(tenantId), []);
  assert.ok(!gateway.body.includes("operator-secret-token"));
});

test("saved gateway tests use the persisted endpoint while drafts use the current operator gateway", async (t) => {
  const savedGateway = await probeServer(t);
  const currentGateway = await probeServer(t);
  const { app, config, cookie, store } = await providerTestContext(t, {
    allowPrivateProviderEndpoints: true, litellmBaseUrl: savedGateway.baseUrl,
  });
  const headers = mutationHeaders(config, cookie);
  const created = await app.inject({ method: "POST", url: "/api/providers", headers, payload: {
    catalogId: "anthropic", name: "Saved gateway", credential: "saved-gateway-token",
  } });
  assert.equal(created.statusCode, 201);
  const providerId = created.json().provider.id as string;
  const tenantId = store.getUserByUsername("provider-admin")!.tenant_id;
  const before = store.getProviderRow(tenantId, providerId);
  config.litellmBaseUrl = currentGateway.baseUrl;

  for (const payload of [{}, undefined]) {
    const saved = await app.inject({ method: "POST", url: `/api/providers/${providerId}/test`, headers,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().result.success, true);
  }
  assert.equal(savedGateway.calls.length, 2);
  assert.equal(currentGateway.calls.length, 0);

  const draft = await app.inject({ method: "POST", url: `/api/providers/${providerId}/test`, headers,
    payload: { defaultModel: "draft-gateway-model" },
  });
  assert.equal(draft.statusCode, 200);
  assert.equal(draft.json().result.success, true);
  assert.equal(savedGateway.calls.length, 2);
  assert.equal(currentGateway.calls.length, 1);
  assert.equal(currentGateway.calls[0]!.body.model, "draft-gateway-model");
  assert.equal(currentGateway.calls[0]!.headers.authorization, "Bearer saved-gateway-token");
  assert.deepEqual(store.getProviderRow(tenantId, providerId), before);

  config.allowPrivateProviderEndpoints = false;
  const blocked = await app.inject({ method: "POST", url: `/api/providers/${providerId}/test`, headers, payload: {} });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error, "private_provider_url_disabled");
  assert.equal(savedGateway.calls.length, 2, "saved endpoints must still pass current deployment policy");
});

test("returns safe failures for upstream authentication, quotas, redirects and invalid Responses results", async (t) => {
  const remote = await probeServer(t);
  const { app, config, cookie } = await providerTestContext(t, { allowPrivateProviderEndpoints: true });
  const cases = [
    { status: 401, body: '{"error":"echoed-credential-secret"}', message: /Authentication failed/ },
    { status: 429, body: '{"error":"echoed-credential-secret"}', message: /quota/ },
    { status: 302, body: "echoed-credential-secret", message: /redirected/ },
    { status: 503, body: "echoed-credential-secret", message: /unavailable/ },
    { status: 200, body: "echoed-credential-secret", message: /valid Responses API JSON/ },
    { status: 200, body: '{"object":"response","status":"failed","output":[],"error":{"message":"echoed-credential-secret"}}', message: /successful Responses API result/ },
    { status: 200, body: '{"object":"response","status":"incomplete","output":[],"incomplete_details":{"reason":"content_filter"}}', message: /successful Responses API result/ },
    { status: 200, body: '{"choices":[]}', message: /successful Responses API result/ },
  ];
  for (const candidate of cases) {
    Object.assign(remote.upstream, candidate);
    const response = await app.inject({ method: "POST", url: "/api/providers/test", headers: mutationHeaders(config, cookie), payload: {
      catalogId: "newapi", name: "Draft router", baseUrl: remote.baseUrl, defaultModel: "test-model", credential: "echoed-credential-secret",
    } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.success, false);
    assert.match(response.json().result.message, candidate.message);
    assert.ok(!response.body.includes("echoed-credential-secret"));
  }
  assert.equal(remote.calls.length, cases.length, "must not follow redirects");
  remote.upstream.body = '{"object":"response","status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"}}';
  const capped = await app.inject({ method: "POST", url: "/api/providers/test", headers: mutationHeaders(config, cookie), payload: {
    catalogId: "newapi", name: "Draft router", baseUrl: remote.baseUrl, defaultModel: "test-model", credential: "test-secret",
  } });
  assert.equal(capped.statusCode, 200);
  assert.equal(capped.json().result.success, true, "the deliberately small output-token cap is compatible with reasoning models");
});

test("validates test URLs, models, credentials and provider changes before making network requests", async (t) => {
  const remote = await probeServer(t);
  const { app, config, cookie } = await providerTestContext(t);
  const headers = mutationHeaders(config, cookie);
  const created = await app.inject({ method: "POST", url: "/api/providers", headers, payload: {
    catalogId: "openai", name: "Saved router", credential: "saved-secret",
  } });
  assert.equal(created.statusCode, 201);
  const cases = [
    { baseUrl: remote.baseUrl },
    { baseUrl: "https://169.254.169.254/latest" },
    { baseUrl: "https://user:secret@router.example/v1" },
    { defaultModel: null },
    { defaultModel: " " },
    { credential: null },
    { catalogId: "newapi" },
    { catalogId: "unsupported" },
    { arbitraryPrompt: "not accepted" },
  ];
  for (const payload of cases) {
    const response = await app.inject({ method: "POST", url: `/api/providers/${created.json().provider.id}/test`, headers, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  const missing = await app.inject({ method: "POST", url: "/api/providers/test", headers, payload: {
    catalogId: "openrouter", name: "No model", credential: "test-secret",
  } });
  assert.equal(missing.json().error, "provider_model_required");
  assert.equal(remote.calls.length, 0);
});

test("provider tests require an administrator, a valid origin and a same-tenant route", async (t) => {
  const { app, config, cookie, store } = await providerTestContext(t);
  const headers = mutationHeaders(config, cookie);
  const payload = { catalogId: "openai", name: "Test route", credential: "test-secret" };
  const anonymous = await app.inject({ method: "POST", url: "/api/providers/test", headers: { origin: config.webOrigin }, payload });
  assert.equal(anonymous.statusCode, 401);
  const origin = await app.inject({ method: "POST", url: "/api/providers/test", headers: { cookie, origin: "https://elsewhere.example" }, payload });
  assert.equal(origin.statusCode, 403);
  assert.equal(origin.json().error, "invalid_origin");

  store.db.prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
    .run("other-provider-tenant", "Other tenant", "other-provider-tenant", new Date().toISOString());
  const otherProvider = store.saveProvider({
    tenantId: "other-provider-tenant", catalogId: "openai", name: "Other route", adapter: "responses",
    baseUrl: "https://api.openai.com/v1", defaultModel: "test-model", enabled: false, isDefault: false,
  });
  const outsider = await app.inject({ method: "POST", url: `/api/providers/${otherProvider.id}/test`, headers, payload: {} });
  assert.equal(outsider.statusCode, 404);
  assert.equal(outsider.json().error, "provider_not_found");

  store.db.prepare("UPDATE users SET role = 'member' WHERE username = ?").run("provider-admin");
  for (const url of ["/api/providers/test", `/api/providers/${otherProvider.id}/test`]) {
    const member = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(member.statusCode, 403);
    assert.equal(member.json().error, "forbidden");
  }
});
