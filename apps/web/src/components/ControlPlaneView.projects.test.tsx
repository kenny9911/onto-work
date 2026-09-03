import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardPayload, SavedProjectSummary } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { ControlPlaneView } from "./ControlPlaneView";

const savedProject: SavedProjectSummary = {
  id: "project-1",
  name: "Agent Harness",
  path: "/workspace/agent-harness",
  branch: "main",
  isGitRepository: true,
  workspaceId: "workspace-1",
  enabled: true,
  availability: "available",
  repositoryStatus: "repository",
  repositoryRoot: "/workspace/agent-harness",
  headCommit: "0123456789abcdef0123456789abcdef01234567",
  upstream: "origin/main",
  dirty: false,
  remoteUrl: "https://example.test/org/agent-harness.git",
  createdAt: "2026-09-01T00:00:00.000Z",
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

function dashboard(role: "admin" | "member" = "admin"): DashboardPayload {
  return {
    user: {
      id: "user-1",
      tenantId: "tenant-1",
      username: role,
      displayName: role === "admin" ? "Admin" : "Member",
      role,
      status: "active",
      mustChangePassword: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      lastLoginAt: null,
    },
    subscription: {
      plan: "team",
      status: "active",
      seats: 2,
      currentPeriodEnd: null,
      stripeConfigured: false,
    },
    usage: {
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: null,
      requestsUsed: 1,
      requestLimit: 100,
      activeRuns: 1,
      activeRunLimit: 2,
      inputTokens: 10,
      outputTokens: 10,
      seatsUsed: 2,
      seatLimit: 2,
    },
    providers: [],
    runtime: { status: "ready", message: null, activeRuntimes: 1 },
    projects: [
      {
        id: "runtime-project",
        name: "Transient runtime project",
        path: "/workspace/runtime-only",
        branch: "runtime-branch",
        isGitRepository: true,
      },
    ],
    threads: [
      {
        id: "thread-1",
        title: "Running task",
        projectId: "runtime-project",
        projectName: "Transient runtime project",
        status: "running",
        model: "model-a",
        updatedAt: "2026-09-02T00:00:00.000Z",
        preview: "Working",
      },
    ],
    featuredThread: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProjectsView", () => {
  it("loads the saved registry without presenting runtime projects as saved entries", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue({
      projects: [savedProject],
      nextCursor: null,
    });

    render(
      <ControlPlaneView
        dashboard={dashboard("member")}
        onOpenSidebar={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="projects"
      />,
    );

    expect(await screen.findByText("Agent Harness")).toBeInTheDocument();
    expect(screen.getByText("/workspace/agent-harness")).toBeInTheDocument();
    expect(screen.queryByText("Transient runtime project")).not.toBeInTheDocument();
    expect(screen.getByText("Runtime-derived active task states")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Agent Harness" })).not.toBeInTheDocument();
  });

  it("lets an administrator register an existing granted workspace", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue({ projects: [], nextCursor: null });
    const registerProject = vi.spyOn(api, "registerProject").mockResolvedValue({
      project: savedProject,
    });
    const onProjectsChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <ControlPlaneView
        dashboard={dashboard()}
        onOpenSidebar={vi.fn()}
        onProjectsChanged={onProjectsChanged}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="projects"
      />,
    );

    await screen.findByText("No saved projects");
    fireEvent.click(screen.getByRole("button", { name: "Register project" }));
    const dialog = await screen.findByRole("dialog", { name: "Register an existing workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), {
      target: { value: "Agent Harness" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Existing workspace path" }), {
      target: { value: "/workspace/agent-harness" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Register project" }));

    await waitFor(() => {
      expect(registerProject).toHaveBeenCalledWith({
        name: "Agent Harness",
        workspacePath: "/workspace/agent-harness",
      });
    });
    expect(await screen.findByText("/workspace/agent-harness")).toBeInTheDocument();
    await waitFor(() => expect(onProjectsChanged).toHaveBeenCalledWith({
      type: "upsert",
      project: savedProject,
    }));
  });

  it("keeps a registered project when an older registry read settles later", async () => {
    const staleRead = deferred<{ projects: SavedProjectSummary[]; nextCursor: null }>();
    vi.spyOn(api, "listProjects").mockReturnValue(staleRead.promise);
    vi.spyOn(api, "registerProject").mockResolvedValue({ project: savedProject });
    const onProjectsChanged = vi.fn();

    render(
      <ControlPlaneView
        dashboard={dashboard()}
        onOpenSidebar={vi.fn()}
        onProjectsChanged={onProjectsChanged}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="projects"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Register project" }));
    const dialog = await screen.findByRole("dialog", { name: "Register an existing workspace" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), {
      target: { value: savedProject.name },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Existing workspace path" }), {
      target: { value: savedProject.path },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Register project" }));

    expect(await screen.findByText(savedProject.path)).toBeInTheDocument();
    expect(onProjectsChanged).toHaveBeenCalledWith({ type: "upsert", project: savedProject });

    await act(async () => {
      staleRead.resolve({ projects: [], nextCursor: null });
      await staleRead.promise;
    });
    expect(screen.getByText(savedProject.path)).toBeInTheDocument();
    expect(screen.queryByText("No saved projects")).not.toBeInTheDocument();
  });

  it("lets an administrator rename and disable a saved project", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue({
      projects: [savedProject],
      nextCursor: null,
    });
    const updateProject = vi.spyOn(api, "updateProject").mockResolvedValue({
      project: { ...savedProject, name: "Renamed Harness", enabled: false },
    });
    const onProjectsChanged = vi.fn().mockResolvedValue(undefined);

    render(
      <ControlPlaneView
        dashboard={dashboard()}
        onOpenSidebar={vi.fn()}
        onProjectsChanged={onProjectsChanged}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="projects"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Manage Agent Harness" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage saved project" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), {
      target: { value: "Renamed Harness" },
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Enabled for new work/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save project" }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith("project-1", {
        name: "Renamed Harness",
        enabled: false,
      });
    });
    expect(await screen.findByText("Renamed Harness")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    await waitFor(() => expect(onProjectsChanged).toHaveBeenCalledWith({
      type: "upsert",
      project: { ...savedProject, name: "Renamed Harness", enabled: false },
    }));
  });

  it("shows a truthful registry error with a retry action", async () => {
    const listProjects = vi.spyOn(api, "listProjects")
      .mockRejectedValueOnce(new Error("Registry is offline"))
      .mockResolvedValueOnce({ projects: [], nextCursor: null });

    render(
      <ControlPlaneView
        dashboard={dashboard()}
        onOpenSidebar={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        view="projects"
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Registry is offline");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No saved projects")).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });
});
