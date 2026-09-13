import { describe, expect, it } from "vitest";
import { applyNotification, itemPlan, reportedThreadStatus } from "./task-progress";

describe("task execution events", () => {
  it("upserts streamed commands and records their actual exit result", () => {
    let items = applyNotification([], { method: "item/started", params: { turnId: "turn", item: { id: "cmd", type: "commandExecution", command: "test command" } } });
    items = applyNotification(items, { method: "item/commandExecution/outputDelta", params: { turnId: "turn", itemId: "cmd", delta: "output" } });
    items = applyNotification(items, { method: "item/completed", params: { turnId: "turn", item: { id: "cmd", type: "commandExecution", status: "completed", exitCode: 1, aggregatedOutput: "failed output" } } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "cmd", status: "failed", body: "failed output", metadata: { exitCode: 1, turnId: "turn" } });
  });
  it("replays a pending approval once and explains expiry", () => {
    const approval = { kind: "server-request" as const, method: "item/commandExecution/requestApproval", requestId: 1, expiresAt: 99, params: { turnId: "turn" } };
    let items = applyNotification([], approval);
    items = applyNotification(items, approval);
    expect(items).toHaveLength(1);
    items = applyNotification(items, { method: "serverRequest/resolved", params: { requestId: 1, reason: "expired" } });
    expect(items[0]).toMatchObject({ status: "failed", metadata: { expired: true } });
    expect(items[0]?.body).toContain("pending action was cancelled");
  });
  it("updates the plan and only closes activity from the completed turn", () => {
    let items = applyNotification([], { method: "turn/plan/updated", params: { turnId: "one", plan: [{ step: "Search", status: "inProgress" }] } });
    items = applyNotification(items, { method: "turn/plan/updated", params: { turnId: "one", plan: [{ step: "Search", status: "completed" }] } });
    expect(items).toHaveLength(1);
    expect(itemPlan(items[0])).toEqual([{ step: "Search", status: "completed" }]);
    items = applyNotification(items, { method: "item/started", params: { turnId: "two", item: { id: "cmd", type: "commandExecution" } } });
    items = applyNotification(items, { method: "turn/completed", params: { turn: { id: "one", status: "interrupted" } } });
    expect(items[1]?.status).toBe("running");
  });
  it("uses runtime waiting flags instead of treating every active turn as running", () => {
    expect(reportedThreadStatus({ type: "active", activeFlags: ["waitingOnApproval"] })).toBe("waiting");
    expect(reportedThreadStatus({ type: "active", activeFlags: [] })).toBe("running");
    expect(reportedThreadStatus({ type: "systemError" })).toBe("failed");
  });
});
