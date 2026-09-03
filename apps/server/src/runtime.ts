import type {
  ProjectSummary,
  ThreadDetailPayload,
  ThreadSummary,
  TimelineItem,
} from "@agent-harness/contracts";
import { CodexRuntimeManager } from "./codex/runtime.js";

export interface RuntimeDashboardSnapshot {
  projects: ProjectSummary[];
  threads: ThreadSummary[];
  featuredThread: {
    thread: ThreadSummary;
    timeline: TimelineItem[];
  } | null;
}

export interface RuntimeHealth {
  status: "ready" | "not_configured" | "degraded";
  message?: string;
  activeRuntimes?: number;
}

/**
 * Product-facing seam for the Codex runtime. A CodexRuntimeManager adapter can
 * implement this interface without coupling HTTP routes to an unstable runtime API.
 */
export interface HarnessRuntime {
  dashboardSnapshot(input: {
    tenantId: string;
    userId: string;
  }): Promise<RuntimeDashboardSnapshot>;
  threadSnapshot?(input: {
    tenantId: string;
    userId: string;
    threadId: string;
  }): Promise<ThreadDetailPayload | null>;
  health(): Promise<RuntimeHealth>;
  close?(): Promise<void> | void;
}

export class UnconfiguredHarnessRuntime implements HarnessRuntime {
  async dashboardSnapshot(): Promise<RuntimeDashboardSnapshot> {
    return { projects: [], threads: [], featuredThread: null };
  }

  async health(): Promise<RuntimeHealth> {
    return {
      status: "not_configured",
      message: "Codex runtime adapter has not been connected.",
    };
  }
}

/**
 * Conservative lifecycle adapter for the Codex app-server manager. Thread and
 * project mapping intentionally stays empty until the app-server response schema
 * is represented in shared contracts; future run routes can receive this same
 * manager through the HarnessRuntime dependency rather than constructing another.
 */
export class CodexManagerHarnessRuntime implements HarnessRuntime {
  constructor(readonly manager: CodexRuntimeManager) {}

  async dashboardSnapshot(): Promise<RuntimeDashboardSnapshot> {
    return { projects: [], threads: [], featuredThread: null };
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
}
