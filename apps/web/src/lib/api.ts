import type {
  AuditEventSummary,
  CreateTaskPayload,
  DashboardPayload,
  PlanId,
  ProjectDetailPayload,
  ProjectListPayload,
  ProviderConnection,
  RegisterProjectPayload,
  ReviewTarget,
  ThreadDetailPayload,
  UpdateProjectPayload,
  UserRole,
  UserStatus,
  UserSummary,
} from "@agent-harness/contracts";

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export type RuntimeCapabilitySection<T> =
  | { status: "available"; data: T; error: null }
  | { status: "unavailable"; data: null; error: { code: string; message: string } };

export interface RuntimeCapabilitiesPayload {
  generatedAt: string;
  skills: RuntimeCapabilitySection<{
    items: Array<{
      name: string;
      displayName: string | null;
      description: string;
      scope: string;
      pluginId: string | null;
      enabledInWorkspaceCount: number;
    }>;
    workspaceCount: number;
    loadErrorCount: number;
    truncated: boolean;
  }>;
  mcpServers: RuntimeCapabilitySection<{
    items: Array<{
      name: string;
      pluginId: string | null;
      runtimeStatus: string | null;
      authStatus: string | null;
      tools: string[];
      toolsTruncated: boolean;
    }>;
    truncated: boolean;
  }>;
  models: RuntimeCapabilitySection<{
    items: Array<{
      id: string;
      model: string;
      displayName: string;
      hidden: boolean;
      isDefault: boolean;
      multiAgentVersion: "disabled" | "v1" | "v2" | null;
    }>;
    truncated: boolean;
  }>;
  providerCapabilities: RuntimeCapabilitySection<{
    namespaceTools: boolean;
    imageGeneration: boolean;
    webSearch: boolean;
  }>;
  permissionProfiles: RuntimeCapabilitySection<{
    items: Array<{
      id: string;
      description: string | null;
      availableInWorkspaceCount: number;
      allowedInWorkspaceCount: number;
    }>;
    workspaceCount: number;
    truncated: boolean;
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const data = (await response.json().catch(() => null)) as
    | { error?: string; message?: string }
    | T
    | null;

  if (!response.ok) {
    const failure = data as { error?: string; message?: string } | null;
    throw new ApiClientError(
      response.status,
      failure?.error ?? "request_failed",
      failure?.message ?? `Request failed with status ${response.status}`,
    );
  }

  return data as T;
}

function idempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: UserSummary }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  me: () => request<{ user: UserSummary }>("/api/auth/me"),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ user: UserSummary }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  dashboard: () => request<DashboardPayload>("/api/dashboard"),

  listProjects: (limit = 50, cursor?: string) => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (cursor) search.set("cursor", cursor);
    return request<ProjectListPayload>(`/api/projects?${search.toString()}`);
  },

  registerProject: (input: RegisterProjectPayload) =>
    request<ProjectDetailPayload>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateProject: (projectId: string, input: UpdateProjectPayload) =>
    request<ProjectDetailPayload>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  capabilities: () => request<RuntimeCapabilitiesPayload>("/api/capabilities"),

  createTask: <T>(input: CreateTaskPayload, requestKey = idempotencyKey()) =>
    request<{ result: T; replayed?: true }>("/api/tasks", {
      method: "POST",
      headers: { "idempotency-key": requestKey },
      body: JSON.stringify(input),
    }),

  thread: (threadId: string) =>
    request<ThreadDetailPayload>(`/api/codex/threads/${encodeURIComponent(threadId)}`),

  listUsers: () => request<{ users: UserSummary[] }>("/api/users"),

  listAuditEvents: (limit = 100) =>
    request<{ events: AuditEventSummary[] }>(`/api/audit?limit=${limit}`),

  createUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
  }) =>
    request<{ user: UserSummary }>("/api/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  setUserStatus: (userId: string, status: UserStatus) =>
    request<{ user: UserSummary }>(`/api/users/${userId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  saveProvider: (input: {
    id?: string;
    catalogId: string;
    name?: string;
    baseUrl?: string | null;
    defaultModel?: string | null;
    apiKey?: string;
    enabled?: boolean;
    isDefault?: boolean;
  }) => {
    const { id, apiKey, ...provider } = input;
    return request<{ provider: ProviderConnection }>(
      id ? `/api/providers/${id}` : "/api/providers",
      {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify({
          ...provider,
          ...(apiKey === undefined ? {} : { credential: apiKey }),
        }),
      },
    );
  },

  deleteProvider: (id: string) =>
    request<{ ok: true }>(`/api/providers/${id}`, { method: "DELETE" }),

  createCheckout: (plan: Exclude<PlanId, "free" | "enterprise">) =>
    request<{ url?: string; setupRequired?: boolean; message?: string }>(
      "/api/billing/checkout",
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey() },
        body: JSON.stringify({ plan }),
      },
    ),

  createPortal: () =>
    request<{ url?: string; setupRequired?: boolean; message?: string }>(
      "/api/billing/portal",
      { method: "POST" },
    ),

  codexRequest: <T>(method: string, params?: unknown, requestKey = idempotencyKey()) =>
    request<{ result: T }>("/api/codex/request", {
      method: "POST",
      headers: { "idempotency-key": requestKey },
      body: JSON.stringify({ method, params }),
    }),

  startReview: <T>(threadId: string, target: ReviewTarget) =>
    request<{ result: T }>("/api/codex/request", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey() },
      body: JSON.stringify({ method: "review/start", params: { threadId, target } }),
    }),

  renameTask: (threadId: string, name: string) =>
    request<{ result: Record<string, never> }>(
      `/api/tasks/${encodeURIComponent(threadId)}/name`,
      {
        method: "PATCH",
        headers: { "idempotency-key": idempotencyKey() },
        body: JSON.stringify({ name }),
      },
    ),

  forkTask: (threadId: string, lastTurnId?: string | null) =>
    request<{
      result: {
        thread: { id: string; cwd?: string };
        cwd?: string;
      };
    }>(`/api/tasks/${encodeURIComponent(threadId)}/actions/fork`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey() },
      body: JSON.stringify({ lastTurnId: lastTurnId ?? null }),
    }),

  archiveTask: (threadId: string) =>
    request<{ result: Record<string, never> }>(
      `/api/tasks/${encodeURIComponent(threadId)}/actions/archive`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey() },
      },
    ),

  restoreTask: (threadId: string) =>
    request<{ result: { thread?: { id: string } } }>(
      `/api/tasks/${encodeURIComponent(threadId)}/actions/unarchive`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey() },
      },
    ),

  interruptTurn: (threadId: string, turnId: string) =>
    request<{ result: Record<string, never> }>(
      `/api/tasks/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/actions/interrupt`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey() },
      },
    ),

  steerTurn: (
    threadId: string,
    turnId: string,
    text: string,
    requestKey = idempotencyKey(),
  ) =>
    request<{ result: { turnId: string } }>(
      `/api/tasks/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/actions/steer`,
      {
        method: "POST",
        headers: { "idempotency-key": requestKey },
        body: JSON.stringify({ input: [{ type: "text", text }] }),
      },
    ),

  resolveCodexApproval: (
    requestId: string | number,
    method:
      | "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval",
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ) =>
    request<{ ok: true }>("/api/codex/approval", {
      method: "POST",
      body: JSON.stringify({ requestId, method, decision }),
    }),
};
