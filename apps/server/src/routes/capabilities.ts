import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  CodexAdapterConfigurationError,
  type CodexUserRouteBridge,
} from "../codex/adapter.js";
import {
  CodexRpcError,
  CodexRuntimeError,
  type JsonObject,
  type JsonValue,
} from "../codex/runtime.js";
import type { HarnessStore } from "../database.js";
import { requireUser } from "../http.js";
import type { HarnessRuntime } from "../runtime.js";

const PAGE_SIZE = 50;
const MAX_PAGES = 4;
const MAX_ITEMS = PAGE_SIZE * MAX_PAGES;
const MAX_WORKSPACES = 16;
const MAX_SKILLS = 256;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_STRING_LENGTH = 4_096;
const INVENTORY_TIMEOUT_MS = 15_000;

const MCP_RUNTIME_STATUSES = new Set([
  "notStarted",
  "starting",
  "connected",
  "authenticationRequired",
  "failed",
  "cancelled",
  "disabled",
]);
const MCP_AUTH_STATUSES = new Set([
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);

export interface CapabilityUnavailableError {
  code:
    | "provider_setup_required"
    | "runtime_unavailable"
    | "codex_request_rejected"
    | "no_workspace_grants"
    | "invalid_runtime_response"
    | "inventory_unavailable";
  message: string;
}

export type CapabilitySection<Data> =
  | { status: "available"; data: Data; error: null }
  | { status: "unavailable"; data: null; error: CapabilityUnavailableError };

export interface CapabilityModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  supportsPersonality: boolean;
  multiAgentVersion: "disabled" | "v1" | "v2" | null;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
  isDefault: boolean;
}

export interface PermissionProfileCapability {
  id: string;
  description: string | null;
  availableInWorkspaceCount: number;
  allowedInWorkspaceCount: number;
}

export interface SkillCapability {
  name: string;
  displayName: string | null;
  description: string;
  shortDescription: string | null;
  scope: "user" | "repo" | "system" | "admin";
  pluginId: string | null;
  brandColor: string | null;
  dependencyCount: number;
  availableInWorkspaceCount: number;
  enabledInWorkspaceCount: number;
}

export interface McpServerCapability {
  name: string;
  pluginId: string | null;
  runtimeStatus: string | null;
  authStatus: string | null;
  tools: string[];
  toolsTruncated: boolean;
}

export interface CapabilitiesPayload {
  generatedAt: string;
  models: CapabilitySection<{ items: CapabilityModel[]; truncated: boolean }>;
  providerCapabilities: CapabilitySection<{
    namespaceTools: boolean;
    imageGeneration: boolean;
    webSearch: boolean;
  }>;
  permissionProfiles: CapabilitySection<{
    items: PermissionProfileCapability[];
    workspaceCount: number;
    truncated: boolean;
  }>;
  skills: CapabilitySection<{
    items: SkillCapability[];
    workspaceCount: number;
    loadErrorCount: number;
    truncated: boolean;
  }>;
  mcpServers: CapabilitySection<{
    items: McpServerCapability[];
    truncated: boolean;
  }>;
}

interface InteractiveHarnessRuntime extends HarnessRuntime {
  forUser(identity: { tenantId: string; userId: string }): Promise<CodexUserRouteBridge>;
}

interface PageResult {
  items: unknown[];
  truncated: boolean;
}

interface WorkspaceSet {
  paths: string[];
  truncated: boolean;
}

class InvalidRuntimeResponseError extends Error {
  constructor() {
    super("Codex returned an invalid capability inventory response");
    this.name = "InvalidRuntimeResponseError";
  }
}

class NoWorkspaceGrantsError extends Error {
  constructor() {
    super("No authorized workspace is available");
    this.name = "NoWorkspaceGrantsError";
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum = MAX_STRING_LENGTH): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function boundedOptionalString(value: unknown, maximum = MAX_STRING_LENGTH): string | null {
  return value === null || value === undefined ? null : boundedString(value, maximum);
}

function boundedStringArray(value: unknown, maximumItems = 32): string[] {
  if (!Array.isArray(value)) return [];
  const items = new Set<string>();
  for (const candidate of value) {
    const item = boundedString(candidate, 128);
    if (item) items.add(item);
    if (items.size >= maximumItems) break;
  }
  return [...items];
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nullableEnum(value: unknown, allowed: ReadonlySet<string>): string | null {
  const candidate = boundedString(value, 128);
  return candidate && allowed.has(candidate) ? candidate : null;
}

function interactive(runtime: HarnessRuntime): InteractiveHarnessRuntime {
  if (!("forUser" in runtime) || typeof runtime.forUser !== "function") {
    throw new CodexRuntimeError("Interactive Codex runtime is not configured");
  }
  return runtime as InteractiveHarnessRuntime;
}

function errorFor(error: unknown): CapabilityUnavailableError {
  if (error instanceof CodexAdapterConfigurationError) {
    return {
      code: "provider_setup_required",
      message: "Connect and enable a model route to inspect capabilities.",
    };
  }
  if (error instanceof CodexRpcError) {
    return {
      code: "codex_request_rejected",
      message: "Codex could not provide this capability inventory.",
    };
  }
  if (error instanceof CodexRuntimeError) {
    return {
      code: "runtime_unavailable",
      message: "The Codex runtime is unavailable.",
    };
  }
  if (error instanceof NoWorkspaceGrantsError) {
    return {
      code: "no_workspace_grants",
      message: "Grant an authorized workspace to inspect workspace capabilities.",
    };
  }
  if (error instanceof InvalidRuntimeResponseError) {
    return {
      code: "invalid_runtime_response",
      message: "Codex returned an invalid capability inventory.",
    };
  }
  return {
    code: "inventory_unavailable",
    message: "This capability inventory is temporarily unavailable.",
  };
}

function unavailable<Data>(error: unknown): CapabilitySection<Data> {
  return { status: "unavailable", data: null, error: errorFor(error) };
}

function available<Data>(data: Data): CapabilitySection<Data> {
  return { status: "available", data, error: null };
}

function logSectionFailure(request: FastifyRequest, section: string, error: unknown): void {
  request.log.warn(
    {
      section,
      errorName: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof CodexRpcError ? { rpcCode: error.code } : {}),
    },
    "Codex capability inventory section is unavailable",
  );
}

async function section<Data>(
  request: FastifyRequest,
  name: string,
  operation: () => Promise<Data>,
): Promise<CapabilitySection<Data>> {
  try {
    return available(await operation());
  } catch (error) {
    logSectionFailure(request, name, error);
    return unavailable(error);
  }
}

async function collectPages(
  bridge: CodexUserRouteBridge,
  method: string,
  baseParams: JsonObject,
): Promise<PageResult> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params: JsonObject = {
      ...baseParams,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    };
    const raw = await bridge.request(method, params, { timeoutMs: INVENTORY_TIMEOUT_MS });
    const response = objectValue(raw);
    if (!response || !Array.isArray(response.data)) throw new InvalidRuntimeResponseError();

    const remaining = MAX_ITEMS - items.length;
    items.push(...response.data.slice(0, remaining));
    const nextCursor = response.nextCursor;
    if (nextCursor === null || nextCursor === undefined) return { items, truncated };
    const next = boundedString(nextCursor, 2_048);
    if (!next) throw new InvalidRuntimeResponseError();
    if (response.data.length > remaining || seenCursors.has(next)) {
      truncated = true;
      return { items, truncated };
    }
    if (items.length >= MAX_ITEMS) return { items, truncated: true };
    seenCursors.add(next);
    cursor = next;
  }

  return { items, truncated: true };
}

function normalizeModel(value: unknown): CapabilityModel | null {
  const model = objectValue(value);
  if (!model) return null;
  const id = boundedString(model.id, 256);
  const modelId = boundedString(model.model, 256);
  const displayName = boundedString(model.displayName, 256);
  if (!id || !modelId || !displayName) return null;

  const serviceTiers: CapabilityModel["serviceTiers"] = [];
  if (Array.isArray(model.serviceTiers)) {
    for (const rawTier of model.serviceTiers.slice(0, 16)) {
      const tier = objectValue(rawTier);
      const tierId = boundedString(tier?.id, 128);
      const name = boundedString(tier?.name, 256);
      if (!tierId || !name) continue;
      serviceTiers.push({
        id: tierId,
        name,
        description: boundedOptionalString(tier?.description) ?? "",
      });
    }
  }

  const multiAgentVersion = nullableEnum(
    model.multiAgentVersion,
    new Set(["disabled", "v1", "v2"]),
  ) as CapabilityModel["multiAgentVersion"];
  return {
    id,
    model: modelId,
    displayName,
    description: boundedOptionalString(model.description) ?? "",
    hidden: booleanValue(model.hidden),
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
          .slice(0, 16)
          .map((entry) => boundedString(objectValue(entry)?.reasoningEffort, 128))
          .filter((entry): entry is string => entry !== null)
      : [],
    defaultReasoningEffort: boundedOptionalString(model.defaultReasoningEffort, 128),
    inputModalities: boundedStringArray(model.inputModalities, 8),
    supportsPersonality: booleanValue(model.supportsPersonality),
    multiAgentVersion,
    serviceTiers,
    defaultServiceTier: boundedOptionalString(model.defaultServiceTier, 128),
    isDefault: booleanValue(model.isDefault),
  };
}

async function modelInventory(bridge: CodexUserRouteBridge) {
  const page = await collectPages(bridge, "model/list", { includeHidden: false });
  const items = page.items
    .map(normalizeModel)
    .filter((item): item is CapabilityModel => item !== null);
  return { items, truncated: page.truncated };
}

async function providerCapabilityInventory(bridge: CodexUserRouteBridge) {
  const raw = await bridge.request("modelProvider/capabilities/read", {}, {
    timeoutMs: INVENTORY_TIMEOUT_MS,
  });
  const response = objectValue(raw);
  if (
    !response ||
    typeof response.namespaceTools !== "boolean" ||
    typeof response.imageGeneration !== "boolean" ||
    typeof response.webSearch !== "boolean"
  ) {
    throw new InvalidRuntimeResponseError();
  }
  return {
    namespaceTools: response.namespaceTools,
    imageGeneration: response.imageGeneration,
    webSearch: response.webSearch,
  };
}

async function canonicalWorkspaces(
  store: HarnessStore,
  bridge: CodexUserRouteBridge,
  tenantId: string,
): Promise<WorkspaceSet> {
  const grants = store.listWorkspaceGrants(tenantId);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const grant of grants.slice(0, MAX_WORKSPACES)) {
    try {
      const canonical = await bridge.resolveWorkspacePath(grant);
      if (!store.isWorkspaceGranted(tenantId, canonical) || seen.has(canonical)) continue;
      seen.add(canonical);
      paths.push(canonical);
    } catch {
      // A removed or operator-disallowed grant is not a safe inventory context.
    }
  }
  return { paths, truncated: grants.length > MAX_WORKSPACES };
}

async function permissionProfileInventory(
  bridge: CodexUserRouteBridge,
  workspaces: WorkspaceSet,
) {
  if (workspaces.paths.length === 0) throw new NoWorkspaceGrantsError();
  const byId = new Map<
    string,
    PermissionProfileCapability & { seenWorkspaces: Set<number>; allowedWorkspaces: Set<number> }
  >();
  let truncated = workspaces.truncated;

  const pages = await Promise.all(
    workspaces.paths.map((cwd) => collectPages(bridge, "permissionProfile/list", { cwd })),
  );
  pages.forEach((page, workspaceIndex) => {
    truncated ||= page.truncated;
    for (const rawProfile of page.items) {
      const profile = objectValue(rawProfile);
      const id = boundedString(profile?.id, 256);
      if (!id || typeof profile?.allowed !== "boolean") continue;
      const current = byId.get(id) ?? {
        id,
        description: boundedOptionalString(profile.description),
        availableInWorkspaceCount: 0,
        allowedInWorkspaceCount: 0,
        seenWorkspaces: new Set<number>(),
        allowedWorkspaces: new Set<number>(),
      };
      current.seenWorkspaces.add(workspaceIndex);
      if (profile.allowed) current.allowedWorkspaces.add(workspaceIndex);
      byId.set(id, current);
    }
  });

  const items = [...byId.values()]
    .map(({ seenWorkspaces, allowedWorkspaces, ...profile }) => ({
      ...profile,
      availableInWorkspaceCount: seenWorkspaces.size,
      allowedInWorkspaceCount: allowedWorkspaces.size,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { items, workspaceCount: workspaces.paths.length, truncated };
}

function skillKey(skill: {
  name: string;
  scope: string;
  pluginId: string | null;
}): string {
  return `${skill.pluginId ?? ""}\0${skill.scope}\0${skill.name}`;
}

async function skillInventory(bridge: CodexUserRouteBridge, workspaces: WorkspaceSet) {
  if (workspaces.paths.length === 0) throw new NoWorkspaceGrantsError();
  const raw = await bridge.request(
    "skills/list",
    { cwds: workspaces.paths, forceReload: false },
    { timeoutMs: INVENTORY_TIMEOUT_MS },
  );
  const response = objectValue(raw);
  if (!response || !Array.isArray(response.data)) throw new InvalidRuntimeResponseError();

  const authorizedPaths = new Map(workspaces.paths.map((path, index) => [path, index]));
  const byKey = new Map<
    string,
    SkillCapability & { seenWorkspaces: Set<number>; enabledWorkspaces: Set<number> }
  >();
  let loadErrorCount = 0;
  let truncated = workspaces.truncated;

  for (const rawEntry of response.data) {
    const entry = objectValue(rawEntry);
    const cwd = boundedString(entry?.cwd, MAX_STRING_LENGTH);
    const workspaceIndex = cwd ? authorizedPaths.get(cwd) : undefined;
    if (workspaceIndex === undefined || !Array.isArray(entry?.skills)) {
      loadErrorCount += 1;
      continue;
    }
    if (Array.isArray(entry.errors)) loadErrorCount += entry.errors.length;
    const seenInEntry = new Set<string>();
    for (const rawSkill of entry.skills) {
      const skill = objectValue(rawSkill);
      if (!skill) continue;
      const name = boundedString(skill?.name, 256);
      const description = boundedString(skill?.description);
      const scope = boundedString(skill?.scope, 32);
      if (
        !name ||
        !description ||
        !scope ||
        !["user", "repo", "system", "admin"].includes(scope)
      ) {
        continue;
      }
      const pluginId = boundedOptionalString(skill.pluginId, 256);
      const key = skillKey({ name, scope, pluginId });
      if (seenInEntry.has(key)) continue;
      seenInEntry.add(key);
      const skillInterface = objectValue(skill.interface);
      const dependencies = objectValue(skill.dependencies);
      const dependencyCount = Array.isArray(dependencies?.tools)
        ? Math.min(dependencies.tools.length, 1_000)
        : 0;
      const current = byKey.get(key) ?? {
        name,
        displayName: boundedOptionalString(skillInterface?.displayName, 256),
        description,
        shortDescription:
          boundedOptionalString(skillInterface?.shortDescription) ??
          boundedOptionalString(skill.shortDescription),
        scope: scope as SkillCapability["scope"],
        pluginId,
        brandColor: boundedOptionalString(skillInterface?.brandColor, 32),
        dependencyCount,
        availableInWorkspaceCount: 0,
        enabledInWorkspaceCount: 0,
        seenWorkspaces: new Set<number>(),
        enabledWorkspaces: new Set<number>(),
      };
      current.seenWorkspaces.add(workspaceIndex);
      if (skill.enabled === true) current.enabledWorkspaces.add(workspaceIndex);
      byKey.set(key, current);
    }
  }

  let values = [...byKey.values()];
  if (values.length > MAX_SKILLS) {
    values = values.slice(0, MAX_SKILLS);
    truncated = true;
  }
  const items = values
    .map(({ seenWorkspaces, enabledWorkspaces, ...skill }) => ({
      ...skill,
      availableInWorkspaceCount: seenWorkspaces.size,
      enabledInWorkspaceCount: enabledWorkspaces.size,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    items,
    workspaceCount: workspaces.paths.length,
    loadErrorCount,
    truncated,
  };
}

function normalizeMcpServer(value: unknown): McpServerCapability | null {
  const server = objectValue(value);
  if (!server) return null;
  const name = boundedString(server?.name, 256);
  if (!name) return null;
  const toolNames = objectValue(server.tools)
    ? Object.keys(server.tools as Record<string, unknown>)
        .map((tool) => boundedString(tool, 256))
        .filter((tool): tool is string => tool !== null)
        .sort()
    : [];
  return {
    name,
    pluginId: boundedOptionalString(server.pluginId, 256),
    runtimeStatus: nullableEnum(server.runtimeStatus, MCP_RUNTIME_STATUSES),
    authStatus: nullableEnum(server.authStatus, MCP_AUTH_STATUSES),
    tools: toolNames.slice(0, MAX_TOOLS_PER_SERVER),
    toolsTruncated: toolNames.length > MAX_TOOLS_PER_SERVER,
  };
}

async function mcpServerInventory(bridge: CodexUserRouteBridge) {
  const page = await collectPages(bridge, "mcpServerStatus/list", {
    detail: "toolsAndAuthOnly",
  });
  const items = page.items
    .map(normalizeMcpServer)
    .filter((item): item is McpServerCapability => item !== null);
  return { items, truncated: page.truncated };
}

function unavailablePayload(error: unknown): CapabilitiesPayload {
  return {
    generatedAt: new Date().toISOString(),
    models: unavailable(error),
    providerCapabilities: unavailable(error),
    permissionProfiles: unavailable(error),
    skills: unavailable(error),
    mcpServers: unavailable(error),
  };
}

export function registerCapabilitiesRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; runtime: HarnessRuntime },
): void {
  const { store, runtime } = input;

  app.get(
    "/api/capabilities",
    {
      schema: {
        querystring: { type: "object", additionalProperties: false },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request): Promise<CapabilitiesPayload> => {
      const user = requireUser(request, store);
      let bridge: CodexUserRouteBridge;
      try {
        bridge = await interactive(runtime).forUser({
          tenantId: user.tenantId,
          userId: user.id,
        });
      } catch (error) {
        logSectionFailure(request, "runtime", error);
        return unavailablePayload(error);
      }

      const workspacesPromise = canonicalWorkspaces(store, bridge, user.tenantId);
      const [models, providerCapabilities, permissionProfiles, skills, mcpServers] =
        await Promise.all([
          section(request, "models", () => modelInventory(bridge)),
          section(request, "providerCapabilities", () => providerCapabilityInventory(bridge)),
          section(request, "permissionProfiles", async () =>
            permissionProfileInventory(bridge, await workspacesPromise),
          ),
          section(request, "skills", async () =>
            skillInventory(bridge, await workspacesPromise),
          ),
          section(request, "mcpServers", () => mcpServerInventory(bridge)),
        ]);

      return {
        generatedAt: new Date().toISOString(),
        models,
        providerCapabilities,
        permissionProfiles,
        skills,
        mcpServers,
      };
    },
  );
}
