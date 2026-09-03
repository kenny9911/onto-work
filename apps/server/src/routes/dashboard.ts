import type { FastifyInstance } from "fastify";
import type { DashboardPayload } from "@agent-harness/contracts";
import type { HarnessConfig } from "../config.js";
import type { HarnessStore } from "../database.js";
import { requireUser } from "../http.js";
import { CodexAdapterConfigurationError } from "../codex/adapter.js";
import { CodexRuntimeError } from "../codex/runtime.js";
import type { HarnessRuntime, RuntimeDashboardSnapshot } from "../runtime.js";

export function registerDashboardRoutes(
  app: FastifyInstance,
  input: { store: HarnessStore; config: HarnessConfig; runtime: HarnessRuntime },
): void {
  const { store, config, runtime } = input;

  app.get("/api/dashboard", async (request): Promise<DashboardPayload> => {
    const user = requireUser(request, store);
    const providers = store.listProviders(user.tenantId);
    const enabledProvider = providers.some((provider) => provider.enabled);
    let runtimeSnapshot: RuntimeDashboardSnapshot = {
      projects: [],
      threads: [],
      featuredThread: null,
    };
    let runtimeSummary: DashboardPayload["runtime"] = {
      status: enabledProvider ? "ready" : "not_configured",
      message: enabledProvider ? null : "Connect and enable a model route to start tasks.",
      activeRuntimes: 0,
    };

    if (enabledProvider) {
      try {
        runtimeSnapshot = await runtime.dashboardSnapshot({
          tenantId: user.tenantId,
          userId: user.id,
        });
        const health = await runtime.health();
        runtimeSummary = {
          status: health.status,
          message: health.message ?? null,
          activeRuntimes: health.activeRuntimes ?? 0,
        };
      } catch (error) {
        const expectedRuntimeFailure =
          error instanceof CodexAdapterConfigurationError || error instanceof CodexRuntimeError;
        if (expectedRuntimeFailure) {
          request.log.warn({ err: error }, "Codex runtime is unavailable for dashboard");
        } else {
          request.log.error({ err: error }, "Unexpected Codex dashboard failure");
        }
        runtimeSummary = {
          status: "degraded",
          message: "The selected model route or Codex runtime needs attention.",
          activeRuntimes: 0,
        };
      }
    }
    return {
      user,
      subscription: store.getSubscription(user.tenantId, Boolean(config.stripeSecretKey)),
      usage: store.getUsageSummary(user.tenantId),
      providers,
      runtime: runtimeSummary,
      ...runtimeSnapshot,
    };
  });
}
