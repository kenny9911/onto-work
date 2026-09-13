import { lazy, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ManagedTaskDetail, ManagedTaskSummary, SavedProjectSummary } from "@agent-harness/contracts";
import { Bot, LoaderCircle, Plus, RefreshCw, ShieldCheck, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RichContentBoundary } from "@/components/RichContentBoundary";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiClientError, api, idempotencyKey } from "@/lib/api";
import { managedAgentsApi, type ManagedAgentCatalog, type ManagedTaskMessage } from "@/lib/managed-agents-api";
import { cn } from "@/lib/utils";

const MessageResponse = lazy(() => import("@/components/ai-elements/message").then((module) => ({ default: module.MessageResponse })));

type Mutation =
  | { kind: "create"; key: string; input: { projectId: string; agentId: string; message: string } }
  | { kind: "message"; key: string; taskId: string; input: ManagedTaskMessage }
  | { kind: "cancel"; key: string; taskId: string; turnId: string | null }
  | { kind: "delete"; key: string; taskId: string };

const runningStatuses = new Set<ManagedTaskSummary["status"]>(["starting", "running"]);
const closedStatuses = new Set<ManagedTaskSummary["status"]>(["deleting", "deleted"]);
const messageLimit = 16_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The managed agent service could not complete this request.";
}

function uncertainMutation(error: unknown): boolean {
  if (error instanceof ApiClientError && error.code === "managed_agents_unavailable") return false;
  return !(error instanceof ApiClientError) || error.status >= 500 || error.code === "request_in_progress";
}

function upsertTask(tasks: ManagedTaskSummary[], task: ManagedTaskSummary): ManagedTaskSummary[] {
  const current = tasks.find((entry) => entry.id === task.id);
  if (current && current.revision > task.revision) return tasks;
  return [task, ...tasks.filter((entry) => entry.id !== task.id)]
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function loadProjects(): Promise<SavedProjectSummary[]> {
  const projects: SavedProjectSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.listProjects(100, cursor);
    projects.push(...page.projects);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Project pagination could not finish. Refresh and try again.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return projects.filter((project) => project.enabled && project.availability === "available");
}

export function ManagedAgentsView() {
  const [catalog, setCatalog] = useState<ManagedAgentCatalog | null>(null);
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]);
  const [tasks, setTasks] = useState<ManagedTaskSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [task, setTask] = useState<ManagedTaskDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [requiresReview, setRequiresReview] = useState(false);
  const [historyRefreshed, setHistoryRefreshed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const selectedIsDeleted = task?.id === selectedId && task?.status === "deleted";

  const applyTask = useCallback((next: ManagedTaskDetail) => {
    if (!mounted.current) return;
    setTasks((current) => upsertTask(current, next));
    if (selectedIdRef.current !== next.id) return;
    setTask((current) => current?.id === next.id && current.revision > next.revision ? current : next);
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    const results = await Promise.allSettled([managedAgentsApi.catalog(), managedAgentsApi.list(), loadProjects()]);
    if (!mounted.current || generation !== loadGeneration.current) return;
    const errors: string[] = [];
    const [agentsResult, tasksResult, projectsResult] = results;
    if (agentsResult.status === "fulfilled") {
      setCatalog(agentsResult.value);
      setAgentId((current) => agentsResult.value.agents.some((agent) => agent.id === current)
        ? current : agentsResult.value.agents[0]?.id ?? "");
    } else errors.push(`Agents: ${errorText(agentsResult.reason)}`);
    if (tasksResult.status === "fulfilled") {
      setTasks((current) => tasksResult.value.tasks.reduce(upsertTask, current));
    } else errors.push(`Task history: ${errorText(tasksResult.reason)}`);
    if (projectsResult.status === "fulfilled") {
      setProjects(projectsResult.value);
      setProjectId((current) => projectsResult.value.some((project) => project.id === current)
        ? current : projectsResult.value[0]?.id ?? "");
    } else errors.push(`Projects: ${errorText(projectsResult.reason)}`);
    setLoadErrors(errors);
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; loadGeneration.current += 1; };
  }, [refresh]);

  const refreshDetail = useCallback(async (id: string) => {
    setDetailError(null);
    try {
      const result = await managedAgentsApi.detail(id);
      applyTask(result.task);
      return true;
    } catch (error) {
      if (mounted.current && selectedIdRef.current === id) setDetailError(errorText(error));
      return false;
    }
  }, [applyTask]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDetailLoading(true);
    void refreshDetail(selectedId).finally(() => { if (active) setDetailLoading(false); });
    if (selectedIsDeleted) {
      setStreamStatus("Session deleted");
      return () => { active = false; };
    }
    if (typeof EventSource === "undefined") {
      setStreamStatus("Live updates are unavailable in this browser. Refresh output to check progress.");
      return () => { active = false; };
    }
    setStreamStatus("Connecting to live updates…");
    const source = new EventSource(managedAgentsApi.eventsUrl(selectedId), { withCredentials: true });
    source.addEventListener("open", () => {
      if (!active) return;
      setStreamStatus("Live updates connected");
      // A fresh snapshot closes gaps after every reconnect; streams do not replay history.
      void refreshDetail(selectedId);
    });
    source.addEventListener("snapshot", (event) => {
      if (!active) return;
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { task?: ManagedTaskDetail };
        if (!data.task || data.task.id !== selectedId || !Number.isInteger(data.task.revision) || !Array.isArray(data.task.items)) {
          throw new Error("Invalid snapshot");
        }
        applyTask(data.task);
        setStreamStatus("Live updates connected");
      } catch {
        setStreamStatus("An update could not be read. Refresh output to recover the latest state.");
      }
    });
    source.addEventListener("error", (event) => {
      if (!active) return;
      let message = "Live updates disconnected. Reconnecting…";
      if (event instanceof MessageEvent && typeof event.data === "string") {
        try {
          const failure = JSON.parse(event.data) as { message?: unknown };
          if (typeof failure.message === "string") message = failure.message;
        } catch { /* Keep the connection message for malformed events. */ }
      }
      setStreamStatus(message);
    });
    return () => { active = false; source.close(); };
  }, [selectedId, selectedIsDeleted, applyTask, refreshDetail]);

  function chooseTask(id: string | null) {
    if (busyRef.current || pending) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setTask(null);
    setDraft("");
    setDetailError(null);
    setMutationError(null);
    setConfirmDelete(false);
  }

  async function runMutation(mutation: Mutation) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPending(mutation);
    setMutationError(null);
    setRequiresReview(false);
    setHistoryRefreshed(false);
    if (mutation.kind === "delete") setConfirmDelete(false);
    try {
      const result = mutation.kind === "create"
        ? await managedAgentsApi.create(mutation.input, mutation.key)
        : mutation.kind === "message"
          ? await managedAgentsApi.message(mutation.taskId, mutation.input, mutation.key)
          : mutation.kind === "cancel"
            ? await managedAgentsApi.cancel(mutation.taskId, mutation.turnId, mutation.key)
            : await managedAgentsApi.remove(mutation.taskId, mutation.key);
      if (!mounted.current) return;
      if (mutation.kind === "create") {
        selectedIdRef.current = result.task.id;
        setSelectedId(result.task.id);
      }
      applyTask(result.task);
      if (mutation.kind === "create" || mutation.kind === "message") setDraft("");
      setPending(null);
      setConfirmDelete(false);
    } catch (error) {
      if (!mounted.current) return;
      setMutationError(errorText(error));
      if (error instanceof ApiClientError && /managed_(?:input_uncertain|cancel_uncertain|delete_incomplete)/.test(error.code)) setRequiresReview(true);
      if (!uncertainMutation(error)) setPending(null);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const selectedAgent = catalog?.agents.find((agent) => agent.id === (task?.agentId ?? agentId));
  const running = task?.status === "running";
  const starting = task?.status === "starting";
  const cancellable = task ? runningStatuses.has(task.status) || task.status === "interrupted" : false;
  const closed = task ? closedStatuses.has(task.status) : false;
  const locked = busy || pending !== null;
  const canSend = Boolean(catalog?.available && selectedAgent && !locked && !closed && !starting && !running && draft.trim()
    && (selectedId ? task : projectId));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    if (!task) {
      void runMutation({ kind: "create", key: idempotencyKey(), input: { projectId, agentId, message: draft.trim() } });
    } else {
      void runMutation({ kind: "message", key: idempotencyKey(), taskId: task.id, input: {
        message: draft.trim(),
        mode: "follow_up",
      } });
    }
  }

  return (
    <div className="management-content space-y-5">
      <section className="management-panel" aria-label="Managed agent execution">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <h2>Managed agents · local execution</h2>
              <p className="mt-1 text-ui-body text-muted-foreground">Review a saved project with an OpenAI-managed agent and a local executor.</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw aria-hidden="true" className={cn("size-3.5", loading && "animate-spin")} /> Refresh agents
          </Button>
        </div>
        <p className="mt-4 text-ui-body text-muted-foreground">
          OpenAI stores managed session data in the US. Zero Data Retention is unavailable, including with local execution.
          Use projects approved for this data handling. This reviewer has no write actions or attachments.
        </p>
        {loading && !catalog ? <p className="mt-3 text-ui-body" role="status">Loading managed agents…</p> : null}
        {catalog && !catalog.available ? (
          <div className="mt-4 rounded-lg border border-border bg-muted p-4" role="status">
            <h3>Managed agents are not configured</h3>
            <p className="mt-1 text-ui-body text-muted-foreground">{catalog.reason ?? "Ask your operator to configure the managed Agents API runtime and local executor."}</p>
          </div>
        ) : null}
        {loadErrors.length ? <div className="mt-3 space-y-1 text-ui-body text-destructive" role="alert">{loadErrors.map((error) => <p key={error}>{error}</p>)}</div> : null}
      </section>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(210px,280px)_minmax(0,1fr)]">
        <section className="management-panel self-start" aria-label="Your managed tasks">
          <div className="flex items-center justify-between gap-3">
            <h2>Your managed tasks</h2>
            <Button variant="ghost" size="icon" aria-label="New managed task" disabled={locked} onClick={() => chooseTask(null)}><Plus aria-hidden="true" className="size-4" /></Button>
          </div>
          {tasks.length ? (
            <ul className="mt-4 space-y-2">
              {tasks.map((entry) => (
                <li key={entry.id}>
                  <button type="button" aria-pressed={selectedId === entry.id} disabled={locked} onClick={() => chooseTask(entry.id)}
                    className={cn("w-full rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60", selectedId === entry.id ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted")}>
                    <span className="block break-words text-ui-control font-medium">{entry.title}</span>
                    <span className="mt-1 block text-ui-meta text-muted-foreground">{entry.projectName} · {entry.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 text-ui-body text-muted-foreground">{loading ? "Loading task history…" : "Your managed tasks will appear here."}</p>}
        </section>

        <section className="management-panel space-y-5" aria-label={selectedId ? "Managed task details" : "New managed task"}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2>{task?.title ?? (selectedId ? "Managed task" : "Start a repository review")}</h2>
              {task ? <p className="mt-1 text-ui-meta text-muted-foreground">{task.projectName} · Agent version {task.agentVersion} · <span role="status">{task.status}</span></p> : null}
              {task?.sourceRevision ? <p className="mt-1 text-ui-meta text-muted-foreground">Source commit <span className="font-mono" title={task.sourceRevision}>{task.sourceRevision.slice(0, 12)}</span> · Follow-ups use this snapshot</p> : null}
            </div>
            {selectedId ? <Button variant="ghost" size="sm" onClick={() => void refreshDetail(selectedId)}><RefreshCw aria-hidden="true" className="size-3.5" />Refresh output</Button> : <Bot className="size-5 text-muted-foreground" aria-hidden="true" />}
          </div>

          {!selectedId ? (
            <div className="space-y-4">
              <label className="block text-ui-control font-medium" htmlFor="managed-agent">Agent
                <select id="managed-agent" className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-ui-body" value={agentId} disabled={locked || !catalog?.available} onChange={(event) => setAgentId(event.target.value)}>
                  {!catalog?.agents.length ? <option value="">No available agents</option> : null}
                  {catalog?.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              {selectedAgent ? <p className="text-ui-body text-muted-foreground">{selectedAgent.description}</p> : null}
              <label className="block text-ui-control font-medium" htmlFor="managed-project">Saved project
                <select id="managed-project" className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-ui-body" value={projectId} disabled={locked || !catalog?.available} onChange={(event) => setProjectId(event.target.value)}>
                  {!projects.length ? <option value="">No available saved projects</option> : null}
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <p className="text-ui-body text-muted-foreground">The review uses a snapshot of the project’s committed HEAD. Uncommitted and untracked files are excluded. Follow-ups use the same snapshot; start a new review to inspect a newer revision.</p>
              {!projects.length && !loading ? <p className="text-ui-body text-muted-foreground">An administrator can register an available project in Projects.</p> : null}
            </div>
          ) : null}

          {detailLoading && !task ? <p className="flex items-center gap-2 text-ui-body" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading task output…</p> : null}
          {detailError ? <p className="text-ui-body text-destructive" role="alert">{detailError}</p> : null}
          {task ? (
            <>
              {task.error ? <p className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-ui-body text-destructive" role="alert">{task.error}</p> : null}
              <div aria-label="Managed task output" className="max-h-[600px] space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-4">
                {task.items.length ? task.items.map((item) => (
                  <article key={item.id} className="min-w-0 border-b border-border/60 pb-4 last:border-0 last:pb-0">
                    <p className="mb-2 text-ui-meta capitalize text-muted-foreground">{item.role}{item.subagentId ? " · Subagent" : ""} · {item.status.replaceAll("_", " ")}</p>
                    <div className="break-words text-ui-body [overflow-wrap:anywhere]">
                      {item.role === "assistant" ? <RichContentBoundary fallback={<p className="whitespace-pre-wrap">{item.text}</p>}><MessageResponse>{item.text}</MessageResponse></RichContentBoundary>
                        : <p className="whitespace-pre-wrap">{item.text}</p>}
                    </div>
                  </article>
                )) : <p className="text-ui-body text-muted-foreground">No recorded output yet.</p>}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-ui-meta text-muted-foreground">
                <p role="status">{streamStatus}</p>
                <p>{task.usage.reported ? `${task.usage.inputTokens.toLocaleString()} input · ${task.usage.outputTokens.toLocaleString()} output tokens` : "Token usage not reported"}</p>
              </div>
            </>
          ) : null}

          {!closed ? (
            <form onSubmit={submit} className="space-y-3">
              <label htmlFor="managed-message" className="block text-ui-control font-medium">{selectedId ? "Follow-up message" : "Review request"}</label>
              <Textarea id="managed-message" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={locked || starting || running || !catalog?.available || Boolean(selectedId && !task)} maxLength={messageLimit} rows={4} placeholder="Describe the code or behavior to review, and the findings you need." />
              {running || starting ? <p className="text-ui-meta text-muted-foreground">Wait for this turn to finish before sending a follow-up, or cancel it below.</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!canSend}>{busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{selectedId ? "Send follow-up" : "Start review"}</Button>
                {cancellable && task && selectedAgent?.capabilities.cancel ? <Button type="button" variant="outline" disabled={locked} onClick={() => void runMutation({ kind: "cancel", key: idempotencyKey(), taskId: task.id, turnId: task.turnId })}><Square aria-hidden="true" className="size-3.5" />Cancel turn</Button> : null}
              </div>
            </form>
          ) : <p className="text-ui-body text-muted-foreground">{task?.status === "deleted" ? "This remote session has been deleted and its local transcript cleared. Task metadata remains in the harness." : "The remote session is being deleted."}</p>}

          {mutationError ? <div className="space-y-3 rounded-lg border border-destructive/20 p-3" role="alert">
            <p className="text-ui-body text-destructive">{mutationError}</p>
            {pending && requiresReview ? <>
              <p className="text-ui-body text-muted-foreground">This operation will not be resent. Refresh the task and review its latest output before choosing a new action.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy || !selectedId} onClick={async () => {
                  if (!selectedId || busyRef.current) return;
                  busyRef.current = true; setBusy(true);
                  try { if (await refreshDetail(selectedId)) setHistoryRefreshed(true); }
                  finally { busyRef.current = false; if (mounted.current) setBusy(false); }
                }}>Refresh history</Button>
                <Button variant="outline" disabled={busy || !historyRefreshed} onClick={() => {
                  setPending(null); setRequiresReview(false); setHistoryRefreshed(false); setMutationError(null); setDraft("");
                }}>Continue after reviewing history</Button>
              </div>
            </> : pending ? <><p className="text-ui-body text-muted-foreground">The response was not confirmed. Retry with the same request key to recover its saved result. A closed operation will not be sent again.</p><Button variant="outline" disabled={busy} onClick={() => void runMutation(pending)}>Retry request</Button></> : null}
          </div> : null}

          {task && !closed ? <div className="border-t border-border pt-4"><Button variant="ghost" className="text-destructive" disabled={locked} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" className="size-3.5" />Delete remote session</Button></div> : null}
          {task?.status === "deleting" ? <Button variant="outline" disabled={locked} onClick={() => void runMutation({ kind: "delete", key: idempotencyKey(), taskId: task.id })}><Trash2 aria-hidden="true" className="size-3.5" />Retry session deletion</Button> : null}
        </section>
      </div>

      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!busy) setConfirmDelete(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this remote session?</DialogTitle>
            <DialogDescription>This ends the managed session and requests deletion of its stored session data from OpenAI. Deletion may take time. Its local transcript will be cleared; task metadata remains in the harness.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep session</Button>
            <Button variant="destructive" disabled={locked || !task} onClick={() => { if (task) void runMutation({ kind: "delete", key: idempotencyKey(), taskId: task.id }); }}>Delete session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
