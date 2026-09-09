import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { probeProvider } from "./probe.js";

test("provider probes enforce a total timeout and bounded response size", async (t) => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/oversized/")) response.end("x".repeat(65 * 1_024));
    // The other endpoint deliberately never responds.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const input = { model: "test-model", credential: "test-secret", allowAddress: () => true };
  const timedOut = await probeProvider({ ...input, baseUrl: `http://127.0.0.1:${address.port}/timeout`, timeoutMs: 30 });
  assert.equal(timedOut.success, false);
  assert.match(timedOut.message, /timeout/);
  const oversized = await probeProvider({ ...input, baseUrl: `http://127.0.0.1:${address.port}/oversized` });
  assert.equal(oversized.success, false);
  assert.match(oversized.message, /oversized/);
});

test("provider probes screen resolved DNS addresses before connecting", async () => {
  const result = await probeProvider({
    baseUrl: "http://localhost:1/v1", model: "test-model", credential: "test-secret", allowAddress: () => false,
  });
  assert.equal(result.success, false);
  assert.match(result.message, /blocked by the server deployment policy/);
});
