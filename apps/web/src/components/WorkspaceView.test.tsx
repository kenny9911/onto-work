import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  DashboardPayload,
  SavedProjectSummary,
  ThreadSummary,
  TimelineItem,
  UploadSummary,
} from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
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

// jsdom implements neither, and `PromptInput` calls both for every attachment.
let objectUrlSequence = 0;
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: () => `blob:composer/${++objectUrlSequence}`,
  writable: true,
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: () => undefined,
  writable: true,
});

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
    vi.restoreAllMocks();
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
    expect(screen.getByRole("button", { name: "Attach context" })).toBeEnabled();

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

  it("shows truthful sending state and returns the composer when the turn is away", () => {
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
    expect(prompt).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    expect(screen.getByLabelText("Upload files")).toBeEnabled();

    fireEvent.change(prompt, { target: { value: "text" } });
    expect(onDraftChange).toHaveBeenCalledWith("text");
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

interface UploadRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  withCredentials: boolean;
  aborted: boolean;
  progress: (loaded: number, total: number) => void;
  respond: (status: number, payload: unknown) => void;
}

const uploadRequests: UploadRequestRecord[] = [];

/**
 * The composer uploads over `XMLHttpRequest` because only XHR reports upload
 * progress. This stands in for it and exposes the two things a test needs to
 * drive: a progress tick and a response.
 */
class UploadTransportMock {
  status = 0;
  responseText = "";
  withCredentials = false;
  private readonly requestHeaders: Record<string, string> = {};
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  private readonly uploadHandlers = new Map<string, Array<(event: unknown) => void>>();
  private method = "";
  private url = "";
  private record: UploadRequestRecord | null = null;

  readonly upload = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      this.uploadHandlers.set(type, [...(this.uploadHandlers.get(type) ?? []), handler]);
    },
  };

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  removeEventListener(): void {
    // The client only removes its abort listener; nothing here depends on it.
  }

  abort(): void {
    if (this.record) this.record.aborted = true;
    this.emit("abort");
  }

  send(body: unknown): void {
    const record: UploadRequestRecord = {
      aborted: false,
      body,
      headers: { ...this.requestHeaders },
      method: this.method,
      progress: (loaded, total) => {
        for (const handler of this.uploadHandlers.get("progress") ?? []) {
          handler({ lengthComputable: true, loaded, total });
        }
      },
      respond: (status, payload) => {
        this.status = status;
        this.responseText = JSON.stringify(payload);
        this.emit("load");
      },
      url: this.url,
      withCredentials: this.withCredentials,
    };
    this.record = record;
    uploadRequests.push(record);
  }

  private emit(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler({});
  }
}

function storedUpload(id: string, filename: string): { upload: UploadSummary } {
  return {
    upload: {
      contentType: "text/csv",
      createdAt: "2026-09-02T00:04:00.000Z",
      expiresAt: "2026-09-09T00:04:00.000Z",
      filename,
      id,
      projectId: null,
      scope: "thread",
      sizeBytes: 12,
      status: "stored",
      threadId: activeThread.id,
      updatedAt: "2026-09-02T00:04:00.000Z",
    },
  };
}

describe("WorkspaceView composer attachments", () => {
  let media: ReturnType<typeof controlledMatchMedia>;

  beforeEach(() => {
    media = controlledMatchMedia();
    vi.stubGlobal("matchMedia", media.matchMedia);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("XMLHttpRequest", UploadTransportMock);
    uploadRequests.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderComposer(overrides: Partial<ComponentProps<typeof WorkspaceView>> = {}) {
    const onSend = vi.fn(async () => undefined);
    const element = (nextOverrides: Partial<ComponentProps<typeof WorkspaceView>>) => (
      <TooltipProvider delayDuration={0}>
        <WorkspaceView
          {...lifecycleProps}
          activeThread={activeThread}
          activeThreadId={activeThread.id}
          dashboard={dashboard}
          draft="Summarize the attached invoices"
          isSending={false}
          onApproval={vi.fn()}
          onDraftChange={vi.fn()}
          onOpenSidebar={vi.fn()}
          onSend={onSend}
          timeline={timeline}
          {...nextOverrides}
        />
      </TooltipProvider>
    );
    const view = render(element(overrides));
    return {
      ...view,
      onSend,
      rerenderComposer: (nextOverrides: Partial<ComponentProps<typeof WorkspaceView>>) =>
        view.rerender(element({ ...overrides, ...nextOverrides })),
    };
  }

  function pickFile(file: File): void {
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [file] } });
  }

  const csv = () => new File(["id,total\n1,2\n"], "invoices.csv", { type: "text/csv" });

  it("uploads a picked file at once and blocks the turn until it is stored", async () => {
    const { container, onSend } = renderComposer();
    const file = csv();
    pickFile(file);

    expect(screen.getByText("invoices.csv")).toBeInTheDocument();
    expect(uploadRequests).toHaveLength(1);
    const request = uploadRequests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`/api/tasks/${activeThread.id}/uploads`);
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(request.headers["x-upload-filename"]).toBe("invoices.csv");
    expect(request.headers["idempotency-key"]).toEqual(expect.any(String));
    expect(request.withCredentials).toBe(true);
    // The File itself goes on the wire — no FormData, no base64 data URL.
    expect(request.body).toBe(file);

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSend).not.toHaveBeenCalled();

    act(() => request.progress(6, 12));
    expect(container.querySelector('[data-slot="upload-progress"] > span')).toHaveStyle({
      width: "50%",
    });

    await act(async () => request.respond(201, storedUpload("upload-1", "invoices.csv")));
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    expect(container.querySelector('[data-slot="upload-progress"]')).toBeNull();
  });

  it("sends only stored ids without base64 conversion or deleting a handed-off upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const deleteUpload = vi.spyOn(api, "deleteUpload").mockResolvedValue({ ok: true });
    const { onSend } = renderComposer();
    pickFile(csv());
    await act(async () => uploadRequests[0]!.respond(201, storedUpload("upload-9", "invoices.csv")));

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Summarize the attached invoices", ["upload-9"]),
    );
    await waitFor(() => expect(screen.queryByText("invoices.csv")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleteUpload).not.toHaveBeenCalled();
  });

  it("keeps a stored attachment after a failed turn and reuses its id on retry", async () => {
    const failure = new Error("The runtime is temporarily unavailable.");
    const onSend = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const deleteUpload = vi.spyOn(api, "deleteUpload").mockResolvedValue({ ok: true });
    renderComposer({ onSend });
    pickFile(csv());
    await act(async () => uploadRequests[0]!.respond(201, storedUpload("upload-retry", "invoices.csv")));

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.getByText("invoices.csv")).toBeInTheDocument();
    expect(deleteUpload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenNthCalledWith(
      2,
      "Summarize the attached invoices",
      ["upload-retry"],
    );
    await waitFor(() => expect(screen.queryByText("invoices.csv")).not.toBeInTheDocument());
    expect(deleteUpload).not.toHaveBeenCalled();
  });

  it("renders the control plane's own rejection code on the chip", async () => {
    const { onSend } = renderComposer();
    pickFile(csv());

    await act(async () =>
      uploadRequests[0]!.respond(413, {
        error: "upload_too_large",
        message: "The file is larger than 20 MB.",
      }),
    );

    expect(screen.getByText("upload_too_large")).toBeInTheDocument();
    expect(screen.getByText("The file is larger than 20 MB.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry invoices.csv" })).toBeInTheDocument();

    // A failed attachment never blocks the turn, and its id is never sent.
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Summarize the attached invoices", undefined),
    );
  });

  it("retries a failed upload under the original idempotency key", async () => {
    renderComposer();
    pickFile(csv());
    const first = uploadRequests[0]!;
    await act(async () =>
      first.respond(500, { error: "internal_error", message: "The harness failed." }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry invoices.csv" }));

    expect(uploadRequests).toHaveLength(2);
    expect(uploadRequests[1]!.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
  });

  it("uploads against the saved project before a thread exists", () => {
    renderComposer({ activeThread: null, activeThreadId: null, draft: "Read this" });
    pickFile(csv());

    expect(uploadRequests).toHaveLength(1);
    expect(uploadRequests[0]!.url).toBe(`/api/projects/${savedProjects[0]!.id}/uploads`);
  });

  it("deletes project-scoped uploads when a new task changes project", async () => {
    const deleteUpload = vi.spyOn(api, "deleteUpload").mockResolvedValue({ ok: true });
    const secondProject: SavedProjectSummary = {
      ...savedProjects[0]!,
      id: "second-project",
      name: "second-workspace",
      path: "/workspace/second",
      repositoryRoot: "/workspace/second",
      workspaceId: "second-workspace-id",
    };
    const { rerenderComposer } = renderComposer({
      activeThread: null,
      activeThreadId: null,
      draft: "Read this",
      savedProjects: [savedProjects[0]!, secondProject],
      selectedProjectId: savedProjects[0]!.id,
    });
    pickFile(csv());
    await act(async () =>
      uploadRequests[0]!.respond(201, storedUpload("upload-project-a", "invoices.csv")),
    );

    rerenderComposer({ selectedProjectId: secondProject.id });

    await waitFor(() => expect(deleteUpload).toHaveBeenCalledWith("upload-project-a"));
    await waitFor(() => expect(screen.queryByText("invoices.csv")).not.toBeInTheDocument());
  });

  it("deletes unsent stored uploads when the selected task changes", async () => {
    const deleteUpload = vi.spyOn(api, "deleteUpload").mockResolvedValue({ ok: true });
    const otherThread: ThreadSummary = {
      ...activeThread,
      id: "another-thread",
      title: "Another task",
    };
    const { rerenderComposer } = renderComposer();
    pickFile(csv());
    await act(async () =>
      uploadRequests[0]!.respond(201, storedUpload("upload-old-task", "invoices.csv")),
    );

    rerenderComposer({ activeThread: otherThread, activeThreadId: otherThread.id });

    await waitFor(() => expect(deleteUpload).toHaveBeenCalledWith("upload-old-task"));
    await waitFor(() => expect(screen.queryByText("invoices.csv")).not.toBeInTheDocument());
  });

  it("uploads a dropped file and abandons it when the chip is removed", () => {
    renderComposer();
    const form = screen.getByLabelText("Task prompt").closest("form")!;
    fireEvent.drop(form, { dataTransfer: { files: [csv()], types: ["Files"] } });

    expect(uploadRequests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove invoices.csv" }));

    expect(screen.queryByText("invoices.csv")).not.toBeInTheDocument();
    expect(uploadRequests[0]!.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  it("deletes a stored upload when its chip is removed", async () => {
    const deleteUpload = vi.spyOn(api, "deleteUpload").mockResolvedValue({ ok: true });
    renderComposer();
    pickFile(csv());
    await act(async () => uploadRequests[0]!.respond(201, storedUpload("upload-remove", "invoices.csv")));

    fireEvent.click(screen.getByRole("button", { name: "Remove invoices.csv" }));

    await waitFor(() => expect(deleteUpload).toHaveBeenCalledWith("upload-remove"));
    expect(screen.queryByText("invoices.csv")).not.toBeInTheDocument();
  });

  it("reports an unsupported paste inline instead of uploading it", () => {
    renderComposer();
    fireEvent.paste(screen.getByLabelText("Task prompt"), {
      clipboardData: {
        items: [
          { getAsFile: () => new File(["image"], "reference.png", { type: "image/png" }), kind: "file" },
        ],
      },
    });

    expect(
      screen.getByText("Attach UTF-8 text files — .txt, .md, .csv, .tsv, .json, .ndjson, or .xml."),
    ).toBeInTheDocument();
    expect(uploadRequests).toHaveLength(0);
  });

  it("keeps the composer's own file-count warning next to the accepted files", () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: {
        files: Array.from(
          { length: 5 },
          (_unused, index) => new File(["a,b\n"], `row-${index}.csv`, { type: "text/csv" }),
        ),
      },
    });

    expect(uploadRequests).toHaveLength(4);
    expect(screen.getByText("Attach at most 4 files to one turn.")).toBeInTheDocument();
    expect(screen.getByText("row-0.csv")).toBeInTheDocument();
    expect(screen.queryByText("row-4.csv")).not.toBeInTheDocument();
  });

  it("keeps the attach control out of reach while a turn is running", () => {
    renderComposer({ activeTurnId: "turn-1" });
    expect(screen.getByRole("button", { name: "Attach context" })).toBeDisabled();
  });
});
