import type { ManagedTaskDetail, ManagedTaskItem } from "@agent-harness/contracts";
import type { AgentsApiEvent, AgentsApiItem, AgentsApiTurn } from "./client.js";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
const finalStatus = (status: unknown) => status === "completed" || status === "failed" || status === "cancelled";

export class ManagedOutputLimitError extends Error {
  constructor() { super("Managed task output limit reached."); }
}

function upsert(detail: ManagedTaskDetail, item: ManagedTaskItem, remove?: (value: ManagedTaskItem) => boolean): void {
  const items = remove ? detail.items.filter((value) => !remove(value)) : [...detail.items];
  const index = items.findIndex((value) => value.id === item.id);
  if (index >= 0) items[index] = item; else items.push(item);
  if (items.length > 1000 || item.text.length > 131_072 ||
      Buffer.byteLength(JSON.stringify(items)) > 1_048_576) throw new ManagedOutputLimitError();
  // Bounds failures must leave the previously valid snapshot intact.
  detail.items = items;
}

export function mergeLocalItem(detail: ManagedTaskDetail, item: ManagedTaskItem): void {
  upsert(detail, item);
}

function itemKey(itemId: string, subagentId: string | null): string {
  return `${subagentId ? `subagent:${encodeURIComponent(subagentId)}:` : ""}item:${encodeURIComponent(itemId)}`;
}

function agentId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

export function mergeSavedItem(detail: ManagedTaskDetail, item: AgentsApiItem, redact: (text: string) => string): void {
  // Never expose encrypted reasoning, remote metadata, tool credentials or arbitrary JSON objects.
  if (/reasoning|encrypted/i.test(item.type)) return;
  const isMessage = item.type === "message";
  if (isMessage && !["user", "assistant"].includes(String(item.role))) return;
  const content = isMessage && Array.isArray(item.content) ? item.content : [];
  let text = content.map((part) => {
    const value = object(part);
    return ["input_text", "output_text", "text"].includes(String(value.type)) ? string(value.text) || "" : "";
  }).filter(Boolean).join("\n");
  const role = isMessage && ["user", "assistant"].includes(String(item.role)) ? item.role as "user" | "assistant" : "tool";
  if (!text && role === "tool") {
    // Tool argument/result schemas can contain credentials. Display activity labels;
    // reviewed findings arrive through assistant output_text messages.
    text = /^[a-z_]{1,80}$/.test(item.type) ? item.type.replace(/_/g, " ") : "Tool activity";
  }
  if (!text) return;
  const done = finalStatus(item.status);
  const subagentId = agentId(item.subagent_id);
  const id = itemKey(item.id, subagentId);
  const existing = detail.items.find((value) => value.id === id);
  if (existing && existing.status !== "in_progress" && !done) return;
  // A late item.added cannot replace parts already finalized by output_text.done.
  if (!done && detail.items.some((value) => value.id.startsWith(`${id}:part:`))) return;
  upsert(detail, { id, role, text: redact(text), status: item.status === "failed" || item.status === "cancelled" ? "failed" : done ? "completed" : "in_progress", subagentId },
    done ? (value) => value.id.startsWith(`${id}:part:`) : undefined);
}

/** Apply display events only; lifecycle outcomes are handled separately with root-turn correlation. */
export function mergeDisplayEvent(detail: ManagedTaskDetail, event: AgentsApiEvent, redact: (text: string) => string): void {
  const item = object(event.item);
  const subagentId = agentId(event.subagent_id) ?? agentId(object(event.turn).subagent_id);
  if (["agent.session.turn.item.added", "agent.session.turn.item.done"].includes(event.type) &&
      typeof item.id === "string" && typeof item.type === "string") {
    mergeSavedItem(detail, {
      ...item,
      id: item.id, type: item.type,
      status: item.status ?? (event.type.endsWith(".done") ? "completed" : "in_progress"),
      subagent_id: agentId(item.subagent_id) ?? subagentId,
    } as AgentsApiItem, redact);
    return;
  }
  if (!["agent.session.turn.output_text.delta", "agent.session.turn.output_text.done"].includes(event.type)) return;
  const itemId = string(event.item_id);
  if (!itemId) return;
  const baseId = itemKey(itemId, subagentId);
  if (detail.items.some((value) => value.id === baseId && value.status !== "in_progress")) return;
  const index = (value: unknown): number | null => value === undefined ? 0 :
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const outputIndex = index(event.output_index);
  const contentIndex = index(event.content_index);
  if (outputIndex === null || contentIndex === null) return;
  const id = `${baseId}:part:${outputIndex}:${contentIndex}`;
  const previous = detail.items.find((value) => value.id === id);
  if (previous && previous.status !== "in_progress") return;
  const done = event.type.endsWith(".done");
  const incoming = string(done ? event.text : event.delta);
  if (incoming === null) return;
  const text = done ? incoming : (previous?.text || "") + incoming;
  upsert(detail, { id, role: "assistant", text: redact(text), status: done ? "completed" : "in_progress", subagentId },
    (value) => value.id === baseId && value.status === "in_progress");
}

export function rootTurn(turns: AgentsApiTurn[]): AgentsApiTurn | null {
  // The documented root marker is null. Missing attribution is not proof of a root turn.
  return turns.filter((turn) => turn.subagent_id === null).at(-1) ?? null;
}
export function turnUsage(turn: AgentsApiTurn): { inputTokens: number; outputTokens: number; reported: boolean } {
  const usage = object(turn.usage);
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return { inputTokens: valid(usage.input_tokens) ? usage.input_tokens : 0, outputTokens: valid(usage.output_tokens) ? usage.output_tokens : 0,
    reported: valid(usage.input_tokens) && valid(usage.output_tokens) };
}
