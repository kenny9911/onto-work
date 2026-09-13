import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ManagedTaskDetail, UserSummary } from "@agent-harness/contracts";
import type { ManagedAgentsRuntime } from "../agents-api/service.js";
import type { HarnessStore } from "../database.js";
import { ApiHttpError, requireUser } from "../http.js";
import { TaskMutationLedger } from "../task-mutations.js";

const params = z.object({ taskId: z.string().uuid() }).strict();
const message = z.string().trim().min(1).max(16_000);
const createBody = z.object({ projectId: z.string().uuid(), agentId: z.literal("repository-reviewer"), message }).strict();
const messageBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("follow_up"), message }).strict(),
  z.object({ mode: z.literal("steer"), message, expectedTurnId: z.string().min(1).max(200) }).strict(),
]);
const cancelBody = z.object({ expectedTurnId: z.string().min(1).max(200).nullable() }).strict();
const noQuery = z.object({}).strict();

export function registerManagedAgentRoutes(app: FastifyInstance, options: { store: HarnessStore; runtime: ManagedAgentsRuntime }): void {
  const { store, runtime } = options;
  const ledger = new TaskMutationLedger(store.db);
  const connections = new Map<string, number>();
  const closeStreams = new Set<() => void>();
  let shuttingDown = false;
  const mutationLimits = { rateLimit: { max: 30, timeWindow: "1 minute" } };

  // Fastify waits for active HTTP responses before onClose, which is where the
  // managed runtime stops its executors. Close hijacked streams in preClose so
  // an open browser tab cannot hold that lifecycle cleanup indefinitely.
  app.addHook("preClose", async () => {
    shuttingDown = true;
    for (const close of [...closeStreams]) close();
  });

  function owner(request: FastifyRequest): { user: UserSummary; id: string } {
    const user = requireUser(request, store);
    const { taskId: id } = params.parse(request.params);
    runtime.repository.owned(user, id);
    return { user, id };
  }

  async function mutate(request: FastifyRequest, user: UserSummary, action: string, target: string, input: unknown, perform: () => Promise<ManagedTaskDetail>) {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,255}$/.test(key)) throw new ApiHttpError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1 to 255 visible ASCII characters.");
    const reservation = ledger.reserve({ tenantId: user.tenantId, userId: user.id, action, targetId: target, idempotencyKey: key,
      requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") });
    if (reservation.state === "replayed") {
      const result = reservation.response as { taskId?: string };
      if (!result.taskId) throw new ApiHttpError(409, "idempotent_request_closed", "The saved mutation receipt is unavailable.");
      return { task: await runtime.detail(user, result.taskId) };
    }
    if (reservation.state !== "started") {
      const code = reservation.state === "conflict" ? "idempotency_conflict" : reservation.state === "in_progress" ? "request_in_progress" : "idempotent_request_closed";
      throw new ApiHttpError(409, code, "This request key already belongs to an in-progress or closed operation. Refresh the task before trying a new operation.");
    }
    try {
      const task = await perform();
      // Store only a receipt: replay must reauthorize current state and cannot resurrect deleted content.
      ledger.complete({ id: reservation.id, tenantId: user.tenantId, userId: user.id, response: { taskId: task.id } });
      try { return { task: await runtime.detail(user, task.id) }; }
      catch (error) {
        // Cancellation/deletion can release resources after a grant is revoked without disclosing its transcript.
        if (error instanceof ApiHttpError && error.statusCode === 403 && ["managed.cancel", "managed.delete"].includes(action)) {
          return { task: { ...task, items: [], title: "Managed task", sourceRevision: null } };
        }
        throw error;
      }
    } catch (error) {
      ledger.fail({ id: reservation.id, tenantId: user.tenantId, userId: user.id, errorCode: error instanceof ApiHttpError ? error.code : "managed_mutation_failed" });
      throw error;
    }
  }

  app.get("/api/managed-agents", async (request) => {
    const user = requireUser(request, store);
    noQuery.parse(request.query);
    return runtime.catalog(user);
  });
  app.get("/api/managed-tasks", async (request) => {
    const user = requireUser(request, store);
    noQuery.parse(request.query);
    return runtime.list(user);
  });
  app.post("/api/managed-tasks", { config: mutationLimits }, async (request, reply) => {
    const user = requireUser(request, store);
    const input = createBody.parse(request.body);
    const result = await mutate(request, user, "managed.create", input.projectId, input, () => runtime.create(user, input));
    return reply.status(202).send(result);
  });
  app.get("/api/managed-tasks/:taskId", async (request) => {
    const { user, id } = owner(request);
    noQuery.parse(request.query);
    return { task: await runtime.detail(user, id) };
  });
  app.post("/api/managed-tasks/:taskId/messages", { config: mutationLimits }, async (request) => {
    const { user, id } = owner(request);
    const input = messageBody.parse(request.body);
    return mutate(request, user, "managed.message", id, input, () => runtime.message(user, id, input));
  });
  app.post("/api/managed-tasks/:taskId/cancel", { config: mutationLimits }, async (request) => {
    const { user, id } = owner(request);
    const input = cancelBody.parse(request.body);
    return mutate(request, user, "managed.cancel", id, input, () => runtime.cancel(user, id, input.expectedTurnId));
  });
  app.delete("/api/managed-tasks/:taskId", { config: mutationLimits }, async (request) => {
    const { user, id } = owner(request);
    z.object({}).strict().parse(request.body ?? {});
    noQuery.parse(request.query);
    return mutate(request, user, "managed.delete", id, {}, () => runtime.delete(user, id));
  });

  app.get("/api/managed-tasks/:taskId/events", async (request, reply) => {
    const { user, id } = owner(request);
    noQuery.parse(request.query);
    let latest: ManagedTaskDetail | null = await runtime.detail(user, id);
    // Authorization/history may have awaited while preClose ran. Never create
    // a fresh long-lived response after the existing streams were stopped.
    if (shuttingDown) throw new ApiHttpError(503, "managed_stream_closing", "The server is shutting down. Reconnect after it restarts.");
    if (reply.raw.destroyed) return;
    const key = `${user.tenantId}:${user.id}`;
    if ((connections.get(key) ?? 0) >= 4) throw new ApiHttpError(429, "managed_stream_limit", "Too many managed task streams are open.");
    connections.set(key, (connections.get(key) ?? 0) + 1);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let closed = false;
    let backpressured = false;
    let lastRevision = -1;
    let lastAuth = Date.now();
    let checking = false;
    const flush = () => {
      if (closed || backpressured || !latest || latest.revision <= lastRevision) return;
      const current = latest;
      latest = null;
      lastRevision = current.revision;
      backpressured = !reply.raw.write(`event: snapshot\ndata: ${JSON.stringify({ task: current })}\n\n`);
    };
    // Latest snapshot replaces pending work: a slow client never accumulates an unbounded event queue.
    const unsubscribe = runtime.subscribe(id, (task) => { latest = task; });
    const onDrain = () => { backpressured = false; flush(); };
    reply.raw.on("drain", onDrain);
    const timer = setInterval(() => {
      flush();
      if (Date.now() - lastAuth >= 5000 && !checking) {
        checking = true;
        lastAuth = Date.now();
        void (async () => {
          const currentUser = requireUser(request, store);
          if (currentUser.id !== user.id || currentUser.tenantId !== user.tenantId) throw new Error("Session changed");
          await runtime.detail(currentUser, id);
          if (!backpressured && !closed) backpressured = !reply.raw.write(": keep-alive\n\n");
        })().catch(() => {
          if (!closed) { reply.raw.write('event: error\ndata: {"error":"managed_stream_unauthorized","message":"Task access changed. Sign in or refresh."}\n\n'); reply.raw.end(); }
        }).finally(() => { checking = false; });
      }
    }, 250);
    timer.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(timer); unsubscribe(); reply.raw.off("drain", onDrain);
      closeStreams.delete(closeForShutdown);
      const count = (connections.get(key) ?? 1) - 1;
      if (count) connections.set(key, count); else connections.delete(key);
    };
    const closeForShutdown = () => {
      cleanup();
      // Destroy rather than waiting for queued snapshots to drain: slow or
      // disconnected clients must not delay executor shutdown either.
      reply.raw.destroy();
    };
    closeStreams.add(closeForShutdown);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    flush();
  });
}
