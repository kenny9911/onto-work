import type { DashboardPayload, ThreadSummary } from "@agent-harness/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";

const thread: ThreadSummary = {
  id: "thread-1",
  title: "Provider failover",
  projectId: "project-1",
  projectName: "Runtime fallback",
  status: "running",
  model: "helios-4-turbo",
  updatedAt: "2026-09-02T00:00:00.000Z",
  preview: "Routing work",
};

const dashboard: DashboardPayload = {
  user: {
    id: "user-1",
    tenantId: "tenant-1",
    username: "rkennedy",
    displayName: "Rae Kennedy",
    role: "admin",
    status: "active",
    mustChangePassword: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastLoginAt: null,
  },
  subscription: {
    plan: "team",
    status: "active",
    seats: 5,
    currentPeriodEnd: null,
    stripeConfigured: true,
  },
  usage: {
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: null,
    requestsUsed: 1,
    requestLimit: 100,
    activeRuns: 1,
    activeRunLimit: 2,
    inputTokens: 10,
    outputTokens: 20,
    seatsUsed: 1,
    seatLimit: 5,
  },
  providers: [],
  runtime: {
    status: "ready",
    message: null,
    activeRuntimes: 1,
  },
  projects: [
    {
      id: "project-1",
      name: "market-pulse",
      path: "/workspace/market-pulse",
      branch: "codex/provider-health",
      isGitRepository: true,
    },
  ],
  threads: [thread],
  featuredThread: null,
};

describe("AppHeader", () => {
  it("renders factual organization and project context and wires shell actions", () => {
    const onOpenSidebar = vi.fn();
    const onOpenWorkspace = vi.fn();
    const onOpenCommandPalette = vi.fn();
    const onToggleTheme = vi.fn();
    const onOpenOrganizationMenu = vi.fn();
    const onOpenAccountMenu = vi.fn();

    render(
      <AppHeader
        activeThread={thread}
        dashboard={dashboard}
        onOpenAccountMenu={onOpenAccountMenu}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenOrganizationMenu={onOpenOrganizationMenu}
        onOpenSidebar={onOpenSidebar}
        onOpenWorkspace={onOpenWorkspace}
        onToggleTheme={onToggleTheme}
        organizationName="Northstar Research"
      />,
    );

    expect(screen.getByRole("banner", { name: "Workspace header" })).toHaveClass("h-11");
    expect(screen.getByText("market-pulse")).toBeInTheDocument();
    expect(screen.getByText("codex/provider-health")).toBeInTheDocument();
    expect(screen.getByText("ORG ADMIN")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Agent Harness workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Organization: Northstar Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Search or run command" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Rae Kennedy account" }));
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(onOpenWorkspace).toHaveBeenCalledOnce();
    expect(onOpenOrganizationMenu).toHaveBeenCalledOnce();
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(onToggleTheme).toHaveBeenCalledOnce();
    expect(onOpenAccountMenu).toHaveBeenCalledOnce();
    expect(onOpenSidebar).toHaveBeenCalledOnce();
  });

  it("uses neutral fallbacks without inventing organization or project metadata", () => {
    render(
      <AppHeader
        activeThread={{ ...thread, projectId: "missing", projectName: "Runtime fallback" }}
        dashboard={{
          ...dashboard,
          user: { ...dashboard.user, displayName: "Member One", role: "member" },
          projects: [],
        }}
        onOpenCommandPalette={vi.fn()}
        onOpenSidebar={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Organization: Current organization" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Runtime fallback")).toBeInTheDocument();
    expect(screen.queryByText("codex/provider-health")).not.toBeInTheDocument();
    expect(screen.getByText("MEMBER")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Member One account" })).toHaveTextContent("MO");
  });
});
