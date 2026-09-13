import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedTaskDetail } from "@agent-harness/contracts";

import { ManagedOutputLimitError, mergeDisplayEvent, mergeSavedItem, rootTurn, turnUsage } from "./events.js";

function detail(): ManagedTaskDetail {
  return { id: "task", projectId: "project", projectName: "Project", agentId: "reviewer", agentVersion: "1", title: "Review",
    status: "running", turnId: "turn", revision: 1, createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z",
    error: null, sourceRevision: null, items: [], usage: { inputTokens: 0, outputTokens: 0 } };
}
const identity = (text: string) => text;
const delta = (text: string, fields = {}) => ({ type: "agent.session.turn.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: text, ...fields });
const done = (text: string, fields = {}) => ({ type: "agent.session.turn.output_text.done", item_id: "msg", output_index: 0, content_index: 0, text, ...fields });

test("authoritative done text replaces provisional deltas and ignores later stale updates", () => {
  const task = detail();
  mergeDisplayEvent(task, delta("Partial"), identity);
  mergeDisplayEvent(task, done("Complete review"), identity);
  mergeDisplayEvent(task, delta(" stale suffix"), identity);
  assert.equal(task.items.length, 1);
  assert.equal(task.items[0]!.text, "Complete review");
  assert.equal(task.items[0]!.status, "completed");
  const withoutDeltas = detail();
  mergeDisplayEvent(withoutDeltas, done("Delivered without deltas"), identity);
  assert.equal(withoutDeltas.items[0]!.text, "Delivered without deltas");
});

test("saved final items replace temporary parts and win over buffered stale events", () => {
  const task = detail();
  mergeDisplayEvent(task, delta("Provisional"), identity);
  mergeDisplayEvent(task, delta("Second", { content_index: 1 }), identity);
  mergeSavedItem(task, { id: "msg", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Saved complete review" }] }, identity);
  mergeDisplayEvent(task, delta("stale"), identity);
  mergeDisplayEvent(task, done("stale done"), identity);
  mergeDisplayEvent(task, { type: "agent.session.turn.item.added", item: { id: "msg", type: "message", role: "assistant",
    content: [{ type: "output_text", text: "Earlier item" }] } }, identity);
  assert.deepEqual(task.items.map((item) => [item.text, item.status]), [["Saved complete review", "completed"]]);
});

test("item.added with no status stays provisional and only an explicit done event finalizes it", () => {
  const task = detail();
  const item = { id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "Beginning" }] };
  mergeDisplayEvent(task, { type: "agent.session.turn.item.added", item }, identity);
  assert.equal(task.items[0]!.status, "in_progress");
  mergeDisplayEvent(task, delta("Live review"), identity);
  assert.equal(task.items.length, 1);
  assert.equal(task.items[0]!.text, "Live review");
  mergeDisplayEvent(task, { type: "agent.session.turn.item.done", item: { ...item, content: [{ type: "output_text", text: "Final" }] } }, identity);
  assert.deepEqual(task.items.map((value) => [value.text, value.status]), [["Final", "completed"]]);
  const unknown = detail();
  mergeSavedItem(unknown, item, identity);
  assert.equal(unknown.items[0]!.status, "in_progress");
});

test("keeps output indexes, content parts, and subagents separate", () => {
  const task = detail();
  mergeDisplayEvent(task, done("Root first"), identity);
  mergeDisplayEvent(task, done("Root second", { content_index: 1 }), identity);
  mergeDisplayEvent(task, done("Root other output", { output_index: 1 }), identity);
  mergeDisplayEvent(task, done("Child answer", { subagent_id: "child" }), identity);
  assert.equal(new Set(task.items.map((item) => item.id)).size, 4);
  assert.deepEqual(task.items.map((item) => item.subagentId), [null, null, null, "child"]);
  mergeDisplayEvent(task, { type: "agent.session.turn.item.done", subagent_id: "child",
    item: { id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved child" }] } }, identity);
  assert.deepEqual(task.items.map((item) => item.text), ["Root first", "Root second", "Root other output", "Saved child"]);
  mergeDisplayEvent(task, done("Nested attribution", { item_id: "other", turn: { subagent_id: "nested" } }), identity);
  assert.equal(task.items.at(-1)!.subagentId, "nested");
});

test("ignores malformed display events and never treats lifecycle events as content", () => {
  const task = detail();
  for (const index of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
    mergeDisplayEvent(task, delta("Bad", { output_index: index }), identity);
  }
  mergeDisplayEvent(task, { type: "agent.session.turn.output_text.done", item_id: "msg" }, identity);
  mergeDisplayEvent(task, { type: "agent.session.turn.completed", item: { id: "bad", type: "message", role: "assistant", content: [{ type: "output_text", text: "Unexpected" }] } }, identity);
  assert.deepEqual(task.items, []);
  assert.equal(task.status, "running");
});

test("shows assistant findings and activity labels without reasoning, private metadata or tool arguments", () => {
  const task = detail();
  const redact = (text: string) => text.replaceAll("restricted-secret", "[redacted]");
  mergeSavedItem(task, { id: "reason", type: "reasoning", role: "assistant", status: "completed", text: "private thought",
    content: [{ type: "output_text", text: "private thought" }], encrypted_content: "encrypted-private" }, redact);
  mergeSavedItem(task, { id: "system", type: "message", role: "system", status: "completed",
    content: [{ type: "text", text: "private system instructions" }] }, redact);
  mergeSavedItem(task, { id: "tool", type: "shell_call", status: "completed", output: "unknown credential", text: "raw tool result",
    arguments: { authorization: "secret token" }, content: [{ type: "text", text: "raw tool content" }] }, redact);
  mergeDisplayEvent(task, done("Found restricted-secret in output"), redact);
  const serialized = JSON.stringify(task.items);
  assert.doesNotMatch(serialized, /private thought|encrypted-private|private system|unknown credential|raw tool|secret token|restricted-secret/);
  assert.deepEqual(task.items.map((item) => item.text), ["shell call", "Found [redacted] in output"]);
});

test("output bounds are atomic and do not leave an oversized snapshot after rejection", () => {
  const task = detail();
  mergeDisplayEvent(task, delta("Valid"), identity);
  const before = JSON.stringify(task);
  assert.throws(() => mergeDisplayEvent(task, delta("x".repeat(131_073)), identity), ManagedOutputLimitError);
  assert.equal(JSON.stringify(task), before);
  assert.throws(() => mergeSavedItem(task, { id: "msg", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "x".repeat(131_073) }] }, identity), ManagedOutputLimitError);
  assert.equal(JSON.stringify(task), before);
  const many = detail();
  many.items = Array.from({ length: 1000 }, (_value, id) => ({ id: String(id), role: "tool", text: "Activity", status: "completed", subagentId: null }));
  assert.throws(() => mergeDisplayEvent(many, done("One too many"), identity), ManagedOutputLimitError);
  assert.equal(many.items.length, 1000);
  const bytes = detail();
  bytes.items = Array.from({ length: 9 }, (_value, id) => ({ id: String(id), role: "tool", text: "x".repeat(110_000), status: "completed", subagentId: null }));
  assert.throws(() => mergeDisplayEvent(bytes, done("x".repeat(100_000)), identity), ManagedOutputLimitError);
  assert.equal(bytes.items.length, 9);
});

test("selects only explicitly attributed root turns and validates all usage numbers", () => {
  const first = { id: "root1", status: "completed", subagent_id: null };
  const latest = { id: "root2", status: "failed", subagent_id: null };
  assert.equal(rootTurn([first, latest, { id: "child", status: "completed", subagent_id: "child" }, { id: "unknown", status: "completed" }]), latest);
  assert.equal(rootTurn([{ id: "unknown", status: "completed" }]), null);
  assert.deepEqual(turnUsage({ ...first, usage: { input_tokens: 12, output_tokens: 0 } }), { inputTokens: 12, outputTokens: 0, reported: true });
  for (const invalid of [-1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "12", null]) {
    assert.deepEqual(turnUsage({ ...first, usage: { input_tokens: invalid, output_tokens: invalid } }), { inputTokens: 0, outputTokens: 0, reported: false });
  }
  assert.deepEqual(turnUsage(first), { inputTokens: 0, outputTokens: 0, reported: false });
});
