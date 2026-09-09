import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DashboardPayload, ThreadSummary, TimelineItem } from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { idleRuntimeStream } from "@/lib/runtime-stream";
import { controlledMatchMedia } from "@/test/match-media";
import { RouteLoadingBoundary } from "./RouteLoadingBoundary";
import { WorkspaceView } from "./WorkspaceView";

// Reproduce a browser's rejected module request, rather than a renderer that
// merely stays pending: Suspense alone must not make this regression pass.
vi.mock("@/components/ai-elements/message", () => {
  throw new TypeError("Failed to fetch dynamically imported module: message.tsx");
});
vi.mock("@/components/ai-elements/reasoning", () => {
  throw new TypeError("Failed to fetch dynamically imported module: reasoning.tsx");
});
vi.mock("@/components/ai-elements/tool", () => {
  throw new TypeError("Failed to fetch dynamically imported module: tool.tsx");
});

const activeThread: ThreadSummary = {
  id: "renderer-failure-task",
  title: "Task with an unavailable renderer",
  projectId: null,
  projectName: null,
  status: "running",
  model: "gpt-5.4",
  updatedAt: "2026-09-09T00:00:00.000Z",
  preview: "Keep the transcript and composer available.",
};

const dashboard: DashboardPayload = {
  user: {
    id: "admin-user",
    tenantId: "default-tenant",
    username: "admin",
    displayName: "Administrator",
    role: "admin",
    status: "active",
    mustChangePassword: false,
    createdAt: "2026-09-09T00:00:00.000Z",
    lastLoginAt: null,
  },
  subscription: {
    plan: "team",
    status: "active",
    seats: 5,
    currentPeriodEnd: "2026-10-09T00:00:00.000Z",
    stripeConfigured: true,
  },
  usage: {
    periodStart: "2026-09-09T00:00:00.000Z",
    periodEnd: "2026-10-09T00:00:00.000Z",
    requestsUsed: 1,
    requestLimit: 100_000,
    activeRuns: 1,
    activeRunLimit: 16,
    inputTokens: 0,
    outputTokens: 0,
    seatsUsed: 1,
    seatLimit: 5,
  },
  providers: [{
    id: "default-route",
    catalogId: "openai",
    name: "OpenAI",
    adapter: "responses",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    enabled: true,
    isDefault: true,
    hasCredential: true,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  }],
  runtime: { status: "ready", message: null, activeRuntimes: 1 },
  projects: [],
  threads: [activeThread],
  featuredThread: null,
};

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("WorkspaceView renderer failures", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", controlledMatchMedia().matchMedia);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["user", "assistant", "reasoning", "command", "file_change"] as const)(
    "keeps %s content and the composer usable after its lazy import rejects",
    async (kind) => {
      const onCaughtError = vi.fn();
      const onSend = vi.fn(async () => undefined);
      const onDraftChange = vi.fn();
      const draft = "Continue from the preserved draft";
      const item: TimelineItem = {
        id: `failed-renderer-${kind}`,
        kind,
        title: `Preserved ${kind} title`,
        body: `Preserved ${kind} content`,
        status: "running",
        timestamp: "2026-09-09T00:00:00.000Z",
      };
      const workspace = (timeline: TimelineItem[]) => (
        <TooltipProvider>
          <RouteLoadingBoundary>
            <WorkspaceView
              activeThread={activeThread}
              activeThreadId={activeThread.id}
              activeTurnId={null}
              dashboard={dashboard}
              draft={draft}
              isSending={false}
              onApproval={vi.fn()}
              onArchive={vi.fn()}
              onDraftChange={onDraftChange}
              onFork={vi.fn()}
              onInterrupt={vi.fn()}
              onOpenSidebar={vi.fn()}
              onReloadProjects={vi.fn()}
              onRename={vi.fn()}
              onRetryRuntimeStream={vi.fn()}
              onSelectProject={vi.fn()}
              onSend={onSend}
              runtimeStream={idleRuntimeStream}
              savedProjects={[]}
              savedProjectsError={null}
              savedProjectsLoading={false}
              selectedProjectId={null}
              taskActionPending={null}
              timeline={timeline}
            />
          </RouteLoadingBoundary>
        </TooltipProvider>
      );
      const { rerender } = render(workspace([item]), { onCaughtError });

      // Wait until React has handled the rejection, past the pending fallback.
      await waitFor(() => expect(onCaughtError).toHaveBeenCalledOnce());
      expect(screen.queryByRole("alert", { name: "Interface failed to load" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: activeThread.title })).toBeInTheDocument();
      expect(screen.getByText(item.body)).toBeInTheDocument();
      if (kind === "command" || kind === "file_change") {
        expect(screen.getAllByText(item.title).length).toBeGreaterThan(0);
      }
      expect(screen.getByRole("textbox", { name: "Task prompt" })).toHaveValue(draft);

      // New streamed text must still reach the fallback after the failure.
      const updatedBody = `${item.body}, including the next event`;
      rerender(workspace([{ ...item, body: updatedBody }]));
      expect(screen.getByText(updatedBody)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      await waitFor(() => expect(onSend).toHaveBeenCalledWith(draft, undefined));
    },
  );
});
