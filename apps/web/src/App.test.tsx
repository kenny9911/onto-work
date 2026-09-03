import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardPayload, SavedProjectSummary, UserSummary } from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ControlPlaneView } from "@/components/ControlPlaneView";
import { controlledMatchMedia } from "@/test/match-media";
import { MAX_PENDING_NOTIFICATION_COUNT } from "@/lib/codex-notifications";
import type { RuntimeCapabilitiesPayload } from "@/lib/api";
import { App, HarnessApp } from "./App";

const {
  codexRequestMock,
  capabilitiesMock,
  createTaskMock,
  dashboardMock,
  listProjectsMock,
  meMock,
  registerProjectMock,
  steerTurnMock,
  threadMock,
} = vi.hoisted(() => ({
  codexRequestMock: vi.fn(),
  capabilitiesMock: vi.fn(),
  createTaskMock: vi.fn(),
  dashboardMock: vi.fn(),
  listProjectsMock: vi.fn(),
  meMock: vi.fn(),
  registerProjectMock: vi.fn(),
  steerTurnMock: vi.fn(),
  threadMock: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      codexRequest: codexRequestMock,
      capabilities: capabilitiesMock,
      createTask: createTaskMock,
      dashboard: dashboardMock,
      listProjects: listProjectsMock,
      me: meMock,
      registerProject: registerProjectMock,
      steerTurn: steerTurnMock,
      thread: threadMock,
    },
  };
});

const authenticatedUser: UserSummary = {
  id: "08aac4de-53c5-4fa7-bf89-96ec446907a2",
  tenantId: "6b4c6289-39a5-4d04-b695-7fe43ddc2cf1",
  username: "admin",
  displayName: "Administrator",
  role: "admin",
  status: "active",
  mustChangePassword: false,
  createdAt: "2026-09-02T00:00:00.000Z",
  lastLoginAt: "2026-09-02T00:01:00.000Z",
};

const dashboard: DashboardPayload = {
  user: authenticatedUser,
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
      id: "8a8ecac7-fc97-4626-b0d5-bdf89c956abb",
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
      id: "8d03bdd9-a190-4929-a125-2c4748207d57",
      name: "onto-work",
      path: "/workspace/onto-work",
      branch: "main",
      isGitRepository: true,
    },
  ],
  threads: [
    {
      id: "4d626e26-0750-4081-8e6f-a7bd067c0a3f",
      title: "Authenticated workspace regression",
      projectId: "8d03bdd9-a190-4929-a125-2c4748207d57",
      projectName: "onto-work",
      status: "running",
      model: "gpt-5.4",
      updatedAt: "2026-09-02T00:02:00.000Z",
      preview: "Verify the workspace shell remains visible.",
    },
  ],
  featuredThread: {
    thread: {
      id: "4d626e26-0750-4081-8e6f-a7bd067c0a3f",
      title: "Authenticated workspace regression",
      projectId: "8d03bdd9-a190-4929-a125-2c4748207d57",
      projectName: "onto-work",
      status: "running",
      model: "gpt-5.4",
      updatedAt: "2026-09-02T00:02:00.000Z",
      preview: "Verify the workspace shell remains visible.",
    },
    timeline: [
      {
        id: "timeline-1",
        kind: "assistant",
        title: "Agent",
        body: "The authenticated workspace loaded successfully.",
        status: "completed",
        timestamp: "2026-09-02T00:02:00.000Z",
      },
    ],
  },
};

const savedProject: SavedProjectSummary = {
  ...dashboard.projects[0]!,
  workspaceId: "6c71fd09-0f5f-4ea1-aace-ef7360255b85",
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
};

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class EventSourceMock {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = EventSourceMock.CONNECTING;
  readonly OPEN = EventSourceMock.OPEN;
  readonly CLOSED = EventSourceMock.CLOSED;
  readonly url: string;
  readonly withCredentials: boolean;
  readonly readyState = EventSourceMock.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn(() => true);

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = options?.withCredentials ?? false;
    eventSources.push(this);
  }
}

const eventSources: EventSourceMock[] = [];

function installAnimationFrameController() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
    callbacks.delete(id);
  }));
  return {
    flush() {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(performance.now());
    },
  };
}

function emitRuntimeEvent(source: EventSourceMock, payload: unknown) {
  source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
}

function currentEventSource(): EventSourceMock {
  const source = eventSources[0];
  if (!source) throw new Error("Expected the Codex event stream to be connected");
  return source;
}

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

describe("App", () => {
  let media: ReturnType<typeof controlledMatchMedia>;

  beforeEach(() => {
    codexRequestMock.mockReset();
    capabilitiesMock.mockReset();
    createTaskMock.mockReset();
    dashboardMock.mockReset();
    listProjectsMock.mockReset();
    meMock.mockReset();
    registerProjectMock.mockReset();
    steerTurnMock.mockReset();
    threadMock.mockReset();
    threadMock.mockImplementation(async (threadId: string) => ({
      thread: {
        ...dashboard.threads[0]!,
        id: threadId,
        title: threadId === dashboard.threads[0]!.id
          ? dashboard.threads[0]!.title
          : threadId === "thread-created"
          ? "Created task"
          : threadId === "thread-second"
            ? "Second task"
            : "Hydrated task",
      },
      timeline: [],
    }));
    listProjectsMock.mockResolvedValue({ projects: [savedProject], nextCursor: null });
    eventSources.length = 0;
    vi.stubGlobal("EventSource", EventSourceMock);
    media = controlledMatchMedia();
    vi.stubGlobal("matchMedia", media.matchMedia);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the authenticated workspace after its lazy view resolves", async () => {
    meMock.mockResolvedValue({ user: authenticatedUser });
    dashboardMock.mockResolvedValue(dashboard);

    render(
      <TooltipProvider delayDuration={0}>
        <App />
      </TooltipProvider>,
    );

    const workspaceHeading = await screen.findByRole(
      "heading",
      { name: "Authenticated workspace regression" },
      { timeout: 5_000 },
    );
    expect(workspaceHeading).toBeInTheDocument();
    await waitFor(() => expect(workspaceHeading).toHaveFocus());
    expect(screen.getByLabelText("Task prompt")).toBeInTheDocument();
    expect(screen.getByText("The authenticated workspace loaded successfully.")).toBeInTheDocument();
    expect(screen.queryByText("Opening workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading interface")).not.toBeInTheDocument();
    expect(meMock).toHaveBeenCalledOnce();
    expect(dashboardMock).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(eventSources).toHaveLength(1);
    });
    expect(eventSources[0]).toMatchObject({
      url: "/api/codex/events",
      withCredentials: true,
    });

    expect(window.location.pathname).toBe(
      "/tasks/4d626e26-0750-4081-8e6f-a7bd067c0a3f",
    );

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(within(palette).getByText("Model routes"));
    const routesHeading = await screen.findByRole("heading", { name: "Model routes" });
    expect(routesHeading).toBeInTheDocument();
    await waitFor(() => expect(routesHeading).toHaveFocus());
    expect(window.location.pathname).toBe("/settings/providers");

    window.history.replaceState(
      {},
      "",
      "/tasks/4d626e26-0750-4081-8e6f-a7bd067c0a3f",
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    const restoredHeading = await screen.findByRole(
      "heading",
      { name: "Authenticated workspace regression" },
    );
    expect(restoredHeading).toBeInTheDocument();
    await waitFor(() => expect(restoredHeading).toHaveFocus());

    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(await screen.findByText("What should the harness build next?")).toBeInTheDocument();
    const newTaskHeading = screen.getByRole("heading", { name: "Start a new task" });
    await waitFor(() => expect(newTaskHeading).toHaveFocus());
    expect(window.location.pathname).toBe("/workspace");
  });

  it("preserves bounded capability metadata without inferring a default model", async () => {
    const runtimeCapabilities: RuntimeCapabilitiesPayload = {
      generatedAt: "2026-09-02T10:00:00.000Z",
      mcpServers: {
        status: "available",
        data: {
          items: [
            {
              name: "filesystem",
              pluginId: null,
              runtimeStatus: "connected",
              authStatus: null,
              tools: ["read_file"],
              toolsTruncated: true,
            },
          ],
          truncated: false,
        },
        error: null,
      },
      skills: {
        status: "available",
        data: {
          items: [
            {
              name: "review",
              displayName: "Repository review",
              description: "Review a repository.",
              scope: "system",
              pluginId: null,
              enabledInWorkspaceCount: 1,
            },
          ],
          workspaceCount: 2,
          loadErrorCount: 1,
          truncated: false,
        },
        error: null,
      },
      models: {
        status: "available",
        data: {
          items: [
            {
              id: "visible-model",
              model: "visible-model",
              displayName: "Visible but not default",
              hidden: false,
              isDefault: false,
              multiAgentVersion: null,
            },
          ],
          truncated: true,
        },
        error: null,
      },
      permissionProfiles: {
        status: "available",
        data: {
          items: [
            {
              id: "workspace-write",
              description: "Workspace write",
              availableInWorkspaceCount: 2,
              allowedInWorkspaceCount: 1,
            },
          ],
          workspaceCount: 2,
          truncated: true,
        },
        error: null,
      },
      providerCapabilities: {
        status: "available",
        data: {
          namespaceTools: false,
          imageGeneration: false,
          webSearch: false,
        },
        error: null,
      },
    };
    dashboardMock.mockResolvedValue(dashboard);
    capabilitiesMock.mockResolvedValue(runtimeCapabilities);
    window.history.replaceState({}, "", "/settings/capabilities");

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Capabilities" })).toBeInTheDocument();
    expect(await screen.findByText("≥1 models reported")).toBeInTheDocument();
    expect(screen.getByText("No default model reported")).toBeInTheDocument();
    expect(screen.queryByText("Default: Visible but not default")).not.toBeInTheDocument();
    expect(screen.getByText("≥1 profiles reported")).toBeInTheDocument();
    expect(screen.getByText("1 shown as allowed in one or more of 2 workspace contexts")).toBeInTheDocument();
    expect(screen.getByText("No optional features enabled")).toBeInTheDocument();
    expect(screen.getByText("Bounded capability inventory")).toBeInTheDocument();
    expect(screen.getByText(/Codex reported 1 skill load error;/)).toBeInTheDocument();
  });

  it("publishes a project mutation to the new-task selector and ignores the older project read", async () => {
    window.history.replaceState({}, "", "/projects");
    const staleRead = deferred<{ projects: SavedProjectSummary[]; nextCursor: null }>();
    const registeredProject: SavedProjectSummary = {
      ...savedProject,
      id: "project-registered",
      name: "Newly registered project",
      path: "/workspace/newly-registered",
      workspaceId: "workspace-registered",
      repositoryRoot: "/workspace/newly-registered",
      updatedAt: "2026-09-02T00:10:00.000Z",
    };
    dashboardMock.mockResolvedValue(dashboard);
    listProjectsMock
      .mockReset()
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValue({ projects: [], nextCursor: null });
    registerProjectMock.mockResolvedValue({ project: registeredProject });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByText("No saved projects");
    fireEvent.click(screen.getByRole("button", { name: "Register project" }));
    const dialog = await screen.findByRole("dialog", { name: "Register an existing workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), {
      target: { value: registeredProject.name },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Existing workspace path" }), {
      target: { value: registeredProject.path },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Register project" }));
    expect(await screen.findByText(registeredProject.path)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await screen.findByText("What should the harness build next?");
    expect(screen.getByRole("combobox", { name: "Task project" }))
      .toHaveTextContent(registeredProject.name);

    await act(async () => {
      staleRead.resolve({ projects: [savedProject], nextCursor: null });
      await staleRead.promise;
    });
    expect(screen.getByRole("combobox", { name: "Task project" }))
      .toHaveTextContent(registeredProject.name);
    expect(listProjectsMock).toHaveBeenCalledTimes(2);
  });

  it("explains the operator-managed LiteLLM endpoint and refreshes its credential label", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const props = {
      dashboard,
      onOpenSidebar: vi.fn(),
      onRefresh,
    };
    render(<ControlPlaneView {...props} view="providers" />);

    fireEvent.click(screen.getByRole("button", { name: "Add route" }));
    const routeDialog = await screen.findByRole("dialog", { name: "Add a model route" });
    const providerSelect = within(routeDialog).getByRole("combobox");
    fireEvent.keyDown(providerSelect, { key: "ArrowDown" });
    const anthropicOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Anthropic");
    expect(anthropicOption).toBeDefined();
    fireEvent.click(anthropicOption!);
    expect(within(routeDialog).getByRole("note", { name: "LiteLLM endpoint policy" }))
      .toHaveTextContent("gateway URL cannot be changed in the browser");
    expect(within(routeDialog).queryByRole("textbox", { name: "Endpoint" }))
      .not.toBeInTheDocument();
    expect(within(routeDialog).getByLabelText(/^LiteLLM route token/))
      .toHaveAccessibleName(/^LiteLLM route token/);
  });

  it("uses a labelled, focusable scroll owner and a normalized usage meter", () => {
    render(
      <ControlPlaneView
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="usage"
      />,
    );
    const usageRegion = screen.getByRole("region", { name: "Usage content" });
    expect(usageRegion).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain");
    expect(usageRegion).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("meter", { name: "Requests usage" })).toHaveAttribute(
      "aria-valuetext",
      "84 of 100,000 used (0%)",
    );
    expect(screen.getByRole("meter", { name: "Requests usage" })).toHaveAttribute(
      "aria-valuenow",
      "84",
    );
  });

  it("keeps billing plan copy within implemented entitlement behavior", () => {
    render(
      <ControlPlaneView
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="billing"
      />,
    );
    expect(screen.queryByText("Unlimited routes")).not.toBeInTheDocument();
    expect(screen.queryByText("Priority runtimes")).not.toBeInTheDocument();
    expect(screen.getAllByText("Webhook-verified activation")).not.toHaveLength(0);
  });

  it("isolates drafts by task, ignores editable shortcuts, and closes responsive overlays", async () => {
    dashboardMock.mockResolvedValue(dashboard);

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    let prompt = screen.getByLabelText("Task prompt");
    fireEvent.change(prompt, { target: { value: "Draft for the existing task" } });

    fireEvent.keyDown(prompt, { key: "n", metaKey: true });
    expect(window.location.pathname).toBe(
      "/tasks/4d626e26-0750-4081-8e6f-a7bd067c0a3f",
    );

    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await screen.findByText("What should the harness build next?");
    prompt = screen.getByLabelText("Task prompt");
    expect(prompt).toHaveValue("");
    fireEvent.change(prompt, { target: { value: "Draft for a new task" } });

    fireEvent.click(screen.getByRole("button", { name: /Authenticated workspace regression/ }));
    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Draft for the existing task");

    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Draft for a new task");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(within(palette).getByText("Start a new task"));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const mobileSidebar = screen.getByRole("dialog", { name: "Workspace navigation" });
    expect(mobileSidebar).toHaveClass("w-[min(88vw,320px)]");
    expect(within(mobileSidebar).getByRole("complementary"))
      .toHaveClass("w-[min(88vw,320px)]");
    act(() => media.controller("(min-width: 900px)").setMatches(true));
    expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });

  it("keeps a new task's optimistic request visible after the runtime assigns its id", async () => {
    window.history.replaceState({}, "", "/workspace");
    dashboardMock.mockResolvedValue(dashboard);
    createTaskMock.mockResolvedValueOnce({
      result: { thread: { id: "thread-created" } },
    });
    codexRequestMock.mockResolvedValueOnce({ result: { turn: { id: "turn-created" } } });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByText("What should the harness build next?");
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Keep this optimistic request visible" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Keep this optimistic request visible")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/thread-created"));
    expect(dashboardMock).toHaveBeenCalledOnce();
    expect(createTaskMock).toHaveBeenCalledWith(
      { projectId: "8d03bdd9-a190-4929-a125-2c4748207d57" },
      expect.any(String),
    );
    expect(codexRequestMock).toHaveBeenCalledWith("turn/start", {
      input: [{ text: "Keep this optimistic request visible", type: "text" }],
      threadId: "thread-created",
    }, expect.any(String));
  });

  it("reuses the task idempotency key and retains the draft after an uncertain start", async () => {
    window.history.replaceState({}, "", "/workspace");
    dashboardMock.mockResolvedValue(dashboard);
    createTaskMock
      .mockRejectedValueOnce(new Error("Connection closed before the response arrived"))
      .mockResolvedValueOnce({ result: { thread: { id: "thread-replayed" } }, replayed: true });
    codexRequestMock.mockResolvedValueOnce({ result: { turn: { id: "turn-replayed" } } });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByText("What should the harness build next?");
    const prompt = screen.getByLabelText("Task prompt");
    fireEvent.change(prompt, { target: { value: "Retry this logical task safely" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Connection closed before the response arrived"))
      .toBeInTheDocument();
    expect(prompt).toHaveValue("Retry this logical task safely");
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(2));
    expect(createTaskMock.mock.calls[0]?.[1]).toBe(createTaskMock.mock.calls[1]?.[1]);
    expect(createTaskMock.mock.calls[0]?.[1]).toEqual(expect.any(String));
    await waitFor(() => expect(codexRequestMock).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe("/tasks/thread-replayed");
    expect(screen.getAllByText("Retry this logical task safely")).toHaveLength(1);
  });

  it("replays an uncertain turn start even when SSE reports the new turn before retry", async () => {
    dashboardMock.mockResolvedValue(dashboard);
    codexRequestMock
      .mockRejectedValueOnce(new Error("Connection closed before the turn response arrived"))
      .mockResolvedValueOnce({ result: { turn: { id: "turn-replayed" } } });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    await waitFor(() => expect(eventSources).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Start this turn exactly once" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Connection closed before the turn response arrived"))
      .toBeInTheDocument();

    act(() => {
      emitRuntimeEvent(currentEventSource(), {
        kind: "notification",
        method: "turn/started",
        params: {
          threadId: dashboard.threads[0]!.id,
          turn: { id: "turn-observed-over-sse" },
        },
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(codexRequestMock).toHaveBeenCalledTimes(2));
    expect(codexRequestMock.mock.calls[0]?.[2]).toBe(codexRequestMock.mock.calls[1]?.[2]);
    expect(steerTurnMock).not.toHaveBeenCalled();
    expect(screen.getAllByText("Start this turn exactly once")).toHaveLength(1);
  });

  it("rotates a closed mutation key after a definitive API failure", async () => {
    const { ApiClientError } = await import("@/lib/api");
    dashboardMock.mockResolvedValue(dashboard);
    codexRequestMock
      .mockRejectedValueOnce(new ApiClientError(502, "runtime_dispatch_failed", "Runtime rejected the turn"))
      .mockResolvedValueOnce({ result: { turn: { id: "turn-after-retry" } } });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Retry after a definite rejection" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Runtime rejected the turn")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(codexRequestMock).toHaveBeenCalledTimes(2));
    expect(codexRequestMock.mock.calls[0]?.[2]).not.toBe(codexRequestMock.mock.calls[1]?.[2]);
    expect(screen.getAllByText("Retry after a definite rejection")).toHaveLength(1);
  });

  it("keeps ambiguous retry identity isolated per task", async () => {
    const primaryThread = dashboard.threads[0]!;
    const secondThread = {
      ...primaryThread,
      id: "thread-second",
      title: "Second task",
    };
    dashboardMock.mockResolvedValue({
      ...dashboard,
      threads: [primaryThread, secondThread],
    });
    codexRequestMock
      .mockRejectedValueOnce(new Error("Primary response was lost"))
      .mockRejectedValueOnce(new Error("Second response was lost"))
      .mockResolvedValueOnce({ result: { turn: { id: "primary-replayed" } } });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Primary ambiguous prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Primary response was lost")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Second task/ }));
    await screen.findByRole("heading", { name: "Second task" });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Second ambiguous prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Second response was lost")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Authenticated workspace regression/ }));
    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    expect(screen.getByLabelText("Task prompt")).toHaveValue("Primary ambiguous prompt");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(codexRequestMock).toHaveBeenCalledTimes(3));
    expect(codexRequestMock.mock.calls[0]?.[2]).toBe(codexRequestMock.mock.calls[2]?.[2]);
    expect(codexRequestMock.mock.calls[0]?.[2]).not.toBe(codexRequestMock.mock.calls[1]?.[2]);
    expect(screen.getAllByText("Primary ambiguous prompt")).toHaveLength(1);
  });

  it("hydrates a deep-linked task that is not the dashboard feature", async () => {
    window.history.replaceState({}, "", "/tasks/thread-history");
    dashboardMock.mockResolvedValue(dashboard);
    threadMock.mockResolvedValue({
      thread: {
        ...dashboard.threads[0]!,
        id: "thread-history",
        title: "Durable task history",
        preview: "Loaded from Codex thread/read.",
      },
      timeline: [
        {
          id: "persisted-item",
          kind: "assistant",
          title: "Agent response",
          body: "This response survived a reload.",
          status: "completed",
          timestamp: "2026-09-02T00:03:00.000Z",
        },
      ],
    });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Durable task history" }))
      .toBeInTheDocument();
    expect(await screen.findByText("This response survived a reload.")).toBeInTheDocument();
    expect(threadMock).toHaveBeenCalledWith("thread-history");
  });

  it("keeps newer SSE liveness and task status across a stale dashboard refresh", async () => {
    const primaryThread = { ...dashboard.threads[0]!, status: "idle" as const };
    const staleDashboard = {
      ...dashboard,
      threads: [primaryThread],
      featuredThread: {
        ...dashboard.featuredThread!,
        thread: primaryThread,
      },
    };
    dashboardMock.mockResolvedValue(staleDashboard);

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: primaryThread.title });
    await waitFor(() => expect(eventSources).toHaveLength(1));
    act(() => {
      emitRuntimeEvent(currentEventSource(), {
        kind: "notification",
        method: "turn/started",
        params: { threadId: primaryThread.id, turn: { id: "turn-live" } },
      });
    });

    expect(await screen.findByRole("button", { name: "Interrupt active turn" }))
      .toBeInTheDocument();
    await waitFor(() => expect(dashboardMock).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(within(screen.getByRole("button", { name: /Authenticated workspace regression/ }))
      .getByText("running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Interrupt active turn" })).toBeInTheDocument();

    act(() => {
      emitRuntimeEvent(currentEventSource(), {
        kind: "notification",
        method: "turn/completed",
        params: { threadId: primaryThread.id, turn: { id: "turn-live", status: "completed" } },
      });
    });
    await waitFor(() => expect(dashboardMock).toHaveBeenCalledTimes(3), { timeout: 2_000 });
    expect(screen.queryByRole("button", { name: "Interrupt active turn" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Authenticated workspace regression/ }))
      .getByText("idle")).toBeInTheDocument();
  });

  it("does not let late hydration erase a turn learned from SSE", async () => {
    window.history.replaceState({}, "", "/tasks/thread-history");
    dashboardMock.mockResolvedValue(dashboard);
    let resolveThread: ((value: unknown) => void) | undefined;
    threadMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveThread = resolve;
    }));

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await waitFor(() => expect(threadMock).toHaveBeenCalledWith("thread-history"));
    await waitFor(() => expect(eventSources).toHaveLength(1));
    act(() => {
      emitRuntimeEvent(currentEventSource(), {
        kind: "notification",
        method: "turn/started",
        params: { threadId: "thread-history", turn: { id: "turn-newer" } },
      });
    });
    await act(async () => {
      resolveThread?.({
        thread: {
          ...dashboard.threads[0]!,
          id: "thread-history",
          title: "Hydrated after SSE",
          status: "idle",
          activeTurnId: null,
        },
        timeline: [],
      });
    });

    expect(await screen.findByRole("button", { name: "Interrupt active turn" }))
      .toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Hydrated after SSE/ }))
      .getByText("running")).toBeInTheDocument();
  });

  it("does not let late hydration resurrect a turn completed over SSE", async () => {
    window.history.replaceState({}, "", "/tasks/thread-history");
    dashboardMock.mockResolvedValue(dashboard);
    let resolveThread: ((value: unknown) => void) | undefined;
    threadMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveThread = resolve;
    }));

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await waitFor(() => expect(threadMock).toHaveBeenCalledWith("thread-history"));
    await waitFor(() => expect(eventSources).toHaveLength(1));
    act(() => {
      emitRuntimeEvent(currentEventSource(), {
        kind: "notification",
        method: "turn/started",
        params: { threadId: "thread-history", turn: { id: "turn-finished" } },
      });
      emitRuntimeEvent(currentEventSource(), {
        kind: "notification",
        method: "turn/completed",
        params: {
          threadId: "thread-history",
          turn: { id: "turn-finished", status: "completed" },
        },
      });
    });
    await act(async () => {
      resolveThread?.({
        thread: {
          ...dashboard.threads[0]!,
          id: "thread-history",
          title: "Stale active hydration",
          status: "running",
          activeTurnId: "turn-finished",
        },
        timeline: [],
      });
    });

    await screen.findByRole("heading", { name: "Stale active hydration" });
    expect(screen.queryByRole("button", { name: "Interrupt active turn" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Stale active hydration/ }))
      .getByText("idle")).toBeInTheDocument();
  });

  it("runs a requested follow-up hydration after the current read finishes", async () => {
    window.history.replaceState({}, "", "/tasks/thread-history");
    dashboardMock.mockResolvedValue(dashboard);
    let resolveFirstRead: ((value: unknown) => void) | undefined;
    threadMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstRead = resolve;
      }))
      .mockResolvedValueOnce({
        thread: {
          ...dashboard.threads[0]!,
          id: "thread-history",
          title: "Fresh follow-up hydration",
          status: "idle",
        },
        timeline: [],
      });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await waitFor(() => expect(threadMock).toHaveBeenCalledTimes(1));
    act(() => {
      window.history.pushState({}, "", "/tasks/thread-history");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      resolveFirstRead?.({
        thread: {
          ...dashboard.threads[0]!,
          id: "thread-history",
          title: "Older hydration",
          status: "idle",
        },
        timeline: [],
      });
    });

    await waitFor(() => expect(threadMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "Fresh follow-up hydration" }))
      .toBeInTheDocument();
  });

  it("isolates live events by task and restores each in-session timeline", async () => {
    const frames = installAnimationFrameController();
    const primaryThread = dashboard.threads[0];
    if (!primaryThread) throw new Error("Expected the dashboard fixture to include a task");
    const secondThread = {
      ...primaryThread,
      id: "thread-second",
      title: "Second task",
      preview: "A separate task timeline.",
    };
    dashboardMock.mockResolvedValue({
      ...dashboard,
      threads: [...dashboard.threads, secondThread],
    });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    await waitFor(() => expect(eventSources).toHaveLength(1));
    const eventSource = currentEventSource();

    act(() => {
      emitRuntimeEvent(eventSource, {
        kind: "notification",
        method: "runtime/connected",
        params: {},
      });
      emitRuntimeEvent(eventSource, {
        kind: "notification",
        method: "item/agentMessage/delta",
        params: { delta: "foreign event", threadId: "thread-second" },
      });
      emitRuntimeEvent(eventSource, {
        kind: "notification",
        method: "item/agentMessage/delta",
        params: {
          delta: " first task live update",
          threadId: primaryThread.id,
        },
      });
      frames.flush();
    });

    expect(await screen.findByText(/first task live update/)).toBeInTheDocument();
    expect(screen.queryByText("foreign event")).not.toBeInTheDocument();
    expect(screen.queryByText("runtime\/connected")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Second task/ }));
    expect(await screen.findByRole("heading", { name: "Second task" })).toBeInTheDocument();
    expect(screen.queryByText(/first task live update/)).not.toBeInTheDocument();

    act(() => {
      emitRuntimeEvent(eventSource, {
        kind: "notification",
        method: "item/agentMessage/delta",
        params: {
          delta: "second task live update",
          turn: { threadId: "thread-second" },
        },
      });
      frames.flush();
    });
    expect(await screen.findByText("second task live update")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Authenticated workspace regression/ }));
    expect(await screen.findByText(/first task live update/)).toBeInTheDocument();
    expect(screen.queryByText("second task live update")).not.toBeInTheDocument();
  });

  it("binds a new task before turn events can arrive", async () => {
    const frames = installAnimationFrameController();
    window.history.replaceState({}, "", "/workspace");
    dashboardMock.mockResolvedValue(dashboard);
    createTaskMock.mockResolvedValueOnce({
      result: { thread: { id: "thread-live-created" } },
    });
    codexRequestMock.mockImplementationOnce(async () => {
        emitRuntimeEvent(currentEventSource(), {
          kind: "notification",
          method: "item/agentMessage/delta",
          params: {
            delta: "Live response on the assigned thread",
            threadId: "thread-live-created",
          },
        });
        return { result: { turn: { id: "turn-created" } } };
    });

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByText("What should the harness build next?");
    await waitFor(() => expect(eventSources).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "Optimistic request stays with its runtime thread" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(createTaskMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(codexRequestMock).toHaveBeenCalledOnce());
    act(() => frames.flush());
    expect(await screen.findByText("Optimistic request stays with its runtime thread"))
      .toBeInTheDocument();
    expect(await screen.findByText("Live response on the assigned thread"))
      .toBeInTheDocument();
    expect(window.location.pathname).toBe("/tasks/thread-live-created");
  });

  it("replaces an overfull animation-frame queue with one recovery item", async () => {
    const frames = installAnimationFrameController();
    const primaryThread = dashboard.threads[0];
    if (!primaryThread) throw new Error("Expected the dashboard fixture to include a task");
    dashboardMock.mockResolvedValue(dashboard);

    render(
      <TooltipProvider delayDuration={0}>
        <HarnessApp onSignedOut={vi.fn()} user={authenticatedUser} />
      </TooltipProvider>,
    );

    await screen.findByRole("heading", { name: "Authenticated workspace regression" });
    await waitFor(() => expect(eventSources).toHaveLength(1));
    const eventSource = currentEventSource();
    act(() => {
      for (let index = 0; index <= MAX_PENDING_NOTIFICATION_COUNT; index += 1) {
        emitRuntimeEvent(eventSource, {
          kind: "notification",
          method: "item/agentMessage/delta",
          params: {
            delta: `queued-${index}`,
            threadId: primaryThread.id,
          },
        });
      }
      frames.flush();
    });

    expect(await screen.findByText("Live updates were throttled")).toBeInTheDocument();
    expect(screen.getAllByText("Live updates were throttled")).toHaveLength(1);
    expect(screen.queryByText(/queued-0/)).not.toBeInTheDocument();
  });
});
