import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  prepareUserRuntimePaths,
  renderCodexConfig,
  resolveAllowedWorkspacePath,
  writeCodexConfig,
  type CodexProviderConfig,
  type RenderedCodexConfig,
  type UserRuntimePaths,
} from "./config.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonRpcId = string | number;
export type CodexRuntimeState = "starting" | "ready" | "closing" | "closed";

export interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexInitializeResponse extends JsonObject {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexRuntimeEvent {
  sequence: number;
  userId: string;
  kind: "notification" | "server-request";
  method: string;
  params?: JsonValue;
  requestId?: JsonRpcId;
}

export type CodexRuntimeListener = (event: CodexRuntimeEvent) => void;

export interface CodexSubscriptionOptions {
  signal?: AbortSignal;
}

export interface CodexRequestOptions {
  timeoutMs?: number;
}

export interface CodexUserRuntimeOptions {
  provider: CodexProviderConfig;
  workspacePath?: string;
}

export interface CodexRuntimeManagerOptions {
  runtimeDataDir: string;
  allowedWorkspaceRoots: readonly string[];
  codexBinary?: string;
  codexArgs?: readonly string[];
  experimentalApi?: boolean;
  clientInfo?: Partial<CodexClientInfo>;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxPendingRequests?: number;
  maxProtocolLineBytes?: number;
  runtimeEnvironment?: Readonly<Record<string, string | undefined>>;
  onStderr?: (userId: string, chunk: string) => void;
  onError?: (userId: string, error: Error) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RuntimeProcessOptions {
  userId: string;
  paths: UserRuntimePaths;
  processCwd: string;
  configurationFingerprint: string;
  providerEnvironment: Readonly<Record<string, string>>;
  binary: string;
  binaryArgs: readonly string[];
  experimentalApi: boolean;
  clientInfo: CodexClientInfo;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxPendingRequests: number;
  maxProtocolLineBytes: number;
  runtimeEnvironment: Readonly<Record<string, string | undefined>>;
  onStderr?: (userId: string, chunk: string) => void;
  onError?: (userId: string, error: Error) => void;
  onExit: (runtime: CodexRuntime) => void;
}

interface ResolvedManagerOptions {
  runtimeDataDir: string;
  allowedWorkspaceRoots: readonly string[];
  codexBinary: string;
  codexArgs: readonly string[];
  experimentalApi: boolean;
  clientInfo: CodexClientInfo;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxPendingRequests: number;
  maxProtocolLineBytes: number;
  runtimeEnvironment: Readonly<Record<string, string | undefined>>;
  onStderr?: (userId: string, chunk: string) => void;
  onError?: (userId: string, error: Error) => void;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: JsonValue;
}

const DEFAULT_CLIENT_INFO: CodexClientInfo = {
  name: "agent_harness",
  title: "Agent Harness",
  version: "0.1.0",
};
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
const SUPPORTED_INTERACTIVE_SERVER_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const METHOD_NOT_FOUND = -32_601;
const SAFE_INHERITED_ENVIRONMENT = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "TZ",
] as const;

export class CodexRuntimeError extends Error {}

export class CodexRuntimeClosedError extends CodexRuntimeError {}

export class CodexRuntimeConfigurationError extends CodexRuntimeError {}

export class CodexRpcError extends CodexRuntimeError {
  constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
    public readonly data?: JsonValue,
  ) {
    super(`${method}: ${message}`);
    this.name = "CodexRpcError";
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return resolved;
}

function validateEnvironmentValue(name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid runtime environment variable name: ${name}`);
  }
  if (value.includes("\0")) {
    throw new Error(`Runtime environment variable ${name} contains a NUL byte`);
  }
}

async function buildChildEnvironment(
  paths: UserRuntimePaths,
  providerEnvironment: Readonly<Record<string, string>>,
  configuredEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_INHERITED_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(configuredEnvironment)) {
    if (value === undefined) continue;
    validateEnvironmentValue(name, value);
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(providerEnvironment)) {
    validateEnvironmentValue(name, value);
    environment[name] = value;
  }

  const xdgConfigHome = join(paths.processHome, ".config");
  const xdgCacheHome = join(paths.processHome, ".cache");
  const xdgDataHome = join(paths.processHome, ".local", "share");
  await Promise.all([
    mkdir(xdgConfigHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgCacheHome, { recursive: true, mode: 0o700 }),
    mkdir(xdgDataHome, { recursive: true, mode: 0o700 }),
  ]);

  return {
    ...environment,
    CODEX_HOME: paths.codexHome,
    HOME: paths.processHome,
    USERPROFILE: paths.processHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_DATA_HOME: xdgDataHome,
  };
}

function responseKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function rpcErrorPayload(value: unknown): JsonRpcErrorPayload {
  if (!isRecord(value)) return { code: -32_000, message: "Unknown App Server error" };
  return {
    code: typeof value.code === "number" ? value.code : -32_000,
    message: typeof value.message === "string" ? value.message : "Unknown App Server error",
    ...(value.data === undefined ? {} : { data: value.data as JsonValue }),
  };
}

function configurationFingerprint(rendered: RenderedCodexConfig, processCwd: string): string {
  return createHash("sha256")
    .update(rendered.fingerprint)
    .update("\0")
    .update(processCwd)
    .digest("hex");
}

export class CodexRuntime {
  readonly userId: string;
  readonly paths: UserRuntimePaths;
  readonly configurationFingerprint: string;

  private stateValue: CodexRuntimeState = "starting";
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<CodexRuntimeListener>();
  private writeTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | null = null;
  private sequence = 0;
  private terminalError: Error | null = null;
  private initializeResultValue: CodexInitializeResponse | null = null;

  constructor(private readonly options: RuntimeProcessOptions) {
    this.userId = options.userId;
    this.paths = options.paths;
    this.configurationFingerprint = options.configurationFingerprint;
  }

  get state(): CodexRuntimeState {
    return this.stateValue;
  }

  get processId(): number | null {
    return this.child?.pid ?? null;
  }

  get initializeResult(): CodexInitializeResponse | null {
    return this.initializeResultValue;
  }

  async start(): Promise<this> {
    if (this.child) throw new CodexRuntimeError("Codex runtime has already been started");

    const environment = await buildChildEnvironment(
      this.paths,
      this.options.providerEnvironment,
      this.options.runtimeEnvironment,
    );
    const child = spawn(
      this.options.binary,
      [...this.options.binaryArgs, "app-server", "--listen", "stdio://"],
      {
        cwd: this.options.processCwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        this.options.onStderr?.(this.userId, chunk.toString("utf8"));
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    // `close` follows both a normal exit and spawn failures, while `exit` is not
    // guaranteed when the executable cannot be launched.
    child.once("close", (code, signal) => this.handleExit(code, signal));
    child.on("error", (error) => this.handleTransportFailure(error));

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const initialized = await this.requestInternal<CodexInitializeResponse>(
        "initialize",
        {
          clientInfo: {
            name: this.options.clientInfo.name,
            title: this.options.clientInfo.title,
            version: this.options.clientInfo.version,
          },
          capabilities: { experimentalApi: this.options.experimentalApi },
        },
        this.options.initializeTimeoutMs,
      );
      this.initializeResultValue = initialized;
      await this.writeMessage({ method: "initialized" });
      if (this.stateValue !== "starting") {
        throw this.terminalError ?? new CodexRuntimeClosedError("Codex runtime closed during startup");
      }
      this.stateValue = "ready";
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request<Result extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    options: CodexRequestOptions = {},
  ): Promise<Result> {
    if (this.stateValue !== "ready") {
      return Promise.reject(new CodexRuntimeClosedError("Codex runtime is not ready"));
    }
    return this.requestInternal<Result>(
      method,
      params,
      positiveInteger(options.timeoutMs, this.options.requestTimeoutMs, "timeoutMs"),
    );
  }

  async notify(method: string, params?: JsonValue): Promise<void> {
    this.assertReady();
    await this.writeMessage({ method, ...(params === undefined ? {} : { params }) });
  }

  async respond(requestId: JsonRpcId, result: JsonValue = null): Promise<void> {
    this.assertReady();
    await this.writeMessage({ id: requestId, result });
  }

  async respondError(
    requestId: JsonRpcId,
    code: number,
    message: string,
    data?: JsonValue,
  ): Promise<void> {
    this.assertReady();
    await this.writeMessage({
      id: requestId,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  subscribe(
    listener: CodexRuntimeListener,
    options: CodexSubscriptionOptions = {},
  ): () => void {
    if (options.signal?.aborted) return () => undefined;
    this.listeners.add(listener);
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
      options.signal?.removeEventListener("abort", unsubscribe);
    };
    options.signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.performClose();
    return this.closePromise;
  }

  private assertReady(): void {
    if (this.stateValue !== "ready") {
      throw new CodexRuntimeClosedError("Codex runtime is not ready");
    }
  }

  private async requestInternal<Result extends JsonValue>(
    method: string,
    params: JsonValue | undefined,
    timeoutMs: number,
  ): Promise<Result> {
    if (!method.trim()) throw new CodexRuntimeError("RPC method must not be empty");
    if (this.pending.size >= this.options.maxPendingRequests) {
      throw new CodexRuntimeError("Too many pending Codex requests");
    }

    const id = randomUUID();
    const key = responseKey(id);
    let pending!: PendingRequest;
    const response = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new CodexRuntimeError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      pending = { method, resolve, reject, timer };
      this.pending.set(key, pending);
    });

    try {
      await this.writeMessage({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      if (this.pending.delete(key)) {
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response as Promise<Result>;
  }

  private writeMessage(message: Record<string, unknown>): Promise<void> {
    const operation = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = this.child;
          if (!child || child.stdin.destroyed || !child.stdin.writable) {
            reject(this.terminalError ?? new CodexRuntimeClosedError("Codex transport is closed"));
            return;
          }
          const line = `${JSON.stringify(message)}\n`;
          child.stdin.write(line, "utf8", (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.stateValue === "closed") return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline !== -1) {
      if (newline > this.options.maxProtocolLineBytes) {
        this.handleProtocolFailure(new CodexRuntimeError("App Server protocol line is too large"));
        return;
      }
      const rawLine = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      const line = rawLine.toString("utf8").replace(/\r$/, "");
      if (line.trim()) this.routeMessage(line);
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
    if (this.stdoutBuffer.length > this.options.maxProtocolLineBytes) {
      this.handleProtocolFailure(new CodexRuntimeError("App Server protocol line is too large"));
    }
  }

  private routeMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.handleProtocolFailure(new CodexRuntimeError("App Server emitted invalid JSONL"));
      return;
    }
    if (!isRecord(message)) {
      this.handleProtocolFailure(new CodexRuntimeError("App Server emitted a non-object message"));
      return;
    }

    if (isJsonRpcId(message.id) && ("result" in message || "error" in message)) {
      const pending = this.pending.get(responseKey(message.id));
      if (!pending) return;
      this.pending.delete(responseKey(message.id));
      clearTimeout(pending.timer);
      if ("error" in message) {
        const error = rpcErrorPayload(message.error);
        pending.reject(new CodexRpcError(pending.method, error.code, error.message, error.data));
      } else {
        pending.resolve((message.result ?? null) as JsonValue);
      }
      return;
    }

    if (typeof message.method === "string") {
      const requestId = isJsonRpcId(message.id) ? message.id : null;
      const serverRequest = requestId !== null;
      if (serverRequest && !SUPPORTED_INTERACTIVE_SERVER_REQUESTS.has(message.method)) {
        void this.writeMessage({
          id: requestId,
          error: {
            code: METHOD_NOT_FOUND,
            message: "App Server request is not supported by Agent Harness",
          },
        }).catch((error) => {
          this.handleTransportFailure(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      const event: CodexRuntimeEvent = {
        sequence: ++this.sequence,
        userId: this.userId,
        kind: serverRequest ? "server-request" : "notification",
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params as JsonValue }),
        ...(serverRequest ? { requestId } : {}),
      };
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch (error) {
          this.reportError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  private handleProtocolFailure(error: Error): void {
    this.handleTransportFailure(error);
    this.child?.kill("SIGKILL");
  }

  private handleTransportFailure(error: Error): void {
    if (!this.terminalError) this.terminalError = error;
    this.failPending(error);
    if (this.stateValue !== "closing" && this.stateValue !== "closed") {
      this.reportError(error);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stateValue === "closed") return;
    const expected = this.stateValue === "closing";
    const error =
      this.terminalError ??
      new CodexRuntimeClosedError(
        expected
          ? "Codex runtime stopped"
          : `Codex runtime exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
      );
    this.stateValue = "closed";
    this.failPending(error);
    this.listeners.clear();
    this.resolveExit?.();
    this.resolveExit = null;
    this.options.onExit(this);
    if (!expected) this.reportError(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(this.userId, error);
    } catch {
      // Diagnostics must never take down the protocol reader.
    }
  }

  private async performClose(): Promise<void> {
    if (this.stateValue === "closed") return;
    this.stateValue = "closing";
    this.failPending(new CodexRuntimeClosedError("Codex runtime is shutting down"));
    const child = this.child;
    if (!child) {
      this.stateValue = "closed";
      this.options.onExit(this);
      return;
    }

    child.stdin.end();
    child.kill("SIGTERM");
    const stopped = await this.waitForExit(this.options.shutdownTimeoutMs);
    if (!stopped) {
      child.kill("SIGKILL");
      await this.waitForExit(1_000);
    }
    if (this.state !== "closed") this.handleExit(null, "SIGKILL");
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const exited = this.exitPromise.then(() => true as const);
    const result = await Promise.race([exited, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }
}

export class CodexRuntimeManager {
  private readonly options: ResolvedManagerOptions;
  private readonly runtimes = new Map<string, CodexRuntime>();
  private readonly userTails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: CodexRuntimeManagerOptions) {
    this.options = {
      ...options,
      codexBinary: options.codexBinary ?? "codex",
      codexArgs: options.codexArgs ?? [],
      experimentalApi: options.experimentalApi ?? false,
      clientInfo: {
        name: options.clientInfo?.name ?? DEFAULT_CLIENT_INFO.name,
        title: options.clientInfo?.title ?? DEFAULT_CLIENT_INFO.title,
        version: options.clientInfo?.version ?? DEFAULT_CLIENT_INFO.version,
      },
      requestTimeoutMs: positiveInteger(
        options.requestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
        "requestTimeoutMs",
      ),
      initializeTimeoutMs: positiveInteger(
        options.initializeTimeoutMs,
        DEFAULT_INITIALIZE_TIMEOUT_MS,
        "initializeTimeoutMs",
      ),
      shutdownTimeoutMs: positiveInteger(
        options.shutdownTimeoutMs,
        DEFAULT_SHUTDOWN_TIMEOUT_MS,
        "shutdownTimeoutMs",
      ),
      maxPendingRequests: positiveInteger(
        options.maxPendingRequests,
        DEFAULT_MAX_PENDING_REQUESTS,
        "maxPendingRequests",
      ),
      maxProtocolLineBytes: positiveInteger(
        options.maxProtocolLineBytes,
        DEFAULT_MAX_PROTOCOL_LINE_BYTES,
        "maxProtocolLineBytes",
      ),
      runtimeEnvironment: options.runtimeEnvironment ?? {},
    };
  }

  get(userId: string): CodexRuntime | undefined {
    return this.runtimes.get(userId);
  }

  has(userId: string): boolean {
    return this.runtimes.has(userId);
  }

  activeUserIds(): string[] {
    return [...this.runtimes.keys()];
  }

  resolveWorkspacePath(requestedPath: string): Promise<string> {
    return resolveAllowedWorkspacePath(requestedPath, this.options.allowedWorkspaceRoots);
  }

  startUser(userId: string, launch: CodexUserRuntimeOptions): Promise<CodexRuntime> {
    return this.withUserLock(userId, () => this.startUserUnlocked(userId, launch));
  }

  stopUser(userId: string): Promise<void> {
    return this.withUserLock(userId, async () => {
      const runtime = this.runtimes.get(userId);
      if (runtime) await runtime.close();
    });
  }

  restartUser(userId: string, launch: CodexUserRuntimeOptions): Promise<CodexRuntime> {
    return this.withUserLock(userId, async () => {
      const existing = this.runtimes.get(userId);
      if (existing) await existing.close();
      return this.startUserUnlocked(userId, launch);
    });
  }

  request<Result extends JsonValue = JsonValue>(
    userId: string,
    method: string,
    params?: JsonValue,
    options?: CodexRequestOptions,
  ): Promise<Result> {
    const runtime = this.runtimes.get(userId);
    if (!runtime) {
      return Promise.reject(new CodexRuntimeClosedError("No Codex runtime for this user"));
    }
    return runtime.request<Result>(method, params, options);
  }

  notify(userId: string, method: string, params?: JsonValue): Promise<void> {
    const runtime = this.requireRuntime(userId);
    return runtime.notify(method, params);
  }

  respond(userId: string, requestId: JsonRpcId, result: JsonValue = null): Promise<void> {
    const runtime = this.requireRuntime(userId);
    return runtime.respond(requestId, result);
  }

  respondError(
    userId: string,
    requestId: JsonRpcId,
    code: number,
    message: string,
    data?: JsonValue,
  ): Promise<void> {
    const runtime = this.requireRuntime(userId);
    return runtime.respondError(requestId, code, message, data);
  }

  subscribe(
    userId: string,
    listener: CodexRuntimeListener,
    options?: CodexSubscriptionOptions,
  ): () => void {
    const runtime = this.runtimes.get(userId);
    if (!runtime) throw new CodexRuntimeClosedError("No Codex runtime for this user");
    return runtime.subscribe(listener, options);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.userTails.values()]);
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    this.runtimes.clear();
  }

  private async startUserUnlocked(
    userId: string,
    launch: CodexUserRuntimeOptions,
  ): Promise<CodexRuntime> {
    if (this.closed) throw new CodexRuntimeClosedError("Codex runtime manager is closed");

    const paths = await prepareUserRuntimePaths(this.options.runtimeDataDir, userId);
    const rendered = renderCodexConfig(launch.provider);
    const processCwd = launch.workspacePath
      ? await resolveAllowedWorkspacePath(launch.workspacePath, this.options.allowedWorkspaceRoots)
      : paths.processCwd;
    const fingerprint = configurationFingerprint(rendered, processCwd);
    const existing = this.runtimes.get(userId);
    if (existing) {
      if (existing.configurationFingerprint !== fingerprint) {
        throw new CodexRuntimeConfigurationError(
          "A runtime already exists with different provider or workspace settings; restart it",
        );
      }
      return existing;
    }

    await writeCodexConfig(paths.configPath, rendered.toml);
    const runtime = new CodexRuntime({
      userId,
      paths,
      processCwd,
      configurationFingerprint: fingerprint,
      providerEnvironment: rendered.environment,
      binary: this.options.codexBinary,
      binaryArgs: this.options.codexArgs,
      experimentalApi: this.options.experimentalApi,
      clientInfo: this.options.clientInfo,
      requestTimeoutMs: this.options.requestTimeoutMs,
      initializeTimeoutMs: this.options.initializeTimeoutMs,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
      maxPendingRequests: this.options.maxPendingRequests,
      maxProtocolLineBytes: this.options.maxProtocolLineBytes,
      runtimeEnvironment: this.options.runtimeEnvironment,
      onStderr: this.options.onStderr,
      onError: this.options.onError,
      onExit: (exitedRuntime) => {
        if (this.runtimes.get(userId) === exitedRuntime) this.runtimes.delete(userId);
      },
    });
    this.runtimes.set(userId, runtime);
    try {
      await runtime.start();
      if (runtime.state !== "ready") {
        throw new CodexRuntimeClosedError("Codex runtime exited during startup");
      }
      return runtime;
    } catch (error) {
      if (this.runtimes.get(userId) === runtime) this.runtimes.delete(userId);
      throw error;
    }
  }

  private requireRuntime(userId: string): CodexRuntime {
    const runtime = this.runtimes.get(userId);
    if (!runtime) throw new CodexRuntimeClosedError("No Codex runtime for this user");
    return runtime;
  }

  private async withUserLock<Result>(
    userId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.userTails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.userTails.set(userId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.userTails.get(userId) === tail) this.userTails.delete(userId);
    }
  }
}
