import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardPayload, ThreadSummary, TimelineItem } from "@agent-harness/contracts";
import {
  Activity,
  AlertTriangle,
  Blocks,
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDot,
  FileCheck2,
  FolderGit2,
  GitBranch,
  PackageSearch,
  ServerCog,
  ShieldCheck,
  Workflow,
  Wrench,
} from "lucide-react";
import {
  AvailabilityBadge,
  type Availability,
} from "@/components/AvailabilityBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OperationsViewId } from "@/lib/view";

export type CapabilityKind = "mcp_server" | "tool" | "skill";
export type CapabilityStatus = "ready" | "disabled" | "blocked" | "error" | "unknown";

export interface CapabilityInventoryItem {
  id: string;
  name: string;
  kind: CapabilityKind;
  status: CapabilityStatus;
  description?: string | null;
  source?: string | null;
  version?: string | null;
}

export interface CapabilityInventoryPayload {
  items: readonly CapabilityInventoryItem[];
  inventorySummary?: {
    mcpServers: { count: number; truncated: boolean } | null;
    tools: { count: number; truncated: boolean } | null;
    skills: { count: number; truncated: boolean; loadErrorCount: number } | null;
  };
  runtimeSurfaces?: {
    models: { count: number; defaultModel: string | null; truncated: boolean } | null;
    permissionProfiles: {
      count: number;
      allowedInAnyWorkspaceCount: number;
      workspaceCount: number;
      truncated: boolean;
    } | null;
    providerCapabilities: {
      namespaceTools: boolean;
      imageGeneration: boolean;
      webSearch: boolean;
    } | null;
  };
  updatedAt?: string | null;
  warnings?: readonly string[];
}

interface OperationsViewProps {
  view: OperationsViewId;
  dashboard: DashboardPayload;
  capabilities?: CapabilityInventoryPayload | null;
  capabilitiesLoading?: boolean;
  capabilitiesError?: string | null;
  activeThreadId?: string | null;
  timeline?: readonly TimelineItem[];
  onOpenSidebar: () => void;
  onStartReview: (threadId: string) => Promise<void>;
  onSelectThread: (threadId: string) => void;
}

interface ReviewDiffRow {
  kind: "addition" | "deletion" | "context" | "hunk";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

function parseReviewDiff(body: string): {
  additions: number;
  deletions: number;
  rows: ReviewDiffRow[];
} {
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;
  const rows: ReviewDiffRow[] = [];

  for (const sourceLine of body.split("\n")) {
    const hunk = sourceLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: sourceLine });
      continue;
    }
    if (sourceLine.startsWith("+++") || sourceLine.startsWith("---")) {
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: sourceLine });
      continue;
    }
    if (sourceLine.startsWith("+")) {
      additions += 1;
      rows.push({ kind: "addition", oldLine: null, newLine, text: sourceLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (sourceLine.startsWith("-")) {
      deletions += 1;
      rows.push({ kind: "deletion", oldLine, newLine: null, text: sourceLine.slice(1) });
      oldLine += 1;
      continue;
    }
    rows.push({
      kind: "context",
      oldLine,
      newLine,
      text: sourceLine.startsWith(" ") ? sourceLine.slice(1) : sourceLine,
    });
    oldLine += 1;
    newLine += 1;
  }

  return { additions, deletions, rows };
}

function visibleWhitespace(value: string): string {
  return value.replaceAll("\t", "→   ").replaceAll(" ", "·");
}


const pageCopy: Record<
  OperationsViewId,
  { title: string; subtitle: string; availability: Availability }
> = {
  reviews: {
    title: "Reviews",
    subtitle: "Run Codex reviews and inspect their real task evidence without synthesized findings.",
    availability: "LIVE",
  },
  agents: {
    title: "Agents",
    subtitle: "Supervise live task states and show hierarchy only when Codex reports parent and child relationships.",
    availability: "READ-ONLY",
  },
  environments: {
    title: "Environments",
    subtitle: "Inspect effective runtime state and task workspaces reported by Codex.",
    availability: "READ-ONLY",
  },
  capabilities: {
    title: "Capabilities",
    subtitle: "Inspect reported MCP, tool, skill, model, policy, and provider capability summaries.",
    availability: "READ-ONLY",
  },
};

function PageHeader({ view }: { view: OperationsViewId }) {
  const copy = pageCopy[view];
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);

  return (
    <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-7">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1
            className="text-lg font-medium tracking-[-0.025em]"
            ref={headingRef}
            tabIndex={-1}
          >
            {copy.title}
          </h1>
          <AvailabilityBadge state={copy.availability} />
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-body text-muted-foreground sm:truncate">
          {copy.subtitle}
        </p>
      </div>
    </header>
  );
}

function PageScrollRegion({
  view,
  children,
}: {
  view: OperationsViewId;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-label={`${pageCopy[view].title} content`}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-7"
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  tone?: "agent" | "human" | "waiting" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-4">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4",
          tone === "agent" && "text-primary",
          tone === "human" && "text-human",
          tone === "waiting" && "text-[var(--waiting)]",
          tone === "neutral" && "text-[#929aa4]",
        )}
      />
      <p className="mt-4 text-2xl font-medium tracking-tight">{value}</p>
      <p className="mt-1 text-ui-control text-muted-foreground">{label}</p>
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formattedTimestamp(value: string): string {
  const timestamp = timestampValue(value);
  return timestamp ? dateTime.format(timestamp) : "Time unavailable";
}

function threadStatusStyle(status: ThreadSummary["status"]): string {
  if (status === "completed") return "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300";
  if (status === "failed") return "border-red-400/20 bg-red-400/[0.07] text-red-300";
  if (status === "waiting") return "border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.07] text-[var(--waiting)]";
  if (status === "running") return "border-primary/20 bg-primary/[0.07] text-primary";
  return "border-border bg-white/[0.035] text-muted-foreground";
}

function ThreadStatusBadge({ status }: { status: ThreadSummary["status"] }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-[0.12em]",
        threadStatusStyle(status),
      )}
    >
      {status}
    </span>
  );
}

function OpenTaskButton({
  thread,
  onSelectThread,
}: {
  thread: ThreadSummary;
  onSelectThread: (threadId: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <AvailabilityBadge state="LIVE" />
      <Button
        aria-label={`Open ${thread.title} task`}
        className="gap-1.5"
        onClick={() => onSelectThread(thread.id)}
        size="sm"
        variant="ghost"
      >
        Open task
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

function AgentTreeNode({
  thread,
  childrenByParent,
  onSelectThread,
  depth = 0,
  ancestors = new Set<string>(),
}: {
  thread: ThreadSummary;
  childrenByParent: ReadonlyMap<string, ThreadSummary[]>;
  onSelectThread: (threadId: string) => void;
  depth?: number;
  ancestors?: ReadonlySet<string>;
}) {
  const cycle = ancestors.has(thread.id);
  if (cycle) {
    return (
      <li>
        <p className="ml-1 text-ui-body text-red-300">
          Cycle reported; repeated task {thread.agentNickname ?? thread.title} was not rendered again.
        </p>
      </li>
    );
  }

  const children = depth >= 8 ? [] : childrenByParent.get(thread.id) ?? [];
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(thread.id);
  return (
    <li>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/25 p-4 sm:flex-row sm:items-center">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-human/20 bg-human/[0.06]">
          <Bot aria-hidden="true" className="size-4 text-human" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-ui-control font-medium">
              {thread.agentNickname ?? thread.title}
            </h3>
            <ThreadStatusBadge status={thread.status} />
          </div>
          <p className="mt-1 truncate font-mono text-ui-meta text-muted-foreground">
            {thread.agentRole ?? (thread.parentThreadId ? "subagent" : "root task")}
            {thread.source ? ` · ${thread.source}` : ""}
            {children.length ? ` · ${children.length} child${children.length === 1 ? "" : "ren"}` : ""}
          </p>
        </div>
        <OpenTaskButton onSelectThread={onSelectThread} thread={thread} />
      </div>
      {children.length ? (
        <ul className="ml-4 mt-2 space-y-2 border-l border-border pl-4">
          {children.map((child) => (
            <AgentTreeNode
              ancestors={nextAncestors}
              childrenByParent={childrenByParent}
              depth={depth + 1}
              key={child.id}
              onSelectThread={onSelectThread}
              thread={child}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ReviewsView({
  dashboard,
  activeThreadId,
  timeline = [],
  onStartReview,
  onSelectThread,
}: Pick<
  OperationsViewProps,
  "dashboard" | "activeThreadId" | "timeline" | "onStartReview" | "onSelectThread"
>) {
  const [reviewingThreadId, setReviewingThreadId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const candidates = dashboard.threads
    .filter(
      (thread) =>
        thread.status === "completed" || thread.status === "failed" || thread.status === "idle",
    )
    .toSorted((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
  const completedCount = candidates.filter((thread) => thread.status === "completed").length;
  const failedCount = candidates.filter((thread) => thread.status === "failed").length;
  const selectedThread =
    candidates.find((thread) => thread.id === selectedThreadId) ?? candidates[0] ?? null;
  const reviewTimeline = selectedThread?.id === activeThreadId
    ? timeline
    : dashboard.featuredThread && dashboard.featuredThread.thread.id === selectedThread?.id
      ? dashboard.featuredThread.timeline
      : [];
  const fileChanges = reviewTimeline.filter((item) => item.kind === "file_change");
  const selectedFile = fileChanges.find((item) => item.id === selectedFileId) ?? fileChanges[0] ?? null;
  const parsedDiff = useMemo(
    () => selectedFile ? parseReviewDiff(selectedFile.body) : null,
    [selectedFile],
  );
  const findings = reviewTimeline.filter(
    (item) => item.status === "failed" || (item.kind === "approval" && item.status === "pending"),
  );
  const highFindings = findings.filter((item) => item.status === "failed").length;
  const mediumFindings = findings.length - highFindings;
  const reviewTurnCount = Math.max(1, reviewTimeline.filter((item) => item.kind === "user").length);
  const reviewStatusLabel = selectedThread?.status === "failed"
    ? `Failed · ${reviewTurnCount} turn${reviewTurnCount === 1 ? "" : "s"}`
    : findings.length
      ? `Partial success · ${reviewTurnCount} turn${reviewTurnCount === 1 ? "" : "s"}`
      : selectedThread?.status === "completed"
        ? `Success · ${reviewTurnCount} turn${reviewTurnCount === 1 ? "" : "s"}`
        : "Review ready";

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  async function startReview(threadId: string) {
    setReviewError(null);
    setReviewingThreadId(threadId);
    try {
      await onStartReview(threadId);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "The review could not start.");
    } finally {
      setReviewingThreadId(null);
    }
  }

  function exportSelectedReview() {
    if (!selectedThread) return;
    const payload = JSON.stringify({ thread: selectedThread, timeline: reviewTimeline }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedThread.id}-review.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex min-h-[58px] shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="inline-flex h-5 shrink-0 items-center justify-center rounded-[4px] border border-[color-mix(in_oklab,var(--c-verified)_40%,transparent)] bg-[color-mix(in_oklab,var(--c-verified)_14%,transparent)] px-[7px] font-mono text-ui-micro uppercase tracking-[0.1em] text-[var(--c-verified)]">
          <CircleCheck aria-hidden="true" className="mr-2 size-3" />
          {selectedThread ? reviewStatusLabel : "Review queue"}
        </span>
        <div className="min-w-0 flex-1">
          <h1
            aria-label="Reviews"
            className="line-clamp-2 text-ui-title font-semibold tracking-[-0.015em]"
            ref={headingRef}
            tabIndex={-1}
          >
            {selectedThread
              ? selectedThread.title.split(" ").map((word, index) => (
                  <span key={`${word}-${index}`}>
                    {index > 0 ? " " : ""}{word}
                  </span>
                ))
              : "Reviews"}
          </h1>
        </div>
        {selectedThread ? (
          <>
            <p className="hidden w-[197px] shrink-0 font-mono text-ui-meta text-muted-foreground min-[1600px]:block">
              {selectedThread.projectName ?? "No project reported"} · {dashboard.projects.find((project) => project.id === selectedThread.projectId)?.branch ?? "branch not reported"}
              <br />
              updated · {formattedTimestamp(selectedThread.updatedAt)}
            </p>
            <div className="ml-auto hidden min-w-0 items-center gap-1 min-[1160px]:flex">
              <Button
                className="h-auto min-h-8 min-w-0 whitespace-normal bg-[var(--c-surface)] px-2.5 py-1 text-ui-control text-[var(--ink-2)] shadow-none"
                onClick={() => onSelectThread(selectedThread.id)}
                variant="outline"
              >
                Follow-up turn
              </Button>
              <Button className="hidden h-auto min-h-8 min-w-0 whitespace-normal bg-[var(--c-surface)] px-2.5 py-1 text-ui-control text-[var(--ink-2)] shadow-none disabled:opacity-100 min-[1600px]:inline-flex" disabled title="Fork this task from its task cockpit" variant="outline">Fork from turn {reviewTurnCount}</Button>
              <Button className="h-auto min-h-8 min-w-0 whitespace-normal bg-[var(--c-surface)] px-2.5 py-1 text-ui-control text-[var(--ink-2)] shadow-none" disabled={reviewingThreadId !== null} onClick={() => void startReview(selectedThread.id)} variant="outline">{reviewingThreadId === selectedThread.id ? "Starting…" : "Retry failed step"}</Button>
              <Button className="hidden h-auto min-h-8 min-w-0 whitespace-normal bg-[var(--c-surface)] px-2.5 py-1 text-ui-control text-[var(--ink-2)] shadow-none disabled:opacity-100 min-[1600px]:inline-flex" disabled title="History compaction is not reported by this runtime" variant="outline">Compact history</Button>
              <Button className="hidden h-auto min-h-8 min-w-0 whitespace-normal bg-[var(--c-surface)] px-2.5 py-1 text-ui-control text-[var(--ink-2)] shadow-none disabled:opacity-100 min-[1600px]:inline-flex" disabled title="Archive from the task cockpit" variant="outline">Archive</Button>
              <Button className="h-auto min-h-8 min-w-0 whitespace-normal bg-[var(--c-surface)] px-2.5 py-1 text-ui-control text-[var(--ink-2)] shadow-none" onClick={exportSelectedReview} variant="outline">Export</Button>
            </div>
          </>
        ) : null}
      </header>

      {reviewError ? (
        <div className="shrink-0 border-b border-red-400/20 bg-red-400/[0.05] px-5 py-3 text-ui-body text-red-200" role="alert">
          {reviewError}
        </div>
      ) : null}

      {selectedThread ? (
        <div className="min-h-0 flex-1 overflow-y-auto min-[1180px]:grid min-[1180px]:grid-cols-[372px_minmax(0,1fr)] min-[1180px]:overflow-hidden">
          <aside
            aria-label="Selected review summary"
            className="border-b border-border px-5 py-5 min-[1180px]:overflow-y-auto min-[1180px]:border-b-0 min-[1180px]:border-r"
          >
            <section>
              <p className="font-mono text-ui-micro uppercase tracking-[0.18em] text-muted-foreground">
                What changed
              </p>
              <p className="mt-3 text-sm leading-6 text-foreground/90">
                {selectedThread.preview || "No task preview was reported."}
              </p>
            </section>

            <section className="mt-4 rounded-md border border-[var(--waiting)]/25 bg-[var(--waiting)]/[0.09] px-4 py-3.5">
              <div className="flex items-center gap-2 text-ui-control font-medium text-[var(--waiting)]">
                <AlertTriangle aria-hidden="true" className="size-4" />
                Review evidence is task-bound
              </div>
              <p className="mt-2 text-ui-body text-foreground/70">
                Derived from current task status and preview fields. No findings or file diffs are inferred.
              </p>
            </section>

            <section className="mt-5">
              <p className="font-mono text-ui-micro uppercase tracking-[0.18em] text-muted-foreground">
                Reported evidence
              </p>
              <dl className="mt-2 divide-y divide-border border-y border-border">
                <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3">
                  <span aria-hidden="true" className="mt-1 size-2.5 rounded-[2px] bg-cyan-300" />
                  <div>
                    <dt className="text-ui-control font-medium">Task state</dt>
                    <dd className="mt-1 font-mono text-ui-meta capitalize text-muted-foreground">
                      {selectedThread.status}
                    </dd>
                  </div>
                </div>
                <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3">
                  <span aria-hidden="true" className="mt-1 size-2.5 rounded-[2px] bg-cyan-300" />
                  <div>
                    <dt className="text-ui-control font-medium">Runtime model</dt>
                    <dd className="mt-1 truncate font-mono text-ui-meta text-muted-foreground">
                      {selectedThread.model || "No model reported"}
                    </dd>
                  </div>
                </div>
                <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3">
                  <span aria-hidden="true" className="mt-1 size-2.5 rounded-[2px] bg-cyan-300" />
                  <div>
                    <dt className="text-ui-control font-medium">Last task update</dt>
                    <dd className="mt-1 font-mono text-ui-meta text-muted-foreground">
                      {formattedTimestamp(selectedThread.updatedAt)}
                    </dd>
                  </div>
                </div>
              </dl>
            </section>

            <section aria-label="Review summary" className="mt-5">
              <p className="font-mono text-ui-micro uppercase tracking-[0.18em] text-muted-foreground">
                Totals
              </p>
              <dl className="mt-2 grid grid-cols-2 overflow-hidden rounded-md border border-border">
                {[
                  ["Candidates", candidates.length],
                  ["Completed", completedCount],
                  ["Failed", failedCount],
                  ["Requests", dashboard.usage.requestsUsed],
                  ["Input tokens", dashboard.usage.inputTokens.toLocaleString()],
                  ["Output tokens", dashboard.usage.outputTokens.toLocaleString()],
                ].map(([label, value], index) => (
                  <div
                    className={cn(
                      "min-h-16 px-3 py-2.5",
                      index % 2 === 0 && "border-r border-border",
                      index < 4 && "border-b border-border",
                    )}
                    key={label}
                  >
                    <dt className="font-mono text-ui-micro uppercase tracking-[0.16em] text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="mt-1.5 font-mono text-sm text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {fileChanges.length ? (
              <section aria-labelledby="review-artifacts-heading" className="mt-5">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="font-mono text-ui-micro uppercase tracking-[0.18em] text-muted-foreground" id="review-artifacts-heading">
                    Artifacts
                  </h2>
                  <span className="font-mono text-ui-meta text-muted-foreground">{fileChanges.length}</span>
                </div>
                <div className="space-y-1">
                  {fileChanges.map((file) => (
                    <button
                      aria-pressed={selectedFile?.id === file.id}
                      className={cn(
                        "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[4px] border px-2.5 py-1 text-left font-mono text-ui-control",
                        selectedFile?.id === file.id
                          ? "border-[var(--c-run-line)] bg-[var(--c-run-dim)] text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent/35 hover:text-foreground",
                      )}
                      key={file.id}
                      onClick={() => setSelectedFileId(file.id)}
                      type="button"
                    >
                      <FileCheck2 aria-hidden="true" className="size-3.5 shrink-0 text-[var(--c-info)]" />
                      <span className="min-w-0 flex-1 truncate">{file.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <section aria-labelledby="review-candidates-heading" className="mt-5 border-t border-border pt-4">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="font-mono text-ui-micro uppercase tracking-[0.18em] text-muted-foreground" id="review-candidates-heading">
                  Review candidates
                </h2>
                <span className="font-mono text-ui-meta text-muted-foreground">{candidates.length}</span>
              </div>
              <div className="space-y-1">
                {candidates.map((thread) => {
                  const selected = thread.id === selectedThread.id;
                  return (
                    <button
                      aria-label={`Inspect review candidate ${thread.title}`}
                      aria-pressed={selected}
                      className={cn(
                        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[4px] border px-2.5 py-2 text-left transition-colors hover:bg-white/[0.025]",
                        selected
                          ? "border-[var(--c-run-line)] bg-[var(--c-run-dim)]"
                          : "border-transparent",
                      )}
                      key={thread.id}
                      onClick={() => setSelectedThreadId(thread.id)}
                      type="button"
                    >
                      <span aria-hidden="true" className={cn("size-2 rounded-[2px]", thread.status === "failed" ? "bg-[var(--c-fail)]" : "bg-[var(--c-verified)]")} />
                      <span className="min-w-0 truncate text-ui-control font-medium">{thread.title}</span>
                      <ThreadStatusBadge status={thread.status} />
                    </button>
                  );
                })}
              </div>
            </section>
          </aside>

          <section className="flex min-h-[560px] min-w-0 flex-col min-[1180px]:min-h-0 min-[1180px]:overflow-hidden">
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
              <p className="min-w-0 flex-1 truncate font-mono text-ui-meta text-foreground/85">
                {selectedFile?.title ?? selectedThread.projectName ?? "No project reported"}
                {parsedDiff ? (
                  <span className="ml-2">
                    <span className="text-[var(--syn-add)]">+{parsedDiff.additions}</span>
                    <span className="ml-2 text-[var(--syn-del)]">-{parsedDiff.deletions}</span>
                  </span>
                ) : (
                  <span className="ml-2 text-muted-foreground">task/{selectedThread.id}</span>
                )}
              </p>
              <span className="font-mono text-ui-micro uppercase tracking-[0.12em] text-muted-foreground">
                {parsedDiff ? "Evidence reported" : "Evidence pending"}
              </span>
              <Button disabled size="sm" variant="outline">Split</Button>
              <Button aria-pressed="true" disabled size="sm" variant="secondary">Unified</Button>
              <Button
                aria-pressed={showWhitespace}
                disabled={!parsedDiff}
                onClick={() => setShowWhitespace((current) => !current)}
                size="sm"
                variant={showWhitespace ? "secondary" : "outline"}
              >
                Whitespace
              </Button>
            </header>

            {parsedDiff ? (
              <div aria-label={`${selectedFile?.title ?? "File"} unified diff`} className="min-h-72 flex-1 overflow-auto bg-[var(--term-bg)]" role="region" tabIndex={0}>
                <div className="min-w-max py-2 font-mono text-ui-code leading-[22px]">
                  {parsedDiff.rows.map((row, index) => (
                    <div
                      className={cn(
                        "grid min-h-[22px] grid-cols-[42px_42px_minmax(640px,1fr)]",
                        row.kind === "addition" && "bg-[var(--syn-add-bg)]",
                        row.kind === "deletion" && "bg-[var(--syn-del-bg)]",
                        row.kind === "hunk" && "bg-[var(--c-surface)] text-[var(--ink-3)]",
                      )}
                      key={`${row.kind}-${index}`}
                    >
                      <span className="select-none border-r border-white/[0.025] pr-2 text-right text-[var(--ink-4)]">{row.oldLine ?? ""}</span>
                      <span className="select-none border-r border-white/[0.025] pr-2 text-right text-[var(--ink-4)]">{row.newLine ?? ""}</span>
                      <span className={cn("whitespace-pre px-3", row.kind === "addition" && "text-[var(--syn-add)]", row.kind === "deletion" && "text-[var(--syn-del)]")}>
                        <span aria-hidden="true" className="inline-block w-3 select-none">{row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : row.kind === "hunk" ? "" : " "}</span>
                        {showWhitespace ? visibleWhitespace(row.text) : row.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="relative grid min-h-72 flex-1 place-items-center overflow-hidden bg-black/20 px-6 py-12">
                <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_31px,color-mix(in_srgb,var(--border)_34%,transparent)_32px)] bg-[length:100%_32px] opacity-35" />
                <div className="relative max-w-lg text-center">
                  <span className="mx-auto grid size-10 place-items-center rounded-md border border-border bg-card/50">
                    <FileCheck2 aria-hidden="true" className="size-4 text-muted-foreground" />
                  </span>
                  <h2 className="mt-4 text-sm font-medium">No structured diff has been reported yet</h2>
                  <p className="mt-2 text-ui-body text-muted-foreground">
                    Start a Codex review turn to collect file changes and findings. This surface stays empty until the runtime returns verifiable evidence.
                  </p>
                </div>
              </div>
            )}

            <section className="h-[34%] min-h-36 shrink-0 overflow-y-auto border-t border-border">
              <div className="flex h-10 items-center gap-2 border-b border-border px-4">
                <h2 className="text-ui-control font-semibold">Review pass</h2>
                <span className="font-mono text-ui-meta text-muted-foreground">{findings.length} finding{findings.length === 1 ? "" : "s"} · runtime evidence</span>
                <span className="ml-auto rounded-[3px] border border-[var(--c-fail-dim)] bg-[var(--c-fail-dim)] px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-[0.12em] text-[var(--c-fail)]">{highFindings} high</span>
                <span className="rounded-[3px] border border-[var(--c-wait-dim)] bg-[var(--c-wait-dim)] px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-[0.12em] text-[var(--c-wait)]">{mediumFindings} medium</span>
              </div>
              {findings.length ? (
                <div className="divide-y divide-border">
                  {findings.map((finding) => {
                    const high = finding.status === "failed";
                    const reportedPath = finding.metadata?.path ?? finding.metadata?.file;
                    return (
                      <article className="grid min-h-[76px] grid-cols-[76px_minmax(0,1fr)]" key={finding.id}>
                        <div className={cn("grid place-items-center border-r border-border font-mono text-ui-micro uppercase tracking-[0.14em]", high ? "bg-[var(--c-fail-dim)] text-[var(--c-fail)]" : "bg-[var(--c-wait-dim)] text-[var(--c-wait)]")}>{high ? "High" : "Medium"}</div>
                        <div className="min-w-0 px-3.5 py-2.5">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h3 className="truncate text-ui-control font-semibold">{finding.title}</h3>
                            {reportedPath !== undefined && reportedPath !== null ? <span className="truncate font-mono text-ui-meta text-muted-foreground">{String(reportedPath)}</span> : null}
                          </div>
                          <p className="mt-1 line-clamp-2 text-ui-body text-muted-foreground">{finding.body || "The runtime reported this review condition without additional detail."}</p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="grid min-h-28 place-items-center px-6 py-5 text-center">
                  <div className="max-w-md">
                    <p className="text-ui-control font-medium">No review findings have been reported</p>
                    <p className="mt-1.5 text-ui-body text-muted-foreground">Run the Codex review to populate this pane with severity-ranked, file-bound findings.</p>
                  </div>
                </div>
              )}
            </section>
          </section>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-8 text-center">
          <div className="max-w-md">
            <FileCheck2 aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-medium">No review candidates are reported</h2>
            <p className="mt-2 text-ui-body text-muted-foreground">
              Completed, failed, and idle tasks will appear here. Running and waiting tasks remain in the task cockpit.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function agentHierarchyRoots(
  threads: readonly ThreadSummary[],
  childrenByParent: ReadonlyMap<string, ThreadSummary[]>,
  threadById: ReadonlyMap<string, ThreadSummary>,
): ThreadSummary[] {
  const hierarchyNodes = threads.filter(
    (thread) => Boolean(thread.parentThreadId) || childrenByParent.has(thread.id),
  );
  const hierarchyIds = new Set(hierarchyNodes.map((thread) => thread.id));
  const visited = new Set<string>();
  const roots: ThreadSummary[] = [];

  for (const start of hierarchyNodes) {
    if (visited.has(start.id)) continue;

    const component: ThreadSummary[] = [];
    const pending = [start];
    visited.add(start.id);
    while (pending.length > 0) {
      const thread = pending.pop();
      if (!thread) continue;
      component.push(thread);

      const parentId = thread.parentThreadId;
      if (parentId && hierarchyIds.has(parentId) && !visited.has(parentId)) {
        const parent = threadById.get(parentId);
        if (parent) {
          visited.add(parentId);
          pending.push(parent);
        }
      }
      for (const child of childrenByParent.get(thread.id) ?? []) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        pending.push(child);
      }
    }

    const reportedRoot = component.find(
      (thread) => !thread.parentThreadId || !hierarchyIds.has(thread.parentThreadId),
    );
    if (reportedRoot) {
      roots.push(reportedRoot);
      continue;
    }

    // A component without a reported root contains a parent cycle. Follow
    // ancestry from any member until it repeats so rendering begins on the
    // cycle and can reach every descendant in that component.
    let cycleRoot = component[0];
    const ancestry = new Set<string>();
    while (cycleRoot && !ancestry.has(cycleRoot.id)) {
      ancestry.add(cycleRoot.id);
      const parentId = cycleRoot.parentThreadId;
      if (!parentId || !hierarchyIds.has(parentId)) break;
      cycleRoot = threadById.get(parentId);
    }
    if (cycleRoot) roots.push(cycleRoot);
  }

  return roots;
}

function AgentsView({
  dashboard,
  onSelectThread,
}: Pick<OperationsViewProps, "dashboard" | "onSelectThread">) {
  const activeTasks = dashboard.threads
    .filter((thread) => thread.status === "running" || thread.status === "waiting")
    .toSorted((left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt));
  const waitingCount = activeTasks.filter((thread) => thread.status === "waiting").length;
  const childTasks = dashboard.threads.filter((thread) => Boolean(thread.parentThreadId));
  const threadById = new Map(dashboard.threads.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map<string, ThreadSummary[]>();
  for (const child of childTasks) {
    const parentId = child.parentThreadId;
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(child);
    childrenByParent.set(parentId, siblings);
  }
  const visibleRoots = agentHierarchyRoots(
    dashboard.threads,
    childrenByParent,
    threadById,
  );

  return (
    <div className="mx-auto max-w-5xl">
      <section aria-label="Agent supervision summary" className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={Activity} label="Reported child tasks" tone="agent" value={childTasks.length} />
        <MetricCard icon={AlertTriangle} label="Tasks waiting for attention" tone="waiting" value={waitingCount} />
        <MetricCard icon={ServerCog} label="Active user runtimes" value={dashboard.runtime.activeRuntimes} />
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card/20 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-human/20 bg-human/[0.06]">
              <Workflow aria-hidden="true" className="size-4 text-human" />
            </span>
            <div>
              <h2 className="text-sm font-medium">
                {childTasks.length ? "Reported task hierarchy" : "No agent hierarchy is reported"}
              </h2>
              <p className="mt-1 max-w-2xl text-ui-body text-muted-foreground">
                {childTasks.length
                  ? "This tree comes only from Codex parentThreadId, nickname, role, source, and task state fields."
                  : "Codex did not report parent/child task metadata in this snapshot. Agent Harness will not infer child agents from titles or activity."}
              </p>
            </div>
          </div>
          <AvailabilityBadge state="READ-ONLY" />
        </div>
        {childTasks.length ? (
          <ul aria-label="Agent task hierarchy" className="mt-5 space-y-2">
            {visibleRoots.map((thread) => (
              <AgentTreeNode
                childrenByParent={childrenByParent}
                key={thread.id}
                onSelectThread={onSelectThread}
                thread={thread}
              />
            ))}
          </ul>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border/70 pt-4 text-ui-control text-muted-foreground">
          <span>Open child task</span><AvailabilityBadge state="LIVE" />
          <span className="ml-2">Browser-driven spawn/message</span><AvailabilityBadge state="FUTURE" />
          <span className="ml-2">Merge into parent</span><AvailabilityBadge state="FUTURE" />
        </div>
      </section>

      <div className="mt-7">
        <h2 className="text-sm font-medium">Live task states</h2>
        <p className="mt-1 text-ui-body text-muted-foreground">
          These are current tasks, not an inferred parent/child tree.
        </p>
      </div>
      {activeTasks.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
          <Bot aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No active task states</h3>
          <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
            Agent Harness currently reports no running or waiting tasks for this workspace.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card/25">
          <div className="hidden grid-cols-[minmax(0,1fr)_110px_150px_140px] gap-3 border-b border-border px-4 py-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground sm:grid">
            <span>Task</span><span>State</span><span>Updated</span><span />
          </div>
          {activeTasks.map((thread) => (
            <div className="flex flex-col gap-3 border-b border-border/60 p-4 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,1fr)_110px_150px_140px] sm:items-center" key={thread.id}>
              <div className="min-w-0">
                <p className="truncate text-ui-control font-medium">{thread.title}</p>
                <p className="mt-1 truncate font-mono text-ui-meta text-muted-foreground">
                  {thread.projectName ?? "No project reported"}
                </p>
              </div>
              <ThreadStatusBadge status={thread.status} />
              <span className="font-mono text-ui-meta text-muted-foreground">{formattedTimestamp(thread.updatedAt)}</span>
              <OpenTaskButton onSelectThread={onSelectThread} thread={thread} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function runtimeTone(status: DashboardPayload["runtime"]["status"]): string {
  if (status === "ready") return "bg-emerald-400";
  if (status === "degraded") return "bg-[var(--waiting)]";
  return "bg-[#606873]";
}

function EnvironmentsView({ dashboard }: Pick<OperationsViewProps, "dashboard">) {
  return (
    <div className="mx-auto max-w-5xl">
      <section className="grid gap-3 lg:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-lg border border-border bg-card/25 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/[0.06]">
                <ServerCog aria-hidden="true" className="size-4 text-primary" />
              </span>
              <div>
                <p className="font-mono text-ui-micro uppercase tracking-[0.15em] text-muted-foreground">User runtime</p>
                <h2 className="mt-1 text-sm font-medium capitalize">{dashboard.runtime.status.replace("_", " ")}</h2>
              </div>
            </div>
            <AvailabilityBadge state="READ-ONLY" />
          </div>
          <p className="mt-4 text-ui-body text-muted-foreground">
            {dashboard.runtime.message ?? "The runtime did not report an additional status message."}
          </p>
          <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-4 text-ui-control">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", runtimeTone(dashboard.runtime.status))} />
              Runtime state
            </span>
            <span className="font-mono text-ui-meta capitalize">{dashboard.runtime.status.replace("_", " ")}</span>
          </div>
          <div className="mt-3 flex items-center justify-between text-ui-control">
            <span className="text-muted-foreground">Active user runtimes</span>
            <span className="font-mono text-ui-meta">{dashboard.runtime.activeRuntimes}</span>
          </div>
        </article>

        <article className="rounded-lg border border-border bg-card/25 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-ui-micro uppercase tracking-[0.15em] text-muted-foreground">Effective policy coverage</p>
              <h2 className="mt-1 text-sm font-medium">Reported fields only</h2>
            </div>
            <ShieldCheck aria-hidden="true" className="size-4 text-human" />
          </div>
          <dl className="mt-5 space-y-3 text-ui-control">
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Reported task workspaces</dt><dd className="font-mono text-ui-meta">{dashboard.projects.length} reported</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Sandbox policy</dt><dd className="font-mono text-ui-meta text-muted-foreground">Not reported</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Network policy</dt><dd className="font-mono text-ui-meta text-muted-foreground">Not reported</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Approval policy</dt><dd className="font-mono text-ui-meta text-muted-foreground">Not reported</dd></div>
          </dl>
          <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-4">
            <span className="text-ui-control text-muted-foreground">Policy mutation controls</span>
            <AvailabilityBadge state="FUTURE" />
          </div>
        </article>
      </section>

      <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Reported task workspaces</h2>
          <p className="mt-1 text-ui-body text-muted-foreground">
            Paths, repository state, and branches come directly from the current dashboard snapshot.
          </p>
        </div>
        <AvailabilityBadge state="READ-ONLY" />
      </div>

      {dashboard.projects.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
          <FolderGit2 aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No task workspaces are reported</h3>
          <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
            The environment view will not infer filesystem access from runtime task metadata.
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {dashboard.projects.map((project) => (
            <article className="rounded-lg border border-border bg-card/25 p-5" key={project.id}>
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-secondary/60">
                  <FolderGit2 aria-hidden="true" className="size-4 text-primary" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium">{project.name}</h3>
                  <p className="mt-1 truncate font-mono text-ui-meta text-muted-foreground" title={project.path}>{project.path}</p>
                </div>
                <span className="rounded-sm bg-white/[0.045] px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-wider text-muted-foreground">
                  {project.isGitRepository ? "git" : "folder"}
                </span>
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-4 text-ui-control">
                <span className="flex items-center gap-1.5 text-muted-foreground"><GitBranch aria-hidden="true" className="size-3.5" />Branch</span>
                <span className="max-w-[60%] truncate font-mono text-ui-meta">{project.branch ?? "Not reported"}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

const capabilityKindCopy: Record<CapabilityKind, { label: string; icon: typeof Blocks }> = {
  mcp_server: { label: "MCP server", icon: ServerCog },
  tool: { label: "Tool", icon: Wrench },
  skill: { label: "Skill", icon: Blocks },
};

function capabilityStatusStyle(status: CapabilityStatus): string {
  if (status === "ready") return "text-emerald-300";
  if (status === "error") return "text-red-300";
  if (status === "blocked") return "text-[var(--waiting)]";
  return "text-muted-foreground";
}

function CapabilitiesView({
  capabilities,
  capabilitiesLoading = false,
  capabilitiesError = null,
}: Pick<OperationsViewProps, "capabilities" | "capabilitiesLoading" | "capabilitiesError">) {
  if (capabilitiesLoading) {
    return (
      <div aria-busy="true" className="mx-auto max-w-5xl rounded-lg border border-border bg-card/25 p-8 text-center">
        <PackageSearch aria-hidden="true" className="mx-auto size-5 text-primary" />
        <h2 className="mt-3 text-sm font-medium">Loading capability inventory</h2>
        <p className="mt-2 text-ui-body text-muted-foreground">Waiting for the runtime-backed inventory response.</p>
      </div>
    );
  }

  if (capabilitiesError) {
    return (
      <div className="mx-auto max-w-5xl rounded-lg border border-red-400/20 bg-red-400/[0.045] p-6" role="alert">
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-300" />
          <div>
            <h2 className="text-sm font-medium">Capability inventory unavailable</h2>
            <p className="mt-1 text-ui-body text-muted-foreground">{capabilitiesError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!capabilities) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
          <PackageSearch aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h2 className="mt-3 text-sm font-medium">Capability inventory is not connected</h2>
          <p className="mx-auto mt-2 max-w-lg text-ui-body text-muted-foreground">
            No runtime inventory payload is available. Agent Harness will not invent MCP servers, tools, skills, versions, or health states.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <span className="text-ui-control text-muted-foreground">Inventory API</span>
            <AvailabilityBadge state="READ-ONLY" />
          </div>
        </div>
      </div>
    );
  }

  const kindCount = (kind: CapabilityKind) => capabilities.items.filter((item) => item.kind === kind).length;
  const reportedCount = (
    summary: { count: number; truncated: boolean } | null | undefined,
    fallback: number,
  ) => {
    if (summary === null) return "Unavailable";
    return `${summary?.truncated ? "≥" : ""}${summary?.count ?? fallback}`;
  };
  const inventorySummary = capabilities.inventorySummary;
  const reportedSkills = inventorySummary?.skills
    ? {
        ...inventorySummary.skills,
        truncated:
          inventorySummary.skills.truncated || inventorySummary.skills.loadErrorCount > 0,
      }
    : inventorySummary?.skills;
  const runtimeSurfaces = capabilities.runtimeSurfaces;
  const boundedSections = [
    inventorySummary?.mcpServers?.truncated ? "MCP servers" : null,
    inventorySummary?.tools?.truncated ? "tools" : null,
    reportedSkills?.truncated ? "skills" : null,
    runtimeSurfaces?.models?.truncated ? "models" : null,
    runtimeSurfaces?.permissionProfiles?.truncated ? "permission profiles" : null,
  ].filter((section): section is string => section !== null);
  const enabledProviderFeatures = runtimeSurfaces?.providerCapabilities
    ? Object.entries(runtimeSurfaces.providerCapabilities)
        .filter(([, enabled]) => enabled)
        .map(([feature]) => feature.replace(/([A-Z])/g, " $1").toLowerCase())
    : [];
  return (
    <div className="mx-auto max-w-5xl">
      <section aria-label="Capability inventory summary" className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          icon={ServerCog}
          label="Reported MCP servers"
          tone="agent"
          value={reportedCount(inventorySummary?.mcpServers, kindCount("mcp_server"))}
        />
        <MetricCard
          icon={Wrench}
          label="Reported tools"
          value={reportedCount(inventorySummary?.tools, kindCount("tool"))}
        />
        <MetricCard
          icon={Blocks}
          label="Reported skills"
          tone="human"
          value={reportedCount(reportedSkills, kindCount("skill"))}
        />
      </section>

      <section aria-label="Runtime model and policy surfaces" className="mt-3 grid gap-3 md:grid-cols-3">
        <article className="rounded-lg border border-border bg-card/25 p-4">
          <p className="font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Models</p>
          <p className="mt-2 text-sm font-medium">
            {runtimeSurfaces?.models
              ? `${runtimeSurfaces.models.truncated ? "≥" : ""}${runtimeSurfaces.models.count} models reported`
              : "Unavailable"}
          </p>
          <p className="mt-1 truncate text-ui-body text-muted-foreground">
            {runtimeSurfaces?.models?.defaultModel
              ? `Default: ${runtimeSurfaces.models.defaultModel}`
              : "No default model reported"}
          </p>
        </article>
        <article className="rounded-lg border border-border bg-card/25 p-4">
          <p className="font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Permission profiles</p>
          <p className="mt-2 text-sm font-medium">
            {runtimeSurfaces?.permissionProfiles
              ? `${runtimeSurfaces.permissionProfiles.truncated ? "≥" : ""}${runtimeSurfaces.permissionProfiles.count} profiles reported`
              : "Unavailable"}
          </p>
          <p className="mt-1 text-ui-body text-muted-foreground">
            {runtimeSurfaces?.permissionProfiles
              ? runtimeSurfaces.permissionProfiles.workspaceCount > 0
                ? `${runtimeSurfaces.permissionProfiles.allowedInAnyWorkspaceCount}${runtimeSurfaces.permissionProfiles.truncated ? " shown as" : ""} allowed in one or more of ${runtimeSurfaces.permissionProfiles.workspaceCount} workspace context${runtimeSurfaces.permissionProfiles.workspaceCount === 1 ? "" : "s"}`
                : "No workspace contexts reported"
              : "No policy inventory reported"}
          </p>
        </article>
        <article className="rounded-lg border border-border bg-card/25 p-4">
          <p className="font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Provider features</p>
          <p className="mt-2 text-sm font-medium">
            {runtimeSurfaces?.providerCapabilities
              ? `${enabledProviderFeatures.length}/3 enabled`
              : "Unavailable"}
          </p>
          <p className="mt-1 truncate text-ui-body text-muted-foreground">
            {enabledProviderFeatures.length
              ? enabledProviderFeatures.join(" · ")
              : runtimeSurfaces?.providerCapabilities
                ? "No optional features enabled"
                : "No provider feature inventory reported"}
          </p>
        </article>
      </section>

      {boundedSections.length ? (
        <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.045] px-4 py-3" role="status">
          <p className="text-ui-control font-medium text-cyan-200">Bounded capability inventory</p>
          <p className="mt-1 text-ui-body text-muted-foreground">
            Counts prefixed with ≥ are lower bounds because Codex truncated a reported section or reported skill load errors. Affected sections: {boundedSections.join(", ")}.
          </p>
        </div>
      ) : null}

      <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Installed inventory</h2>
          <p className="mt-1 font-mono text-ui-meta text-muted-foreground">
            {capabilities.updatedAt ? `Reported ${formattedTimestamp(capabilities.updatedAt)}.` : "No inventory timestamp was reported."}
          </p>
        </div>
        <AvailabilityBadge state="READ-ONLY" />
      </div>

      {capabilities.warnings?.length ? (
        <div className="mt-4 rounded-lg border border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.045] px-4 py-3" role="status">
          <p className="text-ui-control font-medium text-[var(--waiting)]">Partial runtime inventory</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-ui-body text-muted-foreground">
            {capabilities.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}

      {capabilities.items.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
          <Blocks aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No installed capabilities are reported</h3>
          <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
            The connected inventory returned an empty list. Marketplace entries are intentionally not shown.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card/25">
          <div className="hidden grid-cols-[minmax(0,1fr)_120px_110px_160px] gap-3 border-b border-border px-4 py-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground sm:grid">
            <span>Capability</span><span>Kind</span><span>Status</span><span>Source</span>
          </div>
          {capabilities.items.map((item) => {
            const kind = capabilityKindCopy[item.kind];
            const Icon = kind.icon;
            return (
              <article className="flex flex-col gap-3 border-b border-border/60 p-4 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,1fr)_120px_110px_160px] sm:items-center" key={item.id}>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-secondary/60">
                    <Icon aria-hidden="true" className="size-3.5 text-[#c7ccd2]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-ui-control font-medium">{item.name}</span>
                    <span className="mt-0.5 block truncate text-ui-body text-muted-foreground">
                      {item.description ?? "No description reported"}
                    </span>
                  </span>
                </div>
                <span className="font-mono text-ui-meta text-muted-foreground">{kind.label}</span>
                <span className={cn("flex items-center gap-1.5 font-mono text-ui-meta capitalize", capabilityStatusStyle(item.status))}>
                  <CircleDot aria-hidden="true" className="size-3" />{item.status}
                </span>
                <span className="truncate font-mono text-ui-meta text-muted-foreground">
                  {item.source ?? "Not reported"}{item.version ? ` · ${item.version}` : ""}
                </span>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function OperationsView(props: OperationsViewProps) {
  if (props.view === "reviews") {
    return (
      <ReviewsView
        activeThreadId={props.activeThreadId}
        dashboard={props.dashboard}
        onSelectThread={props.onSelectThread}
        onStartReview={props.onStartReview}
        timeline={props.timeline}
      />
    );
  }

  return (
    <>
      <PageHeader view={props.view} />
      <PageScrollRegion view={props.view}>
        {props.view === "agents" ? (
          <AgentsView dashboard={props.dashboard} onSelectThread={props.onSelectThread} />
        ) : null}
        {props.view === "environments" ? <EnvironmentsView dashboard={props.dashboard} /> : null}
        {props.view === "capabilities" ? (
          <CapabilitiesView
            capabilities={props.capabilities}
            capabilitiesError={props.capabilitiesError}
            capabilitiesLoading={props.capabilitiesLoading}
          />
        ) : null}
      </PageScrollRegion>
    </>
  );
}
