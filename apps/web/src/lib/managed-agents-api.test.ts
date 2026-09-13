import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./api";
import { managedAgentsApi } from "./managed-agents-api";

afterEach(() => vi.unstubAllGlobals());

describe("managed agents API", () => {
  it("keeps all mutations authenticated, encoded, and bound to the caller's idempotency key", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ task: {} }))));
    vi.stubGlobal("fetch", fetchMock);
    await managedAgentsApi.create({ projectId: "saved-project", agentId: "reviewer", message: "Review" }, "create-key");
    await managedAgentsApi.message("task/one", { message: "Focus on auth", mode: "steer", expectedTurnId: "turn-1" }, "steer-key");
    await managedAgentsApi.cancel("task/one", "turn-1", "cancel-key");
    await managedAgentsApi.remove("task/one", "delete-key");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/managed-tasks", expect.objectContaining({
      credentials: "include", method: "POST", headers: expect.objectContaining({ "idempotency-key": "create-key" }),
      body: JSON.stringify({ projectId: "saved-project", agentId: "reviewer", message: "Review" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/managed-tasks/task%2Fone/messages", expect.objectContaining({
      credentials: "include", method: "POST", headers: expect.objectContaining({ "idempotency-key": "steer-key" }),
      body: JSON.stringify({ message: "Focus on auth", mode: "steer", expectedTurnId: "turn-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/managed-tasks/task%2Fone/cancel", expect.objectContaining({
      credentials: "include", method: "POST", headers: expect.objectContaining({ "idempotency-key": "cancel-key" }),
      body: JSON.stringify({ expectedTurnId: "turn-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/managed-tasks/task%2Fone", expect.objectContaining({
      credentials: "include", method: "DELETE", headers: { "idempotency-key": "delete-key" },
    }));
    expect(managedAgentsApi.eventsUrl("task/one")).toBe("/api/managed-tasks/task%2Fone/events");
  });

  it("preserves server failures so the UI can distinguish rejected and uncertain operations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "turn_changed", message: "The active turn changed." }), { status: 409 })));
    await expect(managedAgentsApi.cancel("task-1", "old-turn", "key")).rejects.toMatchObject({
      name: "ApiClientError", status: 409, code: "turn_changed", message: "The active turn changed.",
    } satisfies Partial<ApiClientError>);
  });
});
