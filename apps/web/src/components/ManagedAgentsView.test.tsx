import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ManagedAgentCatalog, ManagedTaskDetail, SavedProjectSummary } from "@agent-harness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api } from "@/lib/api";
import { managedAgentsApi } from "@/lib/managed-agents-api";
import { ManagedAgentsView } from "./ManagedAgentsView";

const project: SavedProjectSummary = {
  id: "project-1", workspaceId: "workspace-1", name: "Harness", path: "/workspace/harness", branch: "main",
  isGitRepository: true, enabled: true, availability: "available", repositoryStatus: "repository", repositoryRoot: "/workspace/harness",
  headCommit: null, upstream: null, dirty: false, remoteUrl: null, createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z",
};
const catalog: ManagedAgentCatalog = {
  available: true, reason: null,
  agents: [{ id: "repository-reviewer", version: "1", name: "Repository Reviewer", description: "Review committed source for actionable findings.", model: "test-model", runtime: "agents_api", maxSubagents: 2,
    capabilities: { readOnly: true, steer: false, cancel: true, attachments: false, writeActions: false } }],
};
const task: ManagedTaskDetail = {
  id: "managed-1", projectId: project.id, projectName: project.name, agentId: "repository-reviewer", agentVersion: "1",
  title: "Review permission checks", status: "running", turnId: "turn-1", revision: 1, sourceRevision: "abcdef1234567890",
  createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z", error: null,
  items: [{ id: "item-1", role: "assistant", text: "Inspecting permission checks.", status: "in_progress", subagentId: null }],
  usage: { inputTokens: 100, outputTokens: 20, reported: true },
};

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  close = vi.fn();
  constructor(readonly url: string, readonly options?: EventSourceInit) {
    super();
    MockEventSource.instances.push(this);
  }
  snapshot(value: ManagedTaskDetail) {
    this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ task: value }) }));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function openTask() {
  fireEvent.click(await screen.findByRole("button", { name: /Review permission checks Harness/ }));
  await screen.findByText("Inspecting permission checks.");
  return MockEventSource.instances.at(-1)!;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.spyOn(api, "listProjects").mockResolvedValue({ projects: [project], nextCursor: null });
  vi.spyOn(managedAgentsApi, "catalog").mockResolvedValue(catalog);
  vi.spyOn(managedAgentsApi, "list").mockResolvedValue({ tasks: [task] });
  vi.spyOn(managedAgentsApi, "detail").mockResolvedValue({ task });
});

afterEach(() => vi.unstubAllGlobals());

describe("ManagedAgentsView", () => {
  it("explains disabled configuration and cloud data handling without offering usable start controls", async () => {
    vi.mocked(managedAgentsApi.catalog).mockResolvedValue({ ...catalog, available: false, reason: "Ask your operator to configure a restricted executor key." });
    render(<ManagedAgentsView />);
    expect(await screen.findByText("Managed agents are not configured")).toBeInTheDocument();
    expect(screen.getByText(/OpenAI stores managed session data in the US/)).toBeInTheDocument();
    expect(screen.getByText(/committed HEAD/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Saved project" })).toBeDisabled();
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();
  });

  it("starts from a saved project and retains the exact request when its result is uncertain", async () => {
    const create = vi.spyOn(managedAgentsApi, "create")
      .mockRejectedValueOnce(new TypeError("Network connection lost"))
      .mockResolvedValueOnce({ task });
    render(<ManagedAgentsView />);
    await screen.findByRole("option", { name: "Repository Reviewer" });
    fireEvent.change(screen.getByRole("textbox", { name: "Review request" }), { target: { value: "Review permission checks" } });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByText("Network connection lost")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Review request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry request" }));
    await screen.findByText("Inspecting permission checks.");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0]?.[0]).toEqual({ projectId: project.id, agentId: "repository-reviewer", message: "Review permission checks" });
    await waitFor(() => expect(MockEventSource.instances[0]?.options).toEqual({ withCredentials: true }));
  });

  it("ignores stale snapshots and binds cancellation to the latest root turn before allowing a follow-up", async () => {
    const message = vi.spyOn(managedAgentsApi, "message").mockResolvedValue({ task: { ...task, revision: 6, status: "starting", turnId: "turn-2" } });
    const cancel = vi.spyOn(managedAgentsApi, "cancel").mockResolvedValue({ task: { ...task, revision: 5, status: "cancelled", turnId: null } });
    render(<ManagedAgentsView />);
    const source = await openTask();
    act(() => {
      source.snapshot({ ...task, revision: 3, turnId: "turn-2", items: [{ ...task.items[0]!, text: "New authoritative output." }] });
      source.snapshot({ ...task, revision: 2, items: [{ ...task.items[0]!, text: "Stale output." }] });
    });
    expect(screen.getByText("New authoritative output.")).toBeInTheDocument();
    expect(screen.queryByText("Stale output.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toBeDisabled();
    expect(message).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(task.id, "turn-2", expect.any(String)));
    expect(await screen.findByRole("textbox", { name: "Follow-up message" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Follow-up message" }), { target: { value: "Summarize the findings" } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(message).toHaveBeenLastCalledWith(task.id, { message: "Summarize the findings", mode: "follow_up" }, expect.any(String)));
  });

  it("prevents sending with steering disabled until an authoritative completed turn arrives", async () => {
    const message = vi.spyOn(managedAgentsApi, "message").mockResolvedValue({ task: { ...task, revision: 3, status: "starting" } });
    render(<ManagedAgentsView />);
    const source = await openTask();
    expect(catalog.agents[0]!.capabilities.steer).toBe(false);
    const composer = screen.getByRole("textbox", { name: "Follow-up message" });
    expect(composer).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
    expect(screen.getByText(/Wait for this turn to finish/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send steering message" })).not.toBeInTheDocument();
    fireEvent.change(composer, { target: { value: "Review the findings" } });
    fireEvent.submit(composer.closest("form")!);
    expect(message).not.toHaveBeenCalled();
    act(() => source.snapshot({ ...task, status: "idle", revision: 2 }));
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(message).toHaveBeenCalledWith(task.id, { message: "Review the findings", mode: "follow_up" }, expect.any(String)));
  });

  it("recovers authoritative history on reconnect and closes the stream on unmount", async () => {
    const { unmount } = render(<ManagedAgentsView />);
    const source = await openTask();
    vi.mocked(managedAgentsApi.detail).mockResolvedValue({ task: { ...task, revision: 3, status: "idle", items: [{ ...task.items[0]!, text: "Recovered completed output.", status: "completed" }] } });
    act(() => source.dispatchEvent(new Event("error")));
    expect(screen.getByText("Live updates disconnected. Reconnecting…")).toBeInTheDocument();
    act(() => source.dispatchEvent(new Event("open")));
    expect(await screen.findByText("Recovered completed output.")).toBeInTheDocument();
    expect(managedAgentsApi.detail).toHaveBeenCalledTimes(2);
    unmount();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("cancels a starting task before a turn is reported and does not present unreported usage as zero", async () => {
    const starting = { ...task, status: "starting" as const, turnId: null, usage: { inputTokens: 0, outputTokens: 0 } };
    vi.mocked(managedAgentsApi.detail).mockResolvedValue({ task: starting });
    const cancel = vi.spyOn(managedAgentsApi, "cancel").mockResolvedValue({ task: { ...starting, status: "cancelled", revision: 2 } });
    render(<ManagedAgentsView />);
    await openTask();
    expect(screen.getByText("Token usage not reported")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(task.id, null, expect.any(String)));
  });

  it("does not send another message while a follow-up is starting", async () => {
    vi.mocked(managedAgentsApi.detail).mockResolvedValue({ task: { ...task, status: "starting", turnId: "previous-turn" } });
    render(<ManagedAgentsView />);
    await openTask();
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel turn" })).toBeEnabled();
  });

  it("does not let a slow history read replace another selected task", async () => {
    const slow = deferred<{ task: ManagedTaskDetail }>();
    const second = { ...task, id: "managed-2", title: "Review routing", items: [{ ...task.items[0]!, text: "Routing output." }] };
    vi.mocked(managedAgentsApi.list).mockResolvedValue({ tasks: [task, second] });
    vi.mocked(managedAgentsApi.detail).mockImplementation((id) => id === task.id ? slow.promise : Promise.resolve({ task: second }));
    render(<ManagedAgentsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Review permission checks Harness/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review routing Harness/ }));
    await screen.findByText("Routing output.");
    await act(async () => slow.resolve({ task }));
    expect(screen.getByText("Routing output.")).toBeInTheDocument();
    expect(screen.queryByText("Inspecting permission checks.")).not.toBeInTheDocument();
    expect(MockEventSource.instances[0]?.close).toHaveBeenCalled();
  });

  it("requires refreshed history before continuing after an uncertain remote input, without resending it", async () => {
    const message = vi.spyOn(managedAgentsApi, "message").mockRejectedValue(new ApiClientError(502, "managed_input_uncertain", "Input delivery is uncertain."));
    vi.mocked(managedAgentsApi.detail).mockResolvedValue({ task: { ...task, status: "idle" } });
    render(<ManagedAgentsView />);
    await openTask();
    fireEvent.change(screen.getByRole("textbox", { name: "Follow-up message" }), { target: { value: "Check authentication" } });
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up" }));
    await screen.findByText("Input delivery is uncertain.");
    expect(screen.queryByRole("button", { name: "Retry request" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue after reviewing history" })).toBeDisabled();
    vi.mocked(managedAgentsApi.detail).mockResolvedValue({ task: { ...task, status: "idle", revision: 2, items: [{ ...task.items[0]!, text: "Recovered final result." }] } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    await screen.findByText("Recovered final result.");
    fireEvent.click(screen.getByRole("button", { name: "Continue after reviewing history" }));
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toHaveValue("");
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("requires a concrete deletion confirmation and displays the metadata tombstone afterward", async () => {
    const deleted = { ...task, status: "deleted" as const, turnId: null, revision: 2, items: [] };
    const remove = vi.spyOn(managedAgentsApi, "remove").mockResolvedValue({ task: deleted });
    render(<ManagedAgentsView />);
    const source = await openTask();
    fireEvent.click(screen.getByRole("button", { name: "Delete remote session" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this remote session?" });
    expect(remove).not.toHaveBeenCalled();
    vi.mocked(managedAgentsApi.detail).mockResolvedValue({ task: deleted });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete session" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(task.id, expect.any(String)));
    expect(await screen.findByText(/This remote session has been deleted/)).toBeInTheDocument();
    expect(screen.queryByText("Inspecting permission checks.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send follow-up" })).not.toBeInTheDocument();
    expect(source.close).toHaveBeenCalled();
  });
});
