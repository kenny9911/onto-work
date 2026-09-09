// Local deterministic probes only: no database, API call, or downloaded script execution.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outputDir = dirname(fileURLToPath(import.meta.url));
const operator = resolve(process.env.AGENTIC_OPERATOR_ROOT || resolve(outputDir, "../../../../agentic-operator"));
const moduleAt = (relative: string) => import(pathToFileURL(resolve(operator, relative)).href);
const { readSkillCatalog, prepareCatalogSkill } = await moduleAt("apps/api/src/services/skill-catalog-import.ts");
const { SkillSession, DEFAULT_SKILL_SESSION_LIMITS } = await moduleAt("packages/skills/src/session.ts");
const { prepareSkillMessages } = await moduleAt("packages/runtime/src/skill-execution.ts");
const { mapAnthropicMessages } = await moduleAt("packages/llm-gateway/src/adapters/anthropic.ts");
const { root, catalog } = readSkillCatalog(resolve(operator, "skills-library/catalog.json"));
const prepared = catalog.skills.map((skill: any) => {
  const result = prepareCatalogSkill(root, skill);
  return { source: skill, bundle: result.bundle, entry: {
    id: skill.id, versionId: "review-" + result.validation.digest,
    contentDigest: result.validation.digest,
    name: result.validation.metadata.name,
    description: result.validation.metadata.description,
  }};
});
const sessionFor = (selected: any[]) => new SkillSession({
  catalog: selected.map(item => item.entry),
  readBundle: (entry: any) => selected.find(item => item.entry.id === entry.id).bundle,
});
const activation = [];
for (const item of prepared) {
  const session = sessionFor([item]);
  try {
    const result = await session.activate({ id: item.entry.id }, { origin: "model" });
    activation.push({ id: item.entry.id, status: "passed", bodyBytes: result.bytes,
      renderedBytes: Buffer.byteLength(await session.renderActiveInstructions()) });
  } catch (error: any) {
    activation.push({ id: item.entry.id, status: "failed", code: error.code, message: error.message });
  }
}
const all = sessionFor(prepared);
const pages = [];
let cursor;
do {
  const page = await all.list({ origin: "model", ...(cursor ? { cursor } : {}) });
  pages.push({ names: page.skills.map((x: any) => x.name), count: page.skills.length,
    serializedBytes: Buffer.byteLength(JSON.stringify(page)), hasNext: Boolean(page.nextCursor) });
  cursor = page.nextCursor;
} while (cursor);

// Use a real prepared bundle and real gateway projector to compare prefix bytes.
const item = prepared.find((x: any) => x.entry.id === "openai/curated/pdf");
const session = sessionFor([item]);
const history = [{ role: "system", content: "Follow the user's request and approved tools." },
  { role: "user", content: "Inspect the supplied PDF." }];
const before = await prepareSkillMessages(history, session);
const wireBefore = mapAnthropicMessages(before);
await session.activate({ id: item.entry.id }, { origin: "model" });
// A synthetic tool-turn represents the position of an API-returned assistant.
// No thinking/signature content is invented and no request is sent.
const after = await prepareSkillMessages([...history,
  { role: "assistant", content: "I will load the PDF skill." },
  { role: "user", content: "The skill is now loaded." }], session);
const wireAfter = mapAnthropicMessages(after);
const hash = (value: any) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const wirePrefixEqual = JSON.stringify(wireBefore.messages) === JSON.stringify(wireAfter.messages.slice(0, wireBefore.messages.length));

// Individually successful skills may exceed the total active context budget together.
const largest = activation.filter(x => x.status === "passed").sort((a, b) => b.renderedBytes - a.renderedBytes);
const combinationSession = sessionFor(prepared);
const combination = [];
for (const result of largest.slice(0, 8)) {
  try {
    await combinationSession.activate({ id: result.id }, { origin: "model" });
    combination.push({ id: result.id, status: "passed", activeRenderedBytes: Buffer.byteLength(await combinationSession.renderActiveInstructions()) });
  } catch (error: any) {
    combination.push({ id: result.id, status: "failed", code: error.code, message: error.message });
    break;
  }
}
const representativeSession = sessionFor(prepared);
const representativeCombination = [];
for (const id of ["anthropic/skill-creator", "openai/curated/playwright-interactive"]) {
  try {
    await representativeSession.activate({ id }, { origin: "model" });
    representativeCombination.push({ id, status: "passed", activeRenderedBytes: Buffer.byteLength(await representativeSession.renderActiveInstructions()) });
  } catch (error: any) {
    representativeCombination.push({ id, status: "failed", code: error.code, message: error.message });
  }
}
const nameResolution = [];
for (const name of ["openai-docs", "openai-openai-docs", "openai-system-openai-docs"]) {
  try {
    const isolated = sessionFor(prepared);
    const result = await isolated.activate(name, { origin: "model" });
    nameResolution.push({ requested: name, status: "passed", resolvedId: result.id });
  } catch (error: any) {
    nameResolution.push({ requested: name, status: "failed", code: error.code, message: error.message });
  }
}
const sourceFiles = ["packages/skills/src/session.ts", "packages/runtime/src/skill-execution.ts",
  "apps/api/src/services/skill-runtime.ts", "apps/api/src/services/skill-catalog-import.ts",
  "packages/llm-gateway/src/adapters/anthropic.ts"];
const sourceHashes = [];
for (const path of sourceFiles) sourceHashes.push({ path: resolve(operator, path),
  sha256: createHash("sha256").update(await readFile(resolve(operator, path))).digest("hex") });
const results = {
  performedAt: new Date().toISOString(), method: "local deterministic runtime probes", modelCalls: 0,
  productionDataAccess: false, evaluatedRoutes: [], defaultLimits: DEFAULT_SKILL_SESSION_LIMITS,
  sourceHashes, activation, discovery: { total: prepared.length, pages },
  historyPrefixProbe: { skillId: item.entry.id, beforeMessageCount: wireBefore.messages.length,
    afterMessageCount: wireAfter.messages.length, wirePrefixEqual,
    beforeGuidanceSha256: hash(wireBefore.messages[0]), afterGuidanceSha256: hash(wireAfter.messages[0]),
    observation: "The real message builder changes an earlier user guidance message after skill activation.",
    inference: "Where Fable 5.1 enforces prefix-bound thinking replay, this changed prefix may produce a provider error or discard thinking. No provider rejection was measured." },
  combination, representativeCombination, nameResolution,
};
await writeFile(resolve(outputDir, "runtime-probe-results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ individualPassed: activation.filter(x => x.status === "passed").length,
  individualFailed: activation.filter(x => x.status === "failed"), discoveryPages: pages.map(p => p.count),
  wirePrefixEqual, combination, modelCalls: 0 }, null, 2));
