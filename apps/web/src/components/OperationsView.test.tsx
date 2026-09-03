import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { OperationsView } from "./OperationsView";

const dashboard: DashboardPayload = {
  user: {
    id: "user-1",
    tenantId: "tenant-1",
    username: "operator",
    displayName: "Operator",
    role: "admin",
    status: "active",
    mustChangePassword: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastLoginAt: null,
  },
  subscription: {
    plan: "team",
    status: "active",
    seats: 3,
    currentPeriodEnd: null,
    stripeConfigured: false,
  },
  usage: {
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: null,
    requestsUsed: 3,
    requestLimit: 100,
    activeRuns: 1,
    activeRunLimit: 4,
    inputTokens: 100,
    outputTokens: 50,
    seatsUsed: 1,
    seatLimit: 3,
  },
  providers: [],
  runtime: {
    status: "ready",
    message: "Runtime is accepting requests.",
    activeRuntimes: 1,
  },
  projects: [
    {
      id: "project-1",
      name: "Harness",
      path: "/workspace/harness",
      branch: "main",
      isGitRepository: true,
    },
  ],
  threads: [
    {
      id: "thread-complete",
      title: "Completed task",
      projectId: "project-1",
      projectName: "Harness",
      status: "completed",
      model: "model-a",
      updatedAt: "2026-09-02T10:00:00.000Z",
      preview: "Verified the real output.",
    },
    {
      id: "thread-failed",
      title: "Failed task",
      projectId: "project-1",
      projectName: "Harness",
      status: "failed",
      model: "model-a",
      updatedAt: "2026-09-02T09:00:00.000Z",
      preview: "Command exited with an error.",
    },
    {
      id: "thread-running",
      title: "Running task",
      projectId: "project-1",
      projectName: "Harness",
      status: "running",
      model: "model-b",
      updatedAt: "2026-09-02T11:00:00.000Z",
      preview: "Still working.",
    },
  ],
  featuredThread: null,
};

describe("OperationsView", () => {
  it("moves focus to the page heading when the operations route changes", async () => {
    const props = {
      dashboard,
      onOpenSidebar: vi.fn(),
      onStartReview: vi.fn(),
      onSelectThread: vi.fn(),
    };
    const { rerender } = render(<OperationsView {...props} view="agents" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Agents" })).toHaveFocus());

    rerender(<OperationsView {...props} view="capabilities" />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Capabilities" })).toHaveFocus();
    });
  });

  it("derives review candidates from real terminal and idle thread states", () => {
    const onSelectThread = vi.fn();
    const onStartReview = vi.fn().mockResolvedValue(undefined);
    render(
      <OperationsView
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={onStartReview}
        onSelectThread={onSelectThread}
        view="reviews"
      />,
    );

    expect(screen.getByRole("heading", { name: "Reviews" })).toBeInTheDocument();
    expect(screen.getByText("Completed task")).toBeInTheDocument();
    expect(screen.getByText("Failed task")).toBeInTheDocument();
    expect(screen.queryByText("Running task")).not.toBeInTheDocument();
    expect(screen.getByText(/No findings or file diffs are inferred/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry failed step" }));
    expect(onStartReview).toHaveBeenCalledWith("thread-complete");

    fireEvent.click(screen.getByRole("button", { name: "Follow-up turn" }));
    expect(onSelectThread).toHaveBeenCalledWith("thread-complete");
  });

  it("renders reported diffs and severity findings without synthesizing evidence", () => {
    render(
      <OperationsView
        activeThreadId="thread-complete"
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={vi.fn()}
        onSelectThread={vi.fn()}
        timeline={[
          {
            id: "file-1",
            kind: "file_change",
            title: "src/gateway/route.ts",
            body: "@@ -38,2 +38,3 @@\n const value = 1\n-oldRoute()\n+newRoute()\n+recordRoute()",
            status: "completed",
            timestamp: "2026-09-02T10:01:00.000Z",
          },
          {
            id: "finding-high",
            kind: "command",
            title: "Fallback remains unsafe",
            body: "A partial write can still enter route selection.",
            metadata: { path: "src/gateway/route.ts:88" },
            status: "failed",
            timestamp: "2026-09-02T10:02:00.000Z",
          },
          {
            id: "finding-medium",
            kind: "approval",
            title: "Migration approval pending",
            body: "Staging approval is required before migration.",
            status: "pending",
            timestamp: "2026-09-02T10:03:00.000Z",
          },
        ]}
        view="reviews"
      />,
    );

    const diff = screen.getByRole("region", { name: "src/gateway/route.ts unified diff" });
    expect(within(diff).getByText("oldRoute()", { exact: false })).toBeInTheDocument();
    expect(within(diff).getByText("newRoute()", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Fallback remains unsafe")).toBeInTheDocument();
    expect(screen.getByText("Migration approval pending")).toBeInTheDocument();
    expect(screen.getByText("1 high")).toBeInTheDocument();
    expect(screen.getByText("1 medium")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Whitespace" }));
    expect(within(diff).getByText("const·value·=·1", { exact: false })).toBeInTheDocument();
  });

  it("does not invent an agent hierarchy while still exposing live task state", () => {
    render(
      <OperationsView
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={vi.fn()}
        onSelectThread={vi.fn()}
        view="agents"
      />,
    );

    expect(screen.getByText("No agent hierarchy is reported")).toBeInTheDocument();
    expect(screen.getByText("Running task")).toBeInTheDocument();
    expect(screen.queryByText("Completed task")).not.toBeInTheDocument();
    expect(screen.getAllByText("FUTURE")).toHaveLength(2);
    expect(screen.getAllByText("LIVE")).toHaveLength(2);
  });

  it("renders every rooted and cyclic agent hierarchy component once", () => {
    const onSelectThread = vi.fn();
    const graphDashboard: DashboardPayload = {
      ...dashboard,
      threads: [
        {
          ...dashboard.threads[0]!,
          id: "root",
          title: "Root task",
          agentNickname: "Root agent",
        },
        {
          ...dashboard.threads[0]!,
          id: "child",
          title: "Child task",
          agentNickname: "Child agent",
          parentThreadId: "root",
        },
        {
          ...dashboard.threads[0]!,
          id: "cycle-a",
          title: "Cycle A task",
          agentNickname: "Cycle A agent",
          parentThreadId: "cycle-b",
        },
        {
          ...dashboard.threads[0]!,
          id: "cycle-b",
          title: "Cycle B task",
          agentNickname: "Cycle B agent",
          parentThreadId: "cycle-a",
        },
        {
          ...dashboard.threads[0]!,
          id: "cycle-c",
          title: "Cycle C task",
          agentNickname: "Cycle C agent",
          parentThreadId: "cycle-d",
        },
        {
          ...dashboard.threads[0]!,
          id: "cycle-d",
          title: "Cycle D task",
          agentNickname: "Cycle D agent",
          parentThreadId: "cycle-c",
        },
      ],
    };

    render(
      <OperationsView
        dashboard={graphDashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={vi.fn()}
        onSelectThread={onSelectThread}
        view="agents"
      />,
    );

    const hierarchy = screen.getByRole("list", { name: "Agent task hierarchy" });
    for (const nickname of [
      "Root agent",
      "Child agent",
      "Cycle A agent",
      "Cycle B agent",
      "Cycle C agent",
      "Cycle D agent",
    ]) {
      expect(within(hierarchy).getAllByText(nickname, { exact: true })).toHaveLength(1);
    }
    expect(within(hierarchy).getAllByText(/Cycle reported;/)).toHaveLength(2);
    expect(within(hierarchy).getAllByRole("button", { name: /^Open .* task$/ })).toHaveLength(6);

    fireEvent.click(within(hierarchy).getByRole("button", { name: "Open Cycle A task task" }));
    fireEvent.click(within(hierarchy).getByRole("button", { name: "Open Cycle C task task" }));
    expect(onSelectThread).toHaveBeenNthCalledWith(1, "cycle-a");
    expect(onSelectThread).toHaveBeenNthCalledWith(2, "cycle-c");
  });

  it("renders only reported runtime, project, and effective policy fields", () => {
    render(
      <OperationsView
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={vi.fn()}
        onSelectThread={vi.fn()}
        view="environments"
      />,
    );

    expect(screen.getByText("Runtime is accepting requests.")).toBeInTheDocument();
    expect(screen.getByText("Harness")).toBeInTheDocument();
    expect(screen.getByText("/workspace/harness")).toBeInTheDocument();
    expect(screen.getAllByText("Not reported")).toHaveLength(3);
  });

  it("keeps capabilities empty until a real inventory payload is supplied", () => {
    const { rerender } = render(
      <OperationsView
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={vi.fn()}
        onSelectThread={vi.fn()}
        view="capabilities"
      />,
    );
    expect(screen.getByText("Capability inventory is not connected")).toBeInTheDocument();

    rerender(
      <OperationsView
        capabilities={{
          items: [
            {
              id: "skill-1",
              name: "Repository review",
              kind: "skill",
              status: "ready",
              source: "operator",
              version: "1.0.0",
            },
          ],
          updatedAt: "2026-09-02T10:00:00.000Z",
        }}
        dashboard={dashboard}
        onOpenSidebar={vi.fn()}
        onStartReview={vi.fn()}
        onSelectThread={vi.fn()}
        view="capabilities"
      />,
    );

    expect(screen.getByText("Repository review")).toBeInTheDocument();
    expect(screen.getByText("operator · 1.0.0")).toBeInTheDocument();
    expect(screen.queryByText("Capability inventory is not connected")).not.toBeInTheDocument();
  });

  it("discloses bounded counts and distinguishes disabled optional features from unknown inventory", () => {
    const props = {
      dashboard,
      onOpenSidebar: vi.fn(),
      onStartReview: vi.fn(),
      onSelectThread: vi.fn(),
      view: "capabilities" as const,
    };
    const { rerender } = render(
      <OperationsView
        {...props}
        capabilities={{
          items: [
            { id: "server", name: "server", kind: "mcp_server", status: "ready" },
            { id: "tool-a", name: "tool-a", kind: "tool", status: "ready" },
            { id: "tool-b", name: "tool-b", kind: "tool", status: "ready" },
            { id: "skill", name: "skill", kind: "skill", status: "ready" },
          ],
          inventorySummary: {
            mcpServers: { count: 1, truncated: true },
            tools: { count: 2, truncated: true },
            skills: { count: 1, truncated: false, loadErrorCount: 2 },
          },
          runtimeSurfaces: {
            models: { count: 2, defaultModel: null, truncated: true },
            permissionProfiles: {
              count: 2,
              allowedInAnyWorkspaceCount: 1,
              workspaceCount: 3,
              truncated: true,
            },
            providerCapabilities: {
              namespaceTools: false,
              imageGeneration: false,
              webSearch: false,
            },
          },
        }}
      />,
    );

    const summary = screen.getByRole("region", { name: "Capability inventory summary" });
    expect(within(summary).getByText("Reported MCP servers").parentElement).toHaveTextContent("≥1");
    expect(within(summary).getByText("Reported tools").parentElement).toHaveTextContent("≥2");
    expect(within(summary).getByText("Reported skills").parentElement).toHaveTextContent("≥1");
    expect(screen.getByText("≥2 models reported")).toBeInTheDocument();
    expect(screen.getByText("No default model reported")).toBeInTheDocument();
    expect(screen.getByText("≥2 profiles reported")).toBeInTheDocument();
    expect(screen.getByText("1 shown as allowed in one or more of 3 workspace contexts")).toBeInTheDocument();
    expect(screen.getByText("No optional features enabled")).toBeInTheDocument();
    expect(screen.getByText("Bounded capability inventory")).toBeInTheDocument();
    expect(screen.getByText(/Counts prefixed with ≥ are lower bounds/)).toBeInTheDocument();

    rerender(
      <OperationsView
        {...props}
        capabilities={{
          items: [],
          runtimeSurfaces: {
            models: null,
            permissionProfiles: null,
            providerCapabilities: null,
          },
        }}
      />,
    );
    expect(screen.getByText("No provider feature inventory reported")).toBeInTheDocument();
    expect(screen.queryByText("No optional features enabled")).not.toBeInTheDocument();
  });
});
