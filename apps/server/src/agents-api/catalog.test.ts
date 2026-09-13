import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentsApiConfig, type AgentsApiConfig } from "../config.js";
import { managedCatalog, reviewerDefinition } from "./catalog.js";

const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const config = (): AgentsApiConfig => ({
  enabled: true, apiKey: "application-key-fixture", executorKey: "restricted-key-fixture",
  model: "gpt-6-astra", executorImage: `registry.example.invalid/codex@sha256:${"a".repeat(64)}`,
  maxConcurrentSessions: 2, maxTurnSeconds: 600, skillIds: [], allowedTenantIds: [tenantId],
});

test("managed runtime is disabled by default and exposes no application credentials or instruction configuration", () => {
  const defaults = loadAgentsApiConfig({});
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.allowedTenantIds, []);
  assert.equal(defaults.maxConcurrentSessions, 2);
  assert.equal(defaults.maxTurnSeconds, 600);
  assert.equal(managedCatalog(defaults).available, false);
  const valid = config();
  const catalog = managedCatalog(valid);
  assert.equal(catalog.available, true);
  const publicJson = JSON.stringify(catalog);
  for (const privateValue of [valid.apiKey!, valid.executorKey!, valid.executorImage!, tenantId, "instructions", "skillIds"]) {
    assert.ok(!publicJson.includes(privateValue));
  }
  assert.deepEqual(catalog.agents[0]!.capabilities, { readOnly: true, steer: false, cancel: true, attachments: false, writeActions: false });
});

test("reviewer identity is stable across equivalent skill selections and changes with model or selection", () => {
  const first = reviewerDefinition({ ...config(), skillIds: ["review-guidance", "policy-guidance"] });
  const reordered = reviewerDefinition({ ...config(), skillIds: ["policy-guidance", "review-guidance", "review-guidance"] });
  assert.equal(first.version, reordered.version);
  assert.notEqual(first.version, reviewerDefinition({ ...config(), skillIds: ["review-guidance"] }).version);
  assert.notEqual(first.version, reviewerDefinition({ ...config(), model: "different-model", skillIds: first.skillIds }).version);
  assert.equal(first.maxSubagents, 2);
});

test("accepts reviewed local image content IDs and repository digests, but not shortened IDs", () => {
  assert.equal(managedCatalog({ ...config(), executorImage: `sha256:${"b".repeat(64)}` }).available, true);
  assert.equal(managedCatalog({ ...config(), executorImage: "sha256:abcd" }).available, false);
  assert.equal(managedCatalog({ ...config(), executorImage: "abcd1234" }).available, false);
});

test("unsafe configuration fails managed availability without reflecting secrets", async (t) => {
  const scenarios: Array<[string, Partial<AgentsApiConfig>]> = [
    ["missing application key", { apiKey: null }],
    ["same credential", { executorKey: "application-key-fixture" }],
    ["whitespace key", { executorKey: " \n" }],
    ["placeholder", { apiKey: "replace-with-your-key" }],
    ["mutable image", { executorImage: "codex:latest" }],
    ["invalid model", { model: "bad\nmodel" }],
    ["key in model field", { model: "application-key-fixture" }],
    ["skill path", { skillIds: ["../unapproved"] }],
    ["too many skills", { skillIds: Array.from({ length: 65 }, (_, i) => `skill-${i}`) }],
    ["tenant wildcard", { allowedTenantIds: ["*"] }],
    ["tenant path", { allowedTenantIds: ["../tenant"] }],
    ["zero concurrency", { maxConcurrentSessions: 0 }],
    ["nonfinite concurrency", { maxConcurrentSessions: Number.NaN }],
    ["excess concurrency", { maxConcurrentSessions: 17 }],
    ["negative duration", { maxTurnSeconds: -1 }],
    ["fractional duration", { maxTurnSeconds: 1.5 }],
    ["excess duration", { maxTurnSeconds: 1201 }],
  ];
  for (const [name, override] of scenarios) await t.test(name, () => {
    const catalog = managedCatalog({ ...config(), ...override });
    assert.equal(catalog.available, false);
    assert.ok(catalog.reason);
    assert.ok(!JSON.stringify(catalog).includes("application-key-fixture"));
    assert.ok(!JSON.stringify(catalog).includes("restricted-key-fixture"));
  });
});

test("environment parsing rejects ambiguous numeric limits and normalizes explicit selections", () => {
  const env = {
    AGENTS_API_ENABLED: " TRUE ", AGENTS_API_KEY: " application-key ", AGENTS_API_EXECUTOR_KEY: " executor-key ",
    AGENTS_API_ALLOWED_TENANT_IDS: ` ${tenantId},${tenantId}, `,
    AGENTS_API_SKILL_IDS: " review-guidance,policy-guidance,review-guidance ",
  };
  const parsed = loadAgentsApiConfig(env);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.apiKey, "application-key");
  assert.equal(parsed.executorKey, "executor-key");
  assert.deepEqual(parsed.allowedTenantIds, [tenantId]);
  assert.deepEqual(parsed.skillIds, ["review-guidance", "policy-guidance"]);
  for (const value of ["2junk", "1.9", "-1", "Infinity", "1e2"]) {
    const invalid = loadAgentsApiConfig({ ...env, AGENTS_API_MAX_CONCURRENT_SESSIONS: value, AGENTS_API_MAX_TURN_SECONDS: value });
    assert.ok(Number.isNaN(invalid.maxConcurrentSessions), value);
    assert.ok(Number.isNaN(invalid.maxTurnSeconds), value);
  }
  assert.equal(loadAgentsApiConfig({ AGENTS_API_MAX_CONCURRENT_SESSIONS: "17" }).maxConcurrentSessions, 17, "excess values must not silently become valid through clamping");
});
