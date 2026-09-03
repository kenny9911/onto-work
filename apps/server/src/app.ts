import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import Stripe from "stripe";
import { ZodError } from "zod";
import type { ApiError } from "@agent-harness/contracts";
import { CodexHarnessAdapter } from "./codex/adapter.js";
import { loadConfig, type HarnessConfig } from "./config.js";
import { HarnessStore } from "./database.js";
import { ApiHttpError } from "./http.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerCapabilitiesRoutes } from "./routes/capabilities.js";
import { registerCodexRoutes } from "./routes/codex.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerUserRoutes } from "./routes/users.js";
import type { HarnessRuntime } from "./runtime.js";
import {
  startUploadJanitor,
  sweepStagedOnBoot,
  type UploadJanitorHandle,
} from "./uploads/janitor.js";

export interface BuildAppOptions {
  config?: HarnessConfig;
  store?: HarnessStore;
  runtime?: HarnessRuntime;
  logger?: boolean;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_EXEMPT_PATHS = new Set(["/api/billing/webhook"]);

function origin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function configuredWebOrigins(config: HarnessConfig): Set<string> {
  const configured = [config.webOrigin, config.publicAppUrl]
    .map(origin)
    .filter((value): value is string => Boolean(value));
  const origins = new Set(configured);

  // Browsers commonly normalize a local URL to either `localhost` or
  // `127.0.0.1`. Treat those names as equivalent only for local development;
  // production remains pinned to the explicitly configured origins.
  if (process.env.NODE_ENV !== "production") {
    for (const value of configured) {
      const parsed = new URL(value);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) continue;
      for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
        origins.add(`${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}`);
      }
    }
  }

  return origins;
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

// Fastify raises these while choosing or running a body parser, before any
// handler is entered. Without this map every one of them flattens to
// `500 internal_error` and is logged at error level, so an oversized paste
// reads as a server fault in the logs.
const BODY_ERROR_RESPONSES: Readonly<Record<string, readonly [number, string, string]>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: [
    413,
    "payload_too_large",
    "The request body is larger than this endpoint accepts.",
  ],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [
    415,
    "unsupported_media_type",
    "The request Content-Type is not supported by this endpoint.",
  ],
  FST_ERR_CTP_EMPTY_TYPE: [
    415,
    "unsupported_media_type",
    "The request Content-Type is missing.",
  ],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, "invalid_json", "The request body is not valid JSON."],
};

function bodyErrorResponse(error: unknown): readonly [number, string, string] | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    const mapped = BODY_ERROR_RESPONSES[code];
    if (mapped) return mapped;
  }
  // `fastify-raw-body` replaces the JSON parser when `encoding: false`, so a
  // malformed body surfaces as a tagged SyntaxError rather than
  // FST_ERR_CTP_INVALID_JSON_BODY.
  if (error instanceof SyntaxError && (error as { statusCode?: unknown }).statusCode === 400) {
    return [400, "invalid_json", "The request body is not valid JSON."];
  }
  return null;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

async function canonicalOrResolved(path: string): Promise<string> {
  const target = resolve(path);
  return realpath(target).catch(() => target);
}

function missingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Canonicalize the existing portion of a path without creating the path.
 *
 * `realpath` cannot resolve a prospective directory, while a plain `resolve`
 * misses a symlinked parent. Walking to the nearest existing ancestor lets the
 * isolation check see where `mkdir({ recursive: true })` would really write.
 */
async function canonicalProspectivePath(path: string): Promise<string> {
  const target = resolve(path);
  let ancestor = target;

  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, relative(ancestor, target));
    } catch (error) {
      if (!missingPath(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function assertNoWorkspaceOverlap(
  config: HarnessConfig,
  canonicalUploadDataDir: string,
): Promise<void> {
  for (const root of config.allowedWorkspaceRoots) {
    const canonicalRoot = await canonicalOrResolved(root);
    if (
      isWithin(canonicalRoot, canonicalUploadDataDir) ||
      isWithin(canonicalUploadDataDir, canonicalRoot)
    ) {
      throw new Error(
        "UPLOAD_DATA_DIR must not overlap an allowed workspace root: " +
          `upload store ${canonicalUploadDataDir} overlaps workspace root ${canonicalRoot}`,
      );
    }
  }
}

/**
 * Fail closed when the durable upload store overlaps a granted workspace root.
 *
 * Uploads are never a containment control — the Codex child has unconditional
 * full-disk read — but keeping the store outside every workspace root is what
 * keeps uploaded bytes out of `git status`, out of a `review/start`
 * `uncommittedChanges` target, and on a path the control plane alone owns.
 */
async function assertUploadStoreIsolated(config: HarnessConfig): Promise<void> {
  const uploadDataDir = resolve(config.uploadDataDir);
  let existed = true;
  try {
    await lstat(uploadDataDir);
  } catch (error) {
    if (!missingPath(error)) throw error;
    existed = false;
  }

  // No mutation is allowed before this check. In particular, a typo pointing
  // at `/`, a home directory, or a workspace must never chmod that directory
  // on the way to reporting the configuration error.
  const prospectivePath = existed
    ? await realpath(uploadDataDir)
    : await canonicalProspectivePath(uploadDataDir);
  await assertNoWorkspaceOverlap(config, prospectivePath);

  if (existed) {
    const existing = await stat(uploadDataDir);
    if (!existing.isDirectory()) {
      throw new Error(`UPLOAD_DATA_DIR must be a directory: ${prospectivePath}`);
    }
    // Do not take ownership of an arbitrary pre-existing directory by changing
    // its permissions. An operator may opt in explicitly with chmod(1); a path
    // created by this process already has this mode on every later boot.
    if (process.platform !== "win32" && (existing.mode & 0o777) !== 0o700) {
      throw new Error(
        `UPLOAD_DATA_DIR must be private (mode 0700): ${prospectivePath}`,
      );
    }
    return;
  }

  await mkdir(uploadDataDir, { recursive: true, mode: 0o700 });
  const canonicalUploadDataDir = await realpath(uploadDataDir);
  // Re-check after creation so a parent-path replacement or symlink race fails
  // before the store is used.
  await assertNoWorkspaceOverlap(config, canonicalUploadDataDir);
  const created = await stat(uploadDataDir);
  if (!created.isDirectory()) {
    throw new Error(`UPLOAD_DATA_DIR must be a directory: ${canonicalUploadDataDir}`);
  }
  // `mkdir(0700)` cannot grant permissions masked by the process umask, so it
  // never needs a path-based chmod. Refusing an unexpected mode also closes the
  // lstat/mkdir race if some other process created this path in between.
  if (process.platform !== "win32" && (created.mode & 0o777) !== 0o700) {
    throw new Error(
      `UPLOAD_DATA_DIR must be private (mode 0700): ${canonicalUploadDataDir}`,
    );
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  // Runs before anything is opened so a misconfigured store never boots.
  await assertUploadStoreIsolated(config);
  const store = options.store ?? new HarnessStore(config.databasePath);
  const ownsStore = options.store === undefined;
  const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1_048_576,
  });
  if (ownsStore) {
    // Agent Harness currently runs one server process per database. Reserved
    // leases cannot retain live event listeners across a process restart, so
    // fail them closed before admitting new work.
    const reconciled = store.reconcileOrphanedUsageReservations();
    if (reconciled > 0) {
      app.log.warn({ reservations: reconciled }, "orphaned run reservations reconciled");
    }
  }
  const allowedOrigins = configuredWebOrigins(config);
  const runtime: HarnessRuntime =
    options.runtime ??
    new CodexHarnessAdapter({ store, config });

  // Local bootstrap remains frictionless, while production requires explicit
  // tenant workspace grants provisioned by the control plane.
  if (process.env.NODE_ENV !== "production") {
    const defaultTenantId = store.getTenantIdBySlug("default");
    if (defaultTenantId) {
      for (const root of config.allowedWorkspaceRoots) {
        try {
          const workspacePath = await realpath(root);
          store.grantWorkspace({ tenantId: defaultTenantId, rootPath: workspacePath });
          if (ownsStore && !store.findSavedProjectByWorkspacePath(defaultTenantId, workspacePath)) {
            const bootstrapAdmin = store
              .listUsers(defaultTenantId)
              .find((user) => user.role === "admin" && user.status === "active");
            const grant = store.findWorkspaceGrantForPath(defaultTenantId, workspacePath);
            if (bootstrapAdmin && grant) {
              store.registerSavedProject({
                tenantId: defaultTenantId,
                name: basename(workspacePath) || "Workspace",
                workspacePath,
                workspaceGrantId: grant.id,
                createdByUserId: bootstrapAdmin.id,
              });
            }
          }
        } catch (error) {
          app.log.warn(
            { err: error, root },
            "development workspace grant or saved project could not be created",
          );
        }
      }
    }
  }

  await app.register(cookie, {
    secret: config.sessionSecret,
    hook: "onRequest",
  });
  await app.register(cors, {
    origin: [...allowedOrigins],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, {
    global: false,
    hook: "onRequest",
  });
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });

  // Uploads arrive as raw bytes. Handing the unread stream to the handler lets
  // `requireUser` authenticate before a single body byte is consumed, but it
  // also means Fastify's `bodyLimit` — which only buffering parsers enforce —
  // no longer applies: an octet-stream route MUST count bytes itself. Declared
  // after `rawBody` so its `application/json` parser is left untouched.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.addHook("onRequest", async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (CSRF_EXEMPT_PATHS.has(path)) return;
    const requestOrigin = request.headers.origin;
    const normalizedOrigin = requestOrigin ? origin(requestOrigin) : null;
    if (!normalizedOrigin || !allowedOrigins.has(normalizedOrigin)) {
      throw new ApiHttpError(403, "invalid_origin", "Request origin is not allowed.");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    let statusCode = 500;
    let payload: ApiError = {
      error: "internal_error",
      message: "An unexpected server error occurred.",
    };
    const bodyError = bodyErrorResponse(error);

    if (error instanceof ApiHttpError) {
      statusCode = error.statusCode;
      payload = {
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    } else if (error instanceof ZodError) {
      statusCode = 400;
      payload = {
        error: "validation_error",
        message: "The request payload is invalid.",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      };
    } else if (sqliteConstraint(error)) {
      statusCode = 409;
      payload = {
        error: "conflict",
        message: "A resource with those values already exists or is still in use.",
      };
    } else if (bodyError) {
      statusCode = bodyError[0];
      payload = { error: bodyError[1], message: bodyError[2] };
    } else if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      error.statusCode === 429
    ) {
      statusCode = 429;
      payload = { error: "rate_limited", message: "Too many requests. Try again later." };
    }

    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    return reply.status(statusCode).send(payload);
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: "not_found", message: "API route not found." } satisfies ApiError),
  );

  const healthResponse = async () => ({
    status: "ok",
    runtime: await runtime.health(),
  });

  app.get("/api/health", healthResponse);
  app.get("/healthz", healthResponse);

  await registerAuthRoutes(app, { store, config });
  registerDashboardRoutes(app, { store, config, runtime });
  registerCodexRoutes(app, { store, config, runtime });
  registerCapabilitiesRoutes(app, { store, runtime });
  registerUserRoutes(app, { store });
  registerProjectRoutes(app, { store, config });
  registerProviderRoutes(app, { store, config });
  registerBillingRoutes(app, { store, config, stripe });
  registerAuditRoutes(app, { store });
  registerUploadRoutes(app, { store, config });

  // Staged plaintext is per-turn and the Codex child cannot write, so it can
  // never clean up after itself. Same `ownsStore` guard as the reservation
  // reconcile: only the process that owns the database owns its lifecycle work.
  // The janitor unrefs its own timer, so it never holds the process open.
  let janitor: UploadJanitorHandle | null = null;
  if (ownsStore) {
    // Do not accept a turn until every plaintext file orphaned by the previous
    // process has been removed. Starting this in the background creates a race
    // where a fresh turn can stage into the same tree while the boot sweep is
    // still walking it, and have its live files reclaimed as "orphans".
    await sweepStagedOnBoot({ store, config, logger: app.log });
    janitor = startUploadJanitor({ store, config, logger: app.log });
  }

  app.addHook("onClose", async () => {
    janitor?.stop();
    await runtime.close?.();
    if (ownsStore) store.close();
  });

  return app;
}
