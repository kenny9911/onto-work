import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardPayload, ProviderConnection } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { ControlPlaneView } from "./ControlPlaneView";

const route: ProviderConnection = {
  id: "provider-1",
  catalogId: "openrouter",
  name: "Team router",
  adapter: "responses",
  baseUrl: "https://router.example.test/v1",
  defaultModel: "openai/team-model",
  enabled: true,
  isDefault: true,
  hasCredential: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const successfulResult = {
  success: true,
  message: "The configured model answered successfully.",
  model: "openai/team-model",
  latencyMs: 275,
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function dashboard(
  providers: ProviderConnection[] = [route],
  role: "admin" | "member" = "admin",
): DashboardPayload {
  return {
    user: {
      id: "user-1", tenantId: "tenant-1", username: role, displayName: role,
      role, status: "active", mustChangePassword: false,
      createdAt: "2026-09-01T00:00:00.000Z", lastLoginAt: null,
    },
    subscription: {
      plan: "team", status: "active", seats: 2, currentPeriodEnd: null, stripeConfigured: false,
    },
    usage: {
      periodStart: "2026-09-01T00:00:00.000Z", periodEnd: null, requestsUsed: 1,
      requestLimit: 100, activeRuns: 0, activeRunLimit: 2, inputTokens: 10,
      outputTokens: 10, seatsUsed: 2, seatLimit: 2,
    },
    providers,
    runtime: { status: "ready", message: null, activeRuntimes: 0 },
    projects: [], threads: [], featuredThread: null,
  };
}

function renderProviders(payload = dashboard()) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  render(<ControlPlaneView dashboard={payload} onOpenSidebar={vi.fn()} onRefresh={onRefresh} view="providers" />);
  return { onRefresh };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model route settings", () => {
  it("prefills an existing route and saves edits without replacing its credential or disabled state", async () => {
    const disabledRoute = { ...route, enabled: false, isDefault: false };
    const saveProvider = vi.spyOn(api, "saveProvider").mockResolvedValue({ provider: disabledRoute });
    const { onRefresh } = renderProviders(dashboard([disabledRoute]));

    fireEvent.click(screen.getByRole("button", { name: "Edit Team router route" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit model route" });
    expect(within(dialog).getByRole("textbox", { name: "Display name" })).toHaveValue(route.name);
    expect(within(dialog).getByRole("textbox", { name: /^Endpoint/ })).toHaveValue(route.baseUrl);
    expect(within(dialog).getByRole("textbox", { name: "Default model" })).toHaveValue(route.defaultModel);
    expect(within(dialog).getByLabelText(/^OpenRouter API key/)).toHaveValue("");
    expect(within(dialog).getByRole("checkbox", { name: "Enable this route" })).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Use as the default route for new tasks" })).not.toBeChecked();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Display name" }), { target: { value: "Renamed router" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Endpoint/ }), { target: { value: "https://new-router.example.test/v1" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Default model" }), { target: { value: "openai/alternate-model" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(saveProvider).toHaveBeenCalledWith({
      id: route.id, catalogId: route.catalogId, name: "Renamed router",
      baseUrl: "https://new-router.example.test/v1", defaultModel: "openai/alternate-model",
      apiKey: undefined, enabled: false, isDefault: false,
    }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("tests unsaved edits with the stored key and clears the result when the model changes", async () => {
    const testProvider = vi.spyOn(api, "testProvider").mockResolvedValue({ result: successfulResult });
    const saveProvider = vi.spyOn(api, "saveProvider");
    const { onRefresh } = renderProviders();

    fireEvent.click(screen.getByRole("button", { name: "Edit Team router route" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit model route" });
    const modelInput = within(dialog).getByRole("textbox", { name: "Default model" });
    fireEvent.change(modelInput, { target: { value: "openai/draft-model" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(testProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: route.id, catalogId: route.catalogId, baseUrl: route.baseUrl,
      defaultModel: "openai/draft-model", apiKey: undefined,
    })));
    expect(await within(dialog).findByText(successfulResult.message)).toBeInTheDocument();
    expect(saveProvider).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();

    fireEvent.change(modelInput, { target: { value: "openai/another-model" } });
    expect(within(dialog).queryByText(successfulResult.message)).not.toBeInTheDocument();
  });

  it("clears the previous provider credential when testing and saving a switch to a shared gateway", async () => {
    const testProvider = vi.spyOn(api, "testProvider").mockResolvedValue({ result: successfulResult });
    const saveProvider = vi.spyOn(api, "saveProvider").mockResolvedValue({ provider: {
      ...route, catalogId: "anthropic", adapter: "litellm", hasCredential: false,
    } });
    const { onRefresh } = renderProviders();

    fireEvent.click(screen.getByRole("button", { name: "Edit Team router route" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit model route" });
    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "Provider" }), { key: "ArrowDown" });
    const anthropicOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Anthropic");
    expect(anthropicOption).toBeDefined();
    fireEvent.click(anthropicOption!);
    expect(within(dialog).getByLabelText(/^LiteLLM route token/)).toHaveValue("");
    expect(within(dialog).queryByRole("textbox", { name: /^Endpoint/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));

    const changedRoute = expect.objectContaining({
      id: route.id, catalogId: "anthropic", baseUrl: undefined,
      defaultModel: "codex-anthropic", apiKey: null,
    });
    expect(testProvider).toHaveBeenCalledWith(changedRoute);
    expect(await within(dialog).findByText(successfulResult.message)).toBeInTheDocument();
    expect(saveProvider).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(saveProvider).toHaveBeenCalledWith(changedRoute));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  }, 20_000);

  it("opens an unconfigured provider draft and tests a new key without saving a route", async () => {
    const testProvider = vi.spyOn(api, "testProvider").mockResolvedValue({ result: successfulResult });
    const saveProvider = vi.spyOn(api, "saveProvider");
    renderProviders(dashboard([]));

    fireEvent.click(screen.getByRole("button", { name: "Configure NewAPI" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a model route" });
    expect(within(dialog).getByRole("textbox", { name: "Display name" })).toHaveValue("NewAPI");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Endpoint/ }), { target: { value: "https://newapi.example.test/v1" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Default model" }), { target: { value: "team-model" } });
    fireEvent.change(within(dialog).getByLabelText(/^NewAPI token/), { target: { value: "new-draft-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(testProvider).toHaveBeenCalledWith(expect.objectContaining({
      catalogId: "newapi", name: "NewAPI", baseUrl: "https://newapi.example.test/v1",
      defaultModel: "team-model", apiKey: "new-draft-key",
    })));
    expect(await within(dialog).findByText(successfulResult.message)).toBeInTheDocument();
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it("resets a closed Add route draft and saves only the newly entered settings", async () => {
    vi.spyOn(api, "testProvider").mockResolvedValue({ result: successfulResult });
    const saveProvider = vi.spyOn(api, "saveProvider").mockResolvedValue({ provider: route });
    const { onRefresh } = renderProviders(dashboard([]));

    fireEvent.click(screen.getByRole("button", { name: "Add route" }));
    let dialog = await screen.findByRole("dialog", { name: "Add a model route" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Display name" }), { target: { value: "Discarded draft" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Default model" }), { target: { value: "openai/discarded-model" } });
    fireEvent.change(within(dialog).getByLabelText(/^OpenRouter API key/), { target: { value: "discarded-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText(successfulResult.message)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Add route" }));
    dialog = await screen.findByRole("dialog", { name: "Add a model route" });
    expect(within(dialog).getByRole("textbox", { name: "Display name" })).toHaveValue("OpenRouter");
    expect(within(dialog).getByRole("textbox", { name: "Default model" })).toHaveValue("");
    expect(within(dialog).getByLabelText(/^OpenRouter API key/)).toHaveValue("");
    expect(within(dialog).queryByText(successfulResult.message)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Display name" }), { target: { value: "Fresh route" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Default model" }), { target: { value: "openai/fresh-model" } });
    fireEvent.change(within(dialog).getByLabelText(/^OpenRouter API key/), { target: { value: "fresh-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save route" }));

    await waitFor(() => expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({
      catalogId: "openrouter", name: "Fresh route", defaultModel: "openai/fresh-model",
      apiKey: "fresh-key", enabled: true, isDefault: true,
    })));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each(["test", "save"] as const)("prevents editing, closing, or overlapping submissions while a %s is pending", async (action) => {
    const testResponse = deferred<{ result: typeof successfulResult }>();
    const saveResponse = deferred<{ provider: ProviderConnection }>();
    const testProvider = vi.spyOn(api, "testProvider").mockReturnValue(testResponse.promise);
    const saveProvider = vi.spyOn(api, "saveProvider").mockReturnValue(saveResponse.promise);
    renderProviders();

    fireEvent.click(screen.getByRole("button", { name: "Edit Team router route" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit model route" });
    fireEvent.click(within(dialog).getByRole("button", { name: action === "test" ? "Test connection" : "Save changes" }));

    expect(within(dialog).getByRole("textbox", { name: "Default model" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: action === "test" ? "Save changes" : "Saving…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    fireEvent.submit(within(dialog).getByRole("textbox", { name: "Display name" }).closest("form")!);
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("dialog", { name: "Edit model route" })).toBeInTheDocument();
    expect(testProvider).toHaveBeenCalledTimes(action === "test" ? 1 : 0);
    expect(saveProvider).toHaveBeenCalledTimes(action === "save" ? 1 : 0);

    await act(async () => {
      if (action === "test") testResponse.resolve({ result: successfulResult });
      else saveResponse.resolve({ provider: route });
    });
    if (action === "test") {
      expect(await within(dialog).findByText(successfulResult.message)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled();
    } else {
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
  });

  it("shows saved-route probe results and server failures without changing configuration", async () => {
    const testProvider = vi.spyOn(api, "testProvider")
      .mockResolvedValueOnce({ result: successfulResult })
      .mockRejectedValueOnce(new Error("The provider rejected this credential."));
    const saveProvider = vi.spyOn(api, "saveProvider");
    const { onRefresh } = renderProviders();

    fireEvent.click(screen.getByRole("button", { name: "Test Team router route" }));
    expect(await screen.findByText(successfulResult.message)).toBeInTheDocument();
    expect(testProvider).toHaveBeenCalledWith({ id: route.id });

    fireEvent.click(screen.getByRole("button", { name: "Test Team router route" }));
    expect(await screen.findByText("The provider rejected this credential.")).toBeInTheDocument();
    expect(screen.queryByText(successfulResult.message)).not.toBeInTheDocument();
    expect(saveProvider).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("keeps every saved route accessible when multiple connections use the same provider", () => {
    const secondary = { ...route, id: "provider-2", name: "Evaluation router", isDefault: false };
    renderProviders(dashboard([route, secondary]));

    for (const name of [route.name, secondary.name]) {
      expect(screen.getByRole("button", { name: `Edit ${name} route` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Test ${name} route` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Disable ${name} route` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Make Evaluation router the default route" })).toBeInTheDocument();
  });

  it("switches the default to the selected saved route and refreshes settings", async () => {
    const secondary = { ...route, id: "provider-2", name: "Evaluation router", isDefault: false };
    const saveProvider = vi.spyOn(api, "saveProvider").mockResolvedValue({ provider: { ...secondary, isDefault: true } });
    const { onRefresh } = renderProviders(dashboard([route, secondary]));

    fireEvent.click(screen.getByRole("button", { name: "Make Evaluation router the default route" }));

    await waitFor(() => expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: secondary.id, catalogId: secondary.catalogId, isDefault: true,
    })));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });

  it("shows the oldest enabled route as active when no explicit default exists", () => {
    const disabled = {
      ...route, id: "disabled", name: "Aardvark disabled", enabled: false,
      isDefault: false, createdAt: "2026-08-01T00:00:00.000Z",
    };
    const newer = {
      ...route, id: "newer", name: "Alpha later", isDefault: false,
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const oldest = {
      ...route, id: "oldest", name: "Zulu earlier", isDefault: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    renderProviders(dashboard([disabled, newer, oldest]));

    const activeMetric = screen.getByText("Active route").parentElement!;
    expect(within(activeMetric).getByText(oldest.name)).toBeInTheDocument();
    expect(within(activeMetric).queryByText(newer.name)).not.toBeInTheDocument();
    expect(within(activeMetric).queryByText(disabled.name)).not.toBeInTheDocument();
  });

  it("keeps model route settings read-only for members", () => {
    const saveProvider = vi.spyOn(api, "saveProvider");
    const testProvider = vi.spyOn(api, "testProvider");
    renderProviders(dashboard([route], "member"));

    expect(screen.getByRole("heading", { name: "Model routes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add route" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Edit |Test |Make |Enable |Disable |Configure )/ })).not.toBeInTheDocument();
    expect(saveProvider).not.toHaveBeenCalled();
    expect(testProvider).not.toHaveBeenCalled();
  });
});
