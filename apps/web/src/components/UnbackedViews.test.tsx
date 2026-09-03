import { render, screen } from "@testing-library/react";
import type { DashboardPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { ArtifactsView } from "./ArtifactsView";
import { PlatformView } from "./PlatformView";

const dashboard = {
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
  providers: [],
  runtime: { status: "ready", message: null, activeRuntimes: 1 },
  projects: [],
  threads: [],
  featuredThread: null,
} satisfies DashboardPayload;

describe("destinations without a backing service", () => {
  it("says why platform scope is empty instead of listing this tenant as the platform", () => {
    render(<PlatformView dashboard={dashboard} onNavigate={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Platform admin" })).toBeInTheDocument();
    // The whole point: no invented tenant rows.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/no platform role separate from tenant administration/i))
      .toBeInTheDocument();
    expect(screen.getAllByText("FUTURE").length).toBeGreaterThan(0);

    // Facts the control plane genuinely reports are still shown.
    expect(screen.getByText("Supervised app-servers")).toBeInTheDocument();
    expect(screen.getByText("1 / 16")).toBeInTheDocument();
  });

  it("keeps artifacts empty rather than relabelling the task diff", () => {
    const onOpenWorkspace = vi.fn();
    render(<ArtifactsView onOpenWorkspace={onOpenWorkspace} />);

    expect(screen.getByText("No artifacts in this project yet")).toBeInTheDocument();
    expect(screen.getByText(/does not yet mark a file change as a deliverable/i))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the running task" })).toBeInTheDocument();
  });
});
