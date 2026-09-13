import {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  DashboardPayload,
  ProviderConnection,
  SavedProjectSummary,
  ThreadSummary,
  TimelineItem,
} from "@agent-harness/contracts";
import { UPLOAD_MAX_BYTES } from "@agent-harness/contracts";
import { TaskProgress } from "./TaskProgress";
import { RichContentBoundary } from "@/components/RichContentBoundary";
import {
  Activity,
  Archive,
  ArrowUp,
  ArrowRight,
  BrainCircuit,
  ChevronRight,
  CircleDot,
  Code2,
  FileDiff,
  Files,
  GitFork,
  GitBranch,
  MessageSquareText,
  Sparkles,
  Search,
  FolderOpen,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Pencil,
  RotateCcw,
  Shield,
  ShieldAlert,
  Square,
  TerminalSquare,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiClientError, idempotencyKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  eventAge,
  type RuntimeStreamState,
} from "@/lib/runtime-stream";
import "@/workspace.css";

// Rich Markdown, diagram, and syntax-highlighting dependencies are intentionally
// below the workspace boundary. A cold Vite optimizer (or a stale optimized
// dependency after HMR) must not prevent the task frame and composer from
// becoming usable.
const MessageResponse = lazy(() =>
  import("@/components/ai-elements/message").then((module) => ({
    default: module.MessageResponse,
  })),
);
const Reasoning = lazy(() =>
  import("@/components/ai-elements/reasoning").then((module) => ({
    default: module.Reasoning,
  })),
);
const ReasoningContent = lazy(() =>
  import("@/components/ai-elements/reasoning").then((module) => ({
    default: module.ReasoningContent,
  })),
);
const ReasoningTrigger = lazy(() =>
  import("@/components/ai-elements/reasoning").then((module) => ({
    default: module.ReasoningTrigger,
  })),
);
const Tool = lazy(() =>
  import("@/components/ai-elements/tool").then((module) => ({
    default: module.Tool,
  })),
);
const ToolContent = lazy(() =>
  import("@/components/ai-elements/tool").then((module) => ({
    default: module.ToolContent,
  })),
);
const ToolHeader = lazy(() =>
  import("@/components/ai-elements/tool").then((module) => ({
    default: module.ToolHeader,
  })),
);
const ToolInput = lazy(() =>
  import("@/components/ai-elements/tool").then((module) => ({
    default: module.ToolInput,
  })),
);

interface WorkspaceViewProps {
  dashboard: DashboardPayload;
  activeThread: ThreadSummary | null;
  activeThreadId: string | null;
  draft: string;
  timeline: TimelineItem[];
  isSending: boolean;
  savedProjects: SavedProjectSummary[];
  savedProjectsLoading: boolean;
  savedProjectsError: string | null;
  selectedProjectId: string | null;
  activeTurnId: string | null;
  taskActionPending: "rename" | "fork" | "archive" | "interrupt" | null;
  onApproval: (
    item: TimelineItem,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ) => Promise<void>;
  onDraftChange: (draft: string) => void;
  onArchive: () => Promise<void>;
  onFork: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  onOpenSidebar: () => void;
  onReloadProjects: () => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onRetryRuntimeStream: () => void;
  onSelectProject: (projectId: string) => void;
  onSend: (message: string, uploadIds?: string[]) => Promise<void>;
  runtimeStream: RuntimeStreamState;
}

function providerLabel(provider: ProviderConnection | undefined): string {
  if (!provider) return "No model route";
  return provider.defaultModel || provider.name;
}

function toolState(status: TimelineItem["status"]) {
  if (status === "failed") return "output-error" as const;
  if (status === "completed") return "output-available" as const;
  if (status === "running") return "input-available" as const;
  return "input-streaming" as const;
}

const timelineKindLabels: Readonly<Record<TimelineItem["kind"], string>> = {
  user: "Request",
  assistant: "Agent response",
  reasoning: "Reasoning",
  command: "Command",
  file_change: "File change",
  approval: "Human attention",
  system: "Runtime event",
};

const timelineKindIcons = {
  user: UserRound,
  assistant: MessageSquareText,
  reasoning: BrainCircuit,
  command: TerminalSquare,
  file_change: FileDiff,
  approval: ShieldAlert,
  system: CircleDot,
} satisfies Readonly<Record<TimelineItem["kind"], typeof CircleDot>>;

const spineTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function conciseTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "";
  return spineTimeFormatter.format(date);
}

/**
 * Reports runtime event-stream liveness. The run itself is unaffected by a
 * dropped browser connection, so this is a status banner rather than an error:
 * it says what is still true on the server and offers a manual retry.
 */
function RuntimeStreamBanner({
  runtimeStream,
  onRetry,
}: {
  runtimeStream: RuntimeStreamState;
  onRetry: () => void;
}) {
  const degraded = runtimeStream.status === "reconnecting"
    || runtimeStream.status === "offline";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!degraded) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [degraded]);

  if (!degraded) return null;

  const offline = runtimeStream.status === "offline";
  const age = eventAge(runtimeStream.lastEventAt, now);
  const tone = offline ? "var(--c-fail)" : "var(--c-wait)";

  return (
    <div
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-4 py-1.5"
      role="status"
      style={{
        borderColor: offline ? "var(--c-fail-dim)" : "var(--c-wait-dim)",
        background: offline ? "var(--c-fail-dim)" : "var(--c-wait-dim)",
      }}
    >
      <svg
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", !offline && "ah-spin")}
        fill="none"
        viewBox="0 0 14 14"
      >
        <circle
          cx="7"
          cy="7"
          r="5"
          stroke={`color-mix(in oklab, ${tone} 25%, transparent)`}
          strokeWidth="1.6"
        />
        <path
          d="M7 2 A5 5 0 0 1 12 7"
          stroke={tone}
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      </svg>
      <p className="text-ui-control min-w-0 text-[var(--ink-1)]">
        <b className="font-semibold">
          {offline ? "Event stream disconnected" : "Event stream reconnecting"}
        </b>
        {" — "}
        {offline
          ? "this tab stopped retrying."
          : `attempt ${runtimeStream.attempt}.`}
        {" Completed events are preserved on the server; the run continues without you."}
      </p>
      <span className="text-ui-meta ml-auto shrink-0 text-[var(--ink-2)]">
        {age ? `last event ${age} ago` : "no events received yet"}
      </span>
      <Button
        className="h-6 shrink-0 px-2.5"
        onClick={onRetry}
        size="sm"
        style={{ borderColor: tone }}
        variant="outline"
      >
        Retry now
      </Button>
    </div>
  );
}

function SetupNotice({ dashboard, hasAvailableProject }: { dashboard: DashboardPayload; hasAvailableProject: boolean }) {
  const missingProvider = !dashboard.providers.some((provider) => provider.enabled);
  const missingProject = !hasAvailableProject;
  if (!missingProvider && !missingProject) return null;
  return (
    <div className="workspace-setup-note" role="status">
      <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
      <p>{missingProvider && missingProject
        ? "Connect a model and add a project in Settings to start your first task."
        : missingProvider
          ? "Connect a model in Settings to start your first task."
          : "Add a project in Settings to give your task a place to work."}</p>
    </div>
  );
}

function RunSpineNode({
  item,
  last,
  suppressHeader = false,
  children,
}: {
  item: TimelineItem;
  index: number;
  last: boolean;
  suppressHeader?: boolean;
  children: ReactNode;
}) {
  const Icon = timelineKindIcons[item.kind];
  const conversational = item.kind === "user" || item.kind === "assistant";
  const attention = item.kind === "approval" && item.status === "pending";
  return (
    <li
      className={cn("workspace-message", `workspace-message--${item.kind}`, last && "workspace-message--last")}
      id={`event-${item.id}`}
    >
      <div aria-hidden="true" className={cn("workspace-message-avatar", attention && "text-[var(--c-human)]")}>
        {item.kind === "assistant" ? <Sparkles className="size-4" /> : <Icon className="size-4" />}
      </div>
      <div className="min-w-0">
        {!suppressHeader ? (
          <div className="workspace-message-heading">
            <span>{item.kind === "user" ? "You" : item.kind === "assistant" ? "Onto" : item.title}</span>
            {conversational ? <time className="workspace-message-meta">{conciseTime(item.timestamp)}</time> : null}
            {!conversational && item.status ? (
              <span className={cn("workspace-message-meta", item.status === "failed" && "text-[var(--c-fail)]", attention && "text-[var(--c-human)]")}>
                {attention ? "Needs your approval" : item.status}
              </span>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </li>
  );
}

/**
 * Consecutive command events collapse into one spine node so a long tool
 * sequence does not bury the decisions around it. Grouping is presentation
 * only — every command keeps its own event, status and body underneath.
 */
type SpineGroup =
  | { kind: "item"; item: TimelineItem }
  | { kind: "commands"; items: TimelineItem[] };

function groupTimeline(items: readonly TimelineItem[]): SpineGroup[] {
  const groups: SpineGroup[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (item.kind !== "command") {
      groups.push({ kind: "item", item });
      continue;
    }
    if (previous?.kind === "commands") {
      previous.items.push(item);
      continue;
    }
    groups.push({ kind: "commands", items: [item] });
  }
  // A lone command reads better as itself than as a one-item sequence.
  return groups.map((group) =>
    group.kind === "commands" && group.items.length === 1
      ? { kind: "item", item: group.items[0]! }
      : group,
  );
}

function CommandCluster({ items }: { items: readonly TimelineItem[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((item) => item.status === "failed").length;
  const running = items.some((item) => item.status === "running" || item.status === "pending");

  return (
    <div className="mt-1.5">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--c-line)]"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0 text-[var(--ink-3)] transition-transform", open && "rotate-90")}
        />
        <span className="text-ui-control font-medium">Command sequence</span>
        <span className="text-ui-meta text-[var(--ink-3)]">
          {items.length} commands
        </span>
        <span
          className={cn(
            "text-ui-micro ml-auto shrink-0",
            failed ? "text-[var(--c-fail)]" : "text-[var(--c-verified)]",
          )}
        >
          {failed ? `${failed} failed` : running ? "In progress" : "Complete"}
        </span>
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          {items.map((item) => (
            <TimelineEntry item={item} key={item.id} last={false} onApproval={noopApproval} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Commands never carry an approval decision, so the cluster passes a no-op. */
const noopApproval: WorkspaceViewProps["onApproval"] = async () => undefined;

function TimelineEntry({
  item,
  last,
  onApproval,
}: {
  item: TimelineItem;
  last: boolean;
  onApproval: WorkspaceViewProps["onApproval"];
}) {
  if (item.kind === "user") {
    return (
      <div className="workspace-user-body text-ui-body">
        <RichContentBoundary fallback={<p className="whitespace-pre-wrap">{item.body}</p>}>
          <MessageResponse>{item.body}</MessageResponse>
        </RichContentBoundary>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="workspace-response text-ui-body text-[var(--ink-1)] [&_code]:rounded-[3px] [&_code]:bg-[var(--c-surface)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-ui-code [&_code]:text-[var(--ink-1)]">
        <RichContentBoundary fallback={<p className="whitespace-pre-wrap">{item.body}</p>}>
          <MessageResponse>{item.body}</MessageResponse>
        </RichContentBoundary>
      </div>
    );
  }

  if (item.kind === "reasoning") {
    return (
      <RichContentBoundary
        fallback={(
          <p className="mt-1.5 whitespace-pre-wrap text-ui-body text-[var(--ink-3)]">
            {item.body}
          </p>
        )}
      >
        <Reasoning isStreaming={item.status === "running"}>
          <ReasoningTrigger />
          <ReasoningContent>{item.body}</ReasoningContent>
        </Reasoning>
      </RichContentBoundary>
    );
  }

  if (item.kind === "command" || item.kind === "file_change") {
    return (
      <RichContentBoundary
        fallback={(
          <div className="mt-2 overflow-hidden rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)]">
            <p className="border-b border-[var(--c-hair)] px-3 py-2 text-ui-control font-medium text-[var(--ink-2)]">
              {item.title}
            </p>
            <pre className="font-mono overflow-x-auto whitespace-pre-wrap p-3 text-ui-code text-[var(--ink-3)]">
              {item.body}
            </pre>
          </div>
        )}
      >
        <Tool
          className="mt-2 overflow-hidden rounded-md border-[var(--c-hair)] bg-[var(--c-plate)]"
          defaultOpen={item.status === "running"}
        >
          <ToolHeader
            state={toolState(item.status)}
            title={item.title}
            toolName={item.kind === "command" ? "shell" : "file change"}
            type="dynamic-tool"
          />
          <ToolContent>
            {item.metadata ? <ToolInput input={item.metadata} /> : null}
            <pre className="font-mono overflow-x-auto whitespace-pre-wrap text-ui-code text-[var(--ink-3)]">
              {item.body}
            </pre>
          </ToolContent>
        </Tool>
      </RichContentBoundary>
    );
  }

  if (item.kind === "approval") {
    const waiting = item.status === "pending";
    return (
      <div className="mt-2 overflow-hidden rounded-lg border border-[var(--c-human)] bg-[var(--c-plate)] shadow-[var(--e-urgent)]">
        <div className="flex items-start gap-3 border-b border-[var(--c-hair)] px-3.5 py-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[var(--c-human-dim)] text-[var(--c-human)]">
            <ShieldAlert className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-control font-semibold text-[var(--ink-1)]">Approval required</p>
              <span className="rounded-[3px] border border-[var(--c-human-dim)] bg-[var(--c-human-dim)] px-1.5 py-0.5 text-ui-micro text-[var(--c-human)]">
                {waiting ? "Needs you" : item.status}
              </span>
            </div>
            <p className="mt-1 text-ui-meta text-[var(--ink-3)]">
              {item.title}
            </p>
          </div>
        </div>
        <p className="whitespace-pre-wrap px-3.5 py-3 text-ui-body text-[var(--ink-2)]">{item.body}</p>
        <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
          <Button
            className="h-9 rounded-lg bg-primary px-4 text-ui-control font-semibold text-primary-foreground hover:bg-primary/90"
            disabled={!waiting}
            onClick={() => void onApproval(item, "accept")}
            size="sm"
          >
            Approve once
          </Button>
          <Button
            className="h-9 rounded-lg border-[var(--c-line)] px-3 text-ui-control"
            disabled={!waiting}
            onClick={() => void onApproval(item, "acceptForSession")}
            size="sm"
            variant="outline"
          >
            Approve for this session
          </Button>
          <Button
            className="h-9 rounded-lg px-3 text-ui-control"
            disabled={!waiting}
            onClick={() => void onApproval(item, "decline")}
            size="sm"
            variant="ghost"
          >
            Deny
          </Button>
        </div>
        <p className="px-3.5 pb-3 text-ui-meta text-[var(--ink-3)]">
          Approve only if you are comfortable with the requested action.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("mt-2 rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)] px-3 py-2.5", last && "mb-0")}>
      <p className="whitespace-pre-wrap text-ui-body text-[var(--ink-3)]">{item.body}</p>
    </div>
  );
}

function ParallelBranch({ threads }: { threads: readonly ThreadSummary[] }) {
  if (!threads.length) return null;
  return (
    <li className="workspace-message workspace-message--branches">
      <div aria-hidden="true" className="workspace-message-avatar"><GitFork className="size-4" /></div>
      <div className="min-w-0">
        <div className="workspace-message-heading"><span>Related agents</span><span className="workspace-message-meta">{threads.length} task{threads.length === 1 ? "" : "s"}</span></div>
        <div className="mt-3 space-y-2">
          {threads.map((thread) => (
            <div className="rounded-xl border border-border bg-card px-4 py-3" key={thread.id}>
              <div className="flex items-center gap-2">
                <span className={cn("size-1.5 shrink-0 rounded-full", thread.status === "running" ? "bg-[var(--c-run)]" : "bg-muted-foreground")} />
                <span className="min-w-0 flex-1 truncate text-ui-control font-medium">{thread.agentNickname ?? thread.title}</span>
                <span className="text-ui-meta text-muted-foreground">{thread.status}</span>
              </div>
              {thread.preview ? <p className="mt-1.5 line-clamp-2 text-ui-control text-muted-foreground">{thread.preview}</p> : null}
            </div>
          ))}
        </div>
      </div>
    </li>
  );
}

function InspectorEmpty({ icon: Icon, title, children }: { icon: typeof Files; title: string; children: ReactNode }) {
  return (
    <div className="workspace-inspector-empty">
      <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="mt-4 text-ui-control font-medium">{title}</p>
      <p className="mt-1.5 text-ui-control text-muted-foreground">{children}</p>
    </div>
  );
}

function InspectorTabs({ dashboard, activeThread, timeline }: Pick<WorkspaceViewProps, "dashboard" | "activeThread" | "timeline">) {
  const project = dashboard.projects.find((candidate) => candidate.id === activeThread?.projectId);
  const fileChanges = timeline.filter((item) => item.kind === "file_change");
  const childAgents = dashboard.threads.filter((thread) => activeThread && thread.parentThreadId === activeThread.id);
  return (
    <Tabs className="flex min-h-0 flex-1 flex-col gap-0" defaultValue="files">
      <TabsList aria-label="Task inspector" className="workspace-inspector-tabs">
        <TabsTrigger value="files">Files{fileChanges.length ? <span className="ml-1 text-ui-meta">{fileChanges.length}</span> : null}</TabsTrigger>
        <TabsTrigger value="context">Context</TabsTrigger>
        <TabsTrigger value="agents">Agents</TabsTrigger>
        <TabsTrigger value="events">Activity</TabsTrigger>
      </TabsList>
      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-5" value="files">
        {fileChanges.length ? (
          <div className="space-y-3">
            <p className="text-ui-meta text-muted-foreground">{fileChanges.length} reported change{fileChanges.length === 1 ? "" : "s"}</p>
            {fileChanges.map((change) => (
              <details className="workspace-file-detail" key={change.id}>
                <summary><FileDiff aria-hidden="true" className="size-4 shrink-0" /><span className="min-w-0 break-all font-mono text-ui-code">{change.title}</span><ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0" /></summary>
                <pre className="overflow-x-auto whitespace-pre-wrap border-t border-border p-3 font-mono text-ui-code text-muted-foreground">{change.body || "No change details were included in this event."}</pre>
              </details>
            ))}
          </div>
        ) : <InspectorEmpty icon={Files} title="No file changes reported">Files changed during this task will appear here.</InspectorEmpty>}
      </TabsContent>
      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-5" value="context">
        <div className="workspace-context-sections">
          <section>
            <h3>Project</h3>
            <p className="text-ui-control font-medium">{project?.name ?? activeThread?.projectName ?? "No project selected"}</p>
            {project?.branch ? <p className="mt-2 flex items-center gap-2 font-mono text-ui-code text-muted-foreground"><GitBranch className="size-3.5" />{project.branch}</p> : null}
            {project?.path ? <p className="mt-2 break-all font-mono text-ui-code text-muted-foreground">{project.path}</p> : null}
          </section>
          <section>
            <h3>Model</h3>
            <p className="text-ui-control">{activeThread?.model || "Selected by your workspace settings"}</p>
            {activeThread?.reasoningEffort ? <p className="mt-1 text-ui-meta text-muted-foreground">Reasoning effort: {activeThread.reasoningEffort}</p> : null}
          </section>
          <section>
            <h3>Permissions</h3>
            <p className="text-ui-control text-muted-foreground">Permissions are managed by the server. Requests that need your approval appear in the conversation.</p>
          </section>
          <section>
            <h3>Runtime</h3>
            <p className="flex items-center gap-2 text-ui-control"><span className={cn("size-1.5 rounded-full", dashboard.runtime.status === "ready" ? "bg-[var(--c-run)]" : "bg-[var(--c-wait)]")} />{dashboard.runtime.status}</p>
            {dashboard.runtime.message ? <p className="mt-2 text-ui-control text-muted-foreground">{dashboard.runtime.message}</p> : null}
          </section>
          <section>
            <h3>Workspace usage this period</h3>
            <dl className="workspace-context-facts">
              <div><dt>Requests</dt><dd>{dashboard.usage.requestsUsed.toLocaleString()} / {dashboard.usage.requestLimit.toLocaleString()}</dd></div>
              <div><dt>Input tokens</dt><dd>{dashboard.usage.inputTokens.toLocaleString()}</dd></div>
              <div><dt>Output tokens</dt><dd>{dashboard.usage.outputTokens.toLocaleString()}</dd></div>
            </dl>
            <p className="mt-3 text-ui-meta text-muted-foreground">Totals include all tasks in your workspace.</p>
          </section>
        </div>
      </TabsContent>
      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-5" value="agents">
        {childAgents.length ? (
          <div className="space-y-3">{childAgents.map((agent) => (
            <div className="rounded-xl border border-border p-4" key={agent.id}>
              <p className="text-ui-control font-medium">{agent.agentNickname ?? agent.title}</p>
              <p className="mt-1.5 text-ui-meta text-muted-foreground">{agent.agentRole ?? agent.model} · {agent.status}</p>
              {agent.preview ? <p className="mt-2 text-ui-control text-muted-foreground">{agent.preview}</p> : null}
            </div>
          ))}</div>
        ) : <InspectorEmpty icon={UsersRound} title="No child agents reported">Agents started by this task will appear here.</InspectorEmpty>}
      </TabsContent>
      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-5" value="events">
        {timeline.length ? (
          <ol className="workspace-event-list" aria-label="Recent run events">
            {timeline.slice(-30).map((item) => (
              <li key={item.id}>
                <span aria-hidden="true" className={cn("mt-2 size-1.5 shrink-0 rounded-full", item.status === "failed" ? "bg-[var(--c-fail)]" : item.kind === "approval" ? "bg-[var(--c-human)]" : "bg-muted-foreground")} />
                <div className="min-w-0 flex-1"><p className="break-words text-ui-control font-medium">{item.title}</p><p className="mt-1 text-ui-meta text-muted-foreground">{timelineKindLabels[item.kind]}{item.status ? ` · ${item.status}` : ""}</p></div>
                <time className="shrink-0 text-ui-meta text-muted-foreground">{conciseTime(item.timestamp)}</time>
              </li>
            ))}
          </ol>
        ) : <InspectorEmpty icon={Activity} title="No activity yet">Task activity will appear here as it happens.</InspectorEmpty>}
      </TabsContent>
    </Tabs>
  );
}

function TaskInspector({ dashboard, activeThread, timeline, open, onOpenChange }: Pick<WorkspaceViewProps, "dashboard" | "activeThread" | "timeline"> & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1180px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1180px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  if (wide) {
    return open ? (
      <aside aria-label="Task inspector" className="workspace-inspector">
        <div className="workspace-inspector-heading"><h2>Task inspector</h2><Button aria-label="Close task inspector" onClick={() => onOpenChange(false)} size="icon-sm" variant="ghost"><X className="size-4" /></Button></div>
        <InspectorTabs activeThread={activeThread} dashboard={dashboard} timeline={timeline} />
      </aside>
    ) : null;
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="workspace-inspector-dialog bottom-0 left-auto right-0 top-0 h-dvh max-h-none w-[min(94vw,400px)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-r-0 bg-card p-0 sm:rounded-none">
        <DialogHeader className="border-b border-border px-5 py-5 text-left"><DialogTitle className="text-ui-control">Task inspector</DialogTitle><DialogDescription className="sr-only">Files, context, agents, and activity for this task.</DialogDescription></DialogHeader>
        <InspectorTabs activeThread={activeThread} dashboard={dashboard} timeline={timeline} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * File types the composer offers in the OS picker. The server never trusts a
 * client-declared type — it sniffs the bytes and stores only its own
 * classification — so this list is a convenience filter, not a control.
 */
const UPLOAD_ACCEPT = ".txt,.md,.csv,.tsv,.json,.ndjson,.xml,text/*,application/json";

/** The server's `attachments` array is `z.array(...).max(4)` on `turn/start`. */
const MAX_COMPOSER_ATTACHMENTS = 4;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

/**
 * One composer attachment paired with the real `File` the browser handed us.
 *
 * `PromptInput` keeps only a `FileUIPart` (filename, media type, and a blob
 * URL) for each attachment, so the bytes have to be captured from the DOM event
 * that produced them. `file` is null when that pairing failed; such an entry is
 * reported as a failed upload rather than silently dropped.
 */
interface ComposerAttachment {
  id: string;
  filename: string;
  file: File | null;
}

type ComposerUploadState = "uploading" | "stored" | "failed";

interface ComposerUpload {
  state: ComposerUploadState;
  /** Server-issued upload id. Only a `"stored"` entry has one, and only ids are sent. */
  uploadId?: string;
  /** 0…1, driven by `XMLHttpRequest.upload.onprogress`. */
  progress: number;
  error?: string;
  errorCode?: string;
  filename: string;
  sizeBytes: number;
  file: File | null;
  /** Retrying reuses this key so the server replays instead of storing twice. */
  requestKey: string;
  target: { kind: "task" | "project"; id: string } | null;
  controller: AbortController;
}

/**
 * The attach control, and the only place that learns which real `File` belongs
 * to which `PromptInput` attachment id.
 *
 * `usePromptInputAttachments` has to run inside the `PromptInput` subtree, which
 * is why this is a component rather than a hook call in `WorkspaceView`.
 *
 * Capture works because a listener on the element itself runs before React's
 * delegated listener on the root container: the handler reads the `File`s off
 * the DOM event, and `PromptInput`'s own handler then validates them against
 * `accept` / `maxFiles` / `maxFileSize` and appends the parts. The effect below
 * pairs each newly appended part with a captured file of the same name and
 * media type. Every capture replaces the queue, so a file `PromptInput` rejected
 * can never be paired with a later attachment.
 */
function ComposerAttachControl({
  disabled,
  projectToken,
  resetToken,
  tooltip,
  onAttach,
  onDetach,
}: {
  disabled: boolean;
  /** Attachments belong to one task; a move between existing tasks drops them. */
  resetToken: string | null;
  /** Project-scoped uploads must also be dropped when a new task changes project. */
  projectToken: string | null;
  tooltip: string;
  onAttach: (attachments: ComposerAttachment[]) => void;
  onDetach: (attachmentId: string) => void;
}) {
  const attachments = usePromptInputAttachments();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const pickedRef = useRef<File[]>([]);
  const knownRef = useRef<Set<string>>(new Set());
  const resetTokenRef = useRef(resetToken);
  const projectTokenRef = useRef(projectToken);
  const onAttachRef = useRef(onAttach);
  const onDetachRef = useRef(onDetach);
  const { clear, fileInputRef, files, openFileDialog } = attachments;

  useEffect(() => {
    onAttachRef.current = onAttach;
    onDetachRef.current = onDetach;
  }, [onAttach, onDetach]);

  useEffect(() => {
    const previousThread = resetTokenRef.current;
    const previousProject = projectTokenRef.current;
    resetTokenRef.current = resetToken;
    projectTokenRef.current = projectToken;
    // `null -> id` is this composer's own new task becoming real, so its
    // project-scoped attachments stay attachable to the thread that just
    // appeared. A project change while both sides are still a new task is a
    // different target and must clear the project-scoped attachments.
    const movedBetweenTasks = previousThread !== null && previousThread !== resetToken;
    const changedNewTaskProject =
      previousThread === null
      && resetToken === null
      && previousProject !== projectToken;
    if (movedBetweenTasks || changedNewTaskProject) clear();
  }, [clear, projectToken, resetToken]);

  useEffect(() => {
    const input = fileInputRef.current;
    const form = anchorRef.current?.closest("form") ?? null;
    const capture = (picked: File[]) => {
      if (picked.length > 0) pickedRef.current = picked;
    };
    const onChange = (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      capture(target?.files ? [...target.files] : []);
    };
    const onDrop = (event: Event) => {
      const transferred = (event as DragEvent).dataTransfer?.files;
      capture(transferred ? [...transferred] : []);
    };
    const onPaste = (event: Event) => {
      const items = (event as ClipboardEvent).clipboardData?.items;
      if (!items) return;
      const picked: File[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) picked.push(file);
      }
      capture(picked);
    };

    input?.addEventListener("change", onChange, true);
    form?.addEventListener("drop", onDrop, true);
    form?.addEventListener("paste", onPaste, true);
    return () => {
      input?.removeEventListener("change", onChange, true);
      form?.removeEventListener("drop", onDrop, true);
      form?.removeEventListener("paste", onPaste, true);
    };
  }, [fileInputRef]);

  useEffect(() => {
    const known = knownRef.current;
    const present = new Set(files.map((part) => part.id));
    for (const id of [...known]) {
      if (present.has(id)) continue;
      known.delete(id);
      onDetachRef.current(id);
    }

    const queue = pickedRef.current;
    const added: ComposerAttachment[] = [];
    for (const part of files) {
      if (known.has(part.id)) continue;
      known.add(part.id);
      const filename = part.filename ?? "attachment";
      const index = queue.findIndex(
        (candidate) => candidate.name === filename && candidate.type === part.mediaType,
      );
      const file = index >= 0 ? queue.splice(index, 1)[0] ?? null : null;
      added.push({ file, filename, id: part.id });
    }
    if (added.length > 0) onAttachRef.current(added);
  }, [files]);

  return (
    <>
      <span aria-hidden="true" className="hidden" ref={anchorRef} />
      <PromptInputButton
        aria-label="Attach context"
        className="h-[26px] border border-[var(--c-hair)] px-2 text-[var(--ink-3)]"
        disabled={disabled}
        onClick={() => openFileDialog()}
        tooltip={tooltip}
      >
        <Paperclip className="size-3.5" />
      </PromptInputButton>
    </>
  );
}

/**
 * Chips for the composer's attachments. Reads the attachment list from
 * `PromptInput` and the per-upload state from `WorkspaceView`, so a chip always
 * reports what the control plane actually knows about that file.
 */
function ComposerAttachmentTray({
  disabled,
  uploads,
  onRetry,
}: {
  disabled: boolean;
  uploads: Map<string, ComposerUpload>;
  onRetry: (attachmentId: string) => void;
}) {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;

  return (
    <div
      className="flex flex-wrap gap-2 border-t border-[var(--c-hair)] px-3 py-2"
      data-slot="composer-attachments"
    >
      {attachments.files.map((part) => {
        const filename = part.filename ?? "attachment";
        const upload = uploads.get(part.id);
        const state = upload?.state ?? "uploading";
        return (
          <div className="min-w-0 max-w-[248px]" key={part.id}>
            <Badge
              className={cn(
                "flex h-6 w-full items-center gap-1.5 border-[var(--c-hair)] bg-[var(--c-plate)] px-1.5 font-normal text-[var(--ink-2)]",
                state === "failed" && "border-[var(--c-fail)] text-[var(--c-fail)]",
              )}
              variant="outline"
            >
              {state === "uploading" ? (
                <Spinner aria-label={`Uploading ${filename}`} className="size-3 shrink-0" />
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 flex-1 truncate">{filename}</span>
                </TooltipTrigger>
                <TooltipContent>{filename}</TooltipContent>
              </Tooltip>
              <span className="text-ui-micro shrink-0 text-[var(--ink-4)]">
                {formatBytes(upload?.sizeBytes ?? 0)}
              </span>
              <Button
                aria-label={`Remove ${filename}`}
                className="size-4 shrink-0 rounded-sm p-0 text-[var(--ink-4)] hover:text-[var(--ink-1)]"
                disabled={disabled}
                onClick={() => attachments.remove(part.id)}
                type="button"
                variant="ghost"
              >
                <X className="size-3" />
              </Button>
            </Badge>
            {state === "uploading" ? (
              <div
                aria-hidden="true"
                className="mt-1 h-[3px] w-full rounded-full bg-[var(--c-line)]"
                data-slot="upload-progress"
              >
                <span
                  className="block h-full rounded-full bg-[var(--c-wait)]"
                  style={{ width: `${Math.round((upload?.progress ?? 0) * 100)}%` }}
                />
              </div>
            ) : null}
            {state === "failed" ? (
              <p
                className="text-ui-meta mt-1 flex items-center gap-1.5 text-[var(--c-fail)]"
                role="status"
              >
                <span className="shrink-0">{upload?.errorCode ?? "upload_failed"}</span>
                <span className="min-w-0 flex-1 truncate">{upload?.error}</span>
                {upload?.file && upload.target ? (
                  <Button
                    aria-label={`Retry ${filename}`}
                    className="size-4 shrink-0 rounded-sm p-0 text-[var(--c-fail)]"
                    disabled={disabled}
                    onClick={() => onRetry(part.id)}
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw className="size-3" />
                  </Button>
                ) : null}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function WorkspaceView({
  dashboard,
  activeThread,
  activeThreadId,
  activeTurnId,
  draft,
  timeline,
  isSending,
  savedProjects,
  savedProjectsLoading,
  savedProjectsError,
  selectedProjectId,
  taskActionPending,
  onApproval,
  onArchive,
  onDraftChange,
  onFork,
  onInterrupt,
  onReloadProjects,
  onRename,
  onRetryRuntimeStream,
  onSelectProject,
  onSend,
  runtimeStream,
}: WorkspaceViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Map<string, ComposerUpload>>(() => new Map());
  const uploadsRef = useRef(uploads);
  const uploadTargetRef = useRef<ComposerUpload["target"]>(null);
  const previousThreadIdRef = useRef(activeThreadId);
  const previousProjectIdRef = useRef(selectedProjectId);
  /** Uploads in this set were accepted by turn/start and must remain durable. */
  const handedOffUploadIdsRef = useRef<Set<string>>(new Set());
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const activeProvider = dashboard.providers.find((provider) => provider.isDefault && provider.enabled)
    ?? dashboard.providers.find((provider) => provider.enabled);
  const hasActiveTask = activeThreadId !== null || timeline.length > 0;
  const spineGroups = useMemo(() => groupTimeline(timeline), [timeline]);
  const taskTitle = activeThread?.title ?? "New task";
  const status = timeline.some((item) => item.kind === "approval" && item.status === "pending") ? "waiting" : activeThread?.status === "waiting" ? "waiting" : activeTurnId ? "running" : activeThread?.status ?? (isSending ? "running" : "idle");
  const pendingApproval = timeline.findLast(
    (item) => item.kind === "approval" && item.status === "pending",
  );
  const availableSavedProjects = useMemo(
    () => savedProjects.filter(
      (project) => project.enabled && project.availability === "available",
    ),
    [savedProjects],
  );
  const selectedSavedProject = availableSavedProjects.find(
    (project) => project.id === selectedProjectId,
  ) ?? null;
  const taskProject = activeThreadId
    ? dashboard.projects.find((candidate) => candidate.id === activeThread?.projectId)
    : selectedSavedProject;
  const childThreads = activeThread
    ? dashboard.threads.filter((thread) => thread.parentThreadId === activeThread.id)
    : [];

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeThreadId]);


  // A file is uploaded the moment it is attached, against the thread when one
  // exists and against the saved project otherwise — the project-scoped row is
  // claimed by the first turn after `createTask` returns a thread.
  const uploadTarget: ComposerUpload["target"] = activeThreadId
    ? { id: activeThreadId, kind: "task" }
    : selectedSavedProject
      ? { id: selectedSavedProject.id, kind: "project" }
      : null;

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(() => {
    uploadTargetRef.current = uploadTarget;
  });

  const discardUpload = useCallback((entry: ComposerUpload) => {
    entry.controller.abort();
    if (entry.state !== "stored" || !entry.uploadId) return;
    // PromptInput clears its chips after a successful turn/start. That clear is
    // local UI cleanup, not a user request to delete bytes the turn now owns.
    if (handedOffUploadIdsRef.current.delete(entry.uploadId)) return;
    void api.deleteUpload(entry.uploadId).catch(() => {
      // The durable retention janitor remains the backstop when a best-effort
      // composer cleanup cannot reach the control plane.
    });
  }, []);

  const discardAllUploads = useCallback(() => {
    if (uploadsRef.current.size === 0) return;
    for (const entry of uploadsRef.current.values()) discardUpload(entry);
    uploadsRef.current = new Map();
    setUploads(new Map());
  }, [discardUpload]);

  // Uploads are bound to one thread (or to the project that will become one).
  // Moving between existing tasks abandons them rather than offering one task's
  // ids to another; `null -> id` is this composer's own task being created, so
  // its project-scoped uploads survive to be claimed by the first turn.
  useEffect(() => {
    const previous = previousThreadIdRef.current;
    previousThreadIdRef.current = activeThreadId;
    if (previous === null || previous === activeThreadId) return;
    discardAllUploads();
  }, [activeThreadId, discardAllUploads]);

  useEffect(() => {
    const previous = previousProjectIdRef.current;
    previousProjectIdRef.current = selectedProjectId;
    // Once a thread exists its binding, not the project picker, owns the upload
    // target. While composing a new task, however, changing projects changes
    // the workspace in which every project-scoped upload may be claimed.
    if (activeThreadId !== null || previous === selectedProjectId) return;
    discardAllUploads();
  }, [activeThreadId, discardAllUploads, selectedProjectId]);

  const patchUpload = useCallback((attachmentId: string, patch: Partial<ComposerUpload>) => {
    const referenced = uploadsRef.current.get(attachmentId);
    if (referenced) {
      const next = new Map(uploadsRef.current);
      next.set(attachmentId, { ...referenced, ...patch });
      uploadsRef.current = next;
    }
    setUploads((current) => {
      const entry = current.get(attachmentId);
      if (!entry) return current;
      const next = new Map(current);
      next.set(attachmentId, { ...entry, ...patch });
      return next;
    });
  }, []);

  const runUpload = useCallback(
    (attachmentId: string, entry: ComposerUpload) => {
      const { controller, file, requestKey, target } = entry;
      if (!file || !target) return;
      const onProgress = (fraction: number) => patchUpload(attachmentId, { progress: fraction });
      const request = target.kind === "task"
        ? api.uploadToTask(target.id, file, onProgress, requestKey, controller.signal)
        : api.uploadToProject(target.id, file, onProgress, requestKey, controller.signal);

      void request.then(
        (payload) =>
          patchUpload(attachmentId, {
            error: undefined,
            errorCode: undefined,
            progress: 1,
            state: "stored",
            uploadId: payload.upload.id,
          }),
        (cause: unknown) => {
          // A removed chip aborts its own request; that is not a failure to report.
          if (cause instanceof ApiClientError && cause.code === "upload_aborted") return;
          patchUpload(attachmentId, {
            error: cause instanceof Error ? cause.message : "The upload was rejected.",
            errorCode: cause instanceof ApiClientError ? cause.code : "upload_failed",
            state: "failed",
          });
        },
      );
    },
    [patchUpload],
  );

  const attachUploads = useCallback(
    (added: ComposerAttachment[]) => {
      // The notice is deliberately not cleared here: `PromptInput` reports
      // `max_files` while still accepting the files under the cap, and that
      // warning has to survive the accepted subset. Typing or sending clears it.
      const target = uploadTargetRef.current;
      const created = added.map<[string, ComposerUpload]>((attachment) => {
        const entry: ComposerUpload = {
          controller: new AbortController(),
          file: attachment.file,
          filename: attachment.filename,
          progress: 0,
          requestKey: idempotencyKey(),
          sizeBytes: attachment.file?.size ?? 0,
          state: "uploading",
          target,
        };
        if (!attachment.file) {
          return [attachment.id, {
            ...entry,
            error: "The browser did not hand this file to the composer.",
            errorCode: "attachment_unreadable",
            state: "failed",
          }];
        }
        if (!target) {
          return [attachment.id, {
            ...entry,
            error: "Choose an available saved project before attaching a file.",
            errorCode: "no_upload_target",
            state: "failed",
          }];
        }
        return [attachment.id, entry];
      });

      const referenced = new Map(uploadsRef.current);
      for (const [attachmentId, entry] of created) referenced.set(attachmentId, entry);
      uploadsRef.current = referenced;
      setUploads((current) => {
        const next = new Map(current);
        for (const [attachmentId, entry] of created) next.set(attachmentId, entry);
        return next;
      });
      for (const [attachmentId, entry] of created) {
        if (entry.state === "uploading") runUpload(attachmentId, entry);
      }
    },
    [runUpload],
  );

  const detachUpload = useCallback((attachmentId: string) => {
    const entry = uploadsRef.current.get(attachmentId);
    if (!entry) return;
    discardUpload(entry);
    const next = new Map(uploadsRef.current);
    next.delete(attachmentId);
    uploadsRef.current = next;
    setUploads(next);
  }, [discardUpload]);

  const retryUpload = useCallback(
    (attachmentId: string) => {
      const entry = uploadsRef.current.get(attachmentId);
      if (!entry?.file || !entry.target) return;
      // Same idempotency key: the server replays the original summary instead of
      // storing the bytes twice.
      const retried: ComposerUpload = {
        ...entry,
        controller: new AbortController(),
        error: undefined,
        errorCode: undefined,
        progress: 0,
        state: "uploading",
      };
      const referenced = new Map(uploadsRef.current);
      referenced.set(attachmentId, retried);
      uploadsRef.current = referenced;
      setUploads((current) => {
        if (!current.has(attachmentId)) return current;
        const next = new Map(current);
        next.set(attachmentId, retried);
        return next;
      });
      runUpload(attachmentId, retried);
    },
    [runUpload],
  );

  const handleAttachmentError = useCallback(
    (failure: { code: "max_files" | "max_file_size" | "accept"; message: string }) => {
      setAttachmentNotice(
        failure.code === "max_files"
          ? `Attach at most ${MAX_COMPOSER_ATTACHMENTS} files to one turn.`
          : failure.code === "max_file_size"
            ? `Each file must be ${formatBytes(UPLOAD_MAX_BYTES)} or smaller.`
            : "Attach UTF-8 text files — .txt, .md, .csv, .tsv, .json, .ndjson, or .xml.",
      );
    },
    [],
  );

  const uploadEntries = [...uploads.values()];
  const attachmentsUploading = uploadEntries.some((entry) => entry.state === "uploading");
  const storedUploadIds = uploadEntries.flatMap((entry) =>
    entry.state === "stored" && entry.uploadId ? [entry.uploadId] : [],
  );

  async function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    // This PromptInput opts out of data-URL conversion below: the bytes are
    // already in the control plane and the turn carries opaque upload ids.
    if (
      !text
      || isSending
      || attachmentsUploading
      || (activeTurnId !== null && storedUploadIds.length > 0)
    ) return;
    setAttachmentNotice(null);
    await onSend(text, storedUploadIds.length > 0 ? storedUploadIds : undefined);
    // Mark synchronously, before PromptInput observes this promise resolving
    // and clears its chips. Their ensuing onDetach callbacks must not delete
    // uploads that the successful turn now owns.
    for (const uploadId of storedUploadIds) handedOffUploadIdsRef.current.add(uploadId);
    onDraftChange("");
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = renameValue.trim();
    if (!name || taskActionPending) return;
    setActionError(null);
    try {
      await onRename(name);
      setRenameOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The task could not be renamed.");
    }
  }

  async function confirmArchive() {
    if (taskActionPending) return;
    setActionError(null);
    try {
      await onArchive();
      setArchiveOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The task could not be archived.");
    }
  }

  return (
    <div className="workspace-view flex min-h-0 min-w-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" id="main-content" tabIndex={-1}>
        <header className="workspace-task-header">
          <div className="workspace-task-heading-row">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="workspace-task-title" ref={headingRef} tabIndex={-1}>{taskTitle}</h1>
                {hasActiveTask ? <span className={cn("workspace-task-status", status === "running" && "text-[var(--c-run)]", status === "failed" && "text-[var(--c-fail)]")}><span className={cn("size-1.5 rounded-full bg-current", status === "running" && "running-dot")} />{status}</span> : null}
              </div>
              {hasActiveTask && taskProject ? <p className="workspace-task-project"><FolderOpen className="size-3.5 shrink-0" /><span className="min-w-0 truncate" title={taskProject.name}>{taskProject.name}</span>{taskProject.branch ? <><span aria-hidden="true" className="shrink-0">/</span><span className="min-w-0 truncate font-mono text-ui-code" title={taskProject.branch}>{taskProject.branch}</span></> : null}</p> : null}
            </div>
            {pendingApproval ? <Button aria-label="Go to pending approval" className="workspace-approval-shortcut" onClick={() => document.getElementById(`event-${pendingApproval.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} size="sm" variant="outline"><ShieldAlert className="size-4" /><span className="hidden sm:inline">Approval needed</span></Button> : null}
            {activeThreadId ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button aria-label="Task actions" disabled={taskActionPending !== null} size="icon-sm" variant="ghost"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {activeTurnId ? <DropdownMenuItem onSelect={() => void onInterrupt().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The turn could not be interrupted."))}><Square className="fill-current" />Interrupt turn</DropdownMenuItem> : null}
                  <DropdownMenuItem onSelect={() => { setActionError(null); setRenameValue(activeThread?.title ?? ""); setRenameOpen(true); }}><Pencil />Rename task</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void onFork().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The task could not be forked."))}><GitFork />Fork task</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => { setActionError(null); setArchiveOpen(true); }}><Archive />Archive task</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {hasActiveTask ? <Button aria-label={inspectorOpen ? "Close task inspector" : "Open task inspector"} aria-expanded={inspectorOpen} className={cn("shrink-0", inspectorOpen && "bg-muted")} onClick={() => setInspectorOpen((open) => !open)} size="icon-sm" variant="ghost"><PanelRight className="size-4" /></Button> : null}
          </div>
          <RuntimeStreamBanner onRetry={onRetryRuntimeStream} runtimeStream={runtimeStream} />
        </header>

        {actionError ? <div className="workspace-error-banner" role="alert">{actionError}</div> : null}
        <div aria-atomic="true" aria-live="polite" className="sr-only">
          {isSending ? "Sending request…" : pendingApproval ? `${pendingApproval.title}. Waiting for your decision.` : dashboard.runtime.status === "degraded" ? `Runtime needs attention. ${dashboard.runtime.message ?? ""}` : ""}
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className={cn("workspace-main-column", !hasActiveTask && "workspace-main-column--welcome")}>
            {!hasActiveTask ? (
              <div className="workspace-welcome">
                <div aria-hidden="true" className="workspace-welcome-mark"><Sparkles className="size-7" strokeWidth={1.4} /></div>
                <h2>What would you like<br className="sm:hidden" /> to work on?</h2>
                <p>Bring an idea, a question, or a task.<br className="sm:hidden" /> Let's make progress.</p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden">
                <Conversation aria-label="Run Spine activity" aria-live="off" className="h-full min-h-0">
                  <ConversationContent className="workspace-conversation mx-auto w-full max-w-[820px] gap-0 px-5 pb-8 pt-8 sm:px-8" scrollClassName="overflow-y-auto overscroll-contain">
                    {!timeline.length ? <div className="workspace-transcript-empty"><MessageSquareText aria-hidden="true" className="size-6 text-muted-foreground" /><p className="mt-4 text-ui-control font-medium">No run events in this snapshot</p><p className="mt-2 max-w-md text-ui-body text-muted-foreground">New activity will appear here. Earlier messages are not included in this task snapshot.</p></div> : null}
                    <ol aria-label="Run Spine" className="m-0 list-none p-0">
                      {spineGroups.map((group, index) => {
                        const last = index === spineGroups.length - 1 && !activeTurnId;
                        const deferOffscreenEntry = spineGroups.length > 24 && index < spineGroups.length - 12;
                        const anchor = group.kind === "commands" ? group.items[0]! : group.item;
                        return (
                          <RunSpineNode index={index} item={anchor} key={anchor.id} last={last} suppressHeader={group.kind === "commands"}>
                            <div className={cn(deferOffscreenEntry && "[contain-intrinsic-size:auto_180px] [content-visibility:auto]")}>
                              {group.kind === "commands" ? <CommandCluster items={group.items} /> : <TimelineEntry item={group.item} last={last} onApproval={onApproval} />}
                            </div>
                          </RunSpineNode>
                        );
                      })}
                      {hasActiveTask ? <li className="workspace-message"><div className="workspace-message-avatar"><Activity className="size-4" /></div><div className="min-w-0 w-full"><TaskProgress
                        thread={activeThread} turnId={activeTurnId} timeline={timeline}
                        agents={dashboard.threads.filter((thread) => thread.parentThreadId === activeThreadId)}
                        stream={runtimeStream} onRefresh={onRetryRuntimeStream} onStop={() => onInterrupt().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The turn could not be interrupted."))}
                        stopping={taskActionPending === "interrupt"}
                      /></div></li> : null}
                      <ParallelBranch threads={childThreads} />
                    </ol>
                  </ConversationContent>
                  <ConversationScrollButton className="bottom-4" />
                </Conversation>
              </div>
            )}

            <div className={cn("workspace-composer-region", !hasActiveTask && "workspace-composer-region--welcome")}>
              {dashboard.runtime.status === "degraded" ? <div className="workspace-runtime-note" role="alert"><ShieldAlert className="mt-0.5 size-4 shrink-0" /><div><p className="text-ui-control font-medium">Runtime needs attention</p><p className="mt-1 text-ui-control">{dashboard.runtime.message}</p></div></div> : null}
              <PromptInput
                accept={UPLOAD_ACCEPT}
                aria-busy={isSending}
                className="workspace-prompt mx-auto w-full max-w-[820px]"
                convertAttachmentsToDataUrls={false}
                maxFileSize={UPLOAD_MAX_BYTES}
                maxFiles={MAX_COMPOSER_ATTACHMENTS}
                multiple
                onError={handleAttachmentError}
                onSubmit={handleSubmit}
              >
                <PromptInputBody>
                  <PromptInputTextarea
                    aria-label="Task prompt"
                    className={cn("workspace-prompt-textarea text-ui-body", !hasActiveTask && "workspace-prompt-textarea--welcome")}
                    onChange={(event) => { setAttachmentNotice(null); onDraftChange(event.target.value); }}
                    placeholder={activeProvider ? activeTurnId ? "Add direction while your task is running…" : hasActiveTask ? "Continue this task…" : "Describe what you'd like to do…" : "Connect a model in Settings to get started…"}
                    readOnly={isSending}
                    value={draft}
                  />
                </PromptInputBody>
                <ComposerAttachmentTray disabled={isSending} onRetry={retryUpload} uploads={uploads} />
                {attachmentNotice ? <p className="px-5 pb-2 text-ui-meta text-[var(--c-wait)]" role="status">{attachmentNotice}</p> : null}
                {!activeThreadId && savedProjectsError ? <div className="flex items-center gap-2 px-5 pb-2 text-ui-meta text-[var(--c-fail)]" role="alert"><span className="min-w-0 flex-1">{savedProjectsError}</span><Button onClick={() => void onReloadProjects()} size="sm" type="button" variant="ghost">Retry</Button></div> : null}
                {!activeThreadId && !savedProjectsLoading && !savedProjectsError && !availableSavedProjects.length ? <p className="px-5 pb-2 text-ui-meta text-[var(--c-wait)]" role="status">Register and enable a saved project before starting a task.</p> : null}
                <PromptInputFooter className="workspace-prompt-footer flex-wrap gap-2">
                  <PromptInputTools className="min-w-0 flex-wrap gap-1.5">
                    <ComposerAttachControl
                      disabled={isSending || activeTurnId !== null || uploadTarget === null}
                      onAttach={attachUploads}
                      onDetach={detachUpload}
                      projectToken={selectedProjectId}
                      resetToken={activeThreadId}
                      tooltip={activeTurnId ? "Attachments can be added when the current turn finishes" : uploadTarget === null ? "Choose a project before attaching a file" : "Attach text, Markdown, CSV, or JSON files"}
                    />
                    {!activeThreadId ? (
                      <Select disabled={savedProjectsLoading || !availableSavedProjects.length || isSending} onValueChange={onSelectProject} value={selectedProjectId ?? undefined}>
                        <SelectTrigger aria-label="Task project" className="workspace-project-select text-ui-control" size="sm"><FolderOpen className="size-4 shrink-0" /><SelectValue placeholder={savedProjectsLoading ? "Loading projects…" : "Choose project"} /></SelectTrigger>
                        <SelectContent>{availableSavedProjects.map((project) => <SelectItem className="text-ui-control" key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
                      </Select>
                    ) : null}
                    <Tooltip><TooltipTrigger asChild><span className="workspace-model-label">{activeThread?.model || providerLabel(activeProvider)}</span></TooltipTrigger><TooltipContent>The model is selected in your workspace settings.</TooltipContent></Tooltip>
                  </PromptInputTools>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {activeTurnId ? <Button aria-label="Interrupt active turn" className="h-9 gap-1.5 rounded-full px-3 text-ui-control text-[var(--c-fail)]" disabled={taskActionPending !== null} onClick={() => void onInterrupt().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The turn could not be interrupted."))} type="button" variant="outline"><Square className="size-3 fill-current" />{taskActionPending === "interrupt" ? "Stopping…" : "Stop"}</Button> : null}
                    <PromptInputSubmit
                      className="workspace-submit"
                      disabled={isSending || attachmentsUploading || (activeTurnId !== null && storedUploadIds.length > 0) || !draft.trim() || !activeProvider || (!activeThreadId && !selectedSavedProject)}
                      status={isSending ? "submitted" : "ready"}
                    >
                      {isSending ? <Spinner className="size-4" /> : <ArrowUp className="size-5" />}
                    </PromptInputSubmit>
                  </div>
                </PromptInputFooter>
              </PromptInput>
              <div className="workspace-composer-help">
                <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-1.5" tabIndex={0}><Shield className="size-3.5" />You control approvals</span></TooltipTrigger><TooltipContent>When an action needs approval, you can review and allow or deny it in the conversation.</TooltipContent></Tooltip>
                <span className="hidden sm:inline">Shift + Enter for a new line</span>
                {hasActiveTask ? <button aria-controls="terminal-dock" aria-expanded={dockOpen} className="inline-flex items-center gap-1.5 hover:text-foreground" onClick={() => setDockOpen((open) => !open)} type="button"><TerminalSquare className="size-3.5" />Command output</button> : null}
              </div>
              {hasActiveTask && dockOpen ? (
                <section className="workspace-command-dock" id="terminal-dock">
                  <div className="workspace-command-dock-heading"><h2>Command output</h2><Button aria-label="Close terminal dock" onClick={() => setDockOpen(false)} size="icon-sm" variant="ghost"><X className="size-4" /></Button></div>
                  <div className="max-h-56 overflow-y-auto">
                    {timeline.some((item) => item.kind === "command") ? timeline.filter((item) => item.kind === "command").slice(-10).map((item) => <details className="border-t border-border p-3 first:border-t-0" key={item.id}><summary className="cursor-pointer text-ui-control">{item.title}<span className="ml-2 text-ui-meta text-muted-foreground">{item.status}</span></summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-ui-code text-muted-foreground">{item.body}</pre></details>) : <p className="p-4 text-ui-control text-muted-foreground">Commands run during this task will appear here.</p>}
                  </div>
                </section>
              ) : null}
            </div>

            {!hasActiveTask ? (
              <div className="workspace-starters">
                <div className="workspace-suggestion-grid">
                  {[
                    { icon: Search, label: "Understand a project", prompt: "Explore this project and explain how it works. Highlight the main components and where I should start." },
                    { icon: Code2, label: "Build something", prompt: "Help me build a new feature in this project. First, explore the codebase and help me plan the approach." },
                    { icon: FileDiff, label: "Review my changes", prompt: "Review the current changes in this project. Look for bugs, missing edge cases, and ways to simplify the implementation." },
                  ].map(({ icon: Icon, label, prompt }) => <button className="workspace-suggestion" disabled={isSending} key={label} onClick={() => { onDraftChange(prompt); document.querySelector<HTMLTextAreaElement>('[aria-label="Task prompt"]')?.focus(); }} type="button"><Icon aria-hidden="true" className="size-[18px]" /><span>{label}</span><ArrowRight aria-hidden="true" className="workspace-suggestion-arrow size-4" /></button>)}
                </div>
                <SetupNotice dashboard={dashboard} hasAvailableProject={availableSavedProjects.length > 0} />
                {selectedSavedProject?.dirty ? <p className="workspace-checkout-note"><GitBranch className="mt-0.5 size-3.5 shrink-0" />This project has uncommitted changes. Your task will work in the current checkout.</p> : null}
              </div>
            ) : null}
          </div>
          <TaskInspector activeThread={activeThread} dashboard={dashboard} onOpenChange={setInspectorOpen} open={inspectorOpen} timeline={timeline} />
        </div>
      </main>

      <Dialog onOpenChange={(open) => { setRenameOpen(open); if (!open) setActionError(null); }} open={renameOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <form onSubmit={submitRename}>
            <DialogHeader><DialogTitle>Rename task</DialogTitle><DialogDescription>Give this task a name that's easy to find later.</DialogDescription></DialogHeader>
            <div className="grid gap-3 py-6"><label className="grid gap-2 text-ui-control">Task name<Input autoFocus maxLength={120} onChange={(event) => setRenameValue(event.target.value)} value={renameValue} /></label>{actionError ? <p className="text-ui-control text-[var(--c-fail)]" role="alert">{actionError}</p> : null}</div>
            <DialogFooter><Button onClick={() => setRenameOpen(false)} type="button" variant="ghost">Cancel</Button><Button disabled={!renameValue.trim() || taskActionPending !== null} type="submit">{taskActionPending === "rename" ? "Renaming…" : "Rename"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog onOpenChange={(open) => { setArchiveOpen(open); if (!open) setActionError(null); }} open={archiveOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader><DialogTitle>Archive this task?</DialogTitle><DialogDescription>This task and its related agents will move to the archive. Your project files will stay where they are.</DialogDescription></DialogHeader>
          <p className="rounded-xl bg-muted p-4 text-ui-control text-muted-foreground">Archived tasks can be restored through the server API. An archive browser isn't available yet.</p>
          {actionError ? <p className="text-ui-control text-[var(--c-fail)]" role="alert">{actionError}</p> : null}
          <DialogFooter><Button onClick={() => setArchiveOpen(false)} type="button" variant="ghost">Cancel</Button><Button disabled={taskActionPending !== null} onClick={() => void confirmArchive()} type="button">{taskActionPending === "archive" ? "Archiving…" : "Archive task"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
