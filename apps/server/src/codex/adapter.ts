import { createHash } from "node:crypto";
import { basename } from "node:path";

import type {
  HarnessThreadStatus,
  ProjectSummary,
  ThreadDetailPayload,
  ThreadSummary,
  TimelineItem,
} from "@agent-harness/contracts";
import type { HarnessConfig } from "../config.js";
import type {
  HarnessStore,
  ProviderRow,
  SavedProjectRecord,
} from "../database.js";
import type {
  HarnessRuntime,
  RuntimeDashboardSnapshot,
  RuntimeHealth,
} from "../runtime.js";
import { decryptSecret } from "../security.js";
import type { CodexProviderConfig } from "./config.js";
import {
  CodexRuntimeConfigurationError,
  CodexRuntimeManager,
  type CodexRequestOptions,
  type CodexRuntime,
  type CodexRuntimeListener,
  type CodexSubscriptionOptions,
  type JsonObject,
  type JsonRpcId,
  type JsonValue,
} from "./runtime.js";

const DEFAULT_THREAD_LIMIT = 50;
const DEFAULT_TIMELINE_ITEM_LIMIT = 160;
const MAX_PREVIEW_LENGTH = 320;
const MAX_TITLE_LENGTH = 96;
const MAX_TIMELINE_BODY_LENGTH = 12_000;

export interface CodexUserIdentity {
  tenantId: string;
  userId: string;
}

export interface CodexExpectedRoute {
  providerId: string;
  model: string;
}

export interface CodexHarnessAdapterOptions {
  store: HarnessStore;
  config: HarnessConfig;
  manager?: CodexRuntimeManager;
  threadLimit?: number;
  timelineItemLimit?: number;
}

/** A user-bound bridge that HTTP and SSE routes can safely retain per request. */
export interface CodexUserRouteBridge {
  request<Result extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    options?: CodexRequestOptions,
  ): Promise<Result>;
  notify(method: string, params?: JsonValue): Promise<void>;
  respond(requestId: JsonRpcId, result?: JsonValue): Promise<void>;
  respondError(
    requestId: JsonRpcId,
    code: number,
    message: string,
    data?: JsonValue,
  ): Promise<void>;
  subscribe(listener: CodexRuntimeListener, options?: CodexSubscriptionOptions): () => void;
  resolveWorkspacePath(requestedPath: string): Promise<string>;
  startThread<Result extends JsonValue = JsonValue>(
    workspacePath: string,
    params?: JsonObject,
    options?: CodexRequestOptions,
  ): Promise<Result>;
}

interface RuntimeContext {
  runtime: CodexRuntime;
  provider: ProviderRow;
}

interface ProjectMapping {
  projects: ProjectSummary[];
  byThreadId: Map<string, ProjectSummary>;
}

interface AuthorizedRuntimeThread {
  raw: Record<string, unknown>;
  threadId: string;
  workspacePath: string;
}

export class CodexAdapterConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAdapterConfigurationError";
  }
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 1_000) {
    throw new Error(`${field} must be an integer between 1 and 1000`);
  }
  return resolved;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clipped(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function enumLabel(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  const candidate = record(value);
  if (!candidate) return null;
  return stringValue(candidate.type) ?? stringValue(candidate.kind) ?? null;
}

function activeTurnId(thread: Record<string, unknown>): string | null {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = record(turns[index]);
    if (stringValue(turn?.status) !== "inProgress") continue;
    const id = stringValue(turn?.id);
    if (id) return id;
  }
  return null;
}

function timestampFromUnix(value: unknown): string {
  const seconds = numberValue(value);
  if (seconds === null || seconds < 0) return new Date(0).toISOString();
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function threadStatus(value: unknown): HarnessThreadStatus {
  const status = record(value);
  const type = stringValue(status?.type);
  if (type === "active") {
    const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
    return flags.some(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    )
      ? "waiting"
      : "running";
  }
  if (type === "systemError") return "failed";
  if (type === "notLoaded") return "completed";
  return "idle";
}

function itemStatus(value: unknown): TimelineItem["status"] {
  if (value === "inProgress") return "running";
  if (value === "completed") return "completed";
  if (value === "failed" || value === "declined" || value === "interrupted") return "failed";
  return undefined;
}

function displayUserInput(value: unknown): string | null {
  const input = record(value);
  const type = stringValue(input?.type);
  if (type === "text") return stringValue(input?.text);
  if (type === "image" || type === "localImage") return "[Image]";
  if (type === "audio" || type === "localAudio") return "[Audio]";
  if (type === "skill") return stringValue(input?.name) ? `[Skill: ${String(input?.name)}]` : "[Skill]";
  if (type === "mention") return stringValue(input?.name) ? `@${String(input?.name)}` : "[Mention]";
  return null;
}

function timelineItem(
  rawItem: Record<string, unknown>,
  turn: Record<string, unknown>,
  index: number,
): TimelineItem {
  const type = stringValue(rawItem.type) ?? "unknown";
  const id = stringValue(rawItem.id) ?? `${stringValue(turn.id) ?? "turn"}:${index}`;
  const timestamp = timestampFromUnix(turn.completedAt ?? turn.startedAt);

  if (type === "userMessage") {
    const content = Array.isArray(rawItem.content)
      ? rawItem.content.map(displayUserInput).filter((value): value is string => value !== null)
      : [];
    return {
      id,
      kind: "user",
      title: "You",
      body: clipped(content.join("\n"), MAX_TIMELINE_BODY_LENGTH),
      timestamp,
    };
  }
  if (type === "agentMessage") {
    return {
      id,
      kind: "assistant",
      title: rawItem.phase === "final_answer" ? "Agent response" : "Agent",
      body: clipped(stringValue(rawItem.text) ?? "", MAX_TIMELINE_BODY_LENGTH),
      timestamp,
    };
  }
  if (type === "plan") {
    return {
      id,
      kind: "assistant",
      title: "Plan",
      body: clipped(stringValue(rawItem.text) ?? "", MAX_TIMELINE_BODY_LENGTH),
      timestamp,
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(rawItem.summary)
      ? rawItem.summary.filter((value): value is string => typeof value === "string")
      : [];
    const content = Array.isArray(rawItem.content)
      ? rawItem.content.filter((value): value is string => typeof value === "string")
      : [];
    return {
      id,
      kind: "reasoning",
      title: "Reasoning",
      body: clipped([...summary, ...content].join("\n"), MAX_TIMELINE_BODY_LENGTH),
      timestamp,
    };
  }
  if (type === "commandExecution") {
    const command = stringValue(rawItem.command) ?? "Command";
    const exitCode = numberValue(rawItem.exitCode);
    const durationMs = numberValue(rawItem.durationMs);
    return {
      id,
      kind: "command",
      title: clipped(command, MAX_TITLE_LENGTH),
      body: clipped(stringValue(rawItem.aggregatedOutput) ?? command, MAX_TIMELINE_BODY_LENGTH),
      ...(itemStatus(rawItem.status) ? { status: itemStatus(rawItem.status) } : {}),
      timestamp,
      metadata: {
        ...(exitCode === null ? {} : { exitCode }),
        ...(durationMs === null ? {} : { durationMs }),
      },
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(rawItem.changes) ? rawItem.changes : [];
    const descriptions = changes.flatMap((change) => {
      const candidate = record(change);
      const path = stringValue(candidate?.path);
      if (!path) return [];
      const kind = enumLabel(candidate?.kind) ?? "update";
      const diff = stringValue(candidate?.diff);
      return [`${kind}: ${path}${diff ? `\n${diff}` : ""}`];
    });
    return {
      id,
      kind: "file_change",
      title: changes.length === 1 ? "1 file changed" : `${changes.length} files changed`,
      body: clipped(descriptions.join("\n"), MAX_TIMELINE_BODY_LENGTH),
      ...(itemStatus(rawItem.status) ? { status: itemStatus(rawItem.status) } : {}),
      timestamp,
      metadata: { fileCount: changes.length },
    };
  }

  if (type === "collabAgentToolCall") {
    const tool = stringValue(rawItem.tool) ?? "collaboration";
    const receivers = Array.isArray(rawItem.receiverThreadIds)
      ? rawItem.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    return {
      id,
      kind: "system",
      title: `Agent ${tool}`,
      body: clipped(stringValue(rawItem.prompt) ?? "", MAX_TIMELINE_BODY_LENGTH),
      ...(itemStatus(rawItem.status) ? { status: itemStatus(rawItem.status) } : {}),
      timestamp,
      metadata: {
        tool,
        receiverCount: receivers.length,
        ...(stringValue(rawItem.senderThreadId)
          ? { senderThreadId: stringValue(rawItem.senderThreadId)! }
          : {}),
      },
    };
  }
  if (type === "subAgentActivity") {
    return {
      id,
      kind: "system",
      title: `Agent ${stringValue(rawItem.kind) ?? "activity"}`,
      body: stringValue(rawItem.agentPath) ?? "",
      timestamp,
      metadata: {
        ...(stringValue(rawItem.agentThreadId)
          ? { agentThreadId: stringValue(rawItem.agentThreadId)! }
          : {}),
      },
    };
  }

  const toolName =
    stringValue(rawItem.tool) ?? stringValue(rawItem.name) ?? stringValue(rawItem.server);
  return {
    id,
    kind: "system",
    title: toolName ? `${type}: ${toolName}` : type,
    body: "",
    ...(itemStatus(rawItem.status) ? { status: itemStatus(rawItem.status) } : {}),
    timestamp,
  };
}

function timelineFromThread(rawThread: Record<string, unknown>, limit: number): TimelineItem[] {
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const timeline: TimelineItem[] = [];
  for (const rawTurn of turns) {
    const turn = record(rawTurn);
    if (!turn) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    items.forEach((rawItem, index) => {
      const item = record(rawItem);
      if (item) timeline.push(timelineItem(item, turn, index));
    });

    const error = record(turn.error);
    const errorMessage = stringValue(error?.message);
    if (errorMessage) {
      timeline.push({
        id: `${stringValue(turn.id) ?? "turn"}:error`,
        kind: "system",
        title: "Turn failed",
        body: clipped(errorMessage, MAX_TIMELINE_BODY_LENGTH),
        status: "failed",
        timestamp: timestampFromUnix(turn.completedAt ?? turn.startedAt),
      });
    }
  }
  return timeline.slice(-limit);
}

function runtimeKey(identity: CodexUserIdentity): string {
  const digest = createHash("sha256")
    .update(identity.tenantId)
    .update("\0")
    .update(identity.userId)
    .digest("hex");
  return `tenant-user-${digest}`;
}

function pathProjectId(path: string): string {
  return `path-${createHash("sha256").update(path).digest("hex")}`;
}

function emptySnapshot(): RuntimeDashboardSnapshot {
  return { projects: [], threads: [], featuredThread: null };
}

export class CodexHarnessAdapter implements HarnessRuntime {
  readonly manager: CodexRuntimeManager;
  private readonly store: HarnessStore;
  private readonly config: HarnessConfig;
  private readonly threadLimit: number;
  private readonly timelineItemLimit: number;

  constructor(options: CodexHarnessAdapterOptions) {
    this.store = options.store;
    this.config = options.config;
    this.threadLimit = positiveLimit(options.threadLimit, DEFAULT_THREAD_LIMIT, "threadLimit");
    this.timelineItemLimit = positiveLimit(
      options.timelineItemLimit,
      DEFAULT_TIMELINE_ITEM_LIMIT,
      "timelineItemLimit",
    );
    this.manager =
      options.manager ??
      new CodexRuntimeManager({
        runtimeDataDir: options.config.runtimeDataDir,
        allowedWorkspaceRoots: options.config.allowedWorkspaceRoots,
        codexBinary: options.config.codexBinary,
        experimentalApi: options.config.codexExperimentalApi,
      });
  }

  async dashboardSnapshot(identity: CodexUserIdentity): Promise<RuntimeDashboardSnapshot> {
    this.assertIdentity(identity);
    const provider = this.store.getDefaultProviderRow(identity.tenantId);
    if (!provider) return emptySnapshot();
    const { runtime } = await this.runtimeContext(identity, provider);
    const response = await runtime.request<JsonObject>("thread/list", {
      limit: this.threadLimit,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
    });
    const rawThreads = Array.isArray(response.data)
      ? response.data.map(record).filter((value): value is Record<string, unknown> => value !== null)
      : [];
    const authorizedThreads = (
      await Promise.all(
        rawThreads.map((thread) => this.authorizedDashboardThread(identity, runtime, thread)),
      )
    ).filter((thread): thread is AuthorizedRuntimeThread => thread !== null);
    const projects = this.projectMapping(identity.tenantId, authorizedThreads);
    const modelFallback = provider.default_model ?? provider.name;
    const summaries = authorizedThreads.flatMap(({ raw }) => {
      const summary = this.threadSummary(raw, projects.byThreadId, modelFallback);
      return summary ? [summary] : [];
    });
    const featuredSummary = summaries[0];
    if (!featuredSummary) {
      return { projects: projects.projects, threads: summaries, featuredThread: null };
    }

    let timeline: TimelineItem[] = [];
    let hydratedFeaturedSummary = featuredSummary;
    try {
      const readResponse = await runtime.request<JsonObject>("thread/read", {
        threadId: featuredSummary.id,
        includeTurns: true,
      });
      const readThread = record(readResponse.thread);
      const authorized = authorizedThreads.find(
        (thread) => thread.threadId === featuredSummary.id,
      );
      const readWorkspace = stringValue(readThread?.cwd);
      if (readThread && authorized && readWorkspace) {
        const canonicalReadWorkspace = await this.manager.resolveWorkspacePath(readWorkspace);
        if (
          canonicalReadWorkspace === authorized.workspacePath &&
          this.store.isWorkspaceGranted(identity.tenantId, canonicalReadWorkspace)
        ) {
          timeline = timelineFromThread(readThread, this.timelineItemLimit);
          hydratedFeaturedSummary =
            this.threadSummary(readThread, projects.byThreadId, modelFallback) ?? featuredSummary;
        }
      }
    } catch {
      // The list response is still useful if a rollout disappears or cannot be hydrated.
    }

    return {
      projects: projects.projects,
      threads: summaries.map((thread) =>
        thread.id === hydratedFeaturedSummary.id ? hydratedFeaturedSummary : thread,
      ),
      featuredThread: { thread: hydratedFeaturedSummary, timeline },
    };
  }

  async threadSnapshot(
    identity: CodexUserIdentity & { threadId: string },
  ): Promise<ThreadDetailPayload | null> {
    this.assertIdentity(identity);
    const provider = this.store.getDefaultProviderRow(identity.tenantId);
    if (!provider) return null;
    const { runtime } = await this.runtimeContext(identity, provider);
    const response = await runtime.request<JsonObject>("thread/read", {
      threadId: identity.threadId,
      includeTurns: true,
    });
    const rawThread = record(response.thread);
    if (!rawThread || stringValue(rawThread.id) !== identity.threadId) return null;

    const authorized = await this.authorizedDashboardThread(identity, runtime, rawThread);
    const readWorkspace = stringValue(rawThread.cwd);
    if (!authorized || !readWorkspace) return null;
    let canonicalReadWorkspace: string;
    try {
      canonicalReadWorkspace = await this.manager.resolveWorkspacePath(readWorkspace);
    } catch {
      return null;
    }
    if (canonicalReadWorkspace !== authorized.workspacePath) return null;

    const projects = this.projectMapping(identity.tenantId, [authorized]);
    const thread = this.threadSummary(
      rawThread,
      projects.byThreadId,
      provider.default_model ?? provider.name,
    );
    if (!thread) return null;
    return {
      thread,
      timeline: timelineFromThread(rawThread, this.timelineItemLimit),
    };
  }

  async forUser(
    identity: CodexUserIdentity,
    expectedRoute?: CodexExpectedRoute,
  ): Promise<CodexUserRouteBridge> {
    this.assertIdentity(identity);
    const provider = expectedRoute
      ? this.store.getProviderRow(identity.tenantId, expectedRoute.providerId)
      : this.store.getDefaultProviderRow(identity.tenantId);
    if (!provider) {
      throw new CodexAdapterConfigurationError("No enabled provider is configured for this tenant");
    }
    if (
      expectedRoute
      && (provider.enabled !== 1 || provider.default_model !== expectedRoute.model)
    ) {
      throw new CodexAdapterConfigurationError(
        "The model route changed after this run was admitted",
      );
    }
    const { runtime } = await this.runtimeContext(identity, provider);
    const publicUserId = identity.userId;

    return {
      request: <Result extends JsonValue = JsonValue>(
        method: string,
        params?: JsonValue,
        options?: CodexRequestOptions,
      ) => runtime.request<Result>(method, params, options),
      notify: (method, params) => runtime.notify(method, params),
      respond: (requestId, result = null) => runtime.respond(requestId, result),
      respondError: (requestId, code, message, data) =>
        runtime.respondError(requestId, code, message, data),
      subscribe: (listener, options) =>
        runtime.subscribe(
          (event) => listener({ ...event, userId: publicUserId }),
          options,
        ),
      resolveWorkspacePath: (requestedPath) => this.manager.resolveWorkspacePath(requestedPath),
      startThread: async <Result extends JsonValue = JsonValue>(
        workspacePath: string,
        params: JsonObject = {},
        options?: CodexRequestOptions,
      ) => {
        const cwd = await this.manager.resolveWorkspacePath(workspacePath);
        return runtime.request<Result>("thread/start", { ...params, cwd }, options);
      },
    };
  }

  async health(): Promise<RuntimeHealth> {
    return {
      status: "ready",
      activeRuntimes: this.manager.activeUserIds().length,
    };
  }

  async close(): Promise<void> {
    await this.manager.shutdown();
  }

  private assertIdentity(identity: CodexUserIdentity): void {
    const user = this.store.getUserSummary(identity.userId);
    if (!user || user.tenantId !== identity.tenantId || user.status !== "active") {
      throw new CodexAdapterConfigurationError("User does not belong to the requested tenant");
    }
  }

  private providerConfig(provider: ProviderRow): CodexProviderConfig {
    const model = stringValue(provider.default_model);
    if (!model) {
      throw new CodexAdapterConfigurationError("The default provider has no model configured");
    }
    let credential: string | null = null;
    if (provider.credential_ciphertext) {
      try {
        credential = decryptSecret(
          provider.credential_ciphertext,
          this.config.credentialEncryptionKey,
        );
      } catch (error) {
        throw new CodexAdapterConfigurationError("The provider credential could not be decrypted", {
          cause: error,
        });
      }
    }

    if (provider.adapter === "ollama") {
      return {
        adapter: "ollama",
        model,
        baseUrl: provider.base_url,
      };
    }
    const baseUrl = stringValue(provider.base_url) ??
      (provider.adapter === "litellm" ? this.config.litellmBaseUrl : null);
    if (!baseUrl) {
      throw new CodexAdapterConfigurationError("The default provider has no base URL configured");
    }
    return {
      adapter: "responses",
      name: provider.name,
      baseUrl,
      model,
      apiKey:
        provider.adapter === "litellm"
          ? credential ?? this.config.litellmMasterKey
          : credential,
    };
  }

  private async runtimeContext(
    identity: CodexUserIdentity,
    provider: ProviderRow,
  ): Promise<RuntimeContext> {
    const key = runtimeKey(identity);
    const launch = { provider: this.providerConfig(provider) };
    try {
      const runtime = await this.manager.startUser(key, launch);
      return { runtime, provider };
    } catch (error) {
      if (!(error instanceof CodexRuntimeConfigurationError)) throw error;
      const runtime = await this.manager.restartUser(key, launch);
      return { runtime, provider };
    }
  }

  private async authorizedDashboardThread(
    identity: CodexUserIdentity,
    runtime: CodexRuntime,
    raw: Record<string, unknown>,
  ): Promise<AuthorizedRuntimeThread | null> {
    const threadId = stringValue(raw.id);
    if (!threadId) return null;
    const existing = this.store.getThreadWorkspaceBinding(
      identity.tenantId,
      identity.userId,
      threadId,
    );
    let workspacePath = existing?.workspacePath ?? null;

    if (!workspacePath) {
      try {
        const response = await runtime.request<JsonObject>("thread/read", {
          threadId,
          includeTurns: false,
        });
        const thread = record(response.thread);
        if (stringValue(thread?.id) !== threadId) return null;
        workspacePath = stringValue(thread?.cwd);
      } catch {
        return null;
      }
    }
    if (!workspacePath) return null;

    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await this.manager.resolveWorkspacePath(workspacePath);
    } catch {
      return null;
    }
    if (existing && canonicalWorkspace !== existing.workspacePath) return null;
    if (!this.store.isWorkspaceGranted(identity.tenantId, canonicalWorkspace)) return null;
    if (!existing) {
      try {
        this.store.bindThreadWorkspace({
          tenantId: identity.tenantId,
          userId: identity.userId,
          threadId,
          workspacePath: canonicalWorkspace,
        });
      } catch {
        return null;
      }
    }
    return { raw, threadId, workspacePath: canonicalWorkspace };
  }

  private projectMapping(
    tenantId: string,
    rawThreads: readonly AuthorizedRuntimeThread[],
  ): ProjectMapping {
    const projectsById = new Map<string, ProjectSummary>();
    const byThreadId = new Map<string, ProjectSummary>();
    const savedProjectsByPath = new Map<string, SavedProjectRecord | null>();

    for (const { raw, threadId, workspacePath } of rawThreads) {
      let savedProject = savedProjectsByPath.get(workspacePath);
      if (!savedProjectsByPath.has(workspacePath)) {
        savedProject = this.store.findSavedProjectByWorkspacePath(tenantId, workspacePath);
        savedProjectsByPath.set(workspacePath, savedProject);
      }
      const id =
        savedProject?.id ?? stringValue(raw.projectId) ?? pathProjectId(workspacePath);
      const gitInfo = record(raw.gitInfo);
      const candidate: ProjectSummary = {
        id,
        name: savedProject?.name ?? (basename(workspacePath) || workspacePath),
        path: workspacePath,
        branch: stringValue(gitInfo?.branch),
        isGitRepository: gitInfo !== null,
      };
      const project = projectsById.get(id) ?? candidate;
      projectsById.set(id, project);
      byThreadId.set(threadId, project);
    }

    return { projects: [...projectsById.values()], byThreadId };
  }

  private threadSummary(
    thread: Record<string, unknown>,
    projects: ReadonlyMap<string, ProjectSummary>,
    modelFallback: string,
  ): ThreadSummary | null {
    const id = stringValue(thread.id);
    if (!id) return null;
    const preview = clipped(stringValue(thread.preview) ?? "", MAX_PREVIEW_LENGTH);
    const firstPreviewLine = preview.split("\n", 1)[0] ?? "";
    const project = projects.get(id);
    if (!project) return null;
    const updatedAt = thread.recencyAt ?? thread.updatedAt ?? thread.createdAt;
    const parentThreadId = stringValue(thread.parentThreadId);
    const forkedFromId = stringValue(thread.forkedFromId);
    const agentNickname = stringValue(thread.agentNickname);
    const agentRole = stringValue(thread.agentRole);
    const source = enumLabel(thread.threadSource) ?? enumLabel(thread.source);
    // Present only once the runtime reports it; null while a thread is unloaded.
    const reasoningEffort = enumLabel(thread.reasoningEffort);
    const currentTurnId = activeTurnId(thread);
    return {
      id,
      title: clipped(
        stringValue(thread.name) ?? (firstPreviewLine || "Untitled task"),
        MAX_TITLE_LENGTH,
      ),
      projectId: project.id,
      projectName: project.name,
      status: threadStatus(thread.status),
      // Codex reports the thread's configured model, but leaves it null when the
      // thread is unloaded. Fall back to the tenant route so the UI never shows
      // an adapter name in place of a model.
      model: stringValue(thread.model) ?? modelFallback,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      updatedAt: timestampFromUnix(updatedAt),
      preview,
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(forkedFromId ? { forkedFromId } : {}),
      ...(agentNickname ? { agentNickname } : {}),
      ...(agentRole ? { agentRole } : {}),
      ...(source ? { source } : {}),
      ...(currentTurnId ? { activeTurnId: currentTurnId } : {}),
    };
  }
}
