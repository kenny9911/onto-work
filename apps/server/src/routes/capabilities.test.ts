import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { LightMyRequestResponse } from "fastify";

import type { CodexUserRouteBridge } from "../codex/adapter.js";
import {
  CodexRpcError,
  type CodexRequestOptions,
  type CodexRuntimeListener,
  type CodexSubscriptionOptions,
  type JsonObject,
  type JsonRpcId,
  type JsonValue,
} from "../codex/runtime.js";
import { buildApp } from "../app.js";
import type { HarnessConfig } from "../config.js";
import { HarnessStore } from "../database.js";
import type {
  HarnessRuntime,
  RuntimeDashboardSnapshot,
  RuntimeHealth,
} from "../runtime.js";
import type { CapabilitiesPayload } from "./capabilities.js";

interface RequestCall {
  method: string;
  params?: JsonValue;
  options?: CodexRequestOptions;
}

class FakeBridge implements CodexUserRouteBridge {
  readonly requestCalls: RequestCall[] = [];
  readonly resolvedWorkspacePaths: string[] = [];
  requestHandler: (method: string, params?: JsonValue) => unknown | Promise<unknown> = () =>
    ({ data: [], nextCursor: null });

  async request<Result extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    options?: CodexRequestOptions,
  ): Promise<Result> {
    this.requestCalls.push({ method, params, options });
    return (await this.requestHandler(method, params)) as Result;
  }

  async notify(): Promise<void> {}

  async respond(_requestId: JsonRpcId, _result: JsonValue = null): Promise<void> {}

  async respondError(): Promise<void> {}

  subscribe(
    _listener: CodexRuntimeListener,
    _options?: CodexSubscriptionOptions,
  ): () => void {
    return () => {};
  }

  async resolveWorkspacePath(requestedPath: string): Promise<string> {
    this.resolvedWorkspacePaths.push(requestedPath);
    return realpath(requestedPath);
  }

  async startThread<Result extends JsonValue = JsonValue>(
    _workspacePath: string,
    _params?: JsonObject,
    _options?: CodexRequestOptions,
  ): Promise<Result> {
    return {} as Result;
  }
}

class FakeRuntime implements HarnessRuntime {
  readonly bridge = new FakeBridge();
  readonly identities: Array<{ tenantId: string; userId: string }> = [];

  async forUser(identity: { tenantId: string; userId: string }): Promise<CodexUserRouteBridge> {
    this.identities.push(identity);
    return this.bridge;
  }

  async dashboardSnapshot(): Promise<RuntimeDashboardSnapshot> {
    return { projects: [], threads: [], featuredThread: null };
  }

  async health(): Promise<RuntimeHealth> {
    return { status: "ready" };
  }
}

interface Fixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  config: HarnessConfig;
  cookie: string;
  runtime: FakeRuntime;
  store: HarnessStore;
  tenantId: string;
  userId: string;
  workspace: string;
}

function responseCookie(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  assert.ok(header);
  const value = Array.isArray(header) ? header[0] : header;
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function fixture(t: TestContext, withWorkspace = true): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "agent-harness-capabilities-"));
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory);
  const workspace = await realpath(workspaceDirectory);
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
    allowedWorkspaceRoots: [],
    stripeSecretKey: null,
    stripeWebhookSecret: null,
    stripePricePro: null,
    stripePriceTeam: null,
    publicAppUrl: "http://127.0.0.1:4173",
    litellmBaseUrl: "http://127.0.0.1:4000/v1",
    litellmMasterKey: null,
  };
  const store = new HarnessStore(config.databasePath);
  const user = await store.bootstrapAdmin("capability-admin", "capability-test-password");
  store.db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(user.id);
  if (withWorkspace) {
    store.grantWorkspace({ tenantId: user.tenantId, rootPath: workspace });
  }
  const runtime = new FakeRuntime();
  const app = await buildApp({ config, store, runtime, logger: false });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: config.webOrigin },
    payload: { username: "capability-admin", password: "capability-test-password" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = responseCookie(login);

  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    config,
    cookie,
    runtime,
    store,
    tenantId: user.tenantId,
    userId: user.id,
    workspace,
  };
}

function paramsObject(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

function emptySkills(workspace: string): JsonValue {
  return { data: [{ cwd: workspace, skills: [], errors: [] }] };
}

test("capabilities route is authenticated, user-bound, workspace-scoped, and redacted", async (t) => {
  const f = await fixture(t);
  const unauthenticated = await f.app.inject({ method: "GET", url: "/api/capabilities" });
  assert.equal(unauthenticated.statusCode, 401);

  const secretCanary = "do-not-return-capability-secret";
  f.runtime.bridge.requestHandler = (method) => {
    switch (method) {
      case "model/list":
        return {
          data: [
            {
              id: "model-one",
              model: "provider/model-one",
              displayName: "Model One",
              description: "A safe model description",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Balanced" },
                { reasoningEffort: "ultra", description: "Multi-agent" },
              ],
              defaultReasoningEffort: "medium",
              inputModalities: ["text", "image"],
              supportsPersonality: true,
              multiAgentVersion: "v2",
              serviceTiers: [{ id: "fast", name: "Fast", description: "Low latency" }],
              defaultServiceTier: "fast",
              isDefault: true,
              upgradeInfo: { migrationMarkdown: secretCanary, modelLink: secretCanary },
            },
          ],
          nextCursor: null,
        };
      case "modelProvider/capabilities/read":
        return { namespaceTools: true, imageGeneration: false, webSearch: true };
      case "permissionProfile/list":
        return {
          data: [{ id: ":workspace", description: "Workspace access", allowed: true }],
          nextCursor: null,
        };
      case "skills/list":
        return {
          data: [
            {
              cwd: f.workspace,
              skills: [
                {
                  name: "safe-skill",
                  description: "A safe skill description",
                  shortDescription: "Safe skill",
                  path: `/private/${secretCanary}/SKILL.md`,
                  scope: "repo",
                  enabled: true,
                  pluginId: "safe-plugin",
                  interface: {
                    displayName: "Safe Skill",
                    shortDescription: "Safe skill",
                    iconSmall: `/private/${secretCanary}/small.svg`,
                    iconLarge: `/private/${secretCanary}/large.svg`,
                    iconSmallUrl: `https://example.test/${secretCanary}`,
                    defaultPrompt: `run ${secretCanary}`,
                    brandColor: "#123456",
                  },
                  dependencies: {
                    tools: [
                      {
                        type: "command",
                        value: "private-tool",
                        command: `printenv ${secretCanary}`,
                        url: `https://example.test/?token=${secretCanary}`,
                      },
                    ],
                  },
                },
              ],
              errors: [{ path: `/private/${secretCanary}`, message: secretCanary }],
            },
          ],
        };
      case "mcpServerStatus/list":
        return {
          data: [
            {
              name: "safe-mcp",
              runtimeStatus: null,
              pluginId: "safe-plugin",
              authStatus: "oAuth",
              tools: {
                search: { description: secretCanary, inputSchema: { secret: secretCanary } },
              },
              serverInfo: { command: secretCanary, env: { TOKEN: secretCanary } },
              resources: [{ uri: `file:///${secretCanary}` }],
              resourceTemplates: [{ uriTemplate: `file:///${secretCanary}/{id}` }],
            },
          ],
          nextCursor: null,
        };
      default:
        throw new Error(`Unexpected method ${method}`);
    }
  };

  const response = await f.app.inject({
    method: "GET",
    url: "/api/capabilities",
    headers: { cookie: f.cookie },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json() as CapabilitiesPayload;
  assert.equal(payload.models.status, "available");
  assert.equal(payload.providerCapabilities.status, "available");
  assert.equal(payload.permissionProfiles.status, "available");
  assert.equal(payload.skills.status, "available");
  assert.equal(payload.mcpServers.status, "available");
  assert.equal(payload.models.data?.items[0]?.multiAgentVersion, "v2");
  assert.deepEqual(payload.models.data?.items[0]?.supportedReasoningEfforts, ["medium", "ultra"]);
  assert.equal(payload.permissionProfiles.data?.items[0]?.allowedInWorkspaceCount, 1);
  assert.equal(payload.skills.data?.items[0]?.dependencyCount, 1);
  assert.equal(payload.skills.data?.loadErrorCount, 1);
  assert.deepEqual(payload.mcpServers.data?.items[0]?.tools, ["search"]);
  assert.doesNotMatch(response.body, new RegExp(secretCanary));
  assert.doesNotMatch(response.body, new RegExp(f.workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.deepEqual(f.runtime.identities, [{ tenantId: f.tenantId, userId: f.userId }]);
  assert.deepEqual(f.runtime.bridge.resolvedWorkspacePaths, [f.workspace]);
  assert.deepEqual(
    new Set(f.runtime.bridge.requestCalls.map((call) => call.method)),
    new Set([
      "model/list",
      "modelProvider/capabilities/read",
      "permissionProfile/list",
      "skills/list",
      "mcpServerStatus/list",
    ]),
  );
  const permissionsCall = f.runtime.bridge.requestCalls.find(
    (call) => call.method === "permissionProfile/list",
  );
  assert.equal(paramsObject(permissionsCall?.params).cwd, f.workspace);
  assert.equal(paramsObject(permissionsCall?.params).limit, 50);
  const skillsCall = f.runtime.bridge.requestCalls.find((call) => call.method === "skills/list");
  assert.deepEqual(paramsObject(skillsCall?.params), {
    cwds: [f.workspace],
    forceReload: false,
  });
  const mcpCall = f.runtime.bridge.requestCalls.find(
    (call) => call.method === "mcpServerStatus/list",
  );
  assert.deepEqual(paramsObject(mcpCall?.params), {
    detail: "toolsAndAuthOnly",
    limit: 50,
  });
  for (const call of f.runtime.bridge.requestCalls) {
    assert.equal(call.options?.timeoutMs, 15_000);
  }

  const injectedQuery = await f.app.inject({
    method: "GET",
    url: `/api/capabilities?cwd=${encodeURIComponent(`/private/${secretCanary}`)}`,
    headers: { cookie: f.cookie },
  });
  assert.equal(injectedQuery.statusCode, 200);
  assert.doesNotMatch(injectedQuery.body, new RegExp(secretCanary));
  assert.ok(
    f.runtime.bridge.resolvedWorkspacePaths.every((path) => path === f.workspace),
    "client query parameters must never influence workspace resolution",
  );
});

test("one rejected inventory is unavailable without hiding successful sections or leaking errors", async (t) => {
  const f = await fixture(t);
  const secretCanary = "rpc-error-secret-canary";
  f.runtime.bridge.requestHandler = (method) => {
    if (method === "model/list") {
      throw new CodexRpcError(method, -32_601, secretCanary, { secret: secretCanary });
    }
    if (method === "modelProvider/capabilities/read") {
      return { namespaceTools: false, imageGeneration: true, webSearch: false };
    }
    if (method === "permissionProfile/list") return { data: [], nextCursor: null };
    if (method === "skills/list") return emptySkills(f.workspace);
    if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
    throw new Error(`Unexpected method ${method}`);
  };

  const response = await f.app.inject({
    method: "GET",
    url: "/api/capabilities",
    headers: { cookie: f.cookie },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json() as CapabilitiesPayload;
  assert.deepEqual(payload.models, {
    status: "unavailable",
    data: null,
    error: {
      code: "codex_request_rejected",
      message: "Codex could not provide this capability inventory.",
    },
  });
  assert.equal(payload.providerCapabilities.status, "available");
  assert.equal(payload.permissionProfiles.status, "available");
  assert.equal(payload.skills.status, "available");
  assert.equal(payload.mcpServers.status, "available");
  assert.doesNotMatch(response.body, new RegExp(secretCanary));
});

test("workspace inventories fail closed when the tenant has no grants", async (t) => {
  const f = await fixture(t, false);
  f.runtime.bridge.requestHandler = (method) => {
    if (method === "model/list" || method === "mcpServerStatus/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "modelProvider/capabilities/read") {
      return { namespaceTools: false, imageGeneration: false, webSearch: false };
    }
    throw new Error(`Workspace-scoped method must not be called: ${method}`);
  };

  const response = await f.app.inject({
    method: "GET",
    url: "/api/capabilities",
    headers: { cookie: f.cookie },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json() as CapabilitiesPayload;
  assert.equal(payload.permissionProfiles.status, "unavailable");
  assert.equal(payload.permissionProfiles.error?.code, "no_workspace_grants");
  assert.equal(payload.skills.status, "unavailable");
  assert.equal(payload.skills.error?.code, "no_workspace_grants");
  assert.equal(payload.models.status, "available");
  assert.equal(payload.providerCapabilities.status, "available");
  assert.equal(payload.mcpServers.status, "available");
  assert.ok(
    !f.runtime.bridge.requestCalls.some(
      (call) => call.method === "permissionProfile/list" || call.method === "skills/list",
    ),
  );
});

test("paginated inventories stop at the hard page and item bounds", async (t) => {
  const f = await fixture(t);
  let modelPage = 0;
  f.runtime.bridge.requestHandler = (method) => {
    if (method === "model/list") {
      modelPage += 1;
      return {
        data: Array.from({ length: 50 }, (_, index) => ({
          id: `model-${modelPage}-${index}`,
          model: `provider/model-${modelPage}-${index}`,
          displayName: `Model ${modelPage}-${index}`,
          description: "",
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        })),
        nextCursor: `page-${modelPage + 1}`,
      };
    }
    if (method === "modelProvider/capabilities/read") {
      return { namespaceTools: false, imageGeneration: false, webSearch: false };
    }
    if (method === "permissionProfile/list") return { data: [], nextCursor: null };
    if (method === "skills/list") return emptySkills(f.workspace);
    if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
    throw new Error(`Unexpected method ${method}`);
  };

  const response = await f.app.inject({
    method: "GET",
    url: "/api/capabilities",
    headers: { cookie: f.cookie },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json() as CapabilitiesPayload;
  assert.equal(payload.models.status, "available");
  assert.equal(payload.models.data?.items.length, 200);
  assert.equal(payload.models.data?.truncated, true);
  assert.equal(
    f.runtime.bridge.requestCalls.filter((call) => call.method === "model/list").length,
    4,
  );
});

test("health endpoints expose the same unauthenticated runtime readiness", async (t) => {
  const f = await fixture(t, false);
  const [apiHealth, healthz] = await Promise.all([
    f.app.inject({ method: "GET", url: "/api/health" }),
    f.app.inject({ method: "GET", url: "/healthz" }),
  ]);

  assert.equal(apiHealth.statusCode, 200);
  assert.equal(healthz.statusCode, 200);
  assert.deepEqual(healthz.json(), apiHealth.json());
  assert.deepEqual(healthz.json(), {
    status: "ok",
    runtime: { status: "ready" },
  });
});
