import { realpath } from "node:fs/promises";
import { basename } from "node:path";

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
import { registerUserRoutes } from "./routes/users.js";
import type { HarnessRuntime } from "./runtime.js";

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

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
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

  app.addHook("onClose", async () => {
    await runtime.close?.();
    if (ownsStore) store.close();
  });

  return app;
}
