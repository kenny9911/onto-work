import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DashboardPayload,
  SavedProjectSummary,
  ThreadSummary,
  TimelineItem,
} from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { idleRuntimeStream } from "@/lib/runtime-stream";
import { controlledMatchMedia } from "@/test/match-media";
import { WorkspaceView } from "./WorkspaceView";

const activeThread: ThreadSummary = {
  id: "scroll-regression-thread",
  title: "Scrollable workspace regression",
  projectId: "onto-work-project",
  projectName: "onto-work",
  status: "running",
  model: "gpt-5.4",
  updatedAt: "2026-09-02T00:02:00.000Z",
  preview: "Keep the task transcript within its own scroll container.",
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
    createdAt: "2026-09-02T00:00:00.000Z",
    lastLoginAt: "2026-09-02T00:01:00.000Z",
  },
  subscription: {
    plan: "team",
    status: "active",
    seats: 5,
    currentPeriodEnd: "2026-10-02T00:00:00.000Z",
    stripeConfigured: true,
  },
  usage: {
    periodStart: "2026-09-02T00:00:00.000Z",
    periodEnd: "2026-10-02T00:00:00.000Z",
    requestsUsed: 84,
    requestLimit: 100_000,
    activeRuns: 1,
    activeRunLimit: 16,
    inputTokens: 24_000,
    outputTokens: 8_000,
    seatsUsed: 2,
    seatLimit: 5,
  },
  providers: [
    {
      id: "openai-route",
      catalogId: "openai",
      name: "OpenAI",
      adapter: "responses",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.4",
      enabled: true,
      isDefault: true,
      hasCredential: true,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
  ],
  runtime: {
    status: "ready",
    message: null,
    activeRuntimes: 1,
  },
  projects: [
    {
      id: "onto-work-project",
      name: "onto-work",
      path: "/workspace/onto-work",
      branch: "main",
      isGitRepository: true,
    },
  ],
  threads: [activeThread],
  featuredThread: {
    thread: activeThread,
    timeline: [],
  },
};

const timeline: TimelineItem[] = Array.from({ length: 30 }, (_, index) => ({
  id: `timeline-${index}`,
  kind: "assistant",
  title: "Agent",
  body: `Transcript entry ${index + 1}`,
  status: "completed",
  timestamp: "2026-09-02T00:02:00.000Z",
}));

const savedProjects = [
  {
    ...dashboard.projects[0]!,
    workspaceId: "onto-work-workspace",
    enabled: true,
    availability: "available",
    repositoryStatus: "repository",
    repositoryRoot: "/workspace/onto-work",
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    upstream: "origin/main",
    dirty: false,
    remoteUrl: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
] satisfies SavedProjectSummary[];

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const lifecycleProps = {
  activeTurnId: null,
  savedProjects,
  savedProjectsLoading: false,
  savedProjectsError: null,
  selectedProjectId: savedProjects[0]!.id,
  taskActionPending: null,
  onArchive: vi.fn(async () => undefined),
  onFork: vi.fn(async () => undefined),
  onInterrupt: vi.fn(async () => undefined),
  onReloadProjects: vi.fn(async () => undefined),
  onRename: vi.fn(async () => undefined),
  onRetryRuntimeStream: vi.fn(),
  onSelectProject: vi.fn(),
  runtimeStream: idleRuntimeStream,
} as const;

describe("WorkspaceView scrolling", () => {
  let media: ReturnType<typeof controlledMatchMedia>;

  beforeEach(() => {
    media = controlledMatchMedia();
    vi.stubGlobal("matchMedia", media.matchMedia);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the transcript and inspector in bounded internal scroll regions", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          timeline={timeline}
        />
      </TooltipProvider>,
    );

    const runSpine = screen.getByRole("log", { name: "Run Spine activity" });
    expect(runSpine).toHaveClass("h-full", "min-h-0");
    expect(runSpine.firstElementChild).toHaveClass("overflow-y-auto", "overscroll-contain");
    expect(screen.getByRole("list", { name: "Run Spine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach context (not available)" })).toBeDisabled();

    const inspector = screen.getByText("Task inspector").closest("aside");
    expect(inspector).not.toBeNull();
    const inspectorScroller = inspector?.querySelector(".overflow-y-auto");
    expect(inspectorScroller).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");

    const filesTab = screen.getByRole("tab", { name: /Files/ });
    fireEvent.mouseDown(filesTab, { button: 0, ctrlKey: false });
    expect(screen.getByText("No file changes reported")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open task inspector" }));
    expect(screen.getByRole("dialog", { name: "Task inspector" })).toBeInTheDocument();
    act(() => media.controller("(min-width: 1180px)").setMatches(true));
    expect(screen.queryByRole("dialog", { name: "Task inspector" })).not.toBeInTheDocument();
  });

  it("shows a factual empty snapshot instead of onboarding events for an existing task", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          timeline={[]}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("No run events in this snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Your harness is ready")).not.toBeInTheDocument();
  });

  it("renders an optimistic new-thread timeline before dashboard hydration", () => {
    const optimisticItem: TimelineItem = {
      id: "optimistic-request",
      kind: "user",
      title: "Administrator",
      body: "Build the optimistic task cockpit",
      status: "completed",
      timestamp: "2026-09-02T00:03:00.000Z",
    };

    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={null}
          activeThreadId="thread-created"
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          timeline={[optimisticItem]}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByText("Build the optimistic task cockpit")).toBeInTheDocument();
    expect(screen.queryByText("What should the harness build next?")).not.toBeInTheDocument();
  });

  it("shows truthful sending state and rejects unsupported file input with feedback", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft="Queued request"
          isSending
          onApproval={vi.fn()}
          onDraftChange={onDraftChange}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          timeline={timeline}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("Task prompt")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByText("Sending request…")).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={onDraftChange}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          timeline={timeline}
        />
      </TooltipProvider>,
    );

    const prompt = screen.getByLabelText("Task prompt");
    const file = new File(["image"], "reference.png", { type: "image/png" });
    fireEvent.paste(prompt, {
      clipboardData: {
        items: [{ getAsFile: () => file, kind: "file" }],
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "File attachments are not available yet. Paste text instead.",
    );
    expect(screen.getByLabelText("Upload files")).toBeDisabled();

    fireEvent.change(prompt, { target: { value: "text" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.drop(prompt.closest("form")!, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    expect(screen.getByRole("status")).toHaveTextContent("File attachments are not available yet");
  });

  it("reports a dropped runtime stream without claiming the run stopped", () => {
    const onRetryRuntimeStream = vi.fn();
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onRetryRuntimeStream={onRetryRuntimeStream}
          onSend={vi.fn()}
          runtimeStream={{
            status: "reconnecting",
            attempt: 2,
            lastEventAt: Date.now() - 8_000,
          }}
          timeline={timeline}
        />
      </TooltipProvider>,
    );

    const banner = screen
      .getAllByRole("status")
      .find((node) => node.textContent?.includes("Event stream reconnecting"));
    expect(banner).toBeDefined();
    expect(banner).toHaveTextContent("attempt 2");
    expect(banner).toHaveTextContent("the run continues without you");
    expect(banner).toHaveTextContent("last event 8s ago");

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(onRetryRuntimeStream).toHaveBeenCalledTimes(1);
  });

  it("stays quiet about the stream while it is live", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          runtimeStream={{ status: "live", attempt: 0, lastEventAt: null }}
          timeline={timeline}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByText(/Event stream reconnecting/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry now" })).not.toBeInTheDocument();
  });

  it("collapses a consecutive command run into one spine node", () => {
    const commandTimeline: TimelineItem[] = [
      {
        id: "user-1",
        kind: "user",
        title: "Operator",
        body: "Run the suite",
        status: "completed",
        timestamp: "2026-09-02T00:02:00.000Z",
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `command-${index}`,
        kind: "command" as const,
        title: `pnpm test ${index}`,
        body: `run ${index}`,
        status: "completed" as const,
        timestamp: "2026-09-02T00:02:00.000Z",
      })),
    ];

    render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft=""
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onSend={vi.fn()}
          timeline={commandTimeline}
        />
      </TooltipProvider>,
    );

    // Scoped to the spine: the inspector lists every event regardless.
    const spine = within(screen.getByRole("list", { name: "Run Spine" }));
    const cluster = spine.getByRole("button", { name: /Command sequence/ });
    expect(cluster).toHaveTextContent("3 commands");
    expect(cluster).toHaveAttribute("aria-expanded", "false");
    expect(spine.queryByText("pnpm test 0")).not.toBeInTheDocument();

    fireEvent.click(cluster);
    expect(cluster).toHaveAttribute("aria-expanded", "true");
    expect(spine.getByText("pnpm test 0")).toBeInTheDocument();
  });
});
