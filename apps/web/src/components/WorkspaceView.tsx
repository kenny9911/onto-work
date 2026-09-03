import {
  lazy,
  Suspense,
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
import {
  Activity,
  Archive,
  ArrowRight,
  BrainCircuit,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  FileDiff,
  Files,
  Gauge,
  GitFork,
  GitBranch,
  MessageSquareText,
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
import { useCloseAtBreakpoint } from "@/lib/use-close-at-breakpoint";
import { cn } from "@/lib/utils";
import {
  eventAge,
  runtimeStreamLabel,
  type RuntimeStreamState,
} from "@/lib/runtime-stream";
import { AvailabilityBadge } from "@/components/AvailabilityBadge";

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

const onboardingTimeline: TimelineItem[] = [
  {
    id: "welcome",
    kind: "assistant",
    title: "Agent Harness",
    body:
      "## Your harness is ready\n\nConnect a model route, choose a workspace, then describe the outcome you want. Each task runs through an isolated **Codex app-server** runtime and keeps approvals visible here.",
    status: "completed",
    timestamp: new Date().toISOString(),
  },
  {
    id: "next-action",
    kind: "system",
    title: "Next action",
    body: "Add a model route or start with a local Ollama model.",
    status: "pending",
    timestamp: new Date().toISOString(),
  },
];

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

function compactMetric(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return value.toLocaleString();
}

function elapsedClock(timestamp: string | undefined): string {
  if (!timestamp) return "00:00";
  const started = Date.parse(timestamp);
  if (!Number.isFinite(started)) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function itemTone(item: TimelineItem): string {
  if (item.kind === "approval") return "human";
  if (item.status === "failed") return "fail";
  if (item.status === "running") return "run";
  if (item.status === "pending") return "wait";
  if (item.status === "completed") return "verified";
  return "neutral";
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
      <span className="text-ui-meta ml-auto shrink-0 font-mono text-[var(--ink-2)]">
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

/**
 * First-run orientation. Every step is derived from control-plane state the
 * dashboard already returns, so the list reflects the deployment rather than a
 * stored wizard position. It disappears once setup is complete.
 */
function FirstRunChecklist({ dashboard }: { dashboard: DashboardPayload }) {
  const steps = [
    {
      label: "Replace the bootstrap password",
      detail: "The seeded credential stops working once you set your own.",
      done: !dashboard.user.mustChangePassword,
    },
    {
      label: "Connect a model route",
      detail: "Runs are refused until an enabled default route exists.",
      done: dashboard.providers.some((provider) => provider.enabled),
    },
    {
      label: "Register a saved project",
      detail: "Tasks start from an opaque project ID, never a browser-supplied path.",
      done: dashboard.projects.length > 0,
    },
    {
      label: "Run a task end to end",
      detail: "Proves the pinned Codex runtime and your route agree.",
      done: dashboard.threads.length > 0,
    },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  if (remaining === 0) return null;

  return (
    <section className="mt-5 max-w-[560px] overflow-hidden rounded-lg border border-[var(--c-hair)] bg-[var(--c-plate)]">
      <div className="flex items-center gap-2 border-b border-[var(--c-hair)] px-3 py-2">
        <h3 className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">
          First run
        </h3>
        <span className="text-ui-meta font-mono text-[var(--ink-4)]">
          {steps.length - remaining} of {steps.length} done
        </span>
        <span
          aria-hidden="true"
          className="ml-auto flex h-[3px] w-24 overflow-hidden rounded-full bg-[var(--c-surface)]"
        >
          <span
            className="bg-[var(--c-run)]"
            style={{ width: `${((steps.length - remaining) / steps.length) * 100}%` }}
          />
        </span>
      </div>
      <ol className="m-0 list-none divide-y divide-[var(--c-hair)] p-0">
        {steps.map((step) => (
          <li className="flex items-start gap-2.5 px-3 py-2" key={step.label}>
            {step.done ? (
              <CheckCircle2
                aria-label="Done"
                className="mt-0.5 size-3.5 shrink-0 text-[var(--c-run)]"
              />
            ) : (
              <CircleDot
                aria-label="Not done"
                className="mt-0.5 size-3.5 shrink-0 text-[var(--ink-4)]"
              />
            )}
            <div className="min-w-0">
              <p
                className={cn(
                  "text-ui-control font-medium",
                  step.done && "text-[var(--ink-3)] line-through",
                )}
              >
                {step.label}
              </p>
              <p className="text-ui-meta mt-0.5 text-[var(--ink-4)]">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Pre-flight summary for a new task: where it will run and what the server has
 * already decided. Only facts the control plane actually holds appear here —
 * the design's sandbox, approval-mode and budget rows are omitted because the
 * task-start contract carries no such fields.
 */
function NewTaskBriefing({
  project,
  provider,
  thread,
}: {
  project: SavedProjectSummary | null;
  provider: ProviderConnection | undefined;
  thread: ThreadSummary | null;
}) {
  if (!project) return null;

  return (
    <section className="mt-5 max-w-[560px] overflow-hidden rounded-lg border border-[var(--c-hair)] bg-[var(--c-plate)]">
      <h3 className="text-ui-micro border-b border-[var(--c-hair)] px-3 py-2 font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">
        Where it runs
      </h3>
      <dl className="divide-y divide-[var(--c-hair)]">
        <div className="flex items-center gap-3 px-3 py-2">
          <dt className="text-ui-control shrink-0 text-[var(--ink-3)]">Project</dt>
          <dd className="text-ui-code ml-auto min-w-0 truncate font-mono text-[var(--ink-1)]">
            {project.name}
          </dd>
        </div>
        <div className="flex items-center gap-3 px-3 py-2">
          <dt className="text-ui-control shrink-0 text-[var(--ink-3)]">Branch</dt>
          <dd className="text-ui-code ml-auto min-w-0 truncate font-mono text-[var(--ink-1)]">
            {project.branch ?? "not reported"}
          </dd>
        </div>
        <div className="flex items-center gap-3 px-3 py-2">
          <dt className="text-ui-control shrink-0 text-[var(--ink-3)]">Model route</dt>
          <dd className="text-ui-code ml-auto min-w-0 truncate font-mono text-[var(--ink-1)]">
            {provider ? `${provider.name} · ${thread?.model || providerLabel(provider)}` : "none connected"}
          </dd>
          <Shield
            aria-label="Server-selected; a client cannot override it"
            className="size-3 shrink-0 text-[var(--c-human)]"
          />
        </div>
      </dl>
      {project.dirty ? (
        <p className="text-ui-body flex items-start gap-2 border-t border-[var(--c-wait-dim)] bg-[var(--c-wait-dim)] px-3 py-2 text-[var(--ink-1)]">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[var(--c-wait)]" />
          <span>
            Working tree is dirty. The agent runs directly in this checkout —
            product-owned worktree isolation is not implemented, so uncommitted
            work is in scope for the run.
          </span>
        </p>
      ) : null}
    </section>
  );
}

/**
 * Tail of the spine while a turn is in flight. The runtime reports that a turn
 * is running and streams its text, but not a token rate, so the design's
 * throughput readout is deliberately omitted rather than estimated.
 */
function StreamingNode({ model }: { model: string }) {
  return (
    <li className="grid min-w-0 grid-cols-[26px_minmax(0,1fr)] gap-x-3.5">
      <div aria-hidden="true" className="relative flex justify-center">
        <span className="absolute top-[27px] bottom-0 w-px bg-gradient-to-b from-[var(--c-run-line)] to-transparent" />
        <svg className="ah-spin relative z-10 size-[22px]" fill="none" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="7.6" stroke="var(--c-run-dim)" strokeWidth="1.8" />
          <path
            d="M11 3.4 A7.6 7.6 0 0 1 18.6 11"
            stroke="var(--c-run)"
            strokeLinecap="round"
            strokeWidth="1.8"
          />
        </svg>
      </div>
      <div className="min-w-0 pb-4">
        <div className="flex h-[22px] items-center gap-2">
          <span className="text-ui-control font-semibold">Agent</span>
          <span className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--c-run)]">
            Streaming
          </span>
          <span className="text-ui-meta min-w-0 truncate font-mono text-[var(--ink-4)]">{model}</span>
        </div>
        <p className="text-ui-body mt-1.5 text-[var(--ink-2)]">
          The turn is running on the server.
          <span
            aria-hidden="true"
            className="ah-caret ml-1 inline-block h-3.5 w-[7px] translate-y-[2px] bg-[var(--c-run)]"
          />
        </p>
      </div>
    </li>
  );
}

function RunSpineNode({
  item,
  index,
  last,
  suppressHeader = false,
  children,
}: {
  item: TimelineItem;
  index: number;
  last: boolean;
  /** A grouped node supplies its own summary instead of one item's title. */
  suppressHeader?: boolean;
  children: ReactNode;
}) {
  const Icon = timelineKindIcons[item.kind];
  const attention = item.kind === "approval" && item.status === "pending";
  const tone = itemTone(item);
  return (
    <li className="grid min-w-0 grid-cols-[26px_minmax(0,1fr)] gap-x-3.5">
      <div aria-hidden="true" className="relative flex justify-center">
        {!last ? (
          <span className="absolute bottom-0 top-[27px] w-px bg-[var(--c-run-line)]" />
        ) : null}
        <span
          className={cn(
            "relative z-10 grid size-[22px] place-items-center rounded-[5px] border bg-[var(--c-surface)]",
            tone === "human" && "border-[var(--c-human)] text-[var(--c-human)]",
            tone === "fail" && "border-[color-mix(in_oklab,var(--c-fail)_45%,transparent)] text-[var(--c-fail)]",
            tone === "run" && "border-[var(--c-run-line)] bg-[var(--c-run-dim)] text-[var(--c-run)]",
            tone === "wait" && "border-[color-mix(in_oklab,var(--c-wait)_40%,transparent)] text-[var(--c-wait)]",
            tone === "verified" && "border-[color-mix(in_oklab,var(--c-verified)_42%,transparent)] text-[var(--c-verified)]",
            tone === "neutral" && "border-[var(--c-line)] text-[var(--ink-3)]",
          )}
        >
          {item.kind === "user" ? (
            <span className="font-mono text-ui-micro">T{index + 1}</span>
          ) : (
            <Icon className="size-3" />
          )}
        </span>
      </div>
      <div className="min-w-0 pb-4">
        {suppressHeader ? null : (
        <div className="mb-1.5 flex min-h-[22px] items-center gap-2">
          <span className="text-ui-control font-semibold text-[var(--ink-1)]">{item.title}</span>
          <span className="font-mono text-ui-meta text-[var(--ink-4)]">
            {timelineKindLabels[item.kind].toLowerCase()} · {conciseTime(item.timestamp)}
          </span>
          {item.status ? (
            <span
              className={cn(
                "inline-flex min-h-5 items-center rounded-[3px] border px-1.5 font-mono text-ui-micro uppercase tracking-[0.08em]",
                tone === "run" && "border-[var(--c-run-dim)] bg-[var(--c-run-dim)] text-[var(--c-run)]",
                tone === "wait" && "border-[var(--c-wait-dim)] bg-[var(--c-wait-dim)] text-[var(--c-wait)]",
                tone === "fail" && "border-[var(--c-fail-dim)] bg-[var(--c-fail-dim)] text-[var(--c-fail)]",
                tone === "human" && "border-[var(--c-human-dim)] bg-[var(--c-human-dim)] text-[var(--c-human)]",
                tone === "verified" && "border-border bg-transparent text-[var(--ink-3)]",
              )}
            >
              {attention ? "attention" : item.status}
            </span>
          ) : null}
        </div>
        )}
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
        <span className="text-ui-meta font-mono text-[var(--ink-3)]">
          {items.length} commands
        </span>
        <span
          className={cn(
            "text-ui-micro ml-auto shrink-0 font-mono uppercase tracking-[0.12em]",
            failed ? "text-[var(--c-fail)]" : "text-[var(--c-verified)]",
          )}
        >
          {failed ? `${failed} failed` : "complete"}
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
      <div className="mt-2 rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)] px-3 py-2.5 text-ui-body text-[var(--ink-1)]">
        <Suspense fallback={<p className="whitespace-pre-wrap">{item.body}</p>}>
          <MessageResponse>{item.body}</MessageResponse>
        </Suspense>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="mt-1 text-ui-body text-[var(--ink-2)] [&_code]:rounded-[3px] [&_code]:bg-[var(--c-surface)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-ui-code [&_code]:text-[var(--ink-1)]">
        <Suspense fallback={<p className="whitespace-pre-wrap">{item.body}</p>}>
          <MessageResponse>{item.body}</MessageResponse>
        </Suspense>
      </div>
    );
  }

  if (item.kind === "reasoning") {
    return (
      <Suspense
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
      </Suspense>
    );
  }

  if (item.kind === "command" || item.kind === "file_change") {
    return (
      <Suspense
        fallback={(
          <div className="mt-2 overflow-hidden rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)]">
            <p className="border-b border-[var(--c-hair)] px-3 py-2 text-ui-control font-medium text-[var(--ink-2)]">
              {item.title}
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-ui-code text-[var(--ink-3)]">
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
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-ui-code text-[var(--ink-3)]">
              {item.body}
            </pre>
          </ToolContent>
        </Tool>
      </Suspense>
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
              <span className="rounded-[3px] border border-[var(--c-human-dim)] bg-[var(--c-human-dim)] px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-[0.08em] text-[var(--c-human)]">
                {waiting ? "Needs you" : item.status}
              </span>
            </div>
            <p className="mt-1 font-mono text-ui-meta text-[var(--ink-3)]">
              {item.title}
            </p>
          </div>
        </div>
        <p className="whitespace-pre-wrap px-3.5 py-3 text-ui-body text-[var(--ink-2)]">{item.body}</p>
        <div className="grid grid-cols-2 border-y border-[var(--c-hair)] bg-[var(--c-surface)]/35">
          <div className="border-r border-[var(--c-hair)] px-3.5 py-2">
            <p className="font-mono text-ui-micro uppercase tracking-[0.14em] text-[var(--ink-4)]">Policy source</p>
            <p className="mt-1 text-ui-control text-[var(--ink-2)]">Organization policy · supervised</p>
          </div>
          <div className="px-3.5 py-2">
            <p className="font-mono text-ui-micro uppercase tracking-[0.14em] text-[var(--ink-4)]">Side effects</p>
            <p className="mt-1 text-ui-control text-[var(--c-wait)]">Review before execution</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
          <Button
            className="h-8 bg-[var(--c-human)] px-3 text-ui-control font-semibold text-white hover:brightness-110"
            disabled={!waiting}
            onClick={() => void onApproval(item, "accept")}
            size="sm"
          >
            Approve once <span className="font-mono text-ui-micro opacity-70">A</span>
          </Button>
          <Button
            className="h-8 border-[var(--c-line)] px-3 text-ui-control"
            disabled={!waiting}
            onClick={() => void onApproval(item, "acceptForSession")}
            size="sm"
            variant="outline"
          >
            Approve for this session
          </Button>
          <Button
            className="h-8 px-3 text-ui-control"
            disabled={!waiting}
            onClick={() => void onApproval(item, "decline")}
            size="sm"
            variant="ghost"
          >
            Deny <span className="font-mono text-ui-micro opacity-70">D</span>
          </Button>
          <Button className="h-8 border-[var(--c-hair)] px-3 text-ui-control" disabled size="sm" title="Command editing is not exposed by this runtime" variant="outline">
            Edit command…
          </Button>
        </div>
        <p className="px-3.5 pb-3 text-center text-ui-meta text-[var(--ink-3)]">
          Session grants expire when the task ends. They are never written to the project profile.
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

function ParallelBranch({
  threads,
}: {
  threads: readonly ThreadSummary[];
}) {
  if (!threads.length) return null;
  return (
    <li className="grid min-w-0 grid-cols-[26px_minmax(0,1fr)] gap-x-3.5">
      <div aria-hidden="true" className="relative flex justify-center">
        <span className="absolute bottom-0 top-[27px] w-px bg-[var(--c-run-line)]" />
        <span className="relative z-10 grid size-[22px] place-items-center rounded-full border border-[var(--c-line)] bg-[var(--c-plate)] text-[var(--ink-2)]">
          <GitFork className="size-3" />
        </span>
      </div>
      <div className="min-w-0 pb-4">
        <div className="flex min-h-[22px] items-center gap-2">
          <span className="text-ui-title font-semibold">Parallel branch</span>
          <span className="font-mono text-ui-meta text-[var(--ink-4)]">
            {threads.length} child agent{threads.length === 1 ? "" : "s"} · shares parent budget
          </span>
          <span className="ml-auto font-mono text-ui-control text-[var(--c-info)]">Supervise all →</span>
        </div>
        <div className="mt-2 flex flex-col gap-1.5 border-l border-dashed border-[var(--c-run-line)] pl-3">
          {threads.map((thread) => {
            const tone = thread.status === "running"
              ? "run"
              : thread.status === "waiting"
                ? "wait"
                : thread.status === "failed"
                  ? "fail"
                  : "neutral";
            return (
              <div
                className="flex min-w-0 items-center gap-2.5 rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)] px-2.5 py-2"
                key={thread.id}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[7px] shrink-0 rounded-full",
                    tone === "run" && "running-dot bg-[var(--c-run)]",
                    tone === "wait" && "bg-[var(--c-wait)]",
                    tone === "fail" && "bg-[var(--c-fail)]",
                    tone === "neutral" && "bg-[var(--ink-4)]",
                  )}
                />
                <span className="shrink-0 truncate text-ui-control font-medium">
                  {thread.agentNickname ?? thread.title}
                </span>
                <span
                  className={cn(
                    "rounded-[3px] border px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-[0.08em]",
                    tone === "run" && "border-[var(--c-run-dim)] bg-[var(--c-run-dim)] text-[var(--c-run)]",
                    tone === "wait" && "border-[var(--c-wait-dim)] bg-[var(--c-wait-dim)] text-[var(--c-wait)]",
                    tone === "fail" && "border-[var(--c-fail-dim)] bg-[var(--c-fail-dim)] text-[var(--c-fail)]",
                    tone === "neutral" && "border-border bg-transparent text-[var(--ink-3)]",
                  )}
                >
                  {thread.status}
                </span>
                <span className="min-w-0 truncate font-mono text-ui-meta text-[var(--ink-3)]">
                  {thread.preview || thread.agentRole || "child task"}
                </span>
                <span className="ml-auto shrink-0 font-mono text-ui-code text-[var(--ink-4)]">
                  {thread.model}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </li>
  );
}

function InspectorTabs({
  dashboard,
  activeThread,
  timeline,
}: Pick<WorkspaceViewProps, "dashboard" | "activeThread" | "timeline">) {
  const defaultProvider = dashboard.providers.find((provider) => provider.isDefault && provider.enabled)
    ?? dashboard.providers.find((provider) => provider.enabled);
  const project = activeThread?.projectId
    ? dashboard.projects.find((candidate) => candidate.id === activeThread.projectId)
    : undefined;
  const { fileChanges, commandCount, pendingApprovals } = useMemo(() => {
    const changes: TimelineItem[] = [];
    let commands = 0;
    let approvals = 0;
    for (const item of timeline) {
      if (item.kind === "file_change") changes.push(item);
      if (item.kind === "command") commands += 1;
      if (item.kind === "approval" && item.status === "pending") approvals += 1;
    }
    return {
      fileChanges: changes,
      commandCount: commands,
      pendingApprovals: approvals,
    };
  }, [timeline]);
  const childAgents = activeThread
    ? dashboard.threads.filter((thread) => thread.parentThreadId === activeThread.id)
    : [];
  const totalTokens = dashboard.usage.inputTokens + dashboard.usage.outputTokens;

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="files">
      <div className="shrink-0 overflow-x-auto border-b border-[var(--c-hair)] px-1">
        <TabsList aria-label="Task inspector" className="h-10 min-w-max gap-0 rounded-none border-0 bg-transparent p-0">
          <TabsTrigger className="h-10 rounded-none border-b-2 border-transparent px-2.5 text-ui-control font-normal data-[state=active]:border-[var(--c-run)] data-[state=active]:bg-transparent" value="files">Files <span className="ml-1 font-mono text-ui-micro text-[var(--ink-4)]">{fileChanges.length}</span></TabsTrigger>
          <TabsTrigger className="h-10 rounded-none border-b-2 border-transparent px-2.5 text-ui-control font-normal data-[state=active]:border-[var(--c-run)] data-[state=active]:bg-transparent" value="diff">Diff</TabsTrigger>
          <TabsTrigger className="h-10 rounded-none border-b-2 border-transparent px-2.5 text-ui-control font-normal data-[state=active]:border-[var(--c-run)] data-[state=active]:bg-transparent" value="context">Context</TabsTrigger>
          <TabsTrigger className="h-10 rounded-none border-b-2 border-transparent px-2.5 text-ui-control font-normal data-[state=active]:border-[var(--c-run)] data-[state=active]:bg-transparent" value="agents">Agents <span className="ml-1 font-mono text-ui-micro text-[var(--ink-4)]">{childAgents.length}</span></TabsTrigger>
          <TabsTrigger className="h-10 rounded-none border-b-2 border-transparent px-2.5 text-ui-control font-normal data-[state=active]:border-[var(--c-run)] data-[state=active]:bg-transparent" value="usage">Usage</TabsTrigger>
          <TabsTrigger className="h-10 rounded-none border-b-2 border-transparent px-2.5 text-ui-control font-normal data-[state=active]:border-[var(--c-run)] data-[state=active]:bg-transparent" value="events">Events <span className="ml-1 font-mono text-ui-micro text-[var(--ink-4)]">{timeline.length}</span></TabsTrigger>
        </TabsList>
      </div>

      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-4" value="context">
        <div className="space-y-6">
          {/* Token totals are metered server-side, but no provider reports its
              context-window size to the control plane, so the design's
              proportional meter would need an invented denominator. */}
          <section>
            <p className="mb-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">
              Context window
            </p>
            <div className="rounded-lg border border-border/80 bg-card/25 p-3">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[15px] text-[var(--ink-1)]">
                  {compactMetric(totalTokens)}
                </span>
                <span className="text-ui-meta font-mono text-muted-foreground">
                  tokens this period
                </span>
              </div>
              <dl className="mt-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--c-human)]" />
                  <dt className="text-ui-meta text-muted-foreground">Input</dt>
                  <dd className="text-ui-meta ml-auto font-mono">
                    {dashboard.usage.inputTokens.toLocaleString()}
                  </dd>
                </div>
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--c-run)]" />
                  <dt className="text-ui-meta text-muted-foreground">Output</dt>
                  <dd className="text-ui-meta ml-auto font-mono">
                    {dashboard.usage.outputTokens.toLocaleString()}
                  </dd>
                </div>
              </dl>
              <p className="text-ui-meta mt-2.5 text-muted-foreground">
                Window size is not reported by the runtime, so this is a metered
                total rather than a share of a limit. Compaction is a Codex
                operation and is not exposed here.
              </p>
            </div>
          </section>
          <section>
            <p className="mb-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Environment</p>
            <div className="space-y-3 rounded-lg border border-border/80 bg-card/25 p-3">
              <div className="flex items-start gap-2.5">
                <TerminalSquare className="mt-0.5 size-3.5 text-primary" />
                <div className="min-w-0">
                  <p className="text-ui-control font-medium">Local runtime</p>
                  <p className="mt-0.5 truncate font-mono text-ui-meta text-muted-foreground">
                    {dashboard.runtime.status} · isolated home
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <GitBranch className="mt-0.5 size-3.5 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-ui-control font-medium">
                    {project?.name ?? activeThread?.projectName ?? "Project not reported"}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-ui-code text-muted-foreground">
                    {project?.branch ?? "Branch not reported"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <Shield className="mt-0.5 size-3.5 text-muted-foreground" />
                <div>
                  <p className="text-ui-control font-medium">Approval policy</p>
                  <p className="mt-0.5 font-mono text-ui-meta text-muted-foreground">Not reported</p>
                </div>
              </div>
            </div>
          </section>

          <section>
            <p className="mb-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Model route</p>
            <div className="rounded-lg border border-border/80 bg-card/25 p-3">
              <div className="flex items-center gap-2">
                <Braces className="size-3.5 text-primary" />
                <span className="truncate text-ui-control font-medium">
                  {activeThread?.model || "Task model not reported"}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3 font-mono text-ui-meta text-muted-foreground">
                <span>Current default</span>
                <span>{providerLabel(defaultProvider)}</span>
              </div>
            </div>
          </section>

          <section>
            <p className="mb-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Harness</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-ui-meta">
              <dt className="text-muted-foreground">Codex upstream</dt>
              <dd className="font-mono">6127478</dd>
              <dt className="text-muted-foreground">Transport</dt>
              <dd className="font-mono">JSONL</dd>
              <dt className="text-muted-foreground">Session scope</dt>
              <dd className="font-mono">user</dd>
            </dl>
          </section>
        </div>
      </TabsContent>

      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-3" value="files">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-ui-micro uppercase tracking-[0.12em] text-[var(--ink-4)]">
            Changed files · {fileChanges.length}
          </span>
          {fileChanges.length ? <span className="ml-auto font-mono text-ui-meta text-[var(--syn-add)]">reported</span> : null}
        </div>
        {fileChanges.length ? (
          <div className="space-y-0.5">
            {fileChanges.map((change) => (
              <button className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left hover:bg-[var(--c-surface)]" key={change.id} type="button">
                <span className="grid size-[18px] shrink-0 place-items-center rounded-[3px] bg-[color-mix(in_oklab,var(--c-info)_14%,transparent)] font-mono text-ui-micro text-[var(--c-info)]">M</span>
                <span className="min-w-0 truncate font-mono text-ui-code text-[var(--ink-2)]">{change.title}</span>
                <span className="ml-auto flex shrink-0 gap-px"><span className="h-1 w-3.5 rounded-[1px] bg-[var(--syn-add)]" /><span className="h-1 w-1.5 rounded-[1px] bg-[var(--syn-del)]" /></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--c-hair)] px-4 py-8 text-center">
            <Files className="mx-auto size-4 text-[var(--ink-4)]" />
            <p className="mt-3 text-ui-control font-medium">No file changes reported</p>
            <p className="mt-1 text-ui-meta text-[var(--ink-3)]">Runtime file-change events appear here as they arrive.</p>
          </div>
        )}
        <div className="mt-4 border-t border-[var(--c-hair)] pt-3">
          <p className="mb-2 font-mono text-ui-micro uppercase tracking-[0.12em] text-[var(--ink-4)]">Run spine minimap</p>
          <ol className="space-y-1">
            {timeline.slice(-10).map((item) => (
              <li className="flex min-w-0 items-center gap-2 px-1 py-0.5" key={item.id}>
                <span className={cn("size-2 shrink-0 rounded-[2px]", item.kind === "approval" ? "bg-[var(--c-human)]" : item.status === "failed" ? "bg-[var(--c-fail)]" : item.status === "running" ? "bg-[var(--c-run)]" : item.kind === "command" ? "bg-[var(--ink-3)]" : "bg-[var(--c-info)]")} />
                <span className="min-w-0 truncate text-ui-meta text-[var(--ink-2)]">
                  {timelineKindLabels[item.kind]}
                  {item.status ? ` · ${item.status}` : ""}
                </span>
                <time className="ml-auto shrink-0 font-mono text-ui-meta text-[var(--ink-4)]">{conciseTime(item.timestamp)}</time>
              </li>
            ))}
          </ol>
        </div>
      </TabsContent>

      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-3" value="diff">
        {fileChanges.length ? (
          <div className="space-y-2">
            {fileChanges.map((change) => (
              <article className="overflow-hidden rounded-md border border-[var(--c-hair)] bg-[var(--term-bg)]" key={change.id}>
                <div className="flex items-center gap-2 border-b border-[var(--c-hair)] px-2.5 py-2"><Code2 className="size-3.5 text-[var(--c-info)]" /><h3 className="truncate font-mono text-ui-code">{change.title}</h3></div>
                <pre className="overflow-x-auto whitespace-pre-wrap p-2.5 font-mono text-ui-code text-[var(--ink-3)]">{change.body || "The runtime reported a file change without path details."}</pre>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--c-hair)] px-4 py-8 text-center"><FileDiff className="mx-auto size-4 text-[var(--ink-4)]" /><p className="mt-3 text-ui-control font-medium">No diff reported</p><p className="mt-1 text-ui-meta text-[var(--ink-3)]">Diffs remain empty until Codex emits a file-change event.</p></div>
        )}
      </TabsContent>

      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-3" value="agents">
        {childAgents.length ? (
          <div className="space-y-2">
            {childAgents.map((agent) => (
              <div className="rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)] p-3" key={agent.id}>
                <div className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", agent.status === "running" ? "bg-[var(--c-run)]" : agent.status === "waiting" ? "bg-[var(--c-wait)]" : agent.status === "failed" ? "bg-[var(--c-fail)]" : "bg-[var(--ink-4)]")} />
                  <span className="truncate text-ui-control font-medium">{agent.agentNickname ?? agent.title}</span>
                  <span className="ml-auto font-mono text-ui-micro uppercase text-[var(--ink-3)]">{agent.status}</span>
                </div>
                <p className="mt-1.5 truncate font-mono text-ui-meta text-[var(--ink-4)]">{agent.agentRole ?? agent.model}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--c-hair)] px-4 py-8 text-center"><UsersRound className="mx-auto size-4 text-[var(--ink-4)]" /><p className="mt-3 text-ui-control font-medium">No child agents reported</p><p className="mt-1 text-ui-meta text-[var(--ink-3)]">Parallel branches appear when Codex reports ancestry.</p></div>
        )}
      </TabsContent>

      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-3" value="usage">
        <div className="grid grid-cols-2 overflow-hidden rounded-md border border-[var(--c-hair)]">
          {[
            ["Input", dashboard.usage.inputTokens],
            ["Output", dashboard.usage.outputTokens],
            ["Total", totalTokens],
            ["Requests", dashboard.usage.requestsUsed],
          ].map(([label, value], index) => (
            <div className={cn("p-3", index % 2 === 0 && "border-r border-[var(--c-hair)]", index < 2 && "border-b border-[var(--c-hair)]")} key={String(label)}>
              <p className="font-mono text-ui-micro uppercase tracking-[0.14em] text-[var(--ink-4)]">{label}</p>
              <p className="mt-1.5 font-mono text-[13px]">{Number(value).toLocaleString()}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-[var(--c-hair)] bg-[var(--c-plate)] p-3">
          <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-ui-control"><Gauge className="size-3.5 text-[var(--c-wait)]" />Request budget</span><span className="font-mono text-ui-meta text-[var(--c-wait)]">{Math.round((dashboard.usage.requestsUsed / Math.max(1, dashboard.usage.requestLimit)) * 100)}%</span></div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--c-line)]"><span className="block h-full bg-[var(--c-wait)]" style={{ width: `${Math.min(100, (dashboard.usage.requestsUsed / Math.max(1, dashboard.usage.requestLimit)) * 100)}%` }} /></div>
        </div>
        {/* Admission binds one server-selected route per run and records it on
            the usage event, so this is the route that actually served the task
            rather than the tenant's current default. */}
        <div className="mt-3 rounded-md border border-[var(--c-hair)] bg-[var(--c-surface)] p-3">
          <p className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">
            Route actually used
          </p>
          <p className="text-ui-code mt-1.5 font-mono text-[var(--ink-1)]">
            {defaultProvider
              ? `${defaultProvider.name} → ${activeThread?.model || providerLabel(defaultProvider)}`
              : "No model route is connected"}
          </p>
          <p className="text-ui-meta mt-1.5 text-[var(--ink-3)]">
            Server-selected at admission. A client cannot override it, and the
            control plane records no fallback hops because it never retries a run
            on a second route.
          </p>
        </div>
      </TabsContent>

      <TabsContent className="min-h-0 flex-1 overflow-y-auto p-3" value="events">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border/80 bg-card/25 p-3">
            <Activity className="size-3.5 text-primary" />
            <p className="mt-3 text-lg font-medium">{timeline.length}</p>
            <p className="text-ui-meta text-muted-foreground">Visible events</p>
          </div>
          <div className="rounded-lg border border-border/80 bg-card/25 p-3">
            <TerminalSquare className="size-3.5 text-muted-foreground" />
            <p className="mt-3 text-lg font-medium">{commandCount}</p>
            <p className="text-ui-meta text-muted-foreground">Commands</p>
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-border/80 bg-card/25 p-3">
          <div className="flex items-center justify-between">
            <span className="text-ui-control font-medium">Human attention</span>
            <span className={cn("font-mono text-ui-meta", pendingApprovals ? "text-amber-300" : "text-muted-foreground")}>
              {pendingApprovals ? `${pendingApprovals} waiting` : "clear"}
            </span>
          </div>
        </div>
        <ol className="mt-5 space-y-3" aria-label="Recent run events">
          {timeline.slice(-8).map((item) => (
            <li className="flex items-start gap-2.5" key={item.id}>
              <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", item.status === "failed" ? "bg-red-400" : item.status === "running" ? "bg-primary" : "bg-[var(--healthy)]")} />
              <span className="min-w-0">
                <span className="block truncate text-ui-control font-medium">{item.title}</span>
                <span className="mt-0.5 block font-mono text-ui-meta capitalize text-muted-foreground">
                  {timelineKindLabels[item.kind]} · {item.status ?? "event"}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </TabsContent>
    </Tabs>
  );
}

function TaskInspector({
  dashboard,
  activeThread,
  timeline,
  open,
  onOpenChange,
}: Pick<WorkspaceViewProps, "dashboard" | "activeThread" | "timeline"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <aside aria-label="Task inspector" className="hidden min-h-0 w-[340px] shrink-0 border-l border-[var(--c-hair)] bg-[var(--c-plate)] min-[1180px]:flex min-[1180px]:flex-col">
        <span className="sr-only">Task inspector</span>
        <InspectorTabs activeThread={activeThread} dashboard={dashboard} timeline={timeline} />
      </aside>

      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="bottom-0 left-auto right-0 top-0 h-dvh w-[min(92vw,360px)] max-w-none translate-x-0 translate-y-0 gap-0 border-y-0 border-r-0 bg-[var(--c-plate)] p-0 sm:rounded-none min-[1180px]:hidden">
          <DialogTitle className="sr-only">Task inspector</DialogTitle>
          <DialogDescription className="sr-only">
            Inspect task context, reported file changes, and run activity.
          </DialogDescription>
          <div className="flex min-h-0 flex-1 flex-col pt-10">
            <InspectorTabs activeThread={activeThread} dashboard={dashboard} timeline={timeline} />
          </div>
        </DialogContent>
      </Dialog>
    </>
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
              <span className="text-ui-micro shrink-0 font-mono text-[var(--ink-4)]">
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
                <span className="shrink-0 font-mono">{upload?.errorCode ?? "upload_failed"}</span>
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
  onOpenSidebar,
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
  const [composerMode, setComposerMode] = useState<"read" | "write">("write");
  const [dockOpen, setDockOpen] = useState(false);
  const activeProvider = dashboard.providers.find((provider) => provider.isDefault && provider.enabled)
    ?? dashboard.providers.find((provider) => provider.enabled);
  const hasActiveTask = activeThreadId !== null || timeline.length > 0;
  const displayedTimeline = hasActiveTask ? timeline : onboardingTimeline;
  const spineGroups = useMemo(() => groupTimeline(displayedTimeline), [displayedTimeline]);
  const taskTitle = activeThread?.title ?? (hasActiveTask ? "New task" : "Start a new task");
  const status = activeTurnId ? "running" : activeThread?.status ?? (isSending ? "running" : "idle");
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
  const turnCount = Math.max(1, timeline.filter((item) => item.kind === "user").length);
  const budgetPercent = Math.min(
    100,
    Math.round((dashboard.usage.requestsUsed / Math.max(1, dashboard.usage.requestLimit)) * 100),
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeThreadId]);

  useCloseAtBreakpoint("(min-width: 1180px)", setInspectorOpen);

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
    <div className="flex min-h-0 min-w-0 flex-1">
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
        id="main-content"
        tabIndex={-1}
      >
        <header className="shrink-0 border-b border-[var(--c-hair)] bg-[var(--c-plate)]">
          <div className="flex items-start gap-3.5 px-3 py-2 sm:px-4 sm:pb-2 sm:pt-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn("text-ui-micro inline-flex min-h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-2 font-mono uppercase tracking-[0.1em]", status === "running" ? "border-[var(--c-run-line)] bg-[var(--c-run-dim)] text-[var(--c-run)]" : status === "failed" ? "border-[var(--c-fail-dim)] bg-[var(--c-fail-dim)] text-[var(--c-fail)]" : status === "waiting" ? "border-[var(--c-wait-dim)] bg-[var(--c-wait-dim)] text-[var(--c-wait)]" : "border-[color-mix(in_oklab,var(--c-verified)_40%,transparent)] bg-[color-mix(in_oklab,var(--c-verified)_14%,transparent)] text-[var(--c-verified)]")}>
                  <span className={cn("size-[7px] rounded-full", status === "running" && "running-dot bg-[var(--c-run)]", status === "failed" && "bg-[var(--c-fail)]", status === "waiting" && "bg-[var(--c-wait)]", status !== "running" && status !== "failed" && status !== "waiting" && "bg-[var(--c-verified)]")} />
                  {status === "running" ? `Running · turn ${turnCount}` : status}
                </span>
                <h1 className="text-ui-title min-w-0 truncate font-semibold tracking-[-0.015em]" ref={headingRef} tabIndex={-1}>{taskTitle}</h1>
                <Button aria-label="Rename task" className="size-[22px] shrink-0 text-[var(--ink-4)]" disabled={!activeThreadId} onClick={() => { setRenameValue(activeThread?.title ?? ""); setRenameOpen(true); }} size="icon-sm" variant="ghost"><Pencil className="size-3" /></Button>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-ui-code inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-[var(--c-hair)] px-2 font-mono text-[var(--ink-2)]"><GitBranch className="size-3 text-[var(--ink-4)]" />{taskProject?.branch ?? "branch not reported"}</span>
                <span className="text-ui-code inline-flex h-6 items-center whitespace-nowrap rounded-[4px] border border-[var(--c-hair)] px-2 font-mono text-[var(--ink-2)]">worktree · {selectedSavedProject?.headCommit?.slice(0, 7) ?? "managed"}</span>
                <span className="text-ui-code inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-[var(--c-run-line)] bg-[var(--c-run-dim)] px-2 font-mono text-[var(--ink-1)]"><span className="size-[5px] rounded-full bg-[var(--c-run)]" />{activeProvider?.name ?? "No model route"} · {activeThread?.model || providerLabel(activeProvider)}{activeThread?.reasoningEffort ? <span className="text-[var(--ink-4)]">effort:{activeThread.reasoningEffort}</span> : null}</span>
                <span className="text-ui-control inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-[var(--c-hair)] px-2 text-[var(--ink-2)]"><Shield className="size-3 text-[var(--c-human)]" />Supervised · approvals surfaced</span>
              </div>
            </div>

            <div className="hidden shrink-0 items-stretch overflow-hidden rounded-md border border-[var(--c-hair)] lg:flex">
              <div className="min-w-[104px] border-r border-[var(--c-hair)] px-3 py-1.5"><p className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">Elapsed</p><p className="text-ui-control mt-0.5 font-mono">{elapsedClock(activeThread?.updatedAt)}</p></div>
              <div className="min-w-[132px] border-r border-[var(--c-hair)] px-3 py-1.5"><div className="flex justify-between gap-2"><p className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">Budget</p><span className="text-ui-meta font-mono text-[var(--c-wait)]">{budgetPercent}%</span></div><p className="text-ui-code mt-0.5 font-mono">{compactMetric(dashboard.usage.requestsUsed)} / {compactMetric(dashboard.usage.requestLimit)} req</p><div className="mt-1 h-[3px] w-20 rounded-full bg-[var(--c-line)]"><span className="block h-full rounded-full bg-[var(--c-wait)]" style={{ width: `${budgetPercent}%` }} /></div></div>
              <div className="min-w-[88px] px-3 py-1.5"><p className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">Tokens</p><p className="text-ui-control mt-0.5 font-mono">{compactMetric(dashboard.usage.inputTokens + dashboard.usage.outputTokens)}</p></div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button aria-label="Task actions" className="mt-0.5" disabled={!activeThreadId || taskActionPending !== null} size="icon-sm" variant="outline"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 border-border bg-[var(--c-raise)]">
                {activeTurnId ? <DropdownMenuItem onSelect={() => void onInterrupt().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The turn could not be interrupted."))}><Square className="fill-current" /> Interrupt turn</DropdownMenuItem> : null}
                <DropdownMenuItem onSelect={() => { setActionError(null); setRenameValue(activeThread?.title ?? ""); setRenameOpen(true); }}><Pencil /> Rename task</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void onFork().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The task could not be forked."))}><GitFork /> Fork task</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-[var(--c-wait)]" onSelect={() => { setActionError(null); setArchiveOpen(true); }}><Archive /> Archive task</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button aria-label="Open task inspector" className="mt-0.5 min-[1180px]:hidden" onClick={() => setInspectorOpen(true)} size="icon-sm" variant="outline"><PanelRight className="size-4" /></Button>
          </div>
          <div className="flex items-center gap-2.5 px-4 pb-2">
            <span className="text-ui-micro font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">Goal</span>
            <span className="text-ui-control min-w-0 flex-1 truncate text-[var(--ink-2)]">{activeThread?.preview || (hasActiveTask ? "Task outcome is reported by the active Codex thread." : "Choose a project and describe the outcome you want the harness to deliver.")}</span>
            <span className="text-ui-meta shrink-0 font-mono text-[var(--ink-4)]">{timeline.filter((item) => item.status === "completed").length} checks recorded</span>
          </div>
          <RuntimeStreamBanner onRetry={onRetryRuntimeStream} runtimeStream={runtimeStream} />
        </header>

        {actionError ? (
          <div className="text-ui-meta shrink-0 border-b border-red-400/15 bg-red-400/[0.05] px-4 py-2 text-red-200" role="alert">
            {actionError}
          </div>
        ) : null}

        <div aria-atomic="true" aria-live="polite" className="sr-only">
          {isSending
            ? "Sending request…"
            : pendingApproval
            ? `${pendingApproval.title}. Waiting for your decision.`
            : dashboard.runtime.status === "degraded"
              ? `Runtime needs attention. ${dashboard.runtime.message ?? ""}`
              : ""}
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
          <Conversation aria-label="Run Spine activity" aria-live="off" className="h-full min-h-0">
            <ConversationContent
              className="mx-auto w-full max-w-[820px] gap-0 px-5 pb-6 pt-[18px]"
              scrollClassName="overflow-y-auto overscroll-contain"
            >
              {!hasActiveTask ? (
                <div className="mb-6 pt-4">
                  <div className="text-ui-micro mb-4 flex items-center gap-2 font-mono uppercase tracking-[0.14em] text-[var(--ink-4)]"><span className="h-px w-7 bg-[var(--c-hair)]" />Workspace ready</div>
                  <h2 className="max-w-xl text-2xl font-medium tracking-[-0.035em] text-[var(--ink-1)] sm:text-3xl">What should the harness build next?</h2>
                  <FirstRunChecklist dashboard={dashboard} />
                  <NewTaskBriefing
                    project={selectedSavedProject}
                    provider={activeProvider}
                    thread={activeThread}
                  />
                </div>
              ) : null}

              {dashboard.runtime.status === "degraded" ? (
                <div className="mb-4 rounded-md border border-[var(--c-fail-dim)] bg-[var(--c-fail-dim)] px-4 py-3" role="alert">
                  <p className="text-ui-control font-medium text-[var(--c-fail)]">Runtime needs attention</p>
                  <p className="text-ui-body mt-1 text-[var(--ink-2)]">
                    {dashboard.runtime.message}
                  </p>
                </div>
              ) : null}

              {hasActiveTask && !timeline.length ? (
                <div className="rounded-md border border-dashed border-[var(--c-hair)] px-4 py-8 text-center">
                  <Activity className="mx-auto size-4 text-muted-foreground" />
                  <p className="text-ui-control mt-3 font-medium">No run events in this snapshot</p>
                  <p className="text-ui-body mx-auto mt-1 max-w-md text-muted-foreground">
                    New runtime events will appear here. Older task history is not available in the current dashboard snapshot.
                  </p>
                </div>
              ) : null}

              <ol aria-label="Run Spine" className="m-0 list-none p-0">
                {spineGroups.map((group, index) => {
                  const last = index === spineGroups.length - 1 && !activeTurnId;
                  const deferOffscreenEntry =
                    spineGroups.length > 24 && index < spineGroups.length - 12;
                  const anchor = group.kind === "commands" ? group.items[0]! : group.item;
                  return (
                    <RunSpineNode
                      index={index}
                      item={anchor}
                      key={anchor.id}
                      last={last}
                      suppressHeader={group.kind === "commands"}
                    >
                      <div
                        className={cn(
                          deferOffscreenEntry &&
                            "[contain-intrinsic-size:auto_180px] [content-visibility:auto]",
                        )}
                      >
                        {group.kind === "commands" ? (
                          <CommandCluster items={group.items} />
                        ) : (
                          <TimelineEntry item={group.item} last={last} onApproval={onApproval} />
                        )}
                      </div>
                    </RunSpineNode>
                  );
                })}
                {activeTurnId ? (
                  <StreamingNode model={activeThread?.model || providerLabel(activeProvider)} />
                ) : null}
                <ParallelBranch threads={childThreads} />
              </ol>
            </ConversationContent>
            <ConversationScrollButton className="bottom-4" />
          </Conversation>
            </div>

            <div className="shrink-0 border-t border-[var(--c-hair)] bg-[var(--c-plate)] px-4 pb-2 pt-2.5 sm:px-5">
          <PromptInput
            accept={UPLOAD_ACCEPT}
            aria-busy={isSending}
            className="mx-auto w-full max-w-[820px] [&>[data-slot=input-group]]:overflow-hidden [&>[data-slot=input-group]]:rounded-[7px] [&>[data-slot=input-group]]:border-[var(--c-line)] [&>[data-slot=input-group]]:bg-[var(--c-surface)] [&>[data-slot=input-group]]:shadow-none"
            convertAttachmentsToDataUrls={false}
            maxFileSize={UPLOAD_MAX_BYTES}
            maxFiles={MAX_COMPOSER_ATTACHMENTS}
            multiple
            onError={handleAttachmentError}
            onSubmit={handleSubmit}
          >
            <div className="order-first flex w-full items-center gap-1.5 border-b border-[var(--c-hair)] px-2 py-1.5">
              <span className="text-ui-code inline-flex h-6 min-w-0 items-center gap-1.5 rounded-[4px] border border-[var(--c-hair)] bg-[var(--c-plate)] px-1.5 font-mono text-[var(--ink-2)]"><GitBranch className="size-3 text-[var(--ink-4)]" /><span className="truncate">{taskProject?.branch ?? "working tree"}</span></span>
              <span className="text-ui-code inline-flex h-6 min-w-0 items-center rounded-[4px] border border-[var(--c-run-line)] bg-[var(--c-run-dim)] px-2 font-mono text-[var(--ink-1)]"><span className="truncate">{activeThread?.model || providerLabel(activeProvider)}</span></span>
              <span
                className={cn(
                  "text-ui-meta hidden font-mono sm:inline",
                  runtimeStream.status === "live"
                    ? "text-[var(--ink-4)]"
                    : runtimeStream.status === "offline"
                      ? "text-[var(--c-fail)]"
                      : "text-[var(--c-wait)]",
                )}
              >
                runtime · {runtimeStreamLabel(runtimeStream.status)}
              </span>
            </div>
            <PromptInputBody>
              <PromptInputTextarea
                aria-label="Task prompt"
                className="text-ui-body min-h-[58px] px-3 py-2.5"
                onChange={(event) => {
                  setAttachmentNotice(null);
                  onDraftChange(event.target.value);
                }}
                placeholder={activeProvider
                  ? activeTurnId
                    ? "Steer the run, or type / for skills and @ for files…"
                    : "Describe the outcome for this task…"
                  : "Connect a model route to start a task…"}
                readOnly={isSending}
                value={draft}
              />
            </PromptInputBody>
            <ComposerAttachmentTray
              disabled={isSending}
              onRetry={retryUpload}
              uploads={uploads}
            />
            {attachmentNotice ? (
              <p className="text-ui-meta px-4 pb-1 text-amber-200" role="status">
                {attachmentNotice}
              </p>
            ) : null}
            {!activeThreadId && savedProjectsError ? (
              <div className="text-ui-meta flex items-center gap-2 px-4 pb-1 text-red-200" role="alert">
                <span className="min-w-0 flex-1">{savedProjectsError}</span>
                <Button
                  className="text-ui-control h-7 shrink-0 px-2"
                  onClick={() => void onReloadProjects()}
                  type="button"
                  variant="ghost"
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {!activeThreadId && !savedProjectsLoading && !savedProjectsError && !availableSavedProjects.length ? (
              <p className="text-ui-meta px-4 pb-1 text-amber-200" role="status">
                Register and enable a saved project before starting a task.
              </p>
            ) : null}
            <PromptInputFooter className="flex-wrap gap-1.5 border-t border-[var(--c-hair)] px-2 py-1.5">
              <PromptInputTools className="flex-wrap gap-1.5">
                <ComposerAttachControl
                  disabled={isSending || activeTurnId !== null || uploadTarget === null}
                  onAttach={attachUploads}
                  onDetach={detachUpload}
                  projectToken={selectedProjectId}
                  resetToken={activeThreadId}
                  tooltip={
                    activeTurnId
                      ? "Attachments start a new turn — the active run only accepts steering"
                      : uploadTarget === null
                        ? "Choose an available saved project to attach a file"
                        : "Attach UTF-8 text files the agent reads from disk"
                  }
                />
                {!activeThreadId ? (
                  <Select
                    disabled={savedProjectsLoading || !availableSavedProjects.length || isSending}
                    onValueChange={onSelectProject}
                    value={selectedProjectId ?? undefined}
                  >
                    <SelectTrigger
                      aria-label="Task project"
                      className="text-ui-control h-7 w-[min(44vw,180px)] border-[var(--c-hair)] bg-[var(--c-plate)] px-2 shadow-none"
                      size="sm"
                    >
                      <SelectValue
                        placeholder={savedProjectsLoading ? "Loading projects…" : "Choose project"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSavedProjects.map((project) => (
                        <SelectItem className="text-ui-control" key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <span
                  className="text-ui-control flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-[var(--c-hair)] px-2 text-[var(--ink-2)]"
                  title="New tasks use the tenant's default model route"
                >
                  <span className="size-[5px] rounded-full bg-[var(--c-run)]" />
                  {providerLabel(activeProvider)}
                </span>
                <span className="text-ui-micro ml-0.5 font-mono uppercase tracking-[0.12em] text-[var(--ink-4)]">Mode</span>
                {(["read", "write"] as const).map((mode) => (
                  <button className={cn("text-ui-control h-7 rounded-[5px] border px-2.5 capitalize", composerMode === mode ? "border-[var(--c-line)] bg-[var(--c-plate)] text-[var(--ink-1)]" : "border-transparent text-[var(--ink-3)] hover:text-[var(--ink-1)]")} key={mode} onClick={() => setComposerMode(mode)} type="button">{mode}</button>
                ))}
                <button aria-disabled="true" className="text-ui-control h-7 cursor-not-allowed rounded-[5px] border border-transparent px-2.5 text-[var(--ink-4)]" title="Full access is blocked by organization policy" type="button">Full</button>
              </PromptInputTools>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {activeTurnId ? (
                  <Button aria-label="Interrupt active turn" className="text-ui-control h-7 gap-1.5 border-[var(--c-fail)] px-2.5 text-[var(--c-fail)] hover:bg-[var(--c-fail-dim)]" disabled={taskActionPending !== null} onClick={() => void onInterrupt().catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : "The turn could not be interrupted."))} type="button" variant="outline"><Square className="size-2.5 fill-current" />{taskActionPending === "interrupt" ? "Interrupting…" : "Interrupt"}</Button>
                ) : null}
                <PromptInputSubmit
                  className="text-ui-control h-7 w-auto min-w-[88px] shrink-0 gap-1.5 rounded-[5px] bg-[var(--c-run)] px-3 font-semibold text-[var(--c-bg)] hover:brightness-105"
                  disabled={
                    isSending
                    || attachmentsUploading
                    || (activeTurnId !== null && storedUploadIds.length > 0)
                    || !draft.trim()
                    || !activeProvider
                    || (!activeThreadId && !selectedSavedProject)
                  }
                  status={isSending ? "submitted" : "ready"}
                >
                  {isSending ? (activeTurnId ? "Steering…" : "Starting…") : activeTurnId ? "Steer run" : "Start task"}
                  <ArrowRight className="size-3" />
                </PromptInputSubmit>
              </div>
            </PromptInputFooter>
          </PromptInput>
          <div className="text-ui-meta mx-auto mt-1.5 flex max-w-[820px] flex-wrap items-center gap-x-3 gap-y-1 px-0.5 font-mono text-[var(--ink-4)]">
            <span>⏎ {activeTurnId ? "steer" : "start"} · ⇧⏎ newline · ⌘. interrupt</span>
            <span>full access requires org admin</span>
            <span>{activeTurnId ? "Steering is queued into the current turn — it does not interrupt the tool in flight." : "A new isolated Codex task will start in the selected worktree."}</span>
            <button
              aria-controls="terminal-dock"
              aria-expanded={dockOpen}
              className="ml-auto inline-flex items-center gap-1.5 rounded-sm text-[var(--ink-3)] transition-colors hover:text-[var(--ink-1)]"
              onClick={() => setDockOpen((open) => !open)}
              type="button"
            >
              <TerminalSquare aria-hidden="true" className="size-3" />
              Terminal dock
              <span className="text-[var(--c-wait)]">
                {dashboard.runtime.activeRuntimes} session{dashboard.runtime.activeRuntimes === 1 ? "" : "s"}
              </span>
            </button>
            </div>
            {dockOpen ? (
              <div
                className="ah-rise mx-auto mt-2 max-w-[820px] overflow-hidden rounded-md border border-[var(--c-line)]"
                id="terminal-dock"
              >
                <div className="flex items-center gap-2 border-b border-[var(--c-hair)] bg-[var(--c-plate)] px-2.5 py-1.5">
                  <span className="text-ui-meta font-mono text-[var(--ink-2)]">
                    Supervised runtime
                  </span>
                  <span className="text-ui-meta font-mono text-[var(--ink-4)]">
                    {dashboard.runtime.status} · {dashboard.runtime.activeRuntimes} app-server
                    {dashboard.runtime.activeRuntimes === 1 ? "" : "s"}
                  </span>
                  <AvailabilityBadge state="FUTURE" />
                  <Button
                    aria-label="Close terminal dock"
                    className="ml-auto size-5"
                    onClick={() => setDockOpen(false)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <X className="size-3" />
                  </Button>
                </div>
                <div className="bg-[var(--term-bg)] px-3 py-2.5">
                  <p className="text-ui-body text-[var(--ink-2)]">
                    An interactive shell into the task sandbox is not exposed by
                    the runtime API, so no session is attached here.
                  </p>
                  <p className="text-ui-meta mt-1.5 font-mono text-[var(--ink-4)]">
                    Command output is already in the Run Spine above — every
                    executed command arrives as a timeline event with its exit
                    status.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>

          <TaskInspector
            activeThread={activeThread}
            dashboard={dashboard}
            onOpenChange={setInspectorOpen}
            open={inspectorOpen}
            timeline={timeline}
          />
        </div>
      </main>

      <Dialog
        onOpenChange={(open) => {
          setRenameOpen(open);
          if (!open) setActionError(null);
        }}
        open={renameOpen}
      >
        <DialogContent className="border-border bg-[#191c21] sm:max-w-md">
          <form onSubmit={submitRename}>
            <DialogHeader>
              <DialogTitle>Rename task</DialogTitle>
              <DialogDescription>
                The name is stored by the Codex runtime and does not need to be unique.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-5">
              <label className="text-ui-control grid gap-2 text-muted-foreground">
                Task name
                <Input
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                  value={renameValue}
                />
              </label>
              {actionError ? <p className="text-ui-meta text-red-300" role="alert">{actionError}</p> : null}
            </div>
            <DialogFooter>
              <Button onClick={() => setRenameOpen(false)} type="button" variant="ghost">Cancel</Button>
              <Button disabled={!renameValue.trim() || taskActionPending !== null} type="submit">
                {taskActionPending === "rename" ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          setArchiveOpen(open);
          if (!open) setActionError(null);
        }}
        open={archiveOpen}
      >
        <DialogContent className="border-border bg-[#191c21] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive this task?</DialogTitle>
            <DialogDescription>
              Codex moves the persisted task and its spawned descendants into archived storage. Files in the workspace are not deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="text-ui-body rounded-md border border-amber-300/15 bg-amber-300/[0.04] px-3 py-2.5 text-amber-100/75">
            Restore is supported by the server API; the archived-task browser is still being added to the shell.
          </div>
          {actionError ? <p className="text-ui-meta text-red-300" role="alert">{actionError}</p> : null}
          <DialogFooter>
            <Button onClick={() => setArchiveOpen(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={taskActionPending !== null} onClick={() => void confirmArchive()} type="button" variant="outline">
              {taskActionPending === "archive" ? "Archiving…" : "Archive task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
