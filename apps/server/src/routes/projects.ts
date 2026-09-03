import { execFile } from "node:child_process";

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  ProjectDetailPayload,
  ProjectListPayload,
  RegisterProjectPayload,
  SavedProjectSummary,
  UpdateProjectPayload,
} from "@agent-harness/contracts";

import { resolveAllowedWorkspacePath } from "../codex/config.js";
import type { HarnessConfig } from "../config.js";
import type { HarnessStore, SavedProjectRecord } from "../database.js";
import { ApiHttpError, requireAdmin, requireUser } from "../http.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 512 * 1_024;
const PROJECT_LIST_CONCURRENCY = 4;

const projectIdSchema = z.object({ projectId: z.string().uuid() });
const projectListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();
const registerProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    workspacePath: z.string().trim().min(1).max(4_096).refine(
      (value) => !value.includes("\0"),
      "workspacePath cannot contain a NUL byte.",
    ),
  })
  .strict();
const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Supply at least one field to update.");

class GitInspectionError extends Error {
  constructor(
    readonly commandCode: string | number | null,
    readonly stderr: string,
  ) {
    super("Git inspection failed");
    this.name = "GitInspectionError";
  }
}

function runGit(workspacePath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "credential.interactive=never",
        "-C",
        workspacePath,
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GCM_INTERACTIVE: "Never",
          GIT_ASKPASS: "",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          SSH_ASKPASS: "",
        },
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = "code" in error ? error.code : null;
          reject(new GitInspectionError(code ?? null, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sanitizedRemoteUrl(value: string): string | null {
  const remote = value.trim();
  if (!remote || remote.length > 2_048 || /[\0\r\n]/.test(remote)) return null;

  try {
    const parsed = new URL(remote);
    if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Git's common SCP-like syntax is not accepted by URL. Preserve only its
    // host/path display form and deliberately discard the optional username.
    const scpLike = /^(?:[^@\s/:]+@)?([^\s/:]+):([^\0\r\n]+)$/.exec(remote);
    if (!scpLike?.[1] || !scpLike[2]) return null;
    const path = scpLike[2].split(/[?#]/, 1)[0]?.trim();
    return path ? `${scpLike[1]}:${path}` : null;
  }
}

function parseGitStatus(value: string): {
  branch: string | null;
  dirty: boolean;
  headCommit: string | null;
  upstream: string | null;
} {
  let branch: string | null = null;
  let dirty = false;
  let headCommit: string | null = null;
  let upstream: string | null = null;

  for (const line of value.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      headCommit = /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head && head !== "(detached)" ? head.slice(0, 512) : null;
    } else if (line.startsWith("# branch.upstream ")) {
      const configured = line.slice("# branch.upstream ".length).trim();
      upstream = configured ? configured.slice(0, 512) : null;
    } else if (!line.startsWith("# ")) {
      dirty = true;
    }
  }
  return { branch, dirty, headCommit, upstream };
}

function emptyProjectSummary(
  project: SavedProjectRecord,
  availability: SavedProjectSummary["availability"],
): SavedProjectSummary {
  return {
    id: project.id,
    name: project.name,
    path: project.workspacePath,
    branch: null,
    isGitRepository: false,
    workspaceId: project.workspaceId,
    enabled: project.enabled,
    availability,
    repositoryStatus: "unavailable",
    repositoryRoot: null,
    headCommit: null,
    upstream: null,
    dirty: null,
    remoteUrl: null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

async function inspectProject(
  project: SavedProjectRecord,
  store: HarnessStore,
  config: HarnessConfig,
): Promise<SavedProjectSummary> {
  if (
    !project.workspaceGrantId ||
    !store.workspaceGrantAllowsPath(
      project.tenantId,
      project.workspaceGrantId,
      project.workspacePath,
    )
  ) {
    return emptyProjectSummary(project, "workspace_grant_revoked");
  }

  let workspacePath: string;
  try {
    workspacePath = await resolveAllowedWorkspacePath(
      project.workspacePath,
      config.allowedWorkspaceRoots,
    );
  } catch {
    return emptyProjectSummary(project, "unavailable");
  }
  if (workspacePath !== project.workspacePath) {
    return emptyProjectSummary(project, "unavailable");
  }

  const base = emptyProjectSummary(project, "available");
  let repositoryRootOutput: string;
  try {
    repositoryRootOutput = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    const notRepository =
      error instanceof GitInspectionError &&
      error.stderr.toLowerCase().includes("not a git repository");
    return {
      ...base,
      repositoryStatus: notRepository ? "not_repository" : "unavailable",
    };
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await resolveAllowedWorkspacePath(
      repositoryRootOutput.trim(),
      config.allowedWorkspaceRoots,
    );
  } catch {
    return base;
  }
  if (
    !store.workspaceGrantAllowsPath(
      project.tenantId,
      project.workspaceGrantId,
      repositoryRoot,
    )
  ) {
    return base;
  }

  const [statusResult, remoteResult] = await Promise.allSettled([
    runGit(workspacePath, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
    ]),
    runGit(workspacePath, ["remote", "get-url", "origin"]),
  ]);
  const status =
    statusResult.status === "fulfilled" ? parseGitStatus(statusResult.value) : null;
  return {
    ...base,
    branch: status?.branch ?? null,
    isGitRepository: true,
    repositoryStatus: "repository",
    repositoryRoot,
    headCommit: status?.headCommit ?? null,
    upstream: status?.upstream ?? null,
    dirty: status?.dirty ?? null,
    remoteUrl:
      remoteResult.status === "fulfilled" ? sanitizedRemoteUrl(remoteResult.value) : null,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await map(value);
      }
    }),
  );
  return results;
}

async function canonicalWorkspacePath(
  requestedPath: string,
  config: HarnessConfig,
): Promise<string> {
  try {
    return await resolveAllowedWorkspacePath(requestedPath, config.allowedWorkspaceRoots);
  } catch {
    throw new ApiHttpError(
      400,
      "workspace_not_allowed",
      "Choose an existing directory within a workspace root allowed by this deployment.",
    );
  }
}

function projectById(
  store: HarnessStore,
  tenantId: string,
  projectId: string,
): SavedProjectRecord {
  const project = store.getSavedProject(tenantId, projectId);
  if (!project) {
    throw new ApiHttpError(404, "project_not_found", "Saved project not found.");
  }
  return project;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig },
): void {
  const { store, config } = input;

  app.get("/api/projects", async (request): Promise<ProjectListPayload> => {
    const actor = requireUser(request, store);
    const { limit, cursor } = projectListQuerySchema.parse(request.query);
    const page = store.listSavedProjectPage(actor.tenantId, limit, cursor);
    return {
      projects: await mapWithConcurrency(
        page.projects,
        PROJECT_LIST_CONCURRENCY,
        (project) => inspectProject(project, store, config),
      ),
      nextCursor: page.nextCursor,
    };
  });

  app.get("/api/projects/:projectId", async (request): Promise<ProjectDetailPayload> => {
    const actor = requireUser(request, store);
    const { projectId } = projectIdSchema.parse(request.params);
    return {
      project: await inspectProject(
        projectById(store, actor.tenantId, projectId),
        store,
        config,
      ),
    };
  });

  app.post("/api/projects", async (request, reply): Promise<ProjectDetailPayload> => {
    const actor = requireAdmin(request, store);
    const body: RegisterProjectPayload = registerProjectSchema.parse(request.body);
    const workspacePath = await canonicalWorkspacePath(body.workspacePath, config);
    const grant = store.findWorkspaceGrantForPath(actor.tenantId, workspacePath);
    if (!grant) {
      throw new ApiHttpError(
        403,
        "workspace_not_granted",
        "This workspace has not been granted to the active organization.",
      );
    }
    const project = store.registerSavedProject({
      tenantId: actor.tenantId,
      name: body.name,
      workspacePath,
      workspaceGrantId: grant.id,
      createdByUserId: actor.id,
    });
    reply.status(201);
    return { project: await inspectProject(project, store, config) };
  });

  app.patch("/api/projects/:projectId", async (request): Promise<ProjectDetailPayload> => {
    const actor = requireAdmin(request, store);
    const { projectId } = projectIdSchema.parse(request.params);
    const body: UpdateProjectPayload = updateProjectSchema.parse(request.body);
    const current = projectById(store, actor.tenantId, projectId);

    let workspaceGrantId: string | undefined;
    if (body.enabled === true) {
      const workspacePath = await canonicalWorkspacePath(current.workspacePath, config);
      if (workspacePath !== current.workspacePath) {
        throw new ApiHttpError(
          409,
          "workspace_changed",
          "The saved workspace no longer resolves to its registered canonical path.",
        );
      }
      const grant = store.findWorkspaceGrantForPath(actor.tenantId, workspacePath);
      if (!grant) {
        throw new ApiHttpError(
          403,
          "workspace_not_granted",
          "This workspace has not been granted to the active organization.",
        );
      }
      workspaceGrantId = grant.id;
    }

    const project = store.updateSavedProject({
      tenantId: actor.tenantId,
      projectId,
      actorUserId: actor.id,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(workspaceGrantId === undefined ? {} : { workspaceGrantId }),
    });
    if (!project) {
      throw new ApiHttpError(404, "project_not_found", "Saved project not found.");
    }
    return { project: await inspectProject(project, store, config) };
  });
}
