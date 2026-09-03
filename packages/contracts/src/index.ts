export type UserRole = "admin" | "member";
export type UserStatus = "active" | "suspended";
export type PlanId = "free" | "pro" | "team" | "enterprise";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "none";

export interface UserSummary {
  id: string;
  tenantId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SubscriptionSummary {
  plan: PlanId;
  status: SubscriptionStatus;
  seats: number;
  currentPeriodEnd: string | null;
  stripeConfigured: boolean;
}

export type ProviderFamily =
  | "router"
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "doubao"
  | "qwen"
  | "glm"
  | "local";

export type ProviderAdapter = "responses" | "litellm" | "ollama";

export interface ProviderCatalogItem {
  id: string;
  name: string;
  family: ProviderFamily;
  adapter: ProviderAdapter;
  description: string;
  defaultBaseUrl: string | null;
  defaultModel: string | null;
  keyLabel: string | null;
  local: boolean;
  nativeCodex: boolean;
}

export interface ProviderConnection {
  id: string;
  catalogId: string;
  name: string;
  adapter: ProviderAdapter;
  baseUrl: string | null;
  defaultModel: string | null;
  enabled: boolean;
  isDefault: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  isGitRepository: boolean;
  /** Present for projects registered in the durable control plane. */
  workspaceId?: string;
  enabled?: boolean;
  availability?: ProjectAvailability;
  repositoryStatus?: ProjectRepositoryStatus;
  repositoryRoot?: string | null;
  headCommit?: string | null;
  upstream?: string | null;
  dirty?: boolean | null;
  /** A credential-free, query-free display URL when an origin remote is configured. */
  remoteUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type ProjectAvailability =
  | "available"
  | "unavailable"
  | "workspace_grant_revoked";

export type ProjectRepositoryStatus =
  | "repository"
  | "not_repository"
  | "unavailable";

export interface SavedProjectSummary extends ProjectSummary {
  workspaceId: string;
  enabled: boolean;
  availability: ProjectAvailability;
  repositoryStatus: ProjectRepositoryStatus;
  repositoryRoot: string | null;
  headCommit: string | null;
  upstream: string | null;
  dirty: boolean | null;
  remoteUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListPayload {
  projects: SavedProjectSummary[];
  nextCursor: string | null;
}

export interface ProjectDetailPayload {
  project: SavedProjectSummary;
}

export interface RegisterProjectPayload {
  name: string;
  workspacePath: string;
}

export interface UpdateProjectPayload {
  name?: string;
  enabled?: boolean;
}

export interface CreateTaskPayload {
  projectId: string;
}

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type HarnessThreadStatus =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export interface ThreadSummary {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  status: HarnessThreadStatus;
  model: string;
  /**
   * Reasoning effort the runtime reports for this thread. Absent when the
   * thread is unloaded or the route does not configure one.
   */
  reasoningEffort?: string | null;
  updatedAt: string;
  preview: string;
  /** Stable Codex ancestry fields; absent when the runtime did not report them. */
  parentThreadId?: string | null;
  forkedFromId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  source?: string | null;
  /** Present only after a full authorized thread read proves an in-progress turn. */
  activeTurnId?: string | null;
}

export type TimelineItemKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "command"
  | "file_change"
  | "approval"
  | "system";

export interface TimelineItem {
  id: string;
  kind: TimelineItemKind;
  title: string;
  body: string;
  status?: "pending" | "running" | "completed" | "failed";
  timestamp: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ThreadDetailPayload {
  thread: ThreadSummary;
  timeline: TimelineItem[];
}

export interface UsageSummary {
  periodStart: string;
  periodEnd: string | null;
  requestsUsed: number;
  requestLimit: number;
  activeRuns: number;
  activeRunLimit: number;
  inputTokens: number;
  outputTokens: number;
  seatsUsed: number;
  seatLimit: number;
}

export interface AuditEventSummary {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface DashboardPayload {
  user: UserSummary;
  subscription: SubscriptionSummary;
  usage: UsageSummary;
  providers: ProviderConnection[];
  runtime: {
    status: "ready" | "not_configured" | "degraded";
    message: string | null;
    activeRuntimes: number;
  };
  projects: ProjectSummary[];
  threads: ThreadSummary[];
  featuredThread: {
    thread: ThreadSummary;
    timeline: TimelineItem[];
  } | null;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogItem[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    family: "router",
    adapter: "responses",
    description: "Route supported models through an OpenAI-compatible endpoint.",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: null,
    keyLabel: "OpenRouter API key",
    local: false,
    nativeCodex: true,
  },
  {
    id: "newapi",
    name: "NewAPI",
    family: "router",
    adapter: "responses",
    description: "Connect a private NewAPI deployment with a compatible Responses endpoint.",
    defaultBaseUrl: null,
    defaultModel: null,
    keyLabel: "NewAPI token",
    local: false,
    nativeCodex: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    family: "openai",
    adapter: "responses",
    description: "Use OpenAI models through the native Responses API.",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    keyLabel: "OpenAI API key",
    local: false,
    nativeCodex: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    family: "anthropic",
    adapter: "litellm",
    description: "Use Claude models through the configured LiteLLM translation gateway.",
    defaultBaseUrl: null,
    defaultModel: "codex-anthropic",
    keyLabel: "LiteLLM route token",
    local: false,
    nativeCodex: false,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    family: "google",
    adapter: "litellm",
    description: "Use Gemini through the configured LiteLLM translation gateway.",
    defaultBaseUrl: null,
    defaultModel: "codex-gemini",
    keyLabel: "LiteLLM route token",
    local: false,
    nativeCodex: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    family: "deepseek",
    adapter: "litellm",
    description: "Use DeepSeek coding and reasoning models through LiteLLM.",
    defaultBaseUrl: null,
    defaultModel: "codex-deepseek",
    keyLabel: "LiteLLM route token",
    local: false,
    nativeCodex: false,
  },
  {
    id: "doubao",
    name: "Doubao",
    family: "doubao",
    adapter: "litellm",
    description: "Use Volcengine Doubao models through LiteLLM.",
    defaultBaseUrl: null,
    defaultModel: "codex-doubao",
    keyLabel: "LiteLLM route token",
    local: false,
    nativeCodex: false,
  },
  {
    id: "qwen",
    name: "Qwen",
    family: "qwen",
    adapter: "litellm",
    description: "Use Alibaba Qwen models through LiteLLM.",
    defaultBaseUrl: null,
    defaultModel: "codex-qwen",
    keyLabel: "LiteLLM route token",
    local: false,
    nativeCodex: false,
  },
  {
    id: "glm",
    name: "GLM",
    family: "glm",
    adapter: "litellm",
    description: "Use Zhipu GLM models through LiteLLM.",
    defaultBaseUrl: null,
    defaultModel: "codex-glm",
    keyLabel: "LiteLLM route token",
    local: false,
    nativeCodex: false,
  },
  {
    id: "ollama",
    name: "Ollama",
    family: "local",
    adapter: "ollama",
    description: "Run local models without sending prompts off the machine.",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen3-coder",
    keyLabel: null,
    local: true,
    nativeCodex: true,
  },
] as const;
