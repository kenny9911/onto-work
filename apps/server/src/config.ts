import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4310;
const DEFAULT_SESSION_TTL_HOURS = 24 * 7;

/**
 * Uploads are durable customer documents, so they live outside both the
 * process-scratch runtime tree and every granted workspace root. `buildApp`
 * refuses to start when this path overlaps `ALLOWED_WORKSPACE_ROOTS`.
 */
export function defaultUploadDataDir(): string {
  return resolve(homedir(), ".agent-harness", "uploads");
}

function integerFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredSecret(name: string, value: string | undefined): string {
  if (value && value.length >= 24 && !value.startsWith("replace-with")) return value;
  if (process.env.NODE_ENV !== "production") {
    return `development-only-${name.toLowerCase()}-agent-harness`;
  }
  throw new Error(`${name} must be set to a strong secret in production`);
}

function enabledFeatureFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function workspaceRoots(value: string | undefined): string[] {
  const defaults = [resolve(process.cwd(), "../..")];
  const candidates = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? defaults;
  return [...new Set(candidates.map((item) => resolve(item)))];
}

export interface HarnessConfig {
  /** Deployment-owned opt-in. Credentials and executor configuration never enter browser payloads. */
  agentsApi?: AgentsApiConfig;
  host: string;
  port: number;
  webOrigin: string;
  databasePath: string;
  runtimeDataDir: string;
  /** Server-owned durable upload store; must not overlap `allowedWorkspaceRoots`. */
  uploadDataDir: string;
  sessionTtlMs: number;
  sessionSecret: string;
  credentialEncryptionKey: string;
  codexBinary: string;
  codexExperimentalApi: boolean;
  /** Deployment-owned catalog directory; never accepted from the browser. */
  sharedSkillsDir?: string;
  allowedWorkspaceRoots: string[];
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  stripePricePro: string | null;
  stripePriceTeam: string | null;
  publicAppUrl: string;
  litellmBaseUrl: string;
  litellmMasterKey: string | null;
  /** Deployment-owned escape hatch; never exposed through a tenant API. */
  allowPrivateProviderEndpoints?: boolean;
}

export interface AgentsApiConfig {
  enabled: boolean;
  apiKey: string | null;
  executorKey: string | null;
  model: string;
  executorImage: string | null;
  maxConcurrentSessions: number;
  maxTurnSeconds: number;
  skillIds: string[];
  /** Explicit deployment pilot allowlist. Missing or empty denies managed admission. */
  allowedTenantIds?: string[];
}

/** Invalid limits remain invalid so managed availability fails closed without
 * preventing unrelated native-runtime startup. Never parse a prefix like "2abc". */
function managedInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
}

export function loadAgentsApiConfig(env: NodeJS.ProcessEnv = process.env): AgentsApiConfig {
  return {
    enabled: enabledFeatureFlag(env.AGENTS_API_ENABLED),
    apiKey: env.AGENTS_API_KEY?.trim() || null,
    executorKey: env.AGENTS_API_EXECUTOR_KEY?.trim() || null,
    model: env.AGENTS_API_MODEL?.trim() || "gpt-6-astra",
    executorImage: env.AGENTS_API_EXECUTOR_IMAGE?.trim() || null,
    maxConcurrentSessions: managedInteger(env.AGENTS_API_MAX_CONCURRENT_SESSIONS, 2),
    maxTurnSeconds: managedInteger(env.AGENTS_API_MAX_TURN_SECONDS, 600),
    skillIds: [...new Set((env.AGENTS_API_SKILL_IDS || "").split(",").map((id) => id.trim()).filter(Boolean))],
    allowedTenantIds: [...new Set((env.AGENTS_API_ALLOWED_TENANT_IDS || "").split(",").map((id) => id.trim()).filter(Boolean))],
  };
}

export function loadConfig(): HarnessConfig {
  return {
    agentsApi: loadAgentsApiConfig(),
    host: process.env.HOST ?? "127.0.0.1",
    port: integerFromEnv(process.env.PORT, DEFAULT_PORT),
    webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:3590",
    databasePath: resolve(process.env.DATABASE_PATH ?? "./data/agent-harness.db"),
    runtimeDataDir: resolve(process.env.RUNTIME_DATA_DIR ?? "./data/runtimes"),
    uploadDataDir: resolve(process.env.UPLOAD_DATA_DIR || defaultUploadDataDir()),
    sessionTtlMs:
      integerFromEnv(process.env.SESSION_TTL_HOURS, DEFAULT_SESSION_TTL_HOURS) *
      60 *
      60 *
      1_000,
    sessionSecret: requiredSecret("SESSION_SECRET", process.env.SESSION_SECRET),
    credentialEncryptionKey: requiredSecret(
      "CREDENTIAL_ENCRYPTION_KEY",
      process.env.CREDENTIAL_ENCRYPTION_KEY,
    ),
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    codexExperimentalApi: enabledFeatureFlag(process.env.CODEX_EXPERIMENTAL_API),
    sharedSkillsDir: resolve(process.env.SHARED_SKILLS_DIR || fileURLToPath(new URL("../../../shared", import.meta.url))),
    allowedWorkspaceRoots: workspaceRoots(process.env.ALLOWED_WORKSPACE_ROOTS),
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    stripePricePro: process.env.STRIPE_PRICE_PRO || null,
    stripePriceTeam: process.env.STRIPE_PRICE_TEAM || null,
    publicAppUrl: process.env.PUBLIC_APP_URL ?? "http://127.0.0.1:3590",
    litellmBaseUrl: process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000/v1",
    litellmMasterKey: process.env.LITELLM_MASTER_KEY || null,
    allowPrivateProviderEndpoints: enabledFeatureFlag(
      process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS,
    ),
  };
}
