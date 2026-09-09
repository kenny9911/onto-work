import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "./api";

const result = {
  success: true,
  message: "The model answered successfully.",
  model: "openai/test-model",
  latencyMs: 275,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider connection tests API", () => {
  it("tests a new draft with the credential wire format and returns the probe result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ result }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.testProvider({
      catalogId: "openrouter",
      name: "Development router",
      baseUrl: "https://router.example.test/v1",
      defaultModel: "openai/test-model",
      apiKey: "draft-api-key",
      enabled: true,
      isDefault: false,
    })).resolves.toEqual({ result });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/providers/test",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          catalogId: "openrouter",
          name: "Development router",
          baseUrl: "https://router.example.test/v1",
          defaultModel: "openai/test-model",
          enabled: true,
          isDefault: false,
          credential: "draft-api-key",
        }),
      }),
    );
  });

  it("tests saved routes and unsaved model edits without replacing the stored credential", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ result })));
    vi.stubGlobal("fetch", fetchMock);

    await api.testProvider({ id: "provider/one" });
    await api.testProvider({
      id: "provider/one",
      catalogId: "openrouter",
      defaultModel: "openai/alternate-model",
      apiKey: undefined,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/providers/provider%2Fone/test",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/providers/provider%2Fone/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ catalogId: "openrouter", defaultModel: "openai/alternate-model" }),
      }),
    );
  });

  it("sends an explicit credential reset when testing and saving a change to a shared gateway", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ result }))
      .mockResolvedValueOnce(jsonResponse({ provider: { id: "provider-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      id: "provider-1", catalogId: "anthropic", defaultModel: "codex-anthropic", apiKey: null,
    };

    await api.testProvider(input);
    await api.saveProvider(input);

    const body = JSON.stringify({
      catalogId: "anthropic", defaultModel: "codex-anthropic", credential: null,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/providers/provider-1/test",
      expect.objectContaining({ method: "POST", body }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/providers/provider-1",
      expect.objectContaining({ method: "PATCH", body }),
    );
  });

  it("preserves a failed probe result and reports endpoint errors with their server message", async () => {
    const failedResult = { ...result, success: false, message: "The model is unavailable." };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ result: failedResult }))
      .mockResolvedValueOnce(jsonResponse({
        error: "provider_test_forbidden",
        message: "Only administrators can test model routes.",
      }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.testProvider({ id: "provider-1" })).resolves.toEqual({ result: failedResult });
    await expect(api.testProvider({ id: "provider-1" })).rejects.toEqual(
      new ApiClientError(403, "provider_test_forbidden", "Only administrators can test model routes."),
    );
  });
});
