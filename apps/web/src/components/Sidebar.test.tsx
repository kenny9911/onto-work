import { fireEvent, render, screen } from "@testing-library/react";
import type { SubscriptionSummary, UserSummary } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const member: UserSummary = {
  id: "efc980a4-4743-493c-9354-349eb9c07bf8",
  tenantId: "6b2b5815-6441-475c-b56c-4d4a32499df9",
  username: "member-one",
  displayName: "Member One",
  role: "member",
  status: "active",
  mustChangePassword: false,
  createdAt: "2026-09-02T00:00:00.000Z",
  lastLoginAt: null,
};

const freeSubscription: SubscriptionSummary = {
  plan: "free",
  status: "none",
  seats: 1,
  currentPeriodEnd: null,
  stripeConfigured: false,
};

describe("Sidebar", () => {
  it("renders the empty task state and hides administrator-only navigation for members", () => {
    const onNewTask = vi.fn();
    const onOpenCommandPalette = vi.fn();
    const onLogout = vi.fn();
    render(
      <Sidebar
        activeThreadId={null}
        onLogout={onLogout}
        onNavigate={vi.fn()}
        onNewTask={onNewTask}
        onOpenCommandPalette={onOpenCommandPalette}
        onSelectThread={vi.fn()}
        subscription={freeSubscription}
        threads={[]}
        user={member}
        view="usage"
      />,
    );

    expect(screen.getByText("Your first task will appear here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reviews" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model routes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Environments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capabilities" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Team" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Billing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audit log" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    fireEvent.click(screen.getByRole("button", { name: /Search or jump/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onNewTask).toHaveBeenCalledOnce();
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
