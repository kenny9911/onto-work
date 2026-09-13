import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { CreateManagedTaskPayload, ManagedTaskDetail, ManagedTaskMessagePayload, UserSummary } from "@agent-harness/contracts";
import { resolveAllowedWorkspacePath } from "../codex/config.js";
import type { HarnessConfig } from "../config.js";
import type { HarnessStore } from "../database.js";
import { ApiHttpError } from "../http.js";
import { managedCatalog, reviewerDefinition, validManagedApiKey } from "./catalog.js";
import { AgentsApiClient, AgentsApiError, type AgentsApiEvent, type AgentsApiTurn } from "./client.js";
import { AgentsApiExecutorSupervisor } from "./executor.js";
import { mergeDisplayEvent, mergeLocalItem, mergeSavedItem, object, rootTurn, turnUsage } from "./events.js";
import { activeTask, ManagedTaskRepository, type ManagedTaskRecord } from "./repository.js";
import { prepareManagedWorkspace, removeManagedWorkspace } from "./workspace.js";

type Client = Pick<AgentsApiClient, "createSession" | "retrieveSession" | "listItems" | "listTurns" | "retrieveTurn" | "openEventStream" | "sendMessage" | "cancel" | "deleteSession">;
type Executor = Pick<AgentsApiExecutorSupervisor, "start" | "stop" | "close">;
const execFileAsync = promisify(execFile);
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);

export interface ManagedAgentsRuntimeOptions {
  store: HarnessStore;
  config: HarnessConfig;
  client?: Client;
  executor?: Executor;
  prepareWorkspace?: typeof prepareManagedWorkspace;
  cleanupContainer?: (taskId: string) => Promise<void>;
}
interface Controller {
  abort: AbortController;
  connected: boolean;
  stopping: boolean;
  monitor?: Promise<void>;
  sessionId: string;
  reservationId: string | null;
  submitted: boolean;
}

/** Owns managed session lifecycles. Native Codex RPC remains a separate runtime boundary. */
export class ManagedAgentsRuntime {
  readonly repository: ManagedTaskRepository;
  private readonly client: Client | null;
  private readonly executor: Executor | null;
  private readonly controllers = new Map<string, Controller>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(task: ManagedTaskDetail) => void>>();
  private readonly shutdown = new AbortController();
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(private readonly options: ManagedAgentsRuntimeOptions) {
    const settings = options.config.agentsApi;
    this.repository = new ManagedTaskRepository(options.store, settings?.allowedTenantIds);
    this.client = options.client ?? (validManagedApiKey(settings?.apiKey) ? new AgentsApiClient({ apiKey: settings!.apiKey! }) : null);
    this.executor = options.executor ?? (managedCatalog(settings).available && settings?.executorKey && settings.executorImage ? new AgentsApiExecutorSupervisor({
      launcher: { command: "/bin/bash", args: [fileURLToPath(new URL("../../../../scripts/agents-api-executor-docker.sh", import.meta.url)), settings.executorImage] },
      restrictedApiKey: settings.executorKey,
    }) : null);
    this.watchdog = setInterval(() => {
      for (const task of this.repository.unfinished()) {
        if (activeTask(task.detail)) {
          try {
            const user = this.options.store.getUserSummary(task.userId);
            if (!user) throw new Error("Owner is unavailable");
            this.repository.authorizedProject(user, task.detail.projectId, task.workspacePath);
          } catch {
            this.track(this.interrupt(task.detail.id, "The user or project workspace authorization was revoked. The local executor was stopped."));
            continue;
          }
        }
        if (activeTask(task.detail) && task.deadlineAt && Date.parse(task.deadlineAt) <= Date.now()) {
          this.track(this.interrupt(task.detail.id, "The execution time limit was reached. Review the saved result before continuing."));
        }
      }
      for (const [id, controller] of this.controllers) {
        if (!this.repository.get(id)) {
          this.track(this.stopController(id, controller).then(async () => {
            if (controller.sessionId) await this.client?.cancel(controller.sessionId).catch(() => undefined);
          }));
        }
      }
    }, 1000);
    this.watchdog.unref();
  }

  catalog(user?: UserSummary) {
    const catalog = managedCatalog(this.options.config.agentsApi);
    if (user && !this.options.config.agentsApi?.allowedTenantIds?.includes(user.tenantId)) {
      return { ...catalog, available: false, reason: "Managed agents are not enabled for this workspace." };
    }
    return catalog;
  }
  private requireAvailable(): void {
    const catalog = this.catalog();
    if (!catalog.available || !this.client || !this.executor || this.shutdown.signal.aborted) throw new ApiHttpError(503, "managed_agents_unavailable", catalog.reason || "Managed agents are unavailable.");
  }
  private redact = (text: string): string => {
    for (const secret of [this.options.config.agentsApi?.apiKey, this.options.config.agentsApi?.executorKey]) {
      if (secret) text = text.split(secret).join("[redacted]");
    }
    return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
  };
  private track<T>(job: Promise<T>): void {
    this.jobs.add(job);
    void job.catch(() => undefined).finally(() => this.jobs.delete(job));
  }
  private launchRun(id: string, message: string, fresh: boolean): void {
    const job = this.run(id, message, fresh);
    this.starts.set(id, job);
    this.track(job);
    void job.finally(() => { if (this.starts.get(id) === job) this.starts.delete(id); }).catch(() => undefined);
  }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private changed(id: string, change: (task: ManagedTaskRecord) => void): ManagedTaskRecord {
    const record = this.repository.update(id, change);
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(record.detail); } catch { /* One browser cannot interrupt runtime work. */ }
    }
    return record;
  }
  subscribe(id: string, listener: (task: ManagedTaskDetail) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(listener);
    return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(id); };
  }
  private audit(task: ManagedTaskRecord, action: string): void {
    this.options.store.audit({ tenantId: task.tenantId, userId: task.userId, action: `managed.${action}`, targetType: "managed_task", targetId: task.detail.id,
      metadata: { agentId: task.detail.agentId, agentVersion: task.detail.agentVersion, projectId: task.detail.projectId } });
  }
  private async workspace(user: UserSummary, projectId: string): Promise<{ path: string; name: string }> {
    const project = this.repository.authorizedProject(user, projectId);
    let path: string;
    try { path = await resolveAllowedWorkspacePath(project.workspacePath, this.options.config.allowedWorkspaceRoots); }
    catch { throw new ApiHttpError(403, "workspace_not_granted", "The project is outside the allowed workspace roots."); }
    this.repository.authorizedProject(user, projectId, path);
    if (path !== project.workspacePath) throw new ApiHttpError(403, "workspace_not_granted", "The trusted project workspace has changed.");
    return { path, name: project.name };
  }
  async detail(user: UserSummary, id: string): Promise<ManagedTaskDetail> {
    const task = this.repository.owned(user, id);
    if (task.detail.status !== "deleted") await this.workspace(user, task.detail.projectId);
    if (task.detail.status === "interrupted" && task.sessionId && this.client) await this.reconcile(id).catch(() => undefined);
    return this.repository.owned(user, id).detail;
  }
  async list(user: UserSummary) {
    const tasks = [];
    for (const record of this.repository.list(user)) {
      try {
        if (record.detail.status !== "deleted") await this.workspace(user, record.detail.projectId);
        const { items: _items, usage: _usage, ...summary } = record.detail;
        tasks.push(summary);
      } catch { /* A revoked workspace does not expose its retained transcript. */ }
    }
    return { tasks };
  }

  async create(user: UserSummary, input: CreateManagedTaskPayload): Promise<ManagedTaskDetail> {
    this.requireAvailable();
    const definition = reviewerDefinition(this.options.config.agentsApi);
    if (input.agentId !== definition.id) throw new ApiHttpError(404, "managed_agent_not_found", "Managed agent not found.");
    const project = await this.workspace(user, input.projectId);
    const id = randomUUID();
    const reservation = this.repository.reserveTurn({ user, taskId: id, projectId: input.projectId, workspacePath: project.path, model: definition.model,
      maxConcurrentSessions: this.options.config.agentsApi!.maxConcurrentSessions, maxTurnSeconds: this.options.config.agentsApi!.maxTurnSeconds });
    const timestamp = new Date().toISOString();
    const task: ManagedTaskRecord = {
      tenantId: user.tenantId, userId: user.id, workspacePath: project.path, definition,
      sessionId: null, environmentId: null, remoteUrl: null, ...reservation,
      detail: { id, projectId: input.projectId, projectName: project.name, agentId: definition.id, agentVersion: definition.version,
        title: this.redact(input.message).replace(/\s+/g, " ").slice(0, 100), status: "starting", turnId: null, revision: 1,
        sourceRevision: null, createdAt: timestamp, updatedAt: timestamp, error: null,
        items: [], usage: { inputTokens: 0, outputTokens: 0, reported: false } },
    };
    try { this.repository.insert(task); this.audit(task, "created"); }
    catch (error) { this.options.store.failUsageReservation(reservation.reservationId, user.tenantId, "task_creation_failed"); throw error; }
    this.launchRun(id, input.message, true);
    return task.detail;
  }

  private assertActive(id: string, controller?: Controller): ManagedTaskRecord {
    const record = this.repository.get(id);
    if (!record || !activeTask(record.detail) || this.shutdown.signal.aborted ||
        (controller && (controller.abort.signal.aborted || this.controllers.get(id) !== controller || record.reservationId !== controller.reservationId))) throw new ApiHttpError(409, "managed_task_stopped", "Managed task has stopped.");
    return record;
  }

  private async run(id: string, message: string, fresh: boolean): Promise<void> {
    let createdSession: string | null = null;
    const initial = this.repository.get(id);
    const controller: Controller = { abort: new AbortController(), connected: false, stopping: false,
      sessionId: initial?.sessionId ?? "", reservationId: initial?.reservationId ?? null, submitted: false };
    this.controllers.set(id, controller);
    try {
      let task = this.assertActive(id, controller);
      if (fresh) {
        const prepared = await (this.options.prepareWorkspace ?? prepareManagedWorkspace)({ taskId: id, workspacePath: task.workspacePath,
          runtimeDataDir: this.options.config.runtimeDataDir, sharedSkillsDir: this.options.config.sharedSkillsDir, skillIds: task.definition.skillIds });
        task = this.assertActive(id, controller);
        this.changed(id, (record) => {
          record.detail.sourceRevision = prepared.sourceRevision;
          mergeLocalItem(record.detail, { id: "snapshot", role: "system", status: "completed", subagentId: null,
            text: `Reviewing committed snapshot ${prepared.sourceRevision}. ${prepared.excludedFiles} excluded entries. Uncommitted and untracked files are not included.` });
          // Bind selected bundle content to this session's version as well as its configuration.
          if (prepared.skillsFingerprint) { record.detail.agentVersion += `:${prepared.skillsFingerprint.slice(0, 16)}`; record.definition.version = record.detail.agentVersion; }
        });
        const session = await this.client!.createSession({ model: task.definition.model, instructions: task.definition.instructions,
          workspaceDirectory: "/workspace", capabilityDirectories: prepared.capabilityDirectories, maxConcurrentSubagents: task.definition.maxSubagents }, controller.abort.signal);
        createdSession = session.id;
        // Preserve a known allocation even if cancellation raced the response. A
        // failed cleanup must remain retryable through the durable task binding.
        task = this.changed(id, (record) => {
          record.sessionId = session.id; record.environmentId = session.environment.id; record.remoteUrl = session.environment.remote_url;
          if (controller.stopping || !activeTask(record.detail)) record.detail.error = "Unused remote session cleanup is pending. Wait for cleanup before continuing.";
        });
        controller.sessionId = session.id;
        this.assertActive(id, controller);
      }
      task = this.assertActive(id, controller);
      if (!task.sessionId || !task.environmentId || !task.remoteUrl) throw new Error("Managed environment is not bound");
      controller.sessionId = task.sessionId;
      const opened = this.startMonitor(id, controller);
      await opened;
      this.assertActive(id, controller);
      const taskRoot = resolve(this.options.config.runtimeDataDir, "managed-agents", id);
      await access(join(taskRoot, "workspace"));
      const owner = this.options.store.getUserSummary(task.userId);
      if (!owner) throw new Error("Managed task owner is unavailable");
      await this.workspace(owner, task.detail.projectId);
      this.assertActive(id, controller);
      const handle = await this.executor!.start({ sessionId: task.sessionId, environmentId: task.environmentId, remoteUrl: task.remoteUrl,
        workspaceDirectory: join(taskRoot, "workspace"), homeDirectory: join(taskRoot, "home"), codexHomeDirectory: join(taskRoot, "home", ".codex") });
      this.track(handle.closed.then((exit) => {
        if (!exit.expected && !controller.stopping && this.controllers.get(id) === controller && !this.shutdown.signal.aborted) return this.interrupt(id, "The local executor stopped unexpectedly. Review the saved history before continuing.");
      }));
      const connectBy = Date.now() + 60_000;
      while (!controller.connected) {
        this.assertActive(id, controller);
        if (controller.abort.signal.aborted || Date.now() >= connectBy) throw new Error("Environment connection timed out");
        await delay(100, undefined, { signal: controller.abort.signal });
      }
      // Subscribe and connect before input. An uncertain POST is never retried automatically.
      await this.locked(id, async () => {
        this.assertActive(id, controller);
        this.repository.authorizedProject(owner, task.detail.projectId, task.workspacePath);
        this.changed(id, (record) => { mergeLocalItem(record.detail, { id: `input:${randomUUID()}`, role: "user", status: "completed", subagentId: null, text: this.redact(message) }); });
        controller.submitted = true;
        await this.client!.sendMessage(task.sessionId!, message, controller.abort.signal);
      });
    } catch {
      const record = this.repository.get(id);
      if (createdSession && !controller.submitted && (!record || controller.stopping || !activeTask(record.detail))) {
        try {
          try { await this.client?.deleteSession(createdSession); }
          catch (error) { if (!(error instanceof AgentsApiError && error.status === 404)) throw error; }
          if (this.repository.get(id)?.sessionId === createdSession) this.changed(id, (task) => {
            task.sessionId = null; task.environmentId = null; task.remoteUrl = null;
            if (task.detail.error?.startsWith("Unused remote session cleanup")) task.detail.error = null;
          });
        } catch {
          if (this.repository.get(id)?.sessionId === createdSession) this.changed(id, (task) => {
            task.detail.error = "Unused remote session cleanup is incomplete. Delete this task to retry cleanup.";
          });
        }
      }
      if (record && activeTask(record.detail) && this.controllers.get(id) === controller) await this.interrupt(id, "The managed run could not start or continue. Check executor and API configuration; input was not automatically retried.");
    }
  }

  private startMonitor(id: string, controller: Controller): Promise<void> {
    let opened = false;
    let resolveOpened!: () => void;
    let rejectOpened!: (error: unknown) => void;
    const firstOpen = new Promise<void>((resolvePromise, reject) => { resolveOpened = resolvePromise; rejectOpened = reject; });
    controller.monitor = (async () => {
      for (let attempt = 0; attempt < 4 && !controller.abort.signal.aborted; attempt++) {
        let stream: Awaited<ReturnType<Client["openEventStream"]>> | undefined;
        let pump: Promise<void> | undefined;
        const buffer: AgentsApiEvent[] = [];
        let bufferBytes = 0;
        let restored = false;
        let failure: unknown = null;
        const seen = new Set<string>();
        try {
          stream = await this.client!.openEventStream(controller.sessionId, controller.abort.signal);
          pump = (async () => {
            for await (const event of stream!.events) {
              if (event.event_id) {
                if (seen.has(event.event_id)) continue;
                seen.add(event.event_id);
                if (seen.size > 4096) seen.delete(seen.values().next().value!);
              }
              if (!restored) {
                bufferBytes += Buffer.byteLength(JSON.stringify(event));
                if (buffer.length >= 1000 || bufferBytes > 2_097_152) throw new Error("Recovery event buffer exceeded");
                buffer.push(event);
              } else await this.handleEvent(id, controller, event);
            }
            if (!controller.abort.signal.aborted) throw new Error("Managed stream closed before terminal outcome");
          })().catch((error) => { failure = error; });
          const session = await this.client!.retrieveSession(controller.sessionId, controller.abort.signal);
          if (session.status === "failed" || session.environment.status === "failed" ||
              session.required_actions?.some((action) => action.type !== "environment_connection")) throw new Error("Unsupported managed lifecycle state");
          controller.connected = session.environment.status === "connected";
          await this.reconcile(id, controller.abort.signal, controller);
          // Drain through the same serial handler while the pump continues buffering.
          while (buffer.length) await this.handleEvent(id, controller, buffer.shift()!);
          restored = true;
          if (failure) throw failure;
          if (!opened) { opened = true; resolveOpened(); }
          await pump;
          if (failure) throw failure;
          return;
        } catch (error) {
          if (controller.abort.signal.aborted) return;
          if (attempt === 3) {
            if (!opened) rejectOpened(error);
            await this.interrupt(id, "The managed event connection could not be recovered. Saved items are retained; no input was replayed.");
            return;
          }
        } finally { stream?.close(); await pump?.catch(() => undefined); }
        await delay(250 * (attempt + 1), undefined, { signal: controller.abort.signal }).catch(() => undefined);
      }
    })().finally(() => { if (!opened) rejectOpened(new Error("Managed stream stopped")); });
    this.track(controller.monitor);
    return firstOpen;
  }

  private async reconcile(id: string, signal?: AbortSignal, controller?: Controller, terminalTurn?: AgentsApiTurn): Promise<void> {
    const task = this.repository.get(id);
    if (!task?.sessionId) return;
    const [items, turns] = await Promise.all([this.client!.listItems(task.sessionId, { signal, maxItems: 1000 }), this.client!.listTurns(task.sessionId, { signal, maxItems: 500 })]);
    if (terminalTurn) {
      const authoritative = await this.client!.retrieveTurn(task.sessionId, terminalTurn.id, signal);
      const index = turns.findIndex((turn) => turn.id === authoritative.id);
      if (index >= 0) turns[index] = authoritative; else turns.push(authoritative);
    }
    let finished = false;
    await this.locked(id, async () => {
      const current = this.repository.get(id);
      if (!current || ["deleting", "deleted"].includes(current.detail.status) ||
          (controller && (this.controllers.get(id) !== controller || controller.stopping || current.reservationId !== controller.reservationId))) return;
      this.changed(id, (record) => {
        // Replace optimistic inputs when the remote history contains their canonical counterparts.
        const userTexts = new Set(items.filter((item) => item.role === "user").map((item) => JSON.stringify(item.content)));
        if (userTexts.size) record.detail.items = record.detail.items.filter((item) => !item.id.startsWith("input:") || !items.some((remote) => remote.role === "user" && Array.isArray(remote.content) && remote.content.some((part) => this.redact(String(object(part).text ?? "")) === item.text)));
        for (const item of items) mergeSavedItem(record.detail, item, this.redact);
        const usages = turns.filter((turn) => turn.subagent_id === null).map(turnUsage);
        const inputTokens = usages.reduce((sum, usage) => sum + usage.inputTokens, 0);
        const outputTokens = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
        const valid = Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens);
        record.detail.usage = { inputTokens: valid ? inputTokens : 0, outputTokens: valid ? outputTokens : 0,
          reported: valid && usages.length > 0 && usages.every((usage) => usage.reported) };
      });
      const latest = rootTurn(turns);
      if (latest) finished = this.applyTurn(id, latest);
    });
    if (finished) await this.stopController(id, controller);
  }

  /** Must be called with the task lock held, after authoritative history was saved for terminal turns. */
  private applyTurn(id: string, turn: AgentsApiTurn): boolean {
    if (turn.subagent_id !== null) return false;
    const record = this.repository.get(id);
    if (!record || (!activeTask(record.detail) && !(record.detail.status === "interrupted" && record.reservationId))) return false;
    // On follow-up, recovery sees the preceding completed turn until new input starts a new one.
    if (record.detail.status === "starting" && terminal(turn.status) && record.detail.turnId === turn.id) return false;
    if (record.detail.status === "running" && record.detail.turnId && record.detail.turnId !== turn.id) return false;
    // A retained reservation for an interrupted follow-up must not settle against its preceding turn.
    const reservation = record.reservationId ? this.options.store.db.prepare("SELECT turn_id FROM usage_reservations WHERE id=?").get(record.reservationId) as { turn_id: string | null } | undefined : undefined;
    if (record.detail.status === "interrupted" && !reservation?.turn_id && record.detail.turnId === turn.id) return false;
    if (reservation?.turn_id && reservation.turn_id !== turn.id) return false;
    if (!terminal(turn.status)) {
      if (turn.status !== "in_progress" && turn.status !== "running") return false;
      if (record.reservationId) this.bindReservation(record, turn.id);
      this.changed(id, (task) => { task.detail.turnId = turn.id; if (task.detail.status !== "interrupted") task.detail.status = "running"; });
      return false;
    }
    const usage = turnUsage(turn);
    if (record.reservationId) {
      if (!this.repository.settleTurn(record, turn.id, turn.status as "completed" | "failed" | "cancelled",
        usage.reported ? usage.inputTokens : null, usage.reported ? usage.outputTokens : null)) throw new Error("Managed usage settlement could not be correlated");
    }
    const finished = this.changed(id, (task) => {
      task.detail.turnId = turn.id;
      task.detail.status = turn.status === "completed" ? "idle" : turn.status === "cancelled" ? "cancelled" : "failed";
      task.detail.error = turn.status === "failed" ? "The managed turn failed. Review its saved output." : null;
      task.reservationId = null; task.deadlineAt = null;
    });
    this.audit(finished, `turn_${turn.status}`);
    return true;
  }

  private bindReservation(record: ManagedTaskRecord, turnId: string): void {
    if (!record.reservationId) return;
    if (!this.options.store.recordUsageReservationResponse({ reservationId: record.reservationId, tenantId: record.tenantId,
      response: { taskId: record.detail.id }, completesReservation: false, threadId: record.detail.id, turnId })) {
      throw new Error("Managed usage reservation could not be correlated");
    }
  }

  private async handleEvent(id: string, controller: Controller, event: AgentsApiEvent): Promise<void> {
    if (controller.stopping || this.controllers.get(id) !== controller) return;
    if (event.type === "agent.session.environment.connected") controller.connected = true;
    if (event.type === "agent.session.environment.disconnected") controller.connected = false;
    if (["error", "agent.session.failed", "agent.session.environment.failed"].includes(event.type)) throw new Error("Managed lifecycle failed");
    if (event.type === "agent.session.requires_action") {
      const session = await this.client!.retrieveSession(controller.sessionId, controller.abort.signal);
      if (session.required_actions?.some((action) => action.type !== "environment_connection")) throw new Error("Unsupported managed action");
    }
    const turn = object(event.turn);
    if (typeof turn.id === "string" && typeof turn.status === "string" && turn.subagent_id === null && terminal(turn.status)) {
      // Terminal events can precede the UI's last text frame. Fetch saved content and
      // authoritative usage before aborting the stream or stopping its executor.
      await this.reconcile(id, controller.abort.signal, controller, turn as AgentsApiTurn);
      return;
    }
    await this.locked(id, async () => {
      const current = this.repository.get(id);
      if (!current || !activeTask(current.detail) || this.controllers.get(id) !== controller || controller.stopping) return;
      this.changed(id, (record) => mergeDisplayEvent(record.detail, event, this.redact));
      if (typeof turn.id === "string" && typeof turn.status === "string") this.applyTurn(id, turn as AgentsApiTurn);
    });
  }

  async message(user: UserSummary, id: string, input: ManagedTaskMessagePayload): Promise<ManagedTaskDetail> {
    this.requireAvailable();
    const record = this.repository.owned(user, id);
    await this.workspace(user, record.detail.projectId);
    // input.message also starts a turn when the session becomes idle. The beta
    // API documents no atomic expected-turn condition, so a read-then-send check
    // could create an unadmitted paid turn if completion races the request.
    if (input.mode === "steer") throw new ApiHttpError(409, "managed_steering_unavailable",
      "Steering is unavailable for managed agents. Wait for the current turn to finish, then send a follow-up.");
    if (record.detail.status === "interrupted" && record.sessionId) await this.reconcile(id).catch(() => undefined);
    return this.locked(id, async () => {
      const current = this.repository.owned(user, id);
      if (!current.sessionId) throw new ApiHttpError(409, "managed_session_unavailable", "This task has no managed session. Start a new task.");
      if (!["idle", "failed", "cancelled", "interrupted"].includes(current.detail.status)) throw new ApiHttpError(409, "managed_task_busy", "Wait for the current task operation to finish.");
      if (current.detail.error?.toLowerCase().includes("cleanup")) throw new ApiHttpError(409, "managed_cleanup_pending", "Executor or session cleanup is incomplete. Finish cleanup before continuing.");
      if (current.reservationId) throw new ApiHttpError(409, "managed_outcome_unconfirmed", "The preceding run has no confirmed outcome. Refresh or cancel it before starting more work.");
      const latest = rootTurn(await this.client!.listTurns(current.sessionId));
      if (latest && !terminal(latest.status)) throw new ApiHttpError(409, "managed_task_busy", "The remote turn is still active. Cancel it before continuing.");
      await this.stopController(id);
      const reservation = this.repository.reserveTurn({ user, taskId: id, projectId: current.detail.projectId, workspacePath: current.workspacePath, model: current.definition.model,
        maxConcurrentSessions: this.options.config.agentsApi!.maxConcurrentSessions, maxTurnSeconds: this.options.config.agentsApi!.maxTurnSeconds });
      const next = this.changed(id, (task) => { Object.assign(task, reservation); task.detail.status = "starting"; task.detail.turnId = latest?.id ?? null; task.detail.error = null; });
      this.audit(next, "follow_up");
      this.launchRun(id, input.message, false);
      return next.detail;
    });
  }

  async cancel(user: UserSummary, id: string, expectedTurnId: string | null): Promise<ManagedTaskDetail> {
    this.repository.owned(user, id);
    const stopped = await this.locked(id, async () => {
      const task = this.repository.owned(user, id);
      if (!activeTask(task.detail) && task.detail.status !== "interrupted") return null;
      if (expectedTurnId !== task.detail.turnId) throw new ApiHttpError(409, "managed_turn_changed", "The active turn changed. Refresh before cancelling.");
      const controller = this.controllers.get(id);
      const neverSubmitted = controller ? !controller.submitted : !task.sessionId;
      this.changed(id, (record) => { record.detail.status = "interrupted";
        record.detail.error = "The local executor was stopped. Remote cancellation is awaiting confirmation; refresh the history before continuing.";
        record.deadlineAt = null; });
      await this.stopController(id);
      this.audit(task, "cancel_requested");
      return { task, neverSubmitted };
    });
    if (!stopped) return this.repository.owned(user, id).detail;
    if (stopped.task.sessionId && this.client) {
      await this.client.cancel(stopped.task.sessionId).catch(() => undefined);
      await this.reconcile(id).catch(() => undefined);
    }
    if (stopped.neverSubmitted) await this.finishUnsubmitted(id, stopped.task.reservationId, "cancelled");
    return this.repository.owned(user, id).detail;
  }

  private async stopController(id: string, expected?: Controller): Promise<void> {
    const controller = expected ?? this.controllers.get(id);
    if (!controller || this.controllers.get(id) !== controller) return;
    controller.stopping = true;
    controller.abort.abort();
    if (controller.sessionId) await this.executor?.stop(controller.sessionId);
    if (this.controllers.get(id) === controller) this.controllers.delete(id);
  }

  private async interrupt(id: string, reason: string): Promise<void> {
    const stopped = await this.locked(id, async () => {
      const task = this.repository.get(id);
      if (!task || !activeTask(task.detail)) return null;
      const controller = this.controllers.get(id);
      const neverSubmitted = controller ? !controller.submitted : !task.sessionId;
      // Persist first so delayed setup or model events cannot revive this run.
      this.changed(id, (record) => { record.detail.status = "interrupted"; record.detail.error = reason; record.deadlineAt = null; });
      await this.stopController(id);
      this.audit(task, "interrupted");
      return { task, neverSubmitted };
    });
    if (!stopped) return;
    if (stopped.task.sessionId && this.client) {
      await this.client.cancel(stopped.task.sessionId).catch(() => undefined);
      await this.reconcile(id).catch(() => undefined);
    }
    if (stopped.neverSubmitted) await this.finishUnsubmitted(id, stopped.task.reservationId, "interrupted");
  }

  private async finishUnsubmitted(id: string, reservationId: string | null, status: "cancelled" | "interrupted"): Promise<void> {
    await this.locked(id, async () => {
      const task = this.repository.get(id);
      if (!task || task.detail.status !== "interrupted" || task.reservationId !== reservationId) return;
      if (reservationId) this.options.store.failUsageReservation(reservationId, task.tenantId, "managed_input_not_submitted");
      this.changed(id, (record) => { record.reservationId = null; record.detail.status = status;
        if (status === "cancelled" && !record.detail.error?.includes("cleanup is incomplete")) record.detail.error = null; });
    });
  }

  private async cleanupContainer(taskId: string): Promise<void> {
    if (this.options.cleanupContainer) return this.options.cleanupContainer(taskId);
    if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error("Invalid task identifier");
    const name = `harness-agent-${taskId}`;
    const options = { timeout: 10_000,
      env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", HOME: resolve(this.options.config.runtimeDataDir, "managed-agents", taskId, "home") }, maxBuffer: 16_384 };
    const exists = async () => {
      const result = await execFileAsync("docker", ["container", "ls", "--all", "--quiet", "--filter", `name=^/${name}$`], options);
      return result.stdout.trim().length > 0;
    };
    if (!await exists()) return;
    try { await execFileAsync("docker", ["rm", "--force", name], options); }
    catch (error) { if (await exists()) throw error; }
  }
  async delete(user: UserSummary, id: string): Promise<ManagedTaskDetail> {
    this.repository.owned(user, id);
    await this.locked(id, async () => {
      const task = this.repository.owned(user, id);
      if (task.detail.status === "deleted") return;
      this.changed(id, (record) => { record.detail.status = "deleting"; record.detail.error = null; });
      await this.stopController(id);
    });
    // Setup can still be exporting a snapshot. Wait outside the lock so its abort
    // path can finish; it must not recreate files after deletion reports success.
    await this.starts.get(id)?.catch(() => undefined);
    return this.locked(id, async () => {
      const task = this.repository.owned(user, id);
      if (task.detail.status === "deleted") return task.detail;
      try {
        if (task.sessionId) {
          if (!this.client) throw new Error("API configuration is needed for remote deletion");
          await this.client.cancel(task.sessionId).catch(() => undefined);
          // Preserve any confirmed final accounting before deleting the remote
          // history. An unavailable outcome remains unknown, never a zero report.
          if (task.reservationId) {
            try {
              const turns = await this.client.listTurns(task.sessionId, { maxItems: 500 });
              const latest = rootTurn(turns);
              const reservation = this.options.store.db.prepare("SELECT turn_id FROM usage_reservations WHERE id=?").get(task.reservationId) as { turn_id: string | null } | undefined;
              if (latest && terminal(latest.status) &&
                  (reservation?.turn_id === latest.id || (!reservation?.turn_id && task.detail.turnId !== latest.id))) {
                const usage = turnUsage(latest);
                if (this.repository.settleTurn(task, latest.id, latest.status as "completed" | "failed" | "cancelled",
                  usage.reported ? usage.inputTokens : null, usage.reported ? usage.outputTokens : null)) {
                  this.changed(id, (record) => { record.reservationId = null; });
                }
              }
            } catch { /* Deletion can proceed with accounting explicitly unavailable. */ }
          }
          try { await this.client.deleteSession(task.sessionId); }
          catch (error) { if (!(error instanceof AgentsApiError && error.status === 404)) throw error; }
          this.changed(id, (record) => { record.sessionId = null; record.environmentId = null; record.remoteUrl = null; });
        }
        // Stop by deterministic container name as well, including processes left by a server crash.
        if (task.sessionId || task.detail.sourceRevision) await this.cleanupContainer(id);
        await removeManagedWorkspace(this.options.config.runtimeDataDir, id);
      } catch {
        this.changed(id, (record) => { record.detail.error = "Deletion is incomplete. Restore API/executor access and retry to finish cleanup."; });
        throw new ApiHttpError(502, "managed_delete_incomplete", "Deletion is incomplete. Retry after restoring API and executor access.");
      }
      if (task.reservationId) this.options.store.failUsageReservation(task.reservationId, task.tenantId, "managed_deleted_usage_unconfirmed");
      const deleted = this.changed(id, (record) => {
        record.detail.status = "deleted"; record.detail.title = "Deleted managed task"; record.detail.items = []; record.detail.turnId = null;
        record.detail.error = null; record.sessionId = null; record.environmentId = null; record.remoteUrl = null; record.reservationId = null; record.deadlineAt = null;
      });
      this.audit(deleted, "deleted");
      return deleted.detail;
    });
  }

  /** A restart restores history and stops orphan work; it never resubmits a pending message. */
  async initialize(): Promise<void> {
    for (const task of this.repository.unfinished()) {
      const id = task.detail.id;
      let cleanupFailed = false;
      if (task.sessionId) await this.cleanupContainer(id).catch(() => { cleanupFailed = true; });
      if (task.sessionId && this.client && task.detail.status !== "deleting") {
        await this.reconcile(id).catch(() => undefined);
      }
      if (activeTask(this.repository.get(id)!.detail)) await this.interrupt(id, "The server restarted during this run. Saved history was recovered when available; pending input was not replayed.");
      else if (this.repository.get(id)?.detail.status === "interrupted" && task.sessionId && this.client) {
        await this.client.cancel(task.sessionId).catch(() => undefined);
        await this.reconcile(id).catch(() => undefined);
      }
      if (cleanupFailed) this.changed(id, (record) => { record.detail.error = "Cleanup of the previous local executor could not be verified. Restore Docker access and retry cleanup before continuing."; });
    }
  }
  async close(): Promise<void> {
    clearInterval(this.watchdog);
    this.shutdown.abort();
    await Promise.all(this.repository.unfinished().filter((task) => activeTask(task.detail)).map((task) => this.interrupt(task.detail.id, "The server stopped during this run. Continue explicitly after reviewing its history.")));
    await this.executor?.close();
    await Promise.allSettled([...this.jobs]);
    this.listeners.clear();
  }
}
