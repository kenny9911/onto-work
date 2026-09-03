import type { SavedProjectSummary } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const project: SavedProjectSummary = {
  id: "project-1",
  name: "Harness",
  path: "/workspace/harness",
  branch: "main",
  isGitRepository: true,
  workspaceId: "workspace-1",
  enabled: true,
  availability: "available",
  repositoryStatus: "repository",
  repositoryRoot: "/workspace/harness",
  headCommit: null,
  upstream: null,
  dirty: false,
  remoteUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saved project API", () => {
  it("builds a paginated saved-project list request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ projects: [project], nextCursor: "next-project" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listProjects(25, "cursor-project")).resolves.toEqual({
      projects: [project],
      nextCursor: "next-project",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects?limit=25&cursor=cursor-project",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends typed register and update payloads to the saved-project routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ project }))
      .mockResolvedValueOnce(jsonResponse({ project: { ...project, enabled: false } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.registerProject({ name: "Harness", workspacePath: "/workspace/harness" });
    await api.updateProject("project/one", { name: "Renamed", enabled: false });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Harness", workspacePath: "/workspace/harness" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/projects/project%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed", enabled: false }),
      }),
    );
  });
});
