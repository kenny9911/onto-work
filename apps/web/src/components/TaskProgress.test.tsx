import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskProgress } from "./TaskProgress";
import { applyNotification } from "@/lib/task-progress";

const props = { thread: null, turnId: "turn", agents: [], stream: { status: "live" as const, attempt: 0, lastEventAt: null }, onRefresh: vi.fn(), onStop: vi.fn(async () => undefined), stopping: false };

describe("TaskProgress", () => {
  it("shows waiting status, real plan progress, and recovery controls", () => {
    let timeline = applyNotification([], { method: "turn/plan/updated", params: { turnId: "turn", plan: [{ step: "Search jobs", status: "completed" }, { step: "Read listings", status: "inProgress" }] } });
    timeline = applyNotification(timeline, { kind: "server-request", requestId: 1, method: "item/commandExecution/requestApproval", params: { turnId: "turn" } });
    render(<TaskProgress {...props} timeline={timeline} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for approval");
    expect(screen.getByRole("progressbar", { name: "Plan steps complete" })).toHaveAttribute("value", "1");
    expect(screen.getByText("1 of 2 plan steps complete")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(props.onRefresh).toHaveBeenCalledOnce();
    expect(props.onStop).toHaveBeenCalledOnce();
  });
  it("shows a quiet-run explanation without inventing a percentage", () => {
    render(<TaskProgress {...props} timeline={[{ id: "cmd", kind: "command", title: "Read listings", body: "", status: "running", timestamp: new Date(Date.now() - 90_000).toISOString(), metadata: { turnId: "turn" } }]} />);
    expect(screen.getByText(/No new execution activity/)).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("0 execution events completed · 1 active")).toBeVisible();
  });
});
