/** Narrow REST boundary for the Agents API beta. Never retries mutations automatically. */
export interface AgentsApiSession {
  id: string;
  status: string;
  environment: {
    id: string;
    type: "self_hosted";
    remote_url: string;
    status?: string;
  };
  required_actions?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AgentsApiItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface AgentsApiEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

export interface AgentsApiTurn {
  id: string;
  status: string;
  subagent_id?: string | null;
  usage?: unknown;
  [key: string]: unknown;
}

export interface CreateAgentsApiSession {
  model: string;
  instructions: string;
  workspaceDirectory: string;
  capabilityDirectories?: string[];
  maxConcurrentSubagents?: number;
  input?: string;
}

export interface AgentsApiEventStream {
  events: AsyncIterable<AgentsApiEvent>;
  close(): void;
}

export class AgentsApiError extends Error {
  constructor(
    readonly code: "http" | "network" | "timeout" | "aborted" | "protocol" | "limit",
    readonly status?: number,
  ) {
    // Remote bodies, URLs, credentials, and native fetch causes must not reach logs or browsers.
    super(status ? `Agents API request failed (HTTP ${status}).` : `Agents API ${code} failure.`);
    this.name = "AgentsApiError";
  }
}

interface ClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxResponseBytes?: number;
  maxEventBytes?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new AgentsApiError("protocol");
  return encodeURIComponent(value);
}

/** Validate the origin, then retain the API's exact URL, including its path and query. */
export function validateAgentsApiRemoteUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AgentsApiError("protocol"); }
  if (
    url.origin !== "https://api.openai.com" || url.username || url.password || url.hash ||
    value.length > 8_192 || /[\r\n\0]/.test(value)
  ) throw new AgentsApiError("protocol");
  return value;
}

function parseSession(value: unknown): AgentsApiSession {
  if (!object(value) || typeof value.id !== "string" || typeof value.status !== "string" ||
      !object(value.environment) || value.environment.type !== "self_hosted" ||
      typeof value.environment.id !== "string" || typeof value.environment.remote_url !== "string" ||
      (value.required_actions !== undefined && (!Array.isArray(value.required_actions) || !value.required_actions.every(object)))) {
    throw new AgentsApiError("protocol");
  }
  identifier(value.id);
  identifier(value.environment.id);
  validateAgentsApiRemoteUrl(value.environment.remote_url);
  return value as AgentsApiSession;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new AgentsApiError("protocol"); }
}

export class AgentsApiClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxEventBytes: number;

  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new AgentsApiError("protocol");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 90_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_097_152;
    this.maxEventBytes = options.maxEventBytes ?? 262_144;
    for (const limit of [this.requestTimeoutMs, this.streamIdleTimeoutMs, this.maxResponseBytes, this.maxEventBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new AgentsApiError("protocol");
    }
  }

  async createSession(input: CreateAgentsApiSession, signal?: AbortSignal): Promise<AgentsApiSession> {
    if (input.maxConcurrentSubagents !== undefined &&
        (!Number.isInteger(input.maxConcurrentSubagents) || input.maxConcurrentSubagents < 0 || input.maxConcurrentSubagents > 6)) {
      throw new AgentsApiError("protocol");
    }
    const subagents = input.maxConcurrentSubagents ?? 0;
    return parseSession(await this.request("POST", "/sessions", {
      agent: {
        model: input.model,
        instructions: input.instructions,
        multi_agent: subagents > 0
          ? { enabled: true, max_concurrent_subagents: subagents }
          : { enabled: false },
      },
      environment: {
        type: "self_hosted",
        workspace_directory: input.workspaceDirectory,
        ...(input.capabilityDirectories?.length ? { capability_directories: input.capabilityDirectories } : {}),
      },
      ...(input.input !== undefined ? { input: input.input } : {}),
    }, signal));
  }

  async retrieveSession(sessionId: string, signal?: AbortSignal): Promise<AgentsApiSession> {
    return parseSession(await this.request("GET", `/sessions/${identifier(sessionId)}`, undefined, signal));
  }

  async listItems(sessionId: string, options: { signal?: AbortSignal; maxItems?: number } = {}): Promise<AgentsApiItem[]> {
    return this.listRecords<AgentsApiItem>(`/sessions/${identifier(sessionId)}/items`, options,
      (item) => object(item) && typeof item.id === "string" && typeof item.type === "string");
  }

  async listTurns(sessionId: string, options: { signal?: AbortSignal; maxItems?: number } = {}): Promise<AgentsApiTurn[]> {
    return this.listRecords<AgentsApiTurn>(`/sessions/${identifier(sessionId)}/turns`, options,
      (turn) => object(turn) && typeof turn.id === "string" && typeof turn.status === "string");
  }

  async retrieveTurn(sessionId: string, turnId: string, signal?: AbortSignal): Promise<AgentsApiTurn> {
    const turn = await this.request("GET", `/sessions/${identifier(sessionId)}/turns/${identifier(turnId)}`, undefined, signal);
    if (!object(turn) || typeof turn.id !== "string" || typeof turn.status !== "string") throw new AgentsApiError("protocol");
    return turn as AgentsApiTurn;
  }

  private async listRecords<T>(path: string, options: { signal?: AbortSignal; maxItems?: number }, validate: (item: unknown) => boolean): Promise<T[]> {
    const maxItems = options.maxItems ?? 2_000;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 100_000) throw new AgentsApiError("limit");
    const result: T[] = [];
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ order: "asc", limit: String(Math.min(100, maxItems - result.length)) });
      if (after) query.set("after", after);
      const page = await this.request("GET", `${path}?${query}`, undefined, options.signal);
      if (!object(page) || !Array.isArray(page.data) || typeof page.has_more !== "boolean" ||
          !page.data.every(validate)) {
        throw new AgentsApiError("protocol");
      }
      result.push(...page.data as T[]);
      if (result.length > maxItems || (result.length === maxItems && page.has_more)) throw new AgentsApiError("limit");
      if (!page.has_more) return result;
      if (typeof page.last_id !== "string" || !page.last_id || !page.data.length || cursors.has(page.last_id)) {
        throw new AgentsApiError("protocol");
      }
      after = page.last_id;
      cursors.add(after);
    } while (true);
  }

  async sendMessage(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sessions/${identifier(sessionId)}/events`, {
      events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] }],
    }, signal);
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sessions/${identifier(sessionId)}/events`, {
      events: [{ type: "agent.session.input.cancel" }],
    }, signal);
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/sessions/${identifier(sessionId)}`, undefined, signal);
  }

  async openEventStream(sessionId: string, signal?: AbortSignal): Promise<AgentsApiEventStream> {
    const operation = this.operation(signal, this.requestTimeoutMs);
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(`https://api.openai.com/v1/agents/sessions/${identifier(sessionId)}/events?stream=true`, {
        method: "GET", headers: this.headers("text/event-stream"), signal: operation.signal, redirect: "error",
      });
      if (!response.ok) throw new AgentsApiError("http", response.status);
      if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        throw new AgentsApiError("protocol");
      }
      operation.reset(this.streamIdleTimeoutMs);
    } catch (error) {
      const safeError = operation.error(error);
      void response?.body?.cancel().catch(() => undefined);
      operation.close();
      throw safeError;
    }
    const reader = response.body!.getReader();
    const close = () => {
      operation.close();
      void reader.cancel().catch(() => undefined);
    };
    const maxEventBytes = this.maxEventBytes;
    const idleTimeoutMs = this.streamIdleTimeoutMs;
    async function* events(): AsyncGenerator<AgentsApiEvent> {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      const frame = (raw: string): AgentsApiEvent | undefined => {
        const data = raw.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data === "[DONE]") return undefined;
        const event = parseJson(data);
        if (!object(event) || typeof event.type !== "string" || !event.type ||
            (event.event_id !== undefined && typeof event.event_id !== "string")) throw new AgentsApiError("protocol");
        return event as AgentsApiEvent;
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) throw new AgentsApiError("protocol");
            return;
          }
          operation.reset(idleTimeoutMs);
          buffer += decoder.decode(value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
            const raw = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (Buffer.byteLength(raw) > maxEventBytes) throw new AgentsApiError("limit");
            const parsed = frame(raw);
            if (parsed) yield parsed;
          }
          if (Buffer.byteLength(buffer) > maxEventBytes) throw new AgentsApiError("limit");
        }
      } catch (error) {
        throw operation.error(error);
      } finally {
        close();
      }
    }
    return { events: events(), close };
  }

  private headers(accept = "application/json"): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}`, "OpenAI-Beta": "agents=v1", "Content-Type": "application/json", Accept: accept };
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const operation = this.operation(signal, this.requestTimeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetchImpl(`https://api.openai.com/v1/agents${path}`, {
        method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body),
        signal: operation.signal, redirect: "error",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new AgentsApiError("http", response.status);
      }
      if (response.status === 204 || !response.body) return undefined;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) throw new AgentsApiError("limit");
        chunks.push(value);
      }
      if (!size) return undefined;
      return parseJson(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      throw operation.error(error);
    } finally {
      void reader?.cancel().catch(() => undefined);
      operation.close();
    }
  }

  private operation(parent: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => controller.abort();
    const reset = (duration: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
      timer.unref();
    };
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) controller.abort();
    reset(timeoutMs);
    return {
      signal: controller.signal,
      reset,
      close() { clearTimeout(timer); parent?.removeEventListener("abort", abort); controller.abort(); },
      error(error: unknown): AgentsApiError {
        if (error instanceof AgentsApiError) return error;
        if (timedOut) return new AgentsApiError("timeout");
        if (parent?.aborted || controller.signal.aborted) return new AgentsApiError("aborted");
        return new AgentsApiError("network");
      },
    };
  }
}
