import "./management.css";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { OperationsViewId } from "@/lib/view";

const ManagedAgentsView = lazy(() => import("./ManagedAgentsView").then((module) => ({ default: module.ManagedAgentsView })));

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
    subtitle: "Review task results, inspect file changes, and decide what comes next.",
    availability: "LIVE",
  },
  agents: {
    title: "Agents",
    subtitle: "Follow your active tasks and the agents working on them.",
    availability: "READ-ONLY",
  },
  environments: {
    title: "Environments",
    subtitle: "See where your tasks run and the workspace access they use.",
    availability: "READ-ONLY",
  },
  capabilities: {
    title: "Capabilities",
    subtitle: "Explore the tools, skills, and connections available to your tasks.",
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
    <header className="management-header">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1
            className="management-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            {copy.title}
          </h1>
          {view !== "agents" ? <AvailabilityBadge state={copy.availability} /> : null}
        </div>
        <p className="management-subtitle">
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
      className="management-scroll"
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
    <div className="management-panel">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4",
          tone === "agent" && "text-primary",
          tone === "human" && "text-human",
          tone === "waiting" && "text-[var(--waiting)]",
          tone === "neutral" && "text-muted-foreground",
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
  if (status === "completed") return "border-[var(--c-verified)]/20 bg-[var(--healthy)]/[0.07] text-[var(--healthy)]";
  if (status === "failed") return "border-destructive/20 bg-destructive/[0.07] text-destructive";
  if (status === "waiting") return "border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.07] text-[var(--waiting)]";
  if (status === "running") return "border-[var(--c-run-line)] bg-[var(--c-run-dim)] text-[var(--c-run)]";
  return "border-border bg-muted text-muted-foreground";
}

function ThreadStatusBadge({ status }: { status: ThreadSummary["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit rounded-full border px-2 py-0.5 text-ui-meta capitalize",
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
        <p className="ml-1 text-ui-body text-destructive">
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
      <div className="flex flex-col gap-3 management-panel sm:flex-row sm:items-center">
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
          <p className="mt-1 truncate text-ui-meta text-muted-foreground">
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
    <div className="management-review">
      <header className="management-header">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="management-heading" ref={headingRef} tabIndex={-1}>Reviews</h1>
            {selectedThread ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-ui-meta text-muted-foreground">
                <CircleCheck aria-hidden="true" className="size-3.5" />
                {reviewStatusLabel}
              </span>
            ) : null}
          </div>
          <p className="management-subtitle">Inspect task results and file changes, then choose your next step.</p>
        </div>
        {selectedThread ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onSelectThread(selectedThread.id)} variant="outline">Open task</Button>
            <Button onClick={exportSelectedReview} variant="ghost">Export review</Button>
            <Button disabled={reviewingThreadId !== null} onClick={() => void startReview(selectedThread.id)}>
              <FileCheck2 aria-hidden="true" className="size-4" />
              {reviewingThreadId === selectedThread.id ? "Starting…" : "Run review"}
            </Button>
          </div>
        ) : null}
      </header>

      {reviewError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/[0.05] px-5 py-3 text-ui-body text-destructive" role="alert">
          {reviewError}
        </div>
      ) : null}

      {selectedThread ? (
        <div className="management-review-layout">
          <aside
            aria-label="Selected review summary"
            className="management-review-sidebar"
          >
            <section>
              <p className="text-ui-meta text-muted-foreground">
                What changed
              </p>
              <p className="mt-3 text-ui-body text-foreground">
                {selectedThread.preview || "No task summary is available."}
              </p>
            </section>

            <section className="mt-4 rounded-xl bg-muted px-4 py-4">
              <div className="flex items-center gap-2 text-ui-control font-medium text-foreground">
                <AlertTriangle aria-hidden="true" className="size-4" />
                About this review
              </div>
              <p className="mt-2 text-ui-body text-foreground/70">
                This view shows the task’s recorded output. Run a review to check it and collect any findings.
              </p>
            </section>

            <section className="mt-5">
              <p className="text-ui-meta text-muted-foreground">
                Task details
              </p>
              <dl className="mt-2 divide-y divide-border border-y border-border">
                <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3">
                  <span aria-hidden="true" className="mt-1 size-2.5 rounded-[2px] bg-[var(--c-info)]" />
                  <div>
                    <dt className="text-ui-control font-medium">Task state</dt>
                    <dd className="mt-1 text-ui-meta capitalize text-muted-foreground">
                      {selectedThread.status}
                    </dd>
                  </div>
                </div>
                <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3">
                  <span aria-hidden="true" className="mt-1 size-2.5 rounded-[2px] bg-[var(--c-info)]" />
                  <div>
                    <dt className="text-ui-control font-medium">Runtime model</dt>
                    <dd className="mt-1 truncate font-mono text-ui-code text-muted-foreground">
                      {selectedThread.model || "Model unavailable"}
                    </dd>
                  </div>
                </div>
                <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3">
                  <span aria-hidden="true" className="mt-1 size-2.5 rounded-[2px] bg-[var(--c-info)]" />
                  <div>
                    <dt className="text-ui-control font-medium">Last task update</dt>
                    <dd className="mt-1 text-ui-meta text-muted-foreground">
                      {formattedTimestamp(selectedThread.updatedAt)}
                    </dd>
                  </div>
                </div>
              </dl>
            </section>

            <section aria-label="Review summary" className="mt-5">
              <p className="text-ui-meta text-muted-foreground">
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
                    <dt className="text-ui-meta text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="mt-1.5 text-ui-control tabular-nums text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {fileChanges.length ? (
              <section aria-labelledby="review-artifacts-heading" className="mt-5">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="text-ui-meta text-muted-foreground" id="review-artifacts-heading">
                    Artifacts
                  </h2>
                  <span className="text-ui-meta text-muted-foreground">{fileChanges.length}</span>
                </div>
                <div className="space-y-1">
                  {fileChanges.map((file) => (
                    <button
                      aria-pressed={selectedFile?.id === file.id}
                      className={cn(
                        "flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left font-mono text-ui-code",
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
                <h2 className="text-ui-meta text-muted-foreground" id="review-candidates-heading">
                  Review candidates
                </h2>
                <span className="text-ui-meta text-muted-foreground">{candidates.length}</span>
              </div>
              <div className="space-y-1">
                {candidates.map((thread) => {
                  const selected = thread.id === selectedThread.id;
                  return (
                    <button
                      aria-label={`Inspect review candidate ${thread.title}`}
                      aria-pressed={selected}
                      className={cn(
                        "grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border px-3 py-3 text-left transition-colors hover:bg-accent",
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
                      <span className="col-start-2"><ThreadStatusBadge status={thread.status} /></span>
                    </button>
                  );
                })}
              </div>
            </section>
          </aside>

          <section className="management-review-evidence">
            <header className="management-review-toolbar">
              <p className="min-w-0 flex-1 truncate font-mono text-ui-code text-foreground/85">
                {selectedFile?.title ?? selectedThread.projectName ?? "No project"}
                {parsedDiff ? (
                  <span className="ml-2">
                    <span className="text-[var(--syn-add)]">+{parsedDiff.additions}</span>
                    <span className="ml-2 text-[var(--syn-del)]">-{parsedDiff.deletions}</span>
                  </span>
                ) : (
                  <span className="ml-2 text-muted-foreground">task/{selectedThread.id}</span>
                )}
              </p>
              <span className="text-ui-meta text-muted-foreground">
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
                      <span className="select-none border-r border-border pr-2 text-right text-[var(--ink-4)]">{row.oldLine ?? ""}</span>
                      <span className="select-none border-r border-border pr-2 text-right text-[var(--ink-4)]">{row.newLine ?? ""}</span>
                      <span className={cn("whitespace-pre px-3", row.kind === "addition" && "text-[var(--syn-add)]", row.kind === "deletion" && "text-[var(--syn-del)]")}>
                        <span aria-hidden="true" className="inline-block w-3 select-none">{row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : row.kind === "hunk" ? "" : " "}</span>
                        {showWhitespace ? visibleWhitespace(row.text) : row.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="management-review-empty">
                <div className="relative max-w-lg text-center">
                  <span className="mx-auto grid size-10 place-items-center rounded-md border border-border bg-card/50">
                    <FileCheck2 aria-hidden="true" className="size-4 text-muted-foreground" />
                  </span>
                  <h2 className="mt-4 text-ui-control font-medium">No file changes to show</h2>
                  <p className="mt-2 text-ui-body text-muted-foreground">
                    Run a review to collect file changes and findings for this task.
                  </p>
                </div>
              </div>
            )}

            <section className="management-review-findings">
              <div className="management-review-toolbar">
                <h2 className="text-ui-control font-semibold">Review pass</h2>
                <span className="text-ui-meta text-muted-foreground">{findings.length} finding{findings.length === 1 ? "" : "s"} · runtime evidence</span>
                <span className="ml-auto rounded-[3px] border border-[var(--c-fail-dim)] bg-[var(--c-fail-dim)] px-1.5 py-0.5 text-ui-meta text-[var(--c-fail)]">{highFindings} high</span>
                <span className="rounded-[3px] border border-[var(--c-wait-dim)] bg-[var(--c-wait-dim)] px-1.5 py-0.5 text-ui-meta text-[var(--c-wait)]">{mediumFindings} medium</span>
              </div>
              {findings.length ? (
                <div className="divide-y divide-border">
                  {findings.map((finding) => {
                    const high = finding.status === "failed";
                    const reportedPath = finding.metadata?.path ?? finding.metadata?.file;
                    return (
                      <article className="grid min-h-[76px] grid-cols-[76px_minmax(0,1fr)]" key={finding.id}>
                        <div className={cn("grid place-items-center border-r border-border text-ui-meta", high ? "bg-[var(--c-fail-dim)] text-[var(--c-fail)]" : "bg-[var(--c-wait-dim)] text-[var(--c-wait)]")}>{high ? "High" : "Medium"}</div>
                        <div className="min-w-0 px-3.5 py-2.5">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <h3 className="truncate text-ui-control font-semibold">{finding.title}</h3>
                            {reportedPath !== undefined && reportedPath !== null ? <span className="truncate font-mono text-ui-code text-muted-foreground">{String(reportedPath)}</span> : null}
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
                    <p className="text-ui-control font-medium">No findings to show</p>
                    <p className="mt-1.5 text-ui-body text-muted-foreground">Run a review to check this task’s output. Findings will appear here when reported.</p>
                  </div>
                </div>
              )}
            </section>
          </section>
        </div>
      ) : (
        <div className="management-scroll grid place-items-center text-center">
          <div className="max-w-md">
            <FileCheck2 aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
            <h2 className="mt-3 text-ui-control font-medium">No tasks ready for review</h2>
            <p className="mt-2 text-ui-body text-muted-foreground">
              Completed, failed, and idle tasks will appear here. You can follow ongoing work in Tasks.
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
    <div className="management-content">
      <section aria-label="Agent supervision summary" className="management-metrics">
        <MetricCard icon={Activity} label="Delegated tasks" tone="agent" value={childTasks.length} />
        <MetricCard icon={AlertTriangle} label="Waiting for attention" tone="waiting" value={waitingCount} />
        <MetricCard icon={ServerCog} label="Runtimes in use" value={dashboard.runtime.activeRuntimes} />
      </section>

      <section className="mt-6 management-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-human/20 bg-human/[0.06]">
              <Workflow aria-hidden="true" className="size-4 text-human" />
            </span>
            <div>
              <h2 className="text-ui-control font-medium">
                {childTasks.length ? "Delegated work" : "No delegated tasks to show"}
              </h2>
              <p className="mt-1 max-w-2xl text-ui-body text-muted-foreground">
                {childTasks.length
                  ? "Follow the subtasks your agents are working on."
                  : "When an agent delegates work, its subtasks will appear here."}
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

      </section>

      <div className="mt-7">
        <h2 className="text-ui-control font-medium">Active tasks</h2>
        <p className="mt-1 text-ui-body text-muted-foreground">
          Tasks currently running or waiting for your attention.
        </p>
      </div>
      {activeTasks.length === 0 ? (
        <div className="mt-4 management-empty">
          <Bot aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-ui-control font-medium">No active tasks</h3>
          <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
            There are no running or waiting tasks in this workspace.
          </p>
        </div>
      ) : (
        <div className="mt-4 management-list">
          <div className="management-table-heading hidden grid-cols-[minmax(0,1fr)_110px_150px_160px] gap-3 border-b border-border px-4 py-3 text-ui-meta text-muted-foreground xl:grid">
            <span>Task</span><span>State</span><span>Updated</span><span />
          </div>
          {activeTasks.map((thread) => (
            <div className="flex flex-col gap-3 border-b border-border/60 p-4 last:border-b-0 xl:grid xl:grid-cols-[minmax(0,1fr)_110px_150px_160px] xl:items-center" key={thread.id}>
              <div className="min-w-0">
                <p className="truncate text-ui-control font-medium">{thread.title}</p>
                <p className="mt-1 truncate text-ui-meta text-muted-foreground">
                  {thread.projectName ?? "No project"}
                </p>
              </div>
              <ThreadStatusBadge status={thread.status} />
              <span className="text-ui-meta text-muted-foreground">{formattedTimestamp(thread.updatedAt)}</span>
              <OpenTaskButton onSelectThread={onSelectThread} thread={thread} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function runtimeTone(status: DashboardPayload["runtime"]["status"]): string {
  if (status === "ready") return "bg-[var(--healthy)]";
  if (status === "degraded") return "bg-[var(--waiting)]";
  return "bg-muted-foreground";
}

function EnvironmentsView({ dashboard }: Pick<OperationsViewProps, "dashboard">) {
  return (
    <div className="management-content">
      <section className="grid gap-3 lg:grid-cols-[1.15fr_0.85fr]">
        <article className="management-panel">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/[0.06]">
                <ServerCog aria-hidden="true" className="size-4 text-primary" />
              </span>
              <div>
                <p className="text-ui-meta text-muted-foreground">User runtime</p>
                <h2 className="mt-1 text-ui-control font-medium capitalize">{dashboard.runtime.status.replace("_", " ")}</h2>
              </div>
            </div>
            <AvailabilityBadge state="READ-ONLY" />
          </div>
          {dashboard.runtime.message ? (
            <p className="mt-4 text-ui-body text-muted-foreground">{dashboard.runtime.message}</p>
          ) : null}
          <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-4 text-ui-control">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", runtimeTone(dashboard.runtime.status))} />
              Runtime state
            </span>
            <span className="text-ui-meta capitalize">{dashboard.runtime.status.replace("_", " ")}</span>
          </div>
          <div className="mt-3 flex items-center justify-between text-ui-control">
            <span className="text-muted-foreground">Active user runtimes</span>
            <span className="text-ui-meta">{dashboard.runtime.activeRuntimes}</span>
          </div>
        </article>

        <article className="management-panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-ui-meta text-muted-foreground">Runtime permissions</p>
              <h2 className="mt-1 text-ui-control font-medium">Current access</h2>
            </div>
            <ShieldCheck aria-hidden="true" className="size-4 text-human" />
          </div>
          <dl className="mt-5 space-y-3 text-ui-control">
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Task workspaces</dt><dd className="text-ui-meta">{dashboard.projects.length} reported</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Sandbox policy</dt><dd className="text-ui-meta text-muted-foreground">Not reported</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Network policy</dt><dd className="text-ui-meta text-muted-foreground">Not reported</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Approval policy</dt><dd className="text-ui-meta text-muted-foreground">Not reported</dd></div>
          </dl>

        </article>
      </section>

      <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-ui-control font-medium">Task workspaces</h2>
          <p className="mt-1 text-ui-body text-muted-foreground">
            Workspace locations and branches from your latest runtime update.
          </p>
        </div>
        <AvailabilityBadge state="READ-ONLY" />
      </div>

      {dashboard.projects.length === 0 ? (
        <div className="mt-4 management-empty">
          <FolderGit2 aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-ui-control font-medium">No workspaces to show</h3>
          <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
            Workspace locations will appear here as tasks run.
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {dashboard.projects.map((project) => (
            <article className="management-panel" key={project.id}>
              <div className="flex items-start gap-3">
                <span className="management-icon">
                  <FolderGit2 aria-hidden="true" className="size-4 text-primary" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-ui-control font-medium">{project.name}</h3>
                  <p className="mt-1 truncate font-mono text-ui-code text-muted-foreground" title={project.path}>{project.path}</p>
                </div>
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-ui-meta text-muted-foreground">
                  {project.isGitRepository ? "git" : "folder"}
                </span>
              </div>
              {project.isGitRepository ? (
                <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-4 text-ui-control">
                  <span className="flex items-center gap-1.5 text-muted-foreground"><GitBranch aria-hidden="true" className="size-3.5" />Branch</span>
                  <span className="max-w-[60%] truncate font-mono text-ui-code">{project.branch ?? "Not reported"}</span>
                </div>
              ) : null}
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
  if (status === "ready") return "text-[var(--healthy)]";
  if (status === "error") return "text-destructive";
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
      <div aria-busy="true" className="management-content management-empty">
        <PackageSearch aria-hidden="true" className="mx-auto size-5 text-primary" />
        <h2 className="mt-3 text-ui-control font-medium">Loading tools and skills</h2>
        <p className="mt-2 text-ui-body text-muted-foreground">Reading the tools and skills available in your runtime.</p>
      </div>
    );
  }

  if (capabilitiesError) {
    return (
      <div className="management-content rounded-lg border border-destructive/20 bg-destructive/[0.045] p-6" role="alert">
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <h2 className="text-ui-control font-medium">Tools and skills are unavailable</h2>
            <p className="mt-1 text-ui-body text-muted-foreground">{capabilitiesError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!capabilities) {
    return (
      <div className="management-content">
        <div className="management-empty">
          <PackageSearch aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h2 className="mt-3 text-ui-control font-medium">Tools and skills are unavailable</h2>
          <p className="mx-auto mt-2 max-w-lg text-ui-body text-muted-foreground">
            Your workspace has not shared its available tools and skills yet.
          </p>

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
    <div className="management-content">
      <section aria-label="Capability inventory summary" className="management-metrics">
        <MetricCard
          icon={ServerCog}
          label="MCP servers"
          tone="agent"
          value={reportedCount(inventorySummary?.mcpServers, kindCount("mcp_server"))}
        />
        <MetricCard
          icon={Wrench}
          label="Tools"
          value={reportedCount(inventorySummary?.tools, kindCount("tool"))}
        />
        <MetricCard
          icon={Blocks}
          label="Skills"
          tone="human"
          value={reportedCount(reportedSkills, kindCount("skill"))}
        />
      </section>

      <section aria-label="Runtime models and permissions" className="mt-6 grid gap-4 xl:grid-cols-3">
        <article className="management-panel">
          <p className="text-ui-meta text-muted-foreground">Models</p>
          <p className="mt-2 text-ui-control font-medium">
            {runtimeSurfaces?.models
              ? `${runtimeSurfaces.models.truncated ? "≥" : ""}${runtimeSurfaces.models.count} models reported`
              : "Unavailable"}
          </p>
          <p className="mt-1 text-ui-body text-muted-foreground">
            {runtimeSurfaces?.models?.defaultModel
              ? `Default: ${runtimeSurfaces.models.defaultModel}`
              : "Default model not provided"}
          </p>
        </article>
        <article className="management-panel">
          <p className="text-ui-meta text-muted-foreground">Permission profiles</p>
          <p className="mt-2 text-ui-control font-medium">
            {runtimeSurfaces?.permissionProfiles
              ? `${runtimeSurfaces.permissionProfiles.truncated ? "≥" : ""}${runtimeSurfaces.permissionProfiles.count} profiles reported`
              : "Unavailable"}
          </p>
          <p className="mt-1 text-ui-body text-muted-foreground">
            {runtimeSurfaces?.permissionProfiles
              ? runtimeSurfaces.permissionProfiles.workspaceCount > 0
                ? `${runtimeSurfaces.permissionProfiles.allowedInAnyWorkspaceCount}${runtimeSurfaces.permissionProfiles.truncated ? " shown as" : ""} allowed in one or more of ${runtimeSurfaces.permissionProfiles.workspaceCount} workspace${runtimeSurfaces.permissionProfiles.workspaceCount === 1 ? "" : "s"}`
                : "Workspace access is unknown"
              : "Permission details are unavailable"}
          </p>
        </article>
        <article className="management-panel">
          <p className="text-ui-meta text-muted-foreground">Provider features</p>
          <p className="mt-2 text-ui-control font-medium">
            {runtimeSurfaces?.providerCapabilities
              ? `${enabledProviderFeatures.length}/3 enabled`
              : "Unavailable"}
          </p>
          <p className="mt-1 text-ui-body text-muted-foreground">
            {enabledProviderFeatures.length
              ? enabledProviderFeatures.join(" · ")
              : runtimeSurfaces?.providerCapabilities
                ? "No optional features enabled"
                : "Feature availability is unknown"}
          </p>
        </article>
      </section>

      {boundedSections.length ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/50 px-4 py-3" role="status">
          <p className="text-ui-control font-medium text-[var(--c-info)]">Some details are incomplete</p>
          <p className="mt-1 text-ui-body text-muted-foreground">
            Counts prefixed with ≥ are lower bounds; the full list could not be loaded. Affected sections: {boundedSections.join(", ")}.
          </p>
        </div>
      ) : null}

      <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-ui-control font-medium">Tools and connections</h2>
          {capabilities.updatedAt ? (
            <p className="mt-1 text-ui-meta text-muted-foreground">Updated {formattedTimestamp(capabilities.updatedAt)}</p>
          ) : null}
        </div>
        <AvailabilityBadge state="READ-ONLY" />
      </div>

      {capabilities.warnings?.length ? (
        <div className="mt-4 rounded-lg border border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.045] px-4 py-3" role="status">
          <p className="text-ui-control font-medium text-foreground">Some tools could not be loaded</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-ui-body text-muted-foreground">
            {capabilities.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}

      {capabilities.items.length === 0 ? (
        <div className="mt-4 management-empty">
          <Blocks aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-ui-control font-medium">No tools or skills to show</h3>
          <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
            Tools and skills available to your tasks will appear here.
          </p>
        </div>
      ) : (
        <div className="mt-4 management-list">
          <div className="management-table-heading hidden grid-cols-[minmax(0,1fr)_120px_110px_160px] gap-3 border-b border-border px-4 py-3 text-ui-meta text-muted-foreground xl:grid">
            <span>Capability</span><span>Kind</span><span>Status</span><span>Source</span>
          </div>
          {capabilities.items.map((item) => {
            const kind = capabilityKindCopy[item.kind];
            const Icon = kind.icon;
            return (
              <article className="flex flex-col gap-3 border-b border-border/60 p-4 last:border-b-0 xl:grid xl:grid-cols-[minmax(0,1fr)_120px_110px_160px] xl:items-center" key={item.id}>
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-secondary/60">
                    <Icon aria-hidden="true" className="size-3.5 text-foreground" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-ui-control font-medium">{item.name}</span>
                    {item.description ? (
                      <span className="mt-1 block text-ui-body text-muted-foreground">{item.description}</span>
                    ) : null}
                  </span>
                </div>
                <span className="text-ui-meta text-muted-foreground">{kind.label}</span>
                <span className={cn("flex items-center gap-1.5 text-ui-meta capitalize", capabilityStatusStyle(item.status))}>
                  <CircleDot aria-hidden="true" className="size-3" />{item.status}
                </span>
                <span className="truncate text-ui-meta text-muted-foreground">
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
          <Tabs defaultValue="native" className="management-content">
            <TabsList aria-label="Agent runtime" className="mb-5">
              <TabsTrigger value="native">Local task agents</TabsTrigger>
              <TabsTrigger value="managed">Managed tasks</TabsTrigger>
            </TabsList>
            <TabsContent value="native">
              <AgentsView dashboard={props.dashboard} onSelectThread={props.onSelectThread} />
            </TabsContent>
            <TabsContent value="managed">
              <Suspense fallback={<p role="status" className="text-ui-body text-muted-foreground">Loading managed agents…</p>}>
                <ManagedAgentsView />
              </Suspense>
            </TabsContent>
          </Tabs>
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
