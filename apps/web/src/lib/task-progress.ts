import type { ThreadSummary, TimelineItem } from "@agent-harness/contracts";
import type { CodexNotification } from "./codex-notifications";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

export function reportedThreadStatus(value: unknown): ThreadSummary["status"] | null {
  const status = record(value);
  if (status.type === "active") {
    return Array.isArray(status.activeFlags) && status.activeFlags.some(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    ) ? "waiting" : "running";
  }
  if (status.type === "systemError") return "failed";
  if (status.type === "idle" || status.type === "notLoaded") return "idle";
  return null;
}

export interface PlanStep { step: string; status: "pending" | "inProgress" | "completed" }
export function planSteps(value: unknown): PlanStep[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const item = record(entry);
    return typeof item.step === "string" && ["pending", "inProgress", "completed"].includes(text(item.status))
      ? [{ step: item.step, status: item.status as PlanStep["status"] }] : [];
  }) : [];
}
export function itemPlan(item: TimelineItem | undefined): PlanStep[] {
  try { return planSteps(JSON.parse(String(item?.metadata?.plan ?? "null"))); } catch { return []; }
}

export function applyNotification(items: TimelineItem[], event: CodexNotification): TimelineItem[] {
  const params = event.params ?? {};
  const method = event.method;
  const timestamp = new Date().toISOString();
  const turnId = text(params.turnId) || text(record(params.turn).id);
  const upsert = (item: TimelineItem) => {
    const existing = items.findIndex((candidate) => candidate.id === item.id);
    return existing < 0 ? [...items, item] : items.map((candidate, index) => index === existing ? item : candidate);
  };
  if (event.kind === "server-request" && event.requestId !== undefined
    && (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval")) {
    return upsert({
      id: `approval-${String(event.requestId)}`, kind: "approval", status: "pending", timestamp,
      title: method.includes("commandExecution") ? "Command approval required" : "File change approval required",
      body: [text(params.command), text(params.reason), params.cwd ? `Working directory: ${text(params.cwd)}` : ""].filter(Boolean).join("\n") || "Codex is waiting for your decision.",
      metadata: { requestId: event.requestId, method, turnId, expiresAt: event.expiresAt ?? null },
    });
  }
  if (method === "serverRequest/resolved") {
    return items.map((item) => item.kind === "approval" && item.metadata?.requestId === params.requestId
      ? { ...item, status: params.reason === "expired" || item.metadata?.expired ? "failed" : "completed",
          ...(params.reason === "expired" ? { body: `${item.body}\n\nApproval expired. The pending action was cancelled. Continue the task to try again.`, metadata: { ...item.metadata, expired: true } } : {}) } : item);
  }
  if (method === "turn/started") {
    return upsert({ id: `turn-${turnId}`, kind: "system", title: "Turn started", body: "Agent is working on this turn.", status: "running", timestamp, metadata: { turnId } });
  }
  if (method === "turn/plan/updated") {
    const plan = planSteps(params.plan);
    return upsert({ id: `plan-${turnId}`, kind: "system", title: "Execution plan", body: plan.map((step) => `${step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "○"} ${step.step}`).join("\n"),
      timestamp, metadata: { turnId, plan: JSON.stringify(plan) } });
  }
  if (method === "turn/completed") {
    const failed = ["failed", "interrupted"].includes(text(record(params.turn).status));
    return items.map((item) => (!turnId || !item.metadata?.turnId || item.metadata.turnId === turnId)
      && (item.status === "running" || item.status === "pending")
      ? { ...item, status: failed || item.kind === "approval" ? "failed" : "completed" } : item);
  }
  if (method === "error") {
    return upsert({ id: `error-${turnId}-${items.length}`, kind: "system", title: params.willRetry ? "Agent retrying" : "Agent error",
      body: text(record(params.error).message) || "The runtime reported an error.", status: params.willRetry ? "running" : "failed", timestamp, metadata: { turnId } });
  }
  if (method === "item/started" || method === "item/completed") {
    const raw = record(params.item);
    const id = text(raw.id);
    if (!id || raw.type === "userMessage") return items;
    const prior = items.find((item) => item.id === id);
    const type = text(raw.type);
    const kind: TimelineItem["kind"] = type === "agentMessage" ? "assistant" : type === "reasoning" ? "reasoning" : type === "commandExecution" ? "command" : type === "fileChange" ? "file_change" : "system";
    const title = kind === "assistant" ? "Agent" : kind === "command" ? text(raw.command) || "Run command" : kind === "reasoning" ? "Reasoning" : kind === "file_change" ? "File changes" : type === "collabAgentToolCall" ? `Agent ${text(raw.tool) || "activity"}` : text(raw.tool) || type;
    const body = text(raw.aggregatedOutput) || text(raw.text) || (Array.isArray(raw.summary) ? raw.summary.filter((part) => typeof part === "string").join("\n") : "") || prior?.body || text(raw.command);
    return upsert({ id, kind, title, body, timestamp,
      status: ["failed", "declined", "interrupted"].includes(text(raw.status)) || (typeof raw.exitCode === "number" && raw.exitCode !== 0) ? "failed" : method === "item/completed" ? "completed" : "running",
      metadata: { ...prior?.metadata, turnId, ...(typeof raw.exitCode === "number" ? { exitCode: raw.exitCode } : {}), ...(typeof raw.durationMs === "number" ? { durationMs: raw.durationMs } : {}) },
    });
  }
  if (method && /delta$/i.test(method)) {
    const id = text(params.itemId);
    const delta = text(params.delta);
    if (!delta) return items;
    const kind = method.includes("agentMessage") ? "assistant" : method.includes("reasoning") ? "reasoning" : method.includes("commandExecution") ? "command" : null;
    if (!kind) return items;
    const prior = id ? items.find((item) => item.id === id) : items.findLast((item) => item.kind === kind && item.status === "running");
    const previousBody = kind === "command" && !prior?.metadata?.outputStarted ? "" : prior?.body ?? "";
    return upsert({ id: prior?.id || id || `${kind}-${turnId}-${items.length}`, kind, title: prior?.title || (kind === "assistant" ? "Agent" : kind === "command" ? "Run command" : "Reasoning"),
      body: `${previousBody}${delta}`, status: "running", timestamp, metadata: { ...prior?.metadata, turnId, ...(kind === "command" ? { outputStarted: true } : {}) } });
  }
  return items;
}
