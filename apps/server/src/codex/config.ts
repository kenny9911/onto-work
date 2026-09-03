import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PROVIDER_ID = "agent_harness";
const PROVIDER_API_KEY_ENV = "AGENT_HARNESS_PROVIDER_API_KEY";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const MAX_USER_ID_LENGTH = 512;
const MAX_CONFIG_VALUE_LENGTH = 8_192;
const SHELL_ENVIRONMENT_POLICY = [
  "[shell_environment_policy]",
  'inherit = "core"',
  "ignore_default_excludes = false",
  `exclude = [${tomlString(PROVIDER_API_KEY_ENV)}, "CODEX_OSS_BASE_URL"]`,
  "",
];

export interface ResponsesProviderConfig {
  adapter: "responses";
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}

export interface OllamaProviderConfig {
  adapter: "ollama";
  model: string;
  baseUrl?: string | null;
}

export type CodexProviderConfig = ResponsesProviderConfig | OllamaProviderConfig;

export interface RenderedCodexConfig {
  toml: string;
  environment: Readonly<Record<string, string>>;
  fingerprint: string;
}

export interface UserRuntimePaths {
  runtimeDir: string;
  codexHome: string;
  processHome: string;
  processCwd: string;
  configPath: string;
  userDirectoryKey: string;
}

function nonEmptyConfigValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > MAX_CONFIG_VALUE_LENGTH) {
    throw new Error(`${field} is too long`);
  }
  if (/\0/.test(normalized)) throw new Error(`${field} contains a NUL byte`);
  return normalized;
}

function normalizeBaseUrl(value: string, field: string): string {
  const raw = nonEmptyConfigValue(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${field} must not contain embedded credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${field} must not contain a query string or fragment`);
  }

  return url.toString().replace(/\/$/, "");
}

function tomlString(value: string): string {
  // TOML basic strings support the same escapes emitted by JSON.stringify for
  // these scalar values. Escape line separators explicitly for predictable files.
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function renderCodexConfig(provider: CodexProviderConfig): RenderedCodexConfig {
  const model = nonEmptyConfigValue(provider.model, "provider.model");

  if (provider.adapter === "ollama") {
    const baseUrl = normalizeBaseUrl(
      provider.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      "provider.baseUrl",
    );
    const toml = [
      `model = ${tomlString(model)}`,
      'model_provider = "ollama"',
      'oss_provider = "ollama"',
      "",
      ...SHELL_ENVIRONMENT_POLICY,
    ].join("\n");

    return {
      toml,
      environment: { CODEX_OSS_BASE_URL: baseUrl },
      fingerprint: fingerprint({ adapter: provider.adapter, model, baseUrl }),
    };
  }

  const name = nonEmptyConfigValue(provider.name, "provider.name");
  const baseUrl = normalizeBaseUrl(provider.baseUrl, "provider.baseUrl");
  const apiKey = provider.apiKey?.trim() || null;
  if (apiKey?.includes("\0")) throw new Error("provider.apiKey contains a NUL byte");
  const providerLines = [
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${tomlString(name)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
  ];
  const environment: Record<string, string> = {};

  if (apiKey) {
    providerLines.push(`env_key = ${tomlString(PROVIDER_API_KEY_ENV)}`);
    environment[PROVIDER_API_KEY_ENV] = apiKey;
  }

  const toml = [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(PROVIDER_ID)}`,
    "",
    ...providerLines,
    "",
    ...SHELL_ENVIRONMENT_POLICY,
  ].join("\n");

  return {
    toml,
    environment,
    fingerprint: fingerprint({
      adapter: provider.adapter,
      name,
      baseUrl,
      model,
      apiKey,
    }),
  };
}

function validateUserId(userId: string): string {
  if (!userId || !userId.trim()) throw new Error("userId must not be empty");
  if (userId.length > MAX_USER_ID_LENGTH) throw new Error("userId is too long");
  return userId;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // mkdir's mode is affected by umask and does not update pre-existing paths.
  await chmod(path, 0o700);
}

export async function prepareUserRuntimePaths(
  runtimeDataDir: string,
  userId: string,
): Promise<UserRuntimePaths> {
  const validatedUserId = validateUserId(userId);
  const baseDir = resolve(runtimeDataDir);
  await privateDirectory(baseDir);
  const canonicalBaseDir = await realpath(baseDir);

  // User-controlled identifiers never become path components directly.
  const userDirectoryKey = createHash("sha256").update(validatedUserId).digest("hex");
  const runtimeDir = join(canonicalBaseDir, "users", userDirectoryKey);
  if (!isWithin(canonicalBaseDir, runtimeDir)) {
    throw new Error("Unable to derive a safe user runtime path");
  }

  const codexHome = join(runtimeDir, "codex-home");
  const processHome = join(runtimeDir, "home");
  const processCwd = join(runtimeDir, "workspace");
  await Promise.all([
    privateDirectory(runtimeDir),
    privateDirectory(codexHome),
    privateDirectory(processHome),
    privateDirectory(processCwd),
  ]);

  return {
    runtimeDir,
    codexHome,
    processHome,
    processCwd,
    configPath: join(codexHome, "config.toml"),
    userDirectoryKey,
  };
}

export async function resolveAllowedWorkspacePath(
  requestedPath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(requestedPath)) {
    throw new Error("workspacePath must be absolute");
  }
  if (allowedRoots.length === 0) {
    throw new Error("No workspace roots are configured");
  }

  const candidate = await realpath(requestedPath);
  const candidateStat = await stat(candidate);
  if (!candidateStat.isDirectory()) throw new Error("workspacePath must be a directory");

  for (const allowedRoot of allowedRoots) {
    const canonicalRoot = await realpath(resolve(allowedRoot));
    if (isWithin(canonicalRoot, candidate)) return candidate;
  }

  throw new Error("workspacePath is outside the configured workspace roots");
}

export async function writeCodexConfig(
  configPath: string,
  toml: string,
): Promise<void> {
  const parent = dirname(resolve(configPath));
  await privateDirectory(parent);
  const target = resolve(configPath);
  if (!isWithin(parent, target)) throw new Error("Invalid Codex config path");

  const temporaryPath = join(parent, `.config-${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(toml, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
