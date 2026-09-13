import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { validateAgentsApiRemoteUrl } from "./client.js";

export interface AgentsApiExecutorLaunch {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
  /** Host-side snapshot path; the API's workspace path can be a container path. */
  workspaceDirectory: string;
  homeDirectory: string;
  codexHomeDirectory: string;
}

export interface AgentsApiExecutorSnapshot {
  sessionId: string;
  pid: number | null;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  stdoutBytes: number;
  stderrBytes: number;
}

export interface AgentsApiExecutorExit {
  sessionId: string;
  expected: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: "stopped" | "exited" | "spawn_failed" | "output_limit";
}

export interface AgentsApiExecutorHandle {
  readonly sessionId: string;
  readonly closed: Promise<AgentsApiExecutorExit>;
  snapshot(): AgentsApiExecutorSnapshot;
}

export interface AgentsApiExecutorOptions {
  /** Reviewed sandbox wrapper, never a raw codex executable. The wrapper owns OS isolation. */
  launcher: { command: string; args?: readonly string[] };
  restrictedApiKey: string;
  shutdownTimeoutMs?: number;
  maxOutputBytes?: number;
  onExit?: (exit: AgentsApiExecutorExit) => void;
}

export class AgentsApiExecutorError extends Error {
  constructor(readonly code: "configuration" | "duplicate" | "launch" | "closed") {
    super(`Managed executor ${code} failure.`);
    this.name = "AgentsApiExecutorError";
  }
}

interface Entry {
  child?: ChildProcessWithoutNullStreams;
  state: AgentsApiExecutorSnapshot;
  expected: boolean;
  reason?: AgentsApiExecutorExit["reason"];
  handle: AgentsApiExecutorHandle;
  finish(exit: AgentsApiExecutorExit): void;
  stopPromise?: Promise<void>;
}

/**
 * Starts only an operator-specified sandbox launcher. Separate HOME directories and
 * an allowlisted environment are credential hygiene, not a read-only sandbox.
 * The wrapper must mount the workspace read-only and isolate the host filesystem.
 */
export class AgentsApiExecutorSupervisor {
  private readonly entries = new Map<string, Entry>();
  private readonly shutdownTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private closed = false;

  constructor(private readonly options: AgentsApiExecutorOptions) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    if (!isAbsolute(options.launcher.command) || !options.restrictedApiKey || /[\r\n\0]/.test(options.restrictedApiKey) ||
        (options.launcher.args ?? []).some((arg) => arg.includes("\0")) || process.platform === "win32" ||
        !Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs <= 0 ||
        !Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new AgentsApiExecutorError("configuration");
    }
  }

  async start(launch: AgentsApiExecutorLaunch): Promise<AgentsApiExecutorHandle> {
    if (this.closed) throw new AgentsApiExecutorError("closed");
    if (this.entries.has(launch.sessionId)) throw new AgentsApiExecutorError("duplicate");
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(launch.sessionId) || !/^[A-Za-z0-9_-]{1,200}$/.test(launch.environmentId)) {
      throw new AgentsApiExecutorError("configuration");
    }
    let remoteUrl: string;
    let cwd: string;
    let home: string;
    let codexHome: string;
    try {
      remoteUrl = validateAgentsApiRemoteUrl(launch.remoteUrl);
      for (const path of [launch.workspaceDirectory, launch.homeDirectory, launch.codexHomeDirectory]) {
        if (!isAbsolute(path) || path.includes("\0")) throw new Error("invalid path");
      }
      cwd = realpathSync(launch.workspaceDirectory);
      if (!statSync(cwd).isDirectory()) throw new Error("invalid directory");
      mkdirSync(launch.homeDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(launch.codexHomeDirectory, { recursive: true, mode: 0o700 });
      home = realpathSync(launch.homeDirectory);
      codexHome = realpathSync(launch.codexHomeDirectory);
      mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
    } catch {
      throw new AgentsApiExecutorError("configuration");
    }
    let resolveExit!: (value: AgentsApiExecutorExit) => void;
    const closed = new Promise<AgentsApiExecutorExit>((resolve) => { resolveExit = resolve; });
    const state: AgentsApiExecutorSnapshot = { sessionId: launch.sessionId, pid: null, state: "starting", stdoutBytes: 0, stderrBytes: 0 };
    let finished = false;
    const entry: Entry = {
      state, expected: false,
      handle: { sessionId: launch.sessionId, closed, snapshot: () => ({ ...state }) },
      finish: (exit) => {
        if (finished) return;
        finished = true;
        state.state = exit.expected ? "stopped" : "failed";
        resolveExit(exit);
        try { this.options.onExit?.(exit); } catch { /* An observer cannot prevent process cleanup. */ }
      },
    };
    this.entries.set(launch.sessionId, entry);
    try {
      const child = spawn(this.options.launcher.command, [
        ...this.options.launcher.args ?? [], "exec-server", "--remote", remoteUrl,
        "--environment-id", launch.environmentId, "--exit-on-stdin-close",
      ], {
        cwd,
        env: {
          // Do not inherit provider credentials, application keys, proxy settings, or startup hooks.
          PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C.UTF-8", HOME: home, CODEX_HOME: codexHome, TMPDIR: join(home, "tmp"),
          CODEX_API_KEY: this.options.restrictedApiKey,
          HARNESS_WORKSPACE_DIRECTORY: cwd,
          HARNESS_EXECUTOR_SESSION_ID: launch.sessionId,
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      entry.child = child;
      state.pid = child.pid ?? null;
      // Consume output without retaining or logging its potentially secret-bearing content.
      const consume = (field: "stdoutBytes" | "stderrBytes", chunk: Buffer) => {
        state[field] = Math.min(this.maxOutputBytes + 1, state[field] + chunk.length);
        if (state.stdoutBytes + state.stderrBytes > this.maxOutputBytes && !entry.reason) {
          entry.reason = "output_limit";
          void this.terminate(entry, false);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => consume("stdoutBytes", chunk));
      child.stderr.on("data", (chunk: Buffer) => consume("stderrBytes", chunk));
      child.stdin.on("error", () => undefined);
      child.on("error", () => {
        entry.reason = "spawn_failed";
      });
      child.once("exit", () => this.signal(entry, "SIGKILL"));
      child.once("close", (code, signal) => {
        // Stop any descendants still in our process group when the wrapper exits.
        this.signal(entry, "SIGKILL");
        entry.finish({ sessionId: launch.sessionId, expected: entry.expected, code, signal,
          reason: entry.reason ?? (entry.expected ? "stopped" : "exited") });
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => { state.state = "running"; resolve(); });
        child.once("error", () => reject(new AgentsApiExecutorError("launch")));
      });
      return entry.handle;
    } catch {
      entry.reason = "spawn_failed";
      await this.terminate(entry, false);
      this.entries.delete(launch.sessionId);
      throw new AgentsApiExecutorError("launch");
    }
  }

  snapshot(sessionId: string): AgentsApiExecutorSnapshot | undefined {
    return this.entries.get(sessionId)?.handle.snapshot();
  }

  async stop(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await this.terminate(entry, true);
    this.entries.delete(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  private terminate(entry: Entry, expected: boolean): Promise<void> {
    if (entry.stopPromise) return entry.stopPromise;
    entry.expected = expected;
    entry.stopPromise = (async () => {
      if (entry.state.state === "stopped" || entry.state.state === "failed") return;
      entry.state.state = "stopping";
      if (!entry.child) {
        entry.finish({ sessionId: entry.state.sessionId, expected, code: null, signal: null, reason: entry.reason ?? "spawn_failed" });
        return;
      }
      entry.child.stdin.end();
      this.signal(entry, "SIGTERM");
      const timer = setTimeout(() => this.signal(entry, "SIGKILL"), this.shutdownTimeoutMs);
      timer.unref();
      try { await entry.handle.closed; } finally { clearTimeout(timer); }
    })();
    return entry.stopPromise;
  }

  private signal(entry: Entry, signal: NodeJS.Signals): void {
    if (!entry.child?.pid) return;
    try { process.kill(-entry.child.pid, signal); } catch {
      try { entry.child.kill(signal); } catch { /* Already exited; close resolves the lifecycle. */ }
    }
  }
}
