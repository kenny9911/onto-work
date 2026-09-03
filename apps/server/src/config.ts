import { resolve } from "node:path";

const DEFAULT_PORT = 4310;
const DEFAULT_SESSION_TTL_HOURS = 24 * 7;

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
  host: string;
  port: number;
  webOrigin: string;
  databasePath: string;
  runtimeDataDir: string;
  sessionTtlMs: number;
  sessionSecret: string;
  credentialEncryptionKey: string;
  codexBinary: string;
  codexExperimentalApi: boolean;
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

export function loadConfig(): HarnessConfig {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: integerFromEnv(process.env.PORT, DEFAULT_PORT),
    webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:4173",
    databasePath: resolve(process.env.DATABASE_PATH ?? "./data/agent-harness.db"),
    runtimeDataDir: resolve(process.env.RUNTIME_DATA_DIR ?? "./data/runtimes"),
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
    allowedWorkspaceRoots: workspaceRoots(process.env.ALLOWED_WORKSPACE_ROOTS),
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    stripePricePro: process.env.STRIPE_PRICE_PRO || null,
    stripePriceTeam: process.env.STRIPE_PRICE_TEAM || null,
    publicAppUrl: process.env.PUBLIC_APP_URL ?? "http://127.0.0.1:4173",
    litellmBaseUrl: process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000/v1",
    litellmMasterKey: process.env.LITELLM_MASTER_KEY || null,
    allowPrivateProviderEndpoints: enabledFeatureFlag(
      process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS,
    ),
  };
}
