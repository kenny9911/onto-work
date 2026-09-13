import assert from "node:assert/strict";
import test from "node:test";

import { AgentsApiClient, AgentsApiError, validateAgentsApiRemoteUrl } from "./client.js";

const session = {
  id: "sess_test", status: "idle",
  environment: { id: "env_test", type: "self_hosted", remote_url: "https://api.openai.com/v1/agents/environments?route=test" },
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function errorCode(code: AgentsApiError["code"]) {
  return (error: unknown) => error instanceof AgentsApiError && error.code === code;
}

test("uses the documented beta routes and preserves self-hosted environment configuration", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new AgentsApiClient({ apiKey: "test-application-key", fetch: async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (init?.method === "GET" || String(url).endsWith("/sessions")) return json(session);
    return new Response(null, { status: 204 });
  } });
  assert.equal((await client.createSession({
    model: "test-model", instructions: "Review source", workspaceDirectory: "/workspace",
    capabilityDirectories: ["/workspace/capabilities"], maxConcurrentSubagents: 2,
  })).environment.remote_url, session.environment.remote_url);
  await client.retrieveSession(session.id);
  await client.sendMessage(session.id, "Inspect the parser");
  await client.cancel(session.id);
  await client.deleteSession(session.id);
  assert.deepEqual(requests.map(({ url, init }) => [init.method, url]), [
    ["POST", "https://api.openai.com/v1/agents/sessions"],
    ["GET", "https://api.openai.com/v1/agents/sessions/sess_test"],
    ["POST", "https://api.openai.com/v1/agents/sessions/sess_test/events"],
    ["POST", "https://api.openai.com/v1/agents/sessions/sess_test/events"],
    ["DELETE", "https://api.openai.com/v1/agents/sessions/sess_test"],
  ]);
  const created = JSON.parse(requests[0]!.init.body as string);
  assert.deepEqual(created, {
    agent: { model: "test-model", instructions: "Review source", multi_agent: { enabled: true, max_concurrent_subagents: 2 } },
    environment: { type: "self_hosted", workspace_directory: "/workspace", capability_directories: ["/workspace/capabilities"] },
  });
  assert.deepEqual(JSON.parse(requests[2]!.init.body as string), {
    events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "Inspect the parser" }] }] }],
  });
  assert.deepEqual(JSON.parse(requests[3]!.init.body as string), { events: [{ type: "agent.session.input.cancel" }] });
  for (const { init } of requests) {
    assert.equal(new Headers(init.headers).get("OpenAI-Beta"), "agents=v1");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-application-key");
    assert.equal(init.redirect, "error");
  }
});

test("paginates complete history and fails rather than silently truncating or looping", async () => {
  const urls: string[] = [];
  const client = new AgentsApiClient({ apiKey: "test", fetch: async (url) => {
    urls.push(String(url));
    return String(url).includes("after=")
      ? json({ data: [{ id: "second", type: "message" }], has_more: false, last_id: "second" })
      : json({ data: [{ id: "first", type: "message" }], has_more: true, last_id: "first" });
  } });
  assert.deepEqual((await client.listItems("sess_test")).map((item) => item.id), ["first", "second"]);
  assert.equal(new URL(urls[1]!).searchParams.get("after"), "first");
  assert.equal(new URL(urls[1]!).searchParams.get("order"), "asc");
  await assert.rejects(client.listItems("sess_test", { maxItems: 1 }), errorCode("limit"));
  const looping = new AgentsApiClient({ apiKey: "test", fetch: async () =>
    json({ data: [{ id: "first", type: "message" }], has_more: true, last_id: "first" }) });
  await assert.rejects(looping.listItems("sess_test"), errorCode("protocol"));
});

test("retrieves authoritative turns without inventing a current-turn session field", async () => {
  const turn = { id: "turn_1", status: "completed", subagent_id: null, usage: { total_tokens: 42 } };
  const client = new AgentsApiClient({ apiKey: "test", fetch: async (url) =>
    String(url).includes("/turns?") ? json({ data: [turn], has_more: false }) : json(turn) });
  assert.deepEqual(await client.listTurns("sess_test"), [turn]);
  assert.deepEqual(await client.retrieveTurn("sess_test", "turn_1"), turn);
});

test("opens the stream before input and parses fragmented CRLF, Unicode, and multiline SSE data", async () => {
  const content = ': heartbeat\r\n\r\nevent: notification\r\ndata: {"type":"agent.session.turn.output_text.done",\r\ndata: "text":"你好"}\r\n\r\ndata: {"type":"agent.session.idle"}\n\ndata: [DONE]\n\n';
  const encoded = new TextEncoder().encode(content);
  const client = new AgentsApiClient({ apiKey: "test", fetch: async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/agents/sessions/sess_test/events?stream=true");
    assert.equal(new Headers(init!.headers).get("Accept"), "text/event-stream");
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  } });
  const stream = await client.openEventStream("sess_test");
  const received = [];
  for await (const event of stream.events) received.push(event);
  assert.deepEqual(received, [
    { type: "agent.session.turn.output_text.done", text: "你好" },
    { type: "agent.session.idle" },
  ]);
});

test("cancels the stream reader when consumption stops and bounds incomplete frames", async () => {
  let cancelled = false;
  const client = new AgentsApiClient({ apiKey: "test", fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"agent.session.idle"}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } }) });
  const stream = await client.openEventStream("sess_test");
  for await (const event of stream.events) { assert.equal(event.type, "agent.session.idle"); break; }
  assert.equal(cancelled, true);

  const excessive = new AgentsApiClient({ apiKey: "test", maxEventBytes: 32, fetch: async () =>
    new Response(`data: ${"x".repeat(33)}`, { headers: { "Content-Type": "text/event-stream" } }) });
  const largeStream = await excessive.openEventStream("sess_test");
  await assert.rejects(async () => { for await (const _event of largeStream.events) { /* consume */ } }, errorCode("limit"));
});

test("does not expose upstream secrets, follow redirects, or retry failed mutations", async () => {
  let requests = 0;
  const client = new AgentsApiClient({ apiKey: "private-key", fetch: async () => {
    requests += 1;
    return json({ error: { message: "private-key in private upstream URL" } }, 429);
  } });
  await assert.rejects(client.sendMessage("sess_test", "work"), (error: unknown) => {
    assert.ok(error instanceof AgentsApiError);
    assert.equal(error.status, 429);
    assert.doesNotMatch(String(error), /private|upstream URL/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 1);
  const broken = new AgentsApiClient({ apiKey: "test", fetch: async () => { throw new Error("secret DNS address"); } });
  await assert.rejects(broken.openEventStream("sess_test"), errorCode("network"));
  await assert.rejects(broken.retrieveSession("sess_test"), errorCode("network"));
});

test("bounds response bodies and distinguishes timeout from caller cancellation", async () => {
  const oversized = new AgentsApiClient({ apiKey: "test", maxResponseBytes: 10, fetch: async () => json(session) });
  await assert.rejects(oversized.retrieveSession("sess_test"), errorCode("limit"));
  const stalled: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const rejectAborted = () => reject(new Error("private transport details"));
    if (init!.signal!.aborted) rejectAborted();
    else init!.signal!.addEventListener("abort", rejectAborted, { once: true });
  });
  const client = new AgentsApiClient({ apiKey: "test", requestTimeoutMs: 10, fetch: stalled });
  // A real socket keeps the event loop alive; this test double does not.
  const keepAlive = setInterval(() => undefined, 100);
  try { await assert.rejects(client.retrieveSession("sess_test"), errorCode("timeout")); }
  finally { clearInterval(keepAlive); }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.retrieveSession("sess_test", controller.signal), errorCode("aborted"));
});

test("rejects untrusted executor URLs and invalid session responses", async () => {
  for (const url of ["http://api.openai.com/v1", "https://api.openai.com.attacker.test/v1", "https://user:pass@api.openai.com/v1", "https://api.openai.com:123/v1", "https://api.openai.com/v1#fragment"]) {
    assert.throws(() => validateAgentsApiRemoteUrl(url), errorCode("protocol"));
  }
  assert.equal(validateAgentsApiRemoteUrl(session.environment.remote_url), session.environment.remote_url);
  const client = new AgentsApiClient({ apiKey: "test", fetch: async () => json({ ...session, environment: { ...session.environment, remote_url: "https://attacker.test" } }) });
  await assert.rejects(client.retrieveSession("sess_test"), errorCode("protocol"));
  await assert.rejects(client.retrieveSession("../secrets"), errorCode("protocol"));
});
