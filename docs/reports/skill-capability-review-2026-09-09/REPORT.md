# Skill capability review — Fable 5.1 and GPT-6 Astra

Reviewed: 9 September 2026. Scope: all 53 imported Agentic Operator catalog entries, including the 14 shared copies selected for onto-work. The remaining skills installed personally in Codex and the repositories' development-assistant skills are outside this review.

Source location matters: the onto-work shared copies are in the completed import worktree at `/Users/kenny/CSI-AICOE/onto-work-skills/shared`, associated with merged revision `e18db784f510da71a120ef708aee866c8b048b47`. The current `/Users/kenny/CSI-AICOE/onto-work` checkout has other work in progress and does not contain that shared directory. This report does not synchronize or alter either checkout. Shared-copy hashes and instruction-body correspondence are verified separately from the Agentic Operator runtime probes.

**The catalog cannot currently be certified as non-degrading.** Some skills supply valuable domain knowledge, reusable resources and reliable procedures. Others introduce unnecessary stops, fixed approaches, incompatible host assumptions or restrictions on verification. A stronger model can follow those instructions more effectively and therefore still deliver a worse result. Correct installation, licensing and a Pro authoring model do not establish behavioral quality.

This is an evidence-backed instruction review with local runtime probes, **not a completed Fable-versus-Astra benchmark**. No paid model calls were made. Per-skill risk levels are review judgments, not measured regression rates. The report does not change imported files, activation settings, models or production records.

## Review totals

| Source review judgment | All 53 entries | 14 onto-work shared entries |
| --- | ---: | ---: |
| High risk | 16 | 5 |
| Moderate risk | 29 | 9 |
| Low risk | 8 | 0 |

These counts are **review classifications**, not model pass/fail results. The separate local activation probe passed 52 entries and rejected one. 170 source citations were checked against the exact quoted line ranges, and 185 examined source files were hashed. There are 106 proposed development cases and **zero executed model cases**.

Read the [searchable explorer](</Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/index.html>) for filtered per-skill detail, the [JSON manifest](</Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/evaluation-manifest.json>) for structured evidence, and the [planned cases](</Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/evaluation-cases.json>) for the test design. The [CSV summary](</Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/skill-summary.csv>) is available for spreadsheet analysis.

## What “degradation” means

Skills do not change a model's weights. They can change its realized performance by redirecting attention, limiting valid approaches, consuming context, adding unnecessary tools or pauses, reducing verification, or making relevant resources inaccessible. The relevant comparison is the **same model**, task, tool access and operating conditions with and without the skill.

A shorter response, lower token use or narrower scope is not automatically worse. A correct authorization check, data schema, business requirement, accessibility standard or fragile operation's exact procedure may be essential to success. The concern is a constraint that conflicts with the user's task or offers no demonstrated benefit in that context. Removing every “must” or safety boundary would itself reduce quality.

The review examines task completion, correctness, user intent, autonomy on authorized work, solution flexibility, context efficiency, tool/model compatibility, verification and appropriate discovery. It evaluates what the model is asked to do, not an unobservable internal notion of intelligence.

## Evidence levels

| Evidence | What was done | What it establishes |
| --- | --- | --- |
| Text review | Full SKILL.md review for all 53 entries; selected linked references, helper scripts and metadata inspected | Concrete instruction mechanisms, benefits and plausible regression cases |
| Local runtime probes | Real import transformation, SkillSession activation, discovery pagination and Anthropic message projection, without a model or database | Observed loading limits, name resolution and request-prefix changes |
| Earlier installation checks | Source hashes, resources, licenses and native discovery were verified in the import task | Bundle integrity and discovery, not model task quality |
| Proposed challenge cases | Two task-specific cases per skill | A development evaluation set; these cases have not been run on either named model |
| Paired model evaluation | Not performed | No non-degradation certificate, win rate, quality delta or model ranking is claimed |

The evidence manifest records each source entrypoint's SHA-256, size, source revision, examined resources and line citations. Supporting files were read when relevant to the identified behavior; this is not a claim that every bundled reference, library dependency or script was exhaustively audited or executed. Audit instructions were treated as data, not followed as operating instructions.

## Model-specific basis

**GPT-6 Astra.** OpenAI explicitly notes that Astra can be sensitive to instructions in skills and AGENTS.md, and that unclear or conflicting guidance can stall work. It recommends making user-versus-skill priority explicit and explaining a skill-induced pause. This supports auditing unnecessary method mandates and approval loops; it does not establish a numerical regression for any individual skill. [Official Astra guidance](https://developers.openai.com/api/docs/guides/latest-model)

**Claude Fable 5.1.** Anthropic documents that Fable can handle long tasks with little methodological guidance but may stop for already-authorized work. It also advises auditing older instructions that suppress useful progress or formatting. Separately, prefix-bound thinking replay can reject a changed conversation prefix, or discard affected blocks under the documented opt-in behavior; enforcement depends on account/API conditions. That makes the locally observed prefix rewrite a material compatibility risk, not a measured provider failure. [Official Fable prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)

Anthropic's skill guidance recommends matching procedural specificity to task fragility and testing with intended consumer models. This supports keeping exact requirements where they matter and leaving room for judgment elsewhere. [Skill authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

There is no evidence here that Fable is categorically more or less affected than Astra. Their per-skill notes describe expected interactions to test, not a head-to-head ranking. The actual authoring service's verified Sol Pro usage is separate from execution on these two consumer models.

## Reproduced runtime findings

1. **The imported `anthropic/claude-api` skill cannot activate under the current provider-neutral defaults.** The real importer accepts the bundle, but SkillSession activation fails with `LIMIT_EXCEEDED: Skill session maxActiveContextBytes budget exceeded`. The entrypoint is 85,004 UTF-8 bytes; the active guidance budget is 65,536 bytes including JSON framing. The other 52 entries activate individually. Split this skill into a concise router with language/topic references, then repeat activation and task tests. The native Codex loader has different limits; this finding does not imply a native Codex failure.
2. **Skill activation changes an earlier Anthropic request message.** The real `prepareSkillMessages` and `mapAnthropicMessages` functions produced different first-message hashes before and after activating the PDF skill. The existing adapter can replay provider thinking blocks. Under Fable's prefix-binding rules, that combination may cause a request error or discard usable thinking. Preserve earlier request messages and append activation material using a supported history pattern. No actual provider rejection or loss of reasoning quality was measured.
3. **An upstream skill name no longer resolves after namespacing.** `openai-docs` fails with `UNKNOWN_SKILL`, whereas `openai-openai-docs` and `openai-system-openai-docs` resolve. The ChatGPT-app instructions still reference `$openai-docs`. Their documented fallback may rescue the task, so this is not proof every app task fails. Use reviewed dependency aliases or adapt internal references to the actual selected skill ID.
4. **Individually loadable skills can fail together.** Activating Anthropic Skill Creator and then Playwright Interactive exceeds the shared active-context budget. A second size-stress pair fails similarly. This is a deterministic budget result, not a model regression. Reduce unnecessary loaded content and define bounded activation lifetimes; do not simply inject all files because a frontier model has a large context window.
5. **Discovery is paginated, and skill bodies persist after activation.** The full catalog appeared as pages of 20, 20 and 13 entries; the first page contained 13,697 serialized bytes in the probe. Initially visible metadata is not the entire collection. Activated bodies are re-rendered on later requests and the session has no normal unload intrinsic. This can add irrelevant context in long workflows. Prefer relevant workflow selections and progressive references; test discovery of later-page skills and stale guidance after a task changes.

The reproducible script and complete observations are in `runtime-probes.mts` and `runtime-probe-results.json`. They use the real source import transformation and runtime classes in memory; they do not inspect a live tenant's private publications. No production configuration has been changed.

The relevant implementation is the [default budgets and activation accounting](/Users/kenny/CSI-AICOE/agentic-operator/packages/skills/src/session.ts:71), [request guidance placement](/Users/kenny/CSI-AICOE/agentic-operator/packages/runtime/src/skill-execution.ts:30), [Anthropic replay projection](/Users/kenny/CSI-AICOE/agentic-operator/packages/llm-gateway/src/adapters/anthropic.ts:216), [exact skill-name lookup](/Users/kenny/CSI-AICOE/agentic-operator/packages/skills/src/session.ts:663), and [available skill intrinsics](/Users/kenny/CSI-AICOE/agentic-operator/packages/runtime/src/skill-execution.ts:10). Code digests are recorded with the probe results.

## Risk and recommendation meanings

| Label | Meaning |
| --- | --- |
| Low risk | No strong unnecessary constraint identified for an appropriate task and compatible host. Still unproven behaviorally. |
| Moderate risk | A meaningful conditional restriction, dependency, ambiguity or context burden needs adaptation or task-specific verification. |
| High risk | A concrete loading blocker or strong instruction capable of conflicting with common authorized tasks, verification or required host behavior. |
| Retain | Preserve the useful skill; normal relevant discovery and host checks remain appropriate. |
| Adapt | Keep its useful content, but revise the specific harmful mechanism and compare behavior. |
| Host-only | Bind availability to verified tools and runtime features; do not pretend the skill supplies them. |
| Domain-only | Keep its application within the stated business, brand or artifact domain. |
| Retire duplicate | Keep the source archive; choose a single canonical runtime entry for overlapping content. |

These are review recommendations, not applied activation policies. “Host-only” and “domain-only” do not require an extra permission question on every invocation. Skills remain subject to the user's request and existing security/approval boundaries.

## Recommended repair order

First fix the measured activation limit failure, request-prefix mutation and namespaced dependency mismatch. Those are integration issues a better prose prompt cannot reliably overcome.

Next adapt instructions that stop authorized work, disable or skip useful verification, hard-code smaller models, invent a user's preferences, or mandate an incompatible host. Preserve the domain-specific substance. The individual entries identify exact lines and narrower replacement principles.

Then choose a canonical copy for duplicate app-building and OpenAI-docs guidance, and make creators proportional to task complexity. The maintained Agentic creator is comparatively restrained in its text: it favors user intent, conditional procedures, provider-neutral dependencies and honest evaluation claims. That is a favorable design assessment, not proof it is the best creator or that every generated skill is good.

Finally run the paired tests on both consumer models. Prioritize the 14 onto-work skills and the high-risk cases before expanding coverage. Native versus provider-neutral paths should be evaluated separately because their tool surfaces, loading limits and conversation construction differ.

## A fair behavioral evaluation

Freeze model IDs (`claude-fable-5-1`, `gpt-6-astra`), confirmed provider routes, skill digests, prompts, fixtures, tools, permissions and model settings before each comparison. Keep effort and limits constant **within** a model's pair; the same effort label is not identical compute across vendors.

Use separate conditions: no skill; metadata available with natural selection; and the skill explicitly loaded where instruction effects need to be isolated. A fourth condition may test an adapted candidate. Do not confuse discovery failure with an instruction-body failure or a missing dependency.

Measure task success, factual/artifact correctness, satisfaction of explicit constraints, unnecessary approval pauses, verification quality, tool failures, latency and reported token/cost usage. Record failures as well as successes; never turn an unavailable metric into zero. Compare files and outcomes, not whether the answer follows the skill's preferred wording or process. Blind and randomize subjective comparisons where practical.

The 106 proposed cases are **development challenge cases**, created from this review. They are not independent held-out evidence. Fix adapters and candidates against them, then obtain fresh held-out cases before making a release claim. Use a small high-risk pilot, repeat any inconsistent outcomes, and broaden only when it adds evidence. Predeclare any non-inferiority margin and acceptable trade-offs; a cheaper result is not sufficient if it loses a required outcome.

A successful evaluation supports a bounded statement about those tasks, versions and hosts. It cannot prove zero degradation on every future task. The production acceptance decision should preserve beneficial domain constraints while removing demonstrated unnecessary ones.

## Catalog overview

“Shared” identifies the 14 onto-work copies selected during import. Every entry remains in the Agentic Operator archive. A successful activation only means that this bundle loads alone under the probed defaults; it is not a quality score. The full catalog contains 81,030 entrypoint words and 577,937 UTF-8 bytes, spread across separately loaded files. These are not prompt-token totals.

| # | Skill | Risk | Recommendation | Shared | Load alone | Words |
| ---: | --- | --- | --- | :---: | --- | ---: |
| 1 | [anthropic/academy-guide](#skill-01) | moderate | adapt | — | passed | 1,209 |
| 2 | [anthropic/algorithmic-art](#skill-02) | high | adapt | — | passed | 2,761 |
| 3 | [anthropic/brand-guidelines](#skill-03) | moderate | domain-only | — | passed | 329 |
| 4 | [anthropic/canvas-design](#skill-04) | high | adapt | — | passed | 1,749 |
| 5 | [anthropic/claude-api](#skill-05) | high | adapt | — | failed | 11,626 |
| 6 | [anthropic/discernment-nudge](#skill-06) | moderate | adapt | — | passed | 1,751 |
| 7 | [anthropic/frontend-design](#skill-07) | moderate | adapt | yes | passed | 1,516 |
| 8 | [anthropic/internal-comms](#skill-08) | moderate | adapt | yes | passed | 211 |
| 9 | [anthropic/mcp-builder](#skill-09) | moderate | adapt | yes | passed | 1,143 |
| 10 | [anthropic/skill-creator](#skill-10) | high | adapt | yes | passed | 5,205 |
| 11 | [anthropic/slack-gif-creator](#skill-11) | moderate | adapt | — | passed | 1,103 |
| 12 | [anthropic/theme-factory](#skill-12) | moderate | adapt | — | passed | 486 |
| 13 | [anthropic/web-artifacts-builder](#skill-13) | high | host-only | — | passed | 446 |
| 14 | [anthropic/webapp-testing](#skill-14) | moderate | adapt | yes | passed | 501 |
| 15 | [openai-plugins/openai-developers/build-chatgpt-app](#skill-15) | moderate | adapt | yes | passed | 2,707 |
| 16 | [openai-plugins/openai-developers/chatgpt-app-submission](#skill-16) | moderate | adapt | yes | passed | 1,564 |
| 17 | [openai/curated/aspnet-core](#skill-17) | low | retain | — | passed | 573 |
| 18 | [openai/curated/chatgpt-apps](#skill-18) | moderate | retire-duplicate | — | passed | 2,706 |
| 19 | [openai/curated/cli-creator](#skill-19) | moderate | adapt | — | passed | 1,587 |
| 20 | [openai/curated/cloudflare-deploy](#skill-20) | moderate | adapt | — | passed | 972 |
| 21 | [openai/curated/define-goal](#skill-21) | low | retain | — | passed | 870 |
| 22 | [openai/curated/gh-address-comments](#skill-22) | high | adapt | yes | passed | 205 |
| 23 | [openai/curated/gh-fix-ci](#skill-23) | high | adapt | yes | passed | 527 |
| 24 | [openai/curated/hatch-pet](#skill-24) | high | host-only | — | passed | 5,028 |
| 25 | [openai/curated/jupyter-notebook](#skill-25) | moderate | adapt | — | passed | 521 |
| 26 | [openai/curated/linear](#skill-26) | moderate | host-only | — | passed | 699 |
| 27 | [openai/curated/migrate-to-codex](#skill-27) | high | host-only | — | passed | 1,080 |
| 28 | [openai/curated/netlify-deploy](#skill-28) | moderate | adapt | — | passed | 986 |
| 29 | [openai/curated/notion-knowledge-capture](#skill-29) | moderate | adapt | — | passed | 444 |
| 30 | [openai/curated/notion-meeting-intelligence](#skill-30) | moderate | adapt | — | passed | 441 |
| 31 | [openai/curated/notion-research-documentation](#skill-31) | moderate | adapt | — | passed | 456 |
| 32 | [openai/curated/notion-spec-to-implementation](#skill-32) | moderate | adapt | — | passed | 449 |
| 33 | [openai/curated/openai-docs](#skill-33) | high | adapt | — | passed | 2,554 |
| 34 | [openai/curated/pdf](#skill-34) | moderate | adapt | yes | passed | 373 |
| 35 | [openai/curated/playwright](#skill-35) | moderate | adapt | — | passed | 522 |
| 36 | [openai/curated/playwright-interactive](#skill-36) | high | host-only | — | passed | 4,388 |
| 37 | [openai/curated/render-deploy](#skill-37) | high | adapt | — | passed | 2,443 |
| 38 | [openai/curated/screenshot](#skill-38) | low | host-only | — | passed | 983 |
| 39 | [openai/curated/security-best-practices](#skill-39) | moderate | adapt | yes | passed | 1,431 |
| 40 | [openai/curated/security-ownership-map](#skill-40) | moderate | domain-only | — | passed | 932 |
| 41 | [openai/curated/security-threat-model](#skill-41) | high | adapt | yes | passed | 763 |
| 42 | [openai/curated/sentry](#skill-42) | low | host-only | — | passed | 548 |
| 43 | [openai/curated/speech](#skill-43) | moderate | host-only | — | passed | 1,006 |
| 44 | [openai/curated/transcribe](#skill-44) | low | host-only | — | passed | 370 |
| 45 | [openai/curated/vercel-deploy](#skill-45) | high | adapt | — | passed | 380 |
| 46 | [openai/curated/winui-app](#skill-46) | moderate | host-only | — | passed | 1,572 |
| 47 | [openai/curated/yeet](#skill-47) | high | adapt | — | passed | 1,091 |
| 48 | [openai/system/imagegen](#skill-48) | low | host-only | — | passed | 2,340 |
| 49 | [openai/system/openai-docs](#skill-49) | high | adapt | yes | passed | 2,617 |
| 50 | [openai/system/plugin-creator](#skill-50) | low | host-only | — | passed | 753 |
| 51 | [openai/system/skill-creator](#skill-51) | moderate | adapt | yes | passed | 2,612 |
| 52 | [openai/system/skill-installer](#skill-52) | moderate | host-only | — | passed | 431 |
| 53 | [agentic/skill-creator](#skill-53) | low | retain | — | passed | 1,070 |

## Individual evaluations

Per-model notes below are static hypotheses to test. Each source bundle has two tailored proposed cases in the accompanying cases file.

<a id="skill-01"></a>

### 01. anthropic/academy-guide

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 1,209 entrypoint words; 7,755 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/academy-guide/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/academy-guide). 

**Benefit.** Finds relevant Claude Academy learning resources without inventing course URLs.

**Assessment.** The learning-intent trigger and mid-task exclusion are sensible. The unconditional two-item cap also limits requests whose actual deliverable is a larger training inventory; silent catalog errors can conceal why that inventory is incomplete. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Answers the question first and matches learning intent.; Requires current evidence for specific recommendations and treats fetched text as data.; Excludes users who are mid-task and want completion.

**Finding 1: The recommendation cap overrides explicit inventory scope..** A request for six resources may receive only two and a generic link.

- [SKILL.md, lines 84–89](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/academy-guide/SKILL.md:84>): “This cap applies to every reply, including when the question itself is a request for learning content”

**Recommended treatment:** Use a one-or-two recommendation default for incidental suggestions; honor explicit requested coverage.

**Finding 2: Silent catalog errors conceal material research limits..** A requested current catalog survey may appear complete despite unavailable source data.

- [SKILL.md, lines 135–139](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/academy-guide/SKILL.md:135>): “This is silent: never mention fetching, staleness, or errors to the user.”

**Recommended treatment:** Suppress incidental implementation noise, but disclose a source limitation when it prevents the requested research.

**GPT-6 Astra:** Astra benefits from curated provenance, but the fixed cap can suppress requested coverage despite sufficient reasoning capacity.

**Fable 5.1:** Fable benefits from the same catalog; a long-horizon training survey can be cut short by an instruction-level cap. This is not a measured weakness.

**Evidence coverage:** 1 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-02"></a>

### 02. anthropic/algorithmic-art

**High risk · adapt · Agentic Operator catalog.** Local activation: passed. 2,761 entrypoint words; 19,769 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/algorithmic-art/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/algorithmic-art). 

**Benefit.** Provides seeded generative-art patterns, interactive parameters and a reusable p5.js viewer.

**Assessment.** Reproducible seeds and controls are strong assets. The mandatory philosophy essay and literal Anthropic-branded light-theme viewer unnecessarily narrow broad art requests. The template depends on remote p5.js and Google Fonts. Reviewed template sections were viewer lines 1–130 and generator lines 1–100, not all template code. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Stable seeds make results reproducible.; Encourages meaningful algorithm-specific controls and performance attention.

**Finding 1: Fixed branding and layout displace the actual visual brief..** The assistant cannot choose a requested dark theme, brand, font or layout.

- [SKILL.md, lines 109–118](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/algorithmic-art/SKILL.md:109>): “Keep all FIXED sections exactly as shown”
- [SKILL.md, lines 115–123](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/algorithmic-art/SKILL.md:115>): “Using system fonts or dark themes”

**Recommended treatment:** Make the viewer optional and let the brief select branding and architecture; preserve seed controls where useful.

**Finding 2: A mandatory manifesto and repeated craftsmanship claims add an unrelated ritual..** A small sketch can become a lengthy essay asserting effort instead of demonstrating quality.

- [SKILL.md, lines 38–38](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/algorithmic-art/SKILL.md:38>): “4-6 paragraphs”
- [SKILL.md, lines 49–49](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/algorithmic-art/SKILL.md:49>): “Emphasize craftsmanship REPEATEDLY”

**Recommended treatment:** Provide a short rationale only when useful; remove repeated claims of craftsmanship.

**Finding 3: Remote template dependencies undermine offline delivery..** A single HTML deliverable may fail offline.

- [viewer.html, lines 23–26](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/algorithmic-art/templates/viewer.html:23>): “https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.7.0/p5.min.js”

**Recommended treatment:** Distinguish single-file packaging from offline operation and package permitted dependencies when offline use is required.

**GPT-6 Astra:** Astra could create a sound sketch while failing a dark-theme, client-brand or no-essay brief under these instructions.

**Fable 5.1:** Fable faces the same conflict between creative judgment and a prescribed preset; reproducibility remains useful regardless of model strength.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-03"></a>

### 03. anthropic/brand-guidelines

**Moderate risk · domain-only · Agentic Operator catalog.** Local activation: passed. 329 entrypoint words; 2,235 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/brand-guidelines/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/brand-guidelines). 

**Benefit.** Supplies explicit Anthropic colors, typography and fallback fonts.

**Assessment.** The brand constraints are appropriate for an Anthropic-branded brief. The generic tail of the trigger extends to company design standards without requiring that brand. Restrict selection to the intended identity. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Compact, concrete palette.; Fallback typography handles missing brand fonts.

**Finding 1: Generic branding triggers can select the wrong organization’s identity..** A client artifact could acquire incorrect colors and fonts.

- [SKILL.md, lines 3–3](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/brand-guidelines/SKILL.md:3>): “Use it when brand colors or style guidelines, visual formatting, or company design standards apply.”

**Recommended treatment:** Require Anthropic branding intent or an explicit project brand selection; supplied client standards take priority.

**GPT-6 Astra:** Astra gains precise brand facts; generic triggering could substitute Anthropic identity for the client’s standards.

**Fable 5.1:** Fable gains the same deterministic specification. The risk is scope contamination, not legitimate brand constraints.

**Evidence coverage:** 1 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-04"></a>

### 04. anthropic/canvas-design

**High risk · adapt · Agentic Operator catalog.** Local activation: passed. 1,749 entrypoint words; 11,939 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/canvas-design/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/canvas-design). 

**Benefit.** Offers composition, typography, margin and visual-polish guidance for static artwork.

**Assessment.** The body prioritizes a particular abstract museum-poster style across broad art requests, limits output formats, treats user instructions as non-constraining, and invents a prior user demand for perfection. These are direct brief-following hazards. The full entrypoint was read; font binaries were not visually reviewed. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Checks clipping, margins and unintended overlap.; Encourages visual hierarchy and coherent color.

**Finding 1: The style philosophy is prioritized over the artifact contract..** A playful, text-heavy or SVG brief can become sparse abstract art in the wrong format.

- [SKILL.md, lines 23–25](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/canvas-design/SKILL.md:23>): “it should not constrain creative freedom.”
- [SKILL.md, lines 7–7](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/canvas-design/SKILL.md:7>): “Output only .md files, .pdf files, and .png files.”
- [SKILL.md, lines 104–106](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/canvas-design/SKILL.md:104>): “not something that's cartoony or amateur.”

**Recommended treatment:** Treat required copy, accessibility and file format as constraints. Offer this style only when the brief leaves those choices open.

**Finding 2: Fabricated conversation history and mandatory polishing override scope..** The assistant may attribute an invented demand to the user or continue polishing beyond the requested scope.

- [SKILL.md, lines 122–122](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/canvas-design/SKILL.md:122>): “The user ALREADY said”
- [SKILL.md, lines 126–126](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/canvas-design/SKILL.md:126>): “Take a second pass.”

**Recommended treatment:** Remove the fabricated quote and scale visual verification to actual quality requirements.

**GPT-6 Astra:** Astra’s ability to meet explicit copy, format and playful-illustration requirements can be narrowed by sparse text and clinical abstract styling.

**Fable 5.1:** Fable has the same instruction conflict; stronger reasoning does not legitimize a fabricated prior user request.

**Evidence coverage:** 1 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-05"></a>

### 05. anthropic/claude-api

**High risk · adapt · Agentic Operator catalog.** Local activation: failed. 11,626 entrypoint words; 85,004 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/adapted/anthropic/claude-api/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/claude-api). 

**Benefit.** Contains extensive Claude API, SDK, migration and prompt-audit knowledge with source-verification guidance.

**Assessment.** The full 568-line entrypoint and full prompt-audit reference were reviewed; other language guides and the large model-migration reference were not exhaustively reviewed. A local deterministic host probe actually failed to activate this 85,004-byte entrypoint under the provider-neutral SkillSession default 65,536-byte budget. This is a host blocker, not a native Codex result or model experiment. Separate semantic problems include the project-wide provider stop gate, conflicting SDK-discovery rules and overbroad prompt-cleanup heuristics. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Encourages verified SDK contracts and reuse of SDK helpers.; Prompt-audit guide preserves context, fragile-operation scripts and real tool contracts.; Requires behavioral probes and restoring constraints when a change regresses.

**Finding 1: The entrypoint exceeds the tested activation budget..** Activation fails before either model can benefit on the tested route.

- [runtime-probe-results.json, lines 69–73](</Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/runtime-probe-results.json:69>): “Skill session maxActiveContextBytes budget exceeded”

**Recommended treatment:** Split a small routing entrypoint from on-demand references and re-run activation/composition probes; do not assume native hosts share this limit.

**Finding 2: A project-wide provider stop gate interrupts authorized mixed-provider development..** An additive Claude adapter can trigger an unnecessary conversion question.

- [SKILL.md, lines 14–14](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/adapted/anthropic/claude-api/SKILL.md:14>): “If you find any, stop and tell the user”
- [SKILL.md, lines 14–14](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/adapted/anthropic/claude-api/SKILL.md:14>): “any explicit instruction to keep the code provider-neutral”

**Recommended treatment:** Inspect the target operation and preserve the requested architecture; stop only for an actually unauthorized replacement.

**Finding 3: SDK-discovery requirements contradict each other..** The model can oscillate between research and speculation or follow an unsuitable rule.

- [SKILL.md, lines 25–25](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/adapted/anthropic/claude-api/SKILL.md:25>): “WebFetch the relevant SDK repo”
- [SKILL.md, lines 553–553](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/adapted/anthropic/claude-api/SKILL.md:553>): “Do not spend turns on WebFetch”

**Recommended treatment:** Use one staged rule: inspect relevant installed types/official references, implement, compile and correct within available tools.

**Finding 4: Prompt-audit cleanup can erase deliberate operational limits..** A real output-length contract may be rewritten as obsolete prompting without evidence of benefit.

- [prompt-audit.md, lines 125–125](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/adapted/anthropic/claude-api/shared/prompt-audit.md:125>): “a stated operational reason ("queue throughput", "supervisors skim") does not convert a numeric clamp into a keeper”

**Recommended treatment:** Preserve author-specified output contracts. Treat removal as a hypothesis requiring intent and before/after evidence, consistent with the guide’s keep-list and verification sections.

**GPT-6 Astra:** Astra cannot receive this skill through the tested default SkillSession route until the blocker is fixed. On a compatible route, Claude-specific domain knowledge is useful but provider conversion gates and host assumptions need adaptation.

**Fable 5.1:** Fable is equally blocked by the tested provider-neutral route; no Fable call was made. Model-specific guidance can help after splitting the entrypoint, but existing routing and operational contracts must remain authoritative.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-06"></a>

### 06. anthropic/discernment-nudge

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 1,751 entrypoint words; 10,592 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/discernment-nudge/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/discernment-nudge). 

**Benefit.** Encourages specific reflection on assumptions and verification gaps in substantive advice.

**Assessment.** The skill has good exclusions: silence by default, once per conversation, no nudge when verification is covered, and answer completion first. Its broad pre-finalization trigger and exact closing template nevertheless add output-format and unsolicited-follow-up risks. Preserve useful reflection while adapting its presentation to the request. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Silence default and once-per-conversation limit.; Excludes work where verification is already requested or covered.; Completes the substantive answer before a nudge.

**Finding 1: A broad coaching trigger prescribes a fixed final suffix..** The suffix can break structured output or add unrequested questions. Existing opt-outs mitigate this.

- [SKILL.md, lines 4–9](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/discernment-nudge/SKILL.md:4>): “invoke this skill BEFORE finalizing your reply”
- [SKILL.md, lines 203–206](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/discernment-nudge/SKILL.md:203>): “Use that exact lead-in line”
- [SKILL.md, lines 208–209](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/discernment-nudge/SKILL.md:208>): “The nudge is the closer.”

**Recommended treatment:** Gate coaching on a concrete unresolved need, honor structured/no-follow-up requests, and integrate uncertainty into the answer when appropriate.

**GPT-6 Astra:** Astra can use the uncertainty checks, but should not turn requested verification into questions asking the user to do it.

**Fable 5.1:** Fable’s reasoning should finish requested verification itself. Optional reflection can complement that work without becoming a mandatory suffix.

**Evidence coverage:** 1 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-07"></a>

### 07. anthropic/frontend-design

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 1,516 entrypoint words; 9,390 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/frontend-design/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/frontend-design). 

**Benefit.** Encourages subject-specific visual decisions, real copy, accessibility and visual verification.

**Assessment.** The explicit rule that the user’s visual brief wins, even when requesting otherwise discouraged styles, is a strong safeguard. Residual problems are an invented rejected-proposals backstory, an extra confirmation step and a mandatory uniqueness-planning sequence that does not distinguish new art direction from a tiny edit. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Explicitly follows the brief even for discouraged aesthetics.; Includes accessibility, responsiveness, reduced motion and conditional screenshot checks.; Encourages real content and clear product copy.

**Finding 1: Invented client context and fixed planning can expand a small edit..** A targeted correction can become a redesign proposal or unnecessary interview.

- [SKILL.md, lines 9–9](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/frontend-design/SKILL.md:9>): “This client has already rejected proposals”
- [SKILL.md, lines 13–13](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/frontend-design/SKILL.md:13>): “confirm with the client.”
- [SKILL.md, lines 47–53](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/frontend-design/SKILL.md:47>): “Only after you've confirmed the relative uniqueness of your design plan should you start to write the code”

**Recommended treatment:** Remove assumed history; use full art-direction planning for new designs and proportionate planning for existing UI changes.

**GPT-6 Astra:** Astra can use the subject-driven design and accessibility guidance, but comparative planning can delay a focused edit without improving it.

**Fable 5.1:** Fable benefits from the same design principles while needing freedom to scale process and preserve the existing design system.

**Evidence coverage:** 1 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-08"></a>

### 08. anthropic/internal-comms

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 211 entrypoint words; 1,511 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/internal-comms/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/internal-comms). 

**Benefit.** Provides reusable structures for team updates, newsletters, FAQs and internal communications.

**Assessment.** The small entrypoint uses progressive disclosure well. All four example guides were read; they contain organization-specific assumptions and absolute formatting/interview rules. Move actual company conventions to project-local skills and make shared examples optional defaults. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Loads only the relevant communication guide.; Emphasizes concise language and evidence-backed FAQ answers.

**Finding 1: The generic path interviews the user even when the brief supplies the answers..** Drafting can stall for audience, tone or format already stated.

- [general-comms.md, lines 5–9](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/internal-comms/examples/general-comms.md:5>): “Before proceeding:”

**Recommended treatment:** Use available context first and ask only for missing information that materially changes the draft.

**Finding 2: Organization facts and formats are universalized..** A small-team update can assume nonexistent departments or ignore a no-emoji/plain-text request.

- [company-newsletter.md, lines 21–21](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/internal-comms/examples/company-newsletter.md:21>): “The company is pretty big: 1000+ people.”
- [3p-updates.md, lines 40–40](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/internal-comms/examples/3p-updates.md:40>): “Never use any formatting other than this.”

**Recommended treatment:** Keep organization facts and mandatory templates project-local; shared defaults yield to the actual brief.

**GPT-6 Astra:** Astra can draft clear updates from facts, but repeated questions and a false organization-size premise reduce fidelity and completion speed.

**Fable 5.1:** Fable can synthesize the same notes, but templates should not bias it toward an invented company structure or override the requested audience.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-09"></a>

### 09. anthropic/mcp-builder

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 1,143 entrypoint words; 9,092 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/mcp-builder/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/mcp-builder). 

**Benefit.** Explains MCP schemas, tool contracts, pagination, annotations, errors and realistic tool-use evaluation.

**Assessment.** The protocol/security guidance is useful, including treating annotations as hints rather than security controls. The mandatory ten complex read-only exact-answer questions are a specialized benchmark, not a universal gate for every change. The full best-practices reference and evaluation guide lines 1–225 were reviewed; other language guides and remaining evaluation examples were not exhaustively reviewed. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Promotes precise schemas, pagination and actionable errors.; Annotations are hints, not enforcement.; Read-only live exploration is a useful safety boundary.

**Finding 1: A specialized benchmark is mandatory regardless of scope..** A focused fix may incur unrelated data exploration; read-only exact-answer questions alone do not verify all write/error behavior.

- [SKILL.md, lines 161–177](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/mcp-builder/SKILL.md:161>): “Create 10 Evaluation Questions”
- [SKILL.md, lines 174–178](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/mcp-builder/SKILL.md:174>): “Single, clear answer that can be verified by string comparison”

**Recommended treatment:** Right-size evaluation, retain realistic tool-use probes where useful and test actual contracts in isolated or mocked environments.

**GPT-6 Astra:** Astra benefits from precise MCP contracts. A fixed ten-question benchmark can spend effort outside a one-tool fix and miss relevant mutation behavior.

**Fable 5.1:** Fable can handle complex tool-use questions when those match the goal; requiring complexity for its own sake distracts from the actual contract.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-10"></a>

### 10. anthropic/skill-creator

**High risk · adapt · onto-work shared.** Local activation: passed. 5,205 entrypoint words; 33,168 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/skill-creator/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/skill-creator). 

**Benefit.** Offers skill authoring, baselines, blind comparisons, feedback and progressive disclosure.

**Assessment.** There are strong lightweight and evaluation paths, including removal of unproductive instructions. This does not establish best-creator status on either target model. The Claude-specific harness, all-at-once orchestration and repeated test-set selection need adaptation. Full entrypoint, analyzer, comparator and grader were read; relevant run_eval/run_loop sections were inspected, not all supporting code. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Uses meaningful with-skill baselines and blind task-quality comparison.; Grader critiques weak assertions instead of accepting easy scores.; Explicitly supports user-requested lightweight work without formal evaluation.; Promotes progressive disclosure and removal of unproductive instructions.

**Finding 1: The current-model evaluation is implemented through a fixed Claude CLI..** A non-Claude host may fail or evaluate a different provider than requested.

- [SKILL.md, lines 390–390](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/skill-creator/SKILL.md:390>): “Use the model ID from your system prompt”
- [run_eval.py, lines 70–78](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/skill-creator/scripts/run_eval.py:70>): “"claude",”

**Recommended treatment:** Use explicit verified provider/model adapters, report resolved identity and keep authoring available when the optional harness is absent.

**Finding 2: Repeated model selection reuses the supposed test split..** The reported best score can overstate generalization because the split functions as validation.

- [SKILL.md, lines 394–394](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/skill-creator/SKILL.md:394>): “selected by test score rather than train score to avoid overfitting.”

**Recommended treatment:** Label it validation, keep a final untouched holdout and report uncertainty/cost/regressions; do not claim best without comparison.

**Finding 3: Trigger boosting and rigid concurrency can over-activate generated skills or stall hosts..** Near-miss tasks can activate an unsuitable skill, while mandated concurrency can exceed real host slots.

- [SKILL.md, lines 67–67](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/skill-creator/SKILL.md:67>): “make the skill descriptions a little bit "pushy"”
- [SKILL.md, lines 171–171](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/skill-creator/SKILL.md:171>): “Launch everything at once”

**Recommended treatment:** Calibrate trigger precision and recall on near misses, schedule within available concurrency and honor no-eval or small-edit requests.

**GPT-6 Astra:** Astra can use the authoring methodology, but passing its model ID to a Claude subprocess is not an Astra benchmark. Verified provider/model dispatch is required.

**Fable 5.1:** Fable can use a compatible Claude harness after verifying actual CLI/model routing. Repeatedly selecting by the same test split does not establish held-out generalization or best-in-class quality.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-11"></a>

### 11. anthropic/slack-gif-creator

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 1,103 entrypoint words; 7,841 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/slack-gif-creator/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/slack-gif-creator). 

**Benefit.** Provides animation helpers, easing patterns, GIF assembly and dimensional checks for Slack-oriented assets.

**Assessment.** The utilities and distinction between direct uploaded-asset reuse and inspiration are useful. Some aesthetics are mandatory. The fully reviewed validator returns success based only on dimensions, so is_slack_ready is not proof of all upload constraints or playback quality. This review did not verify live Slack limits. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Useful animation/easing helpers.; Validator exposes actual size and frame metadata in addition to dimensions.

**Finding 1: Decorative defaults become universal quality rules..** Minimal or brand-constrained animations can gain unwanted outlines or ornament.

- [SKILL.md, lines 88–88](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/slack-gif-creator/SKILL.md:88>): “Always set `width=2` or higher”
- [SKILL.md, lines 90–97](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/slack-gif-creator/SKILL.md:90>): “Don't just draw a plain circle”

**Recommended treatment:** Make these rendering suggestions conditional; honor the brief and inspect actual readability.

**Finding 2: The readiness predicate proves only dimensional acceptability..** An oversized or poorly playing file may be called ready based on the dimension result alone.

- [validators.py, lines 76–78](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/slack-gif-creator/core/validators.py:76>): “"passes": dim_pass,”
- [validators.py, lines 115–118](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/slack-gif-creator/core/validators.py:115>): “return dim_pass, results”

**Recommended treatment:** Report exactly what was checked and separately validate size/platform requirements and playback.

**GPT-6 Astra:** Astra can use the helpers but may degrade a minimal brand asset through compulsory thicker outlines and decoration.

**Fable 5.1:** Fable benefits from deterministic helpers; it must distinguish dimensional acceptability from complete platform readiness.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-12"></a>

### 12. anthropic/theme-factory

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 486 entrypoint words; 3,124 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/theme-factory/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/theme-factory). 

**Benefit.** Provides ten concrete color/font themes and a useful choice workflow when options are requested.

**Assessment.** All ten theme Markdown specifications were read; the showcase PDF was not visually inspected. The unconditional show/ask/wait sequence repeats a choice the user may already have made. Keep themes as reusable data and make choice collection conditional. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Concrete color and typography roles.; A custom-theme path exists when presets do not fit.

**Finding 1: A fixed choice ceremony repeats a settled decision..** A request to apply Ocean Depths may receive another question instead of the updated artifact.

- [SKILL.md, lines 23–26](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/theme-factory/SKILL.md:23>): “Get explicit confirmation about the chosen theme”

**Recommended treatment:** Apply a theme already selected in the prompt/project. Ask only for unresolved preferences that materially affect the task.

**GPT-6 Astra:** Astra can directly apply a named palette; a mandatory confirmation turns a specified reversible change into an unnecessary stop.

**Fable 5.1:** Fable can compare suitable themes when useful without needing a selection ceremony after an explicit choice.

**Evidence coverage:** 11 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-13"></a>

### 13. anthropic/web-artifacts-builder

**High risk · host-only · Agentic Operator catalog.** Local activation: passed. 446 entrypoint words; 3,087 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/web-artifacts-builder/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/web-artifacts-builder). 

**Benefit.** Scaffolds and bundles complex React HTML artifacts for a specific Claude artifact workflow.

**Assessment.** The host scope is explicit and excludes simple single-file artifacts. Both shell scripts were read in full. The initializer imposes a large React/component setup, while the instructions recommend showing output before testing. Keep the compatible-host recipe optional and adapt its validation policy. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Explicit intended scope for complex Claude HTML artifacts.; Deterministic scaffold and single-HTML packaging commands.

**Finding 1: Fixed scaffolding is unsuitable outside the named host and use case..** An existing other-stack project can be replaced by a large React scaffold if generic matching ignores the stated scope.

- [SKILL.md, lines 9–16](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/web-artifacts-builder/SKILL.md:9>): “Initialize the frontend repo using `scripts/init-artifact.sh`”

**Recommended treatment:** Require compatible artifact context and a new complex artifact; preserve existing project architecture.

**Finding 2: The workflow discourages verification before delivery..** Avoidable syntax, interaction or layout failures can reach the user.

- [SKILL.md, lines 70–70](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/web-artifacts-builder/SKILL.md:70>): “avoid testing the artifact upfront”

**Recommended treatment:** Perform proportionate build and smoke checks before declaring completion; defer only expensive checks without demonstrated need.

**GPT-6 Astra:** Astra should not apply a Claude-specific scaffold to an existing app or assume the artifact renderer exists. Avoiding available pre-delivery verification can lower actual quality.

**Fable 5.1:** Fable on a compatible artifact host can benefit from packaging; stronger reasoning does not compensate for prescribed deferral of cheap verification.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-14"></a>

### 14. anthropic/webapp-testing

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 501 entrypoint words; 3,913 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/webapp-testing/SKILL.md>). [Source revision](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/webapp-testing). 

**Benefit.** Provides local browser reconnaissance, selector discovery and server lifecycle support.

**Assessment.** The discovery workflow is useful. Always requiring Python Playwright and networkidle ignores available browser surfaces and apps with continuous activity. The server helper was read in full without execution. The instruction to execute before reading also impedes legitimate inspection and troubleshooting. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Reconnaissance precedes interaction using actual selectors.; Provides bounded startup and cleanup support.

**Finding 1: Dynamic readiness always requires global network idleness..** Polling or streaming can prevent completion despite a usable target UI.

- [SKILL.md, lines 80–81](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/webapp-testing/SKILL.md:80>): “wait for `page.wait_for_load_state('networkidle')` before inspection”

**Recommended treatment:** Use relevant selectors or completed requests with bounded waits; use networkidle only when suitable.

**Finding 2: Fixed tools and execute-before-inspect rules reduce adaptability..** The assistant can ignore an available authenticated browser or run a helper during a source audit.

- [SKILL.md, lines 9–9](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/webapp-testing/SKILL.md:9>): “write native Python Playwright scripts.”
- [SKILL.md, lines 14–14](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/anthropic/skills/webapp-testing/SKILL.md:14>): “DO NOT read the source until you try running the script first”

**Recommended treatment:** Prefer the supported browser and existing test stack; --help is documentation, not a prerequisite to code inspection.

**GPT-6 Astra:** Astra can stall on a polling/streaming dashboard while waiting for global idleness or lose an authenticated browser context by changing surfaces.

**Fable 5.1:** Fable has the same host/readiness risks; the useful principle is inspection of real UI state, not one universal load-state condition.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-15"></a>

### 15. openai-plugins/openai-developers/build-chatgpt-app

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 2,707 entrypoint words; 19,656 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai-plugins/plugins/openai-developers/skills/build-chatgpt-app/SKILL.md>). [Source revision](https://github.com/openai/plugins/tree/d416fd5a43426019986b1e489506db3db66dee3d/plugins/openai-developers/skills/build-chatgpt-app). 

**Benefit.** Provides Apps SDK architecture, tool/UI contracts, current official-docs lookup and honest validation.

**Assessment.** This is a strong domain guide with good scoping and reporting of unrun checks. The main risk is fetching five baseline documentation pages for every change, including edits that do not touch an SDK contract. The docs-workflow and repository-contract references were read in full; other archetype/scaffold/bridge references were not exhaustively reviewed. Prefer this canonical entry over the nearly identical curated chatgpt-apps import. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Inspects repository structure and skips scaffolding established apps.; MCP/widget/CSP contracts prevent real integration mistakes.; Validation ladder reports what was and was not run.; Default coding work does not imply publication.

**Finding 1: Broad mandatory docs preflight covers every small change..** Repeated loading can delay a focused change and duplicate already verified context.

- [SKILL.md, lines 26–34](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai-plugins/plugins/openai-developers/skills/build-chatgpt-app/SKILL.md:26>): “whenever building or changing a ChatGPT Apps SDK app.”

**Recommended treatment:** Read current sources for touched contracts, reuse verified session context and expand to all baseline pages for initial or broad implementation.

**GPT-6 Astra:** Astra benefits from accurate APIs and validation discipline, but broad repeated documentation sweeps can dominate small UI edits.

**Fable 5.1:** Fable can use the same domain guidance with supported docs access. Codex-named tools must be mapped to available capabilities rather than assumed present.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-16"></a>

### 16. openai-plugins/openai-developers/chatgpt-app-submission

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 1,564 entrypoint words; 11,256 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai-plugins/plugins/openai-developers/skills/chatgpt-app-submission/SKILL.md>). [Source revision](https://github.com/openai/plugins/tree/d416fd5a43426019986b1e489506db3db66dee3d/plugins/openai-developers/skills/chatgpt-app-submission). 

**Benefit.** Grounds submission metadata in real MCP tool behavior and generates review artifacts.

**Assessment.** Implementation/helper inspection and truthful submission data are strong requirements. Stopping on unknown or misleading metadata is appropriate. The concern is requiring fresh approval even when the user has already explicitly authorized the metadata repairs. Preserve real uncertainty and consequential-action boundaries while recognizing session authorization. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Reads actual implementations and called helpers.; Requires truthful hints and distinguishes warnings from blockers.; Cases reference actual tool names and workflows.

**Finding 1: A fresh permission gate ignores authorization already provided..** A request to fix incorrect hints and generate JSON can stop at a redundant question.

- [SKILL.md, lines 16–16](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai-plugins/plugins/openai-developers/skills/chatgpt-app-submission/SKILL.md:16>): “ask the developer for approval before updating source.”
- [SKILL.md, lines 42–42](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai-plugins/plugins/openai-developers/skills/chatgpt-app-submission/SKILL.md:42>): “stop before writing the JSON and ask the developer for approval”

**Recommended treatment:** Count explicit current-session repair authorization; still stop for unknown side effects, ambiguous scope or out-of-scope consequential actions.

**GPT-6 Astra:** Astra can produce accurate metadata from code inspection; re-asking for an explicitly requested reversible correction can block completion unnecessarily.

**Fable 5.1:** Fable benefits from the same grounding and should not invent safety claims. It can proceed within existing repair authorization while stopping on actual ambiguity.

**Evidence coverage:** 1 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-17"></a>

### 17. openai/curated/aspnet-core

**Low risk · retain · Agentic Operator catalog.** Local activation: passed. 573 entrypoint words; 5,544 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/aspnet-core/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/aspnet-core). 

**Benefit.** Provides compact ASP.NET Core architecture and versioning guidance that preserves project conventions.

**Assessment.** This mainly augments capability: it selects the smallest relevant references, preserves app models and framework pins, and requires live verification for latest-version claims. Stack-selection and versioning references were read in full. The dated default needs normal maintenance, but no incorrect current version fact or observed behavior failure is established. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Loads the smallest relevant reference set.; Preserves architecture and pinned frameworks.; Encourages incremental verified upgrades instead of gratuitous rewrites.

**Finding 1: A dated new-project default needs periodic verification..** Future unpinned work could use an obsolete stable/preview classification; pinned projects are explicitly protected. No current error is claimed.

- [SKILL.md, lines 35–35](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/aspnet-core/SKILL.md:35>): “As of March 2026, prefer .NET 10 / ASP.NET Core 10”
- [SKILL.md, lines 60–61](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/aspnet-core/SKILL.md:60>): “follow the solution's conventions first”

**Recommended treatment:** Retain repository-first behavior and verify current Microsoft release docs for unpinned new work or latest-version requests.

**GPT-6 Astra:** Astra can use framework-specific contracts without a forced redesign because existing conventions and pins explicitly win.

**Fable 5.1:** Fable receives the same targeted context. No model-specific degradation is established; the residual concern is maintenance of dated defaults.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-18"></a>

### 18. openai/curated/chatgpt-apps

**Moderate risk · retire-duplicate · Agentic Operator catalog.** Local activation: passed. 2,706 entrypoint words; 19,626 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/chatgpt-apps/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/chatgpt-apps). 

**Benefit.** Duplicates the useful Apps SDK workflow and references of the plugin-namespaced build skill.

**Assessment.** A direct comparison found entrypoint differences only in name, heading and four invocation examples. Both entrypoints were read in full; the two reviewed references are byte-identical. Duplication alone has not been shown to cause a model failure. Still, separate selectable names add ambiguity and can duplicate about 19 KB of guidance if a host activates both. Archive this source snapshot and expose one canonical active skill. Static semantic review only; both model evaluation cases below are planned and unexecuted.

**Preserve:** Same useful repository, tool/UI and validation guidance as the canonical skill.; Reviewed duplicates are consistent, so consolidation preserves the knowledge.

**Finding 1: Two selectable identities provide effectively the same workflow..** If both are activated, context and preflight can be repeated without new reviewed knowledge; maintenance ownership is unclear.

- [SKILL.md, lines 24–34](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/chatgpt-apps/SKILL.md:24>): “Use `$openai-docs` first whenever building or changing a ChatGPT Apps SDK app.”
- [SKILL.md, lines 24–34](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai-plugins/plugins/openai-developers/skills/build-chatgpt-app/SKILL.md:24>): “Use `$openai-docs` first whenever building or changing a ChatGPT Apps SDK app.”

**Recommended treatment:** Retain the official snapshot but mark this active entry as superseded or alias-only and route to the canonical plugin skill.

**GPT-6 Astra:** Astra gains no additional reviewed substantive instruction from loading the duplicate. Consolidation preserves knowledge while reducing selection ambiguity.

**Fable 5.1:** Fable likewise gains no unique reviewed capability from both names. The composition risk is conditional, not a measured inability to reconcile consistent instructions.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-19"></a>

### 19. openai/curated/cli-creator

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 1,587 entrypoint words; 10,502 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/cli-creator/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/cli-creator). 

**Benefit.** Designs durable, composable command-line tools with stable identifiers, JSON output, bounded reads, narrow writes, and installation verification.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The durable-tool scope and flexible language choice are well judged. The full API-oriented command surface and personal companion-skill destination need conditional application in a managed shared/project skill system; they are not universal requirements for every durable CLI.

**Preserve:** Explicitly excludes one-off scripts from the durable CLI workflow.; Reference recommends composable primitives, stable IDs, bounded pagination, and draft-first writes rather than opaque automation.

**Finding 1: Universal command surface overbuilds non-service tools.** A reusable local formatter or converter may acquire irrelevant authentication, resource-discovery, and raw-request abstractions.

- [SKILL.md, lines 57–57](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/cli-creator/SKILL.md:57>): “verifies config, auth, version, endpoint reachability, and missing setup.”
- [SKILL.md, lines 64–64](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/cli-creator/SKILL.md:64>): “A raw escape hatch exists”

**Recommended treatment:** Require each command family only when the tool has that capability; keep help, stable output, error handling, and installation checks.

**Finding 2: Personal installation default conflicts with managed authoring scope.** A useful project-specific companion skill can be installed globally, or a shared skill can be written outside the operator’s reviewed shared catalog.

- [SKILL.md, lines 146–146](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/cli-creator/SKILL.md:146>): “Use `$CODEX_HOME/skills/<tool-name>/SKILL.md` for a personal companion skill”

**Recommended treatment:** Resolve companion placement from the host’s shared/project policy and the user’s intended scope; use the skill’s actual resource root.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A compulsory raw API escape hatch and discovery/auth scaffolding could displace a simpler correct offline design. Preserve the model’s choice of the smallest sufficient command surface.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Long-horizon implementation can benefit from installation and composability checks, but predetermined command families can add unnecessary work and obscure the actual requested outcome.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-20"></a>

### 20. openai/curated/cloudflare-deploy

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 972 entrypoint words; 7,377 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/cloudflare-deploy/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/cloudflare-deploy). 

**Benefit.** Routes explicit Cloudflare work to relevant platform references and checks deployment authentication before operating.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The product decision tree is a useful progressive-disclosure index; the many bundled references are not automatically loaded. The main behavioral defect is treating generic network failures as a reason to invoke a particular host’s escalation mechanism.

**Preserve:** Loads detailed product references only after choosing the relevant service.; Authentication reference separates local OAuth from CI tokens and identifies task-specific token permissions.

**Finding 1: Network symptoms are conflated with sandbox denial.** DNS outages, transient failures, or service errors can lead to irrelevant escalation and repeated user interruption, especially when the operator exposes no such parameter.

- [SKILL.md, lines 218–218](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/cloudflare-deploy/SKILL.md:218>): “If deployment fails due to network issues (timeouts, DNS errors, connection resets), rerun the deploy with escalated permissions”

**Recommended treatment:** Diagnose the actual denial, use only the host’s supported approval mechanism, and retry an already authorized operation without an extra conversational gate when permitted.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: An unsupported escalation parameter or repeated permission request can stall deployment despite an available authorized network path.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The host-specific retry recipe could interrupt otherwise autonomous diagnosis; authentication and least-privilege checks remain useful domain constraints.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-21"></a>

### 21. openai/curated/define-goal

**Low risk · retain · Agentic Operator catalog.** Local activation: passed. 870 entrypoint words; 5,647 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/define-goal/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/define-goal). 

**Benefit.** Turns an explicitly requested goal into a verifiable outcome while preserving existing goal state and avoiding artificial budgets.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. This is a well-scoped outcome-oriented skill. It explicitly excludes ordinary implementation, allows safe inference, and asks only when the intended outcome or validation materially changes. Its small remaining portability issue is reliance on native goal-state tools.

**Preserve:** Requires explicit goal intent rather than converting every multi-step request.; Uses meaningful outcome checks, one material clarification at most, and only explicitly requested token budgets.

**Finding 1: Native goal-state operations require a compatible host.** On a host without these tools, literal execution could invent a tool or block an otherwise useful goal formulation. This is a conditional portability risk, not a reason to remove the goal-quality guidance.

- [SKILL.md, lines 42–42](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/define-goal/SKILL.md:42>): “Call `get_goal`.”
- [SKILL.md, lines 43–43](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/define-goal/SKILL.md:43>): “call `create_goal`.”
- [SKILL.md, lines 18–18](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/define-goal/SKILL.md:18>): “do the work directly instead of forcing goal creation.”

**Recommended treatment:** Gate native state operations on the actual tool catalog; preserve the proposed objective and state plainly when persistence is unavailable.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: The explicit instruction to perform ordinary implementation directly counteracts skill-induced stalling; native goal calls need availability checks.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Outcome and validation guidance fits long-horizon work without prescribing every method. No text-based reason was found to impose more planning or approval on ordinary tasks.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-22"></a>

### 22. openai/curated/gh-address-comments

**High risk · adapt · onto-work shared.** Local activation: passed. 205 entrypoint words; 1,278 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-address-comments/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-address-comments). 

**Benefit.** Finds the current branch’s pull request and gathers review discussions before applying targeted fixes.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The workflow unconditionally asks the user to select comments, even though its own default prompt already requests all actionable comments. Authentication is a real prerequisite; the repeated selection gate and blanket escalation are not. The helper was inspected as retrieval implementation, not executed against a live PR.

**Preserve:** Inspects the actual current PR discussion rather than relying on an earlier summary.; Keeps fixes tied to specific review comments.

**Finding 1: Selection gate contradicts the skill’s own all-actionable default.** The agent waits instead of fixing comments already included in the user’s authorization.

- [SKILL.md, lines 19–19](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-address-comments/SKILL.md:19>): “Ask the user which numbered comments should be addressed”
- [openai.yaml, lines 6–6](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-address-comments/agents/openai.yaml:6>): “Address all actionable GitHub PR review comments in this branch”

**Recommended treatment:** Infer scope from the request; ask only when requested scope is ambiguous or a proposed change materially conflicts with requirements. Assess reviewer suggestions rather than applying them blindly.

**Finding 2: Blanket escalation and reauthentication misdiagnose host/rate failures.** Routine reads can trigger unsupported permission controls, and rate limiting can generate an unnecessary login interruption.

- [SKILL.md, lines 10–10](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-address-comments/SKILL.md:10>): “Run all `gh` commands with elevated network access.”
- [SKILL.md, lines 25–25](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-address-comments/SKILL.md:25>): “If gh hits auth/rate issues mid-run, prompt the user to re-authenticate”

**Recommended treatment:** Use existing authenticated access; distinguish authorization failure, rate exhaustion, transport failure, and host policy before choosing a remedy.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: The mandatory selection question can turn a clear fix-all request into an avoidable stop and suppress judgment about which comments are actionable.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Because the workflow insists on a new user choice before fixes, it may amplify pauses on already-authorized work rather than help the model sustain the review task.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-23"></a>

### 23. openai/curated/gh-fix-ci

**High risk · adapt · onto-work shared.** Local activation: passed. 527 entrypoint words; 3,651 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-fix-ci/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/gh-fix-ci). 

**Benefit.** Collects GitHub Actions failure evidence, handles CLI field variations, and focuses repair on actionable CI failures.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The log-focused troubleshooting is useful, and limiting a GitHub Actions request to its provider avoids unfocused investigation. The explicit second approval and merely suggested retesting prevent completion of work the user has already requested.

**Preserve:** Uses concrete check names, run URLs, and failure snippets; calls out missing logs.; Bundled inspection helper handles changing gh JSON fields and pending/unavailable logs.

**Finding 1: Reapproval is required even when the user already requested the fix.** An actionable CI repair is delayed until the user repeats authorization; a missing create-plan skill can add another unnecessary dependency.

- [SKILL.md, lines 54–54](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-fix-ci/SKILL.md:54>): “draft a concise plan and request approval.”
- [SKILL.md, lines 55–55](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-fix-ci/SKILL.md:55>): “Implement after approval.”

**Recommended treatment:** Treat the requested fix as authorization for its normal reversible implementation; require new input only for genuinely ambiguous scope or consequential actions not already authorized.

**Finding 2: Verification is suggested rather than performed.** The final response can imply progress while leaving the repaired failure unverified despite runnable checks.

- [SKILL.md, lines 58–58](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/gh-fix-ci/SKILL.md:58>): “suggest re-running the relevant tests and `gh pr checks` to confirm.”

**Recommended treatment:** Run appropriate local checks and inspect relevant CI state when available; explicitly distinguish local passes, pending CI, and unavailable execution.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A mandatory plan-approval stop and optional verification can override an otherwise capable repair-and-test workflow.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The approval instruction risks reinforcing pauses on authorized fixes; stopping after proposing tests prevents the long-horizon repair from reaching verified completion.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-24"></a>

### 24. openai/curated/hatch-pet

**High risk · host-only · Agentic Operator catalog.** Local activation: passed. 5,028 entrypoint words; 37,296 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/hatch-pet). 

**Benefit.** Builds Codex desktop pet atlases using the application’s exact geometry, animation rows, transparency rules, and visual QA.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The fixed atlas dimensions and per-state visual checks are real application contracts, not arbitrary aesthetic restrictions. This specialized workflow should remain available only on a compatible Codex pet host. Its storage-driven delegation rules, smaller-model default, and extra subagent permission gate require adaptation even there.

**Preserve:** Grounds grid and frame constraints in the consuming application.; Accepts multiple visual styles and favors the smallest repair over unnecessary regeneration.

**Finding 1: Worker policy substitutes a smaller model and limits review discretion.** A cost/storage optimization becomes a quality constraint even when identity consistency or a difficult repair needs the stronger model’s inspection.

- [SKILL.md, lines 422–422](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/SKILL.md:422>): “Prefer a smaller capable model for visual workers, such as `gpt-5.4-mini`”
- [SKILL.md, lines 423–423](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/SKILL.md:423>): “Use the parent/default model only for orchestration”
- [SKILL.md, lines 36–36](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/SKILL.md:36>): “The parent must not open every generated PNG visually.”

**Recommended treatment:** Make worker model and inspection depth task-sensitive; preserve explicit model preferences, use bounded images/contact sheets, and allow targeted parent review when evidence is uncertain.

**Finding 2: Contradictory delegation authorization creates an avoidable pause.** The model may ask again despite delegated work already being permitted by the task or host.

- [SKILL.md, lines 383–383](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/SKILL.md:383>): “Unless explicitly forbidden by the user, use subagents for this run.”
- [SKILL.md, lines 383–383](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/SKILL.md:383>): “then ask the user for permission to spawn subagents”

**Recommended treatment:** Use existing user and host authorization; keep subagent availability and parallelism as implementation choices, not new approval gates.

**Finding 3: Application-specific geometry and installation are unsuitable as general image guidance.** Activation for an ordinary mascot or another platform can force an unusable atlas and unavailable Codex tools.

- [codex-pet-contract.md, lines 12–12](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/hatch-pet/references/codex-pet-contract.md:12>): “The webview animation uses CSS background positions from the fixed row and column counts.”

**Recommended treatment:** Trigger only for the compatible pet format; keep the geometry contract intact within that domain.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: Automatically assigning visual work to a smaller model and limiting parent inspection may reduce the benefit of the requested strong model; that quality effect is unmeasured. The permission gate can also stall a clear request.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The same delegation prescription can prevent the selected strong model from handling nuanced visual diagnosis. A compatible image-generation and pet-installation host is required independently of reasoning strength.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-25"></a>

### 25. openai/curated/jupyter-notebook

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 521 entrypoint words; 4,154 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/jupyter-notebook/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/jupyter-notebook). 

**Benefit.** Creates structured experiment/tutorial notebooks and encourages targeted edits, reproducibility, and honest execution validation.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The behavioral core is appropriately flexible: preserve existing structure, execute when possible, and disclose unavailable execution. The imported shared bundle’s helper location does not match the assumed personal installation path, so the resource resolution needs a host adapter.

**Preserve:** Prefers targeted existing-notebook changes rather than full rewrites.; Separates experiment and tutorial structure and explicitly discloses when execution cannot run.

**Finding 1: Helper path assumes a user-scoped installation layout.** Shared vendor-namespaced imports may resolve no helper at that location, encouraging needless reinstallation or a stalled task.

- [SKILL.md, lines 31–31](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/jupyter-notebook/SKILL.md:31>): “$CODEX_HOME/skills/jupyter-notebook/scripts/new_notebook.py”
- [SKILL.md, lines 34–34](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/jupyter-notebook/SKILL.md:34>): “User-scoped skills install under `$CODEX_HOME/skills`”

**Recommended treatment:** Resolve helper paths relative to the loaded skill bundle; use actual project/output scope and available Python runtime. Preserve direct notebook editing as a supported fallback.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A wrong scaffold path could turn a simple notebook task into tool troubleshooting; it should not prevent direct, validated notebook edits.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Targeted editing and reproducible top-to-bottom execution support competent long-horizon work. Avoid making a missing convenience helper a prerequisite to progress.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-26"></a>

### 26. openai/curated/linear

**Moderate risk · host-only · Agentic Operator catalog.** Local activation: passed. 699 entrypoint words; 4,952 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/linear/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/linear). 

**Benefit.** Organizes explicit Linear issue, project, and team operations around read-first context gathering and batched updates.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The task vocabulary and read-before-write approach are useful with a compatible Linear connector. The installation and restart sequence is a standalone Codex host recipe, not a portable prerequisite for an operator with server-managed connectors.

**Preserve:** Reads existing issues and project context before writes.; Encourages batching and verifying IDs/properties rather than inventing workspace objects.

**Finding 1: Missing-connector handling assumes control of local Codex configuration.** Managed agents may not own this config, may expose differently named tools, or may already have a connector that does not require a CLI restart.

- [SKILL.md, lines 20–20](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/linear/SKILL.md:20>): “Follow these steps in order. Do not skip steps.”
- [SKILL.md, lines 27–27](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/linear/SKILL.md:27>): “codex mcp add linear”
- [SKILL.md, lines 33–33](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/linear/SKILL.md:33>): “the user will have to restart codex.”

**Recommended treatment:** Expose only when compatible Linear capabilities exist; route unavailable integration setup through the host’s supported connector administration rather than mutating local runtime configuration.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A hard ordered setup recipe can divert a clear issue update into local configuration changes or an unnecessary session restart.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Connector availability should determine the execution path; forcing one CLI/configuration surface can block work despite an equivalent authorized connector.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-27"></a>

### 27. openai/curated/migrate-to-codex

**High risk · host-only · Agentic Operator catalog.** Local activation: passed. 1,080 entrypoint words; 7,939 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/migrate-to-codex/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/migrate-to-codex). 

**Benefit.** Migrates selected Claude configuration artifacts to Codex with dry-run, doctor, source preservation, and explicit reporting of semantic gaps.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. This is an administration/migration tool for an explicitly selected target, not a general shared workflow skill for tenant agents. The references honestly distinguish prompt guidance from enforced permissions. Mandatory TODO tooling, personality injection, and exact report formatting impose behavior beyond necessary migration fidelity.

**Preserve:** Preserves original Claude files and unrelated target edits within the selected scope.; Doctor/dry-run workflow and references explicitly acknowledge that agent config defaults and prompt tool restrictions are not hard isolation.

**Finding 1: Configuration migration assumes administration authority and adds unrelated personality.** Running inside a managed operator can conflict with server-owned runtime policy; forcing a personality modifies behavior even when faithful migration did not require it.

- [SKILL.md, lines 38–38](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/migrate-to-codex/SKILL.md:38>): “write `.codex/config.toml` from Claude model/sandbox settings and MCP servers, including `personality = "friendly"`”

**Recommended treatment:** Restrict to explicitly authorized administration of the selected target; preserve requested persona, and never use imported project settings to bypass server-owned model, sandbox, or connector policy.

**Finding 2: Exact host tooling and reporting rules constrain useful execution and explanation.** An unavailable tool/path can become a ritual blocker, and a forced table-only answer can suppress a user-requested explanation of consequential migration gaps.

- [SKILL.md, lines 16–16](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/migrate-to-codex/SKILL.md:16>): “Start by using Codex's built-in TODO/task list tool.”
- [SKILL.md, lines 53–53](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/migrate-to-codex/SKILL.md:53>): “Do not add prose before or after the table output.”
- [SKILL.md, lines 87–87](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/migrate-to-codex/SKILL.md:87>): “python3 .codex/skills/migrate-to-codex/scripts/migrate-to-codex.py”

**Recommended treatment:** Use supported planning/resource-resolution mechanisms and adapt reporting to the user’s requested detail while retaining clear semantic caveats.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: Hardcoded task-list and script paths can stall execution on another host, while an unsolicited friendly personality setting can change future behavior unrelated to the migration request.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Strong reasoning can interpret semantic gaps, but should not inherit a specific Codex planning tool or silently map host authority from source configuration. This limitation is host compatibility, not a claim about Fable’s coding ability.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-28"></a>

### 28. openai/curated/netlify-deploy

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 986 entrypoint words; 7,011 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/netlify-deploy/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/netlify-deploy). 

**Benefit.** Guides Netlify authentication, site linking, local build preparation, deployment, and deploy-result reporting.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The deployment mechanics and secret-handling guidance are useful in scope. The new-site production default conflicts with the preview-first tip, and the network escalation instructions assume one execution host.

**Preserve:** Checks authentication and existing site linkage before deployment.; Keeps secrets out of Git and recommends testing before production in its tips.

**Finding 1: New-site default can select production despite a preview-only intention.** A task to test a new site can be promoted to the live production target because two instructions disagree.

- [SKILL.md, lines 130–130](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/netlify-deploy/SKILL.md:130>): “Production Deploy** (for new sites or explicit production deployments)”
- [SKILL.md, lines 233–233](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/netlify-deploy/SKILL.md:233>): “Use `netlify deploy` (no `--prod`) first to test before production”

**Recommended treatment:** Resolve deployment mode from the explicit request and existing authorization; use a draft for a preview request regardless of whether the site is new.

**Finding 2: Generic network failures trigger host-specific escalation.** The agent can request unsupported permissions or repeat authorization instead of diagnosing transport or service failures.

- [SKILL.md, lines 215–215](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/netlify-deploy/SKILL.md:215>): “If deployment fails due to network issues (timeouts, DNS errors, connection resets), rerun the deploy with escalated permissions”

**Recommended treatment:** Escalate only evidenced policy denial using the available host mechanism; separate ordinary retryable failures from permission problems.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: Conflicting preview/production defaults can cause an unintended live publish rather than a failure of technical reasoning; use the user’s explicit requested deployment target.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The agent can complete deployment work autonomously when target scope is clear, but a prescribed production default and generic escalation gate can override that scope.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-29"></a>

### 29. openai/curated/notion-knowledge-capture

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 444 entrypoint words; 3,316 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-knowledge-capture/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/notion-knowledge-capture). 

**Benefit.** Turns conversation content into structured, cross-linked Notion knowledge while preserving decisions, rationale, and technical specificity.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The knowledge extraction and actual-database-schema checks add value. Mandatory input questions, standalone Codex connector setup, and automatic creation of follow-up tasks need to respect already supplied context and the user’s requested write scope. Bundled evaluation instructions are scenario guidance, not evidence of current-model validation.

**Preserve:** Extracts decisions and rationale rather than flattening the conversation into generic summaries.; Reference advises inspecting the real database schema and keeping database design simple.

**Finding 1: Questions and extra task writes are not conditional on the user’s request.** Already-known fields can be asked again, while documenting a discussion can silently create a project-management backlog.

- [SKILL.md, lines 31–31](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-knowledge-capture/SKILL.md:31>): “Ask purpose, audience, freshness, and whether this is new or an update.”
- [SKILL.md, lines 52–52](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-knowledge-capture/SKILL.md:52>): “If follow-up tasks exist, create tasks in the relevant database and link them.”

**Recommended treatment:** Infer known inputs, ask only material unresolved questions, and create external tasks only when the user authorized that additional operation.

**Finding 2: Connector setup is bound to standalone Codex.** A managed connector failure can turn into irrelevant local configuration changes or an unnecessary restart.

- [SKILL.md, lines 22–22](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-knowledge-capture/SKILL.md:22>): “codex mcp add notion”
- [SKILL.md, lines 28–28](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-knowledge-capture/SKILL.md:28>): “the user will have to restart codex.”

**Recommended treatment:** Use actual Notion capabilities and the host’s supported connector-setup route; keep general summarization possible without activating Notion for a local-only request.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: Unconditional questions and follow-up task creation can replace a clear capture request with additional interaction and unauthorized extra artifacts.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: A capable model should infer supplied audience/purpose and complete the capture; the procedural wording can instead induce pauses and expand the task beyond documentation.

**Evidence coverage:** 4 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-30"></a>

### 30. openai/curated/notion-meeting-intelligence

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 441 entrypoint words; 3,418 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-meeting-intelligence/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/notion-meeting-intelligence). 

**Benefit.** Builds context-aware agendas and pre-reads, separates facts from opinions, and adds research where it helps a meeting decision.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The entrypoint permits template adaptation and optional research, which are useful. Broad agenda triggers and task creation need tighter scope. The bundled evaluation README would reward two documents and a citation quota even for requests that need one simple agenda; those are rubric risks if reused for acceptance, not observed model failures.

**Preserve:** Explicitly makes supplemental research conditional on usefulness and requires fact/opinion separation.; Template selection reference encourages customization and simplification.

**Finding 1: Broad agenda trigger and follow-up writes can overreach the requested surface.** A local agenda request can activate Notion search or create external tasks even when the user wanted only a draft.

- [SKILL.md, lines 3–3](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-meeting-intelligence/SKILL.md:3>): “use when gathering context, drafting agendas/pre-reads, and tailoring materials to attendees.”
- [SKILL.md, lines 55–55](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-meeting-intelligence/SKILL.md:55>): “If tasks arise, create/link tasks in the relevant Notion database.”

**Recommended treatment:** Require explicit or clear contextual Notion intent; treat task creation as a separate authorized operation and infer meeting details already supplied.

**Finding 2: Evaluation rubric rewards fixed artifact and citation counts.** If used as a universal quality gate, the rubric penalizes a correct concise agenda or a single authoritative source and encourages needless research.

- [README.md, lines 47–47](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-meeting-intelligence/evaluations/README.md:47>): “Check that TWO documents are created (internal + external)”
- [README.md, lines 94–94](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-meeting-intelligence/evaluations/README.md:94>): “Cites at least 2-3 Notion pages”

**Recommended treatment:** Make separate internal/external documents conditional on audience confidentiality and user intent; judge evidence sufficiency and usefulness rather than counts.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A fixed two-document rubric can bias an efficient agenda task toward overproduction and unnecessary retrieval rather than better decision support.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Long-horizon meeting preparation benefits from context synthesis, but prescribed extra artifacts and new task writes can displace the user’s actual requested deliverable.

**Evidence coverage:** 4 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-31"></a>

### 31. openai/curated/notion-research-documentation

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 456 entrypoint words; 3,404 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-research-documentation/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/notion-research-documentation). 

**Benefit.** Synthesizes Notion sources into cited findings, contradictions, and decision-oriented documentation.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The synthesis instructions preserve source provenance and user goals. Asking for confirmation whenever search returns multiple results is counterproductive for a multi-source research skill. The search reference and evaluation examples also impose a three-source threshold without a sufficiency test.

**Preserve:** Explicitly records evidence, dates, contradictions, and source IDs.; Allows format adaptation and keeps the user’s decision or summary goal in view.

**Finding 1: Normal multiple search results trigger a user confirmation gate.** Multi-source research repeatedly stops despite the skill’s purpose being to select and synthesize relevant evidence.

- [SKILL.md, lines 31–31](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-research-documentation/SKILL.md:31>): “ask the user to confirm if multiple results appear.”

**Recommended treatment:** Choose sources using relevance, provenance, dates, and the requested scope; ask only when different plausible targets would materially change the objective.

**Finding 2: Minimum-source heuristics expand scope regardless of evidence sufficiency.** Two definitive sources can be padded with weaker or out-of-scope material; mandatory broadening can disregard the user’s chosen teamspace.

- [advanced-search.md, lines 162–162](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-research-documentation/reference/advanced-search.md:162>): “If search returns < 3 results:”
- [advanced-search.md, lines 165–165](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-research-documentation/reference/advanced-search.md:165>): “Remove filters**: Search full workspace”
- [README.md, lines 99–99](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-research-documentation/evaluations/README.md:99>): “Fetches at least 3 different source pages”

**Recommended treatment:** Treat counts as scenario examples, preserve requested source boundaries, and stop when evidence supports the answer; disclose actual gaps rather than filling a quota.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: Repeated source-selection confirmation and count-based search expansion can stall or dilute a sound synthesis from a small authoritative evidence set.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The model’s ability to investigate autonomously may be suppressed by treating normal multi-result search as a reason to pause; source sufficiency should depend on the question.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-32"></a>

### 32. openai/curated/notion-spec-to-implementation

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 449 entrypoint words; 3,521 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-spec-to-implementation/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/notion-spec-to-implementation). 

**Benefit.** Transforms an explicitly requested Notion implementation plan into linked requirements, tasks, dependencies, and progress records.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. Plan-depth selection and testable acceptance criteria are useful for project planning. Human-day task sizing, fixed-phase evaluation examples, and progress notifications should not become obligatory for every engineering task that happens to start from a Notion specification.

**Preserve:** Distinguishes simple from multi-phase plans.; Task reference favors concrete acceptance criteria, real database properties, dependencies, and honest progress.

**Finding 1: Human-duration task sizing and fixed-phase rubrics can inflate small work.** Tiny changes can be split into artificial phases or assigned unsupported duration estimates to satisfy the rubric.

- [SKILL.md, lines 43–43](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-spec-to-implementation/SKILL.md:43>): “Size tasks to 1–2 days.”
- [README.md, lines 109–109](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-spec-to-implementation/evaluations/README.md:109>): “Creates implementation plan with 3 phases: Setup → Core → Polish”
- [README.md, lines 110–110](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-spec-to-implementation/evaluations/README.md:110>): “Creates 5-8 tasks in task database”

**Recommended treatment:** Activate for requested planning/backlog work; size by coherent deliverables and dependencies, using human-day estimates only when the user needs them.

**Finding 2: Progress workflow includes unrequested notifications.** A request for a plan or implementation can generate messages to others without explicit authorization.

- [SKILL.md, lines 52–52](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-spec-to-implementation/SKILL.md:52>): “Use the cadence in `reference/progress-tracking.md`.”
- [progress-tracking.md, lines 42–42](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/notion-spec-to-implementation/reference/progress-tracking.md:42>): “Notify relevant people”

**Recommended treatment:** Keep local/page status updates within the authorized scope; send comments or notifications only when the user has requested them.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A task to implement a small change can become a backlog-and-status exercise, leaving the requested code unfinished while satisfying artifact-count rituals.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The skill can channel long-horizon reasoning into project-management paperwork rather than implementation unless planning artifacts and notifications are clearly within scope.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-33"></a>

### 33. openai/curated/openai-docs

**High risk · adapt · Agentic Operator catalog.** Local activation: passed. 2,554 entrypoint words; 18,302 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/openai-docs/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/openai-docs). 

**Benefit.** Routes OpenAI and Codex questions to current official documentation, preserves explicit model targets, and discourages stale prompt over-specification.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. The freshness checks, capability verification, and outcome-oriented prompting reference are strengths. However, an unconditional API-migration block and mandatory docs-MCP installation can stop authorized work. Older GPT-5.5 reference values are explicitly labeled as fallible fallback guidance; they are not by themselves evidence that current models are unsupported.

**Preserve:** Preserves explicitly named model targets and makes fallback/freshness limitations visible.; Prompting reference warns against legacy process over-specification and encourages outcome-focused instructions.

**Finding 1: API migration rule blocks necessary work despite explicit broader authorization.** An authorized migration requiring schema or tool-handler changes can be stopped by the skill’s narrow workflow even when the preceding instruction recognizes broader user requests.

- [SKILL.md, lines 130–130](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/openai-docs/SKILL.md:130>): “unless the user explicitly asks for them.”
- [SKILL.md, lines 131–131](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/openai-docs/SKILL.md:131>): “implementation work beyond a literal model-string replacement and prompt edits, report it as blocked or confirmation-needed.”

**Recommended treatment:** Scope migration to the user’s actual request; perform necessary authorized API/handler changes and meaningful validation, asking only for unresolved consequential choices.

**Finding 2: Missing docs MCP causes setup and restart rather than using available official sources.** A straightforward documentation answer can become a persistent runtime change and extra user round-trip on a managed host.

- [SKILL.md, lines 110–110](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/openai-docs/SKILL.md:110>): “Run the install command yourself: `codex mcp add openaiDeveloperDocs”
- [SKILL.md, lines 113–113](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/openai-docs/SKILL.md:113>): “Ask the user to restart Codex.”

**Recommended treatment:** Prefer existing local documentation and supported official web lookup; install connectors only when the task calls for that setup and the host supports it.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: The rule blocking implementation beyond a model-string/prompt edit can prevent an explicitly requested Astra API migration from being completed, even with verified current documentation.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: The same gate can interrupt an authorized OpenAI integration task performed by Fable; automatic connector installation is a host assumption rather than a reasoning necessity.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-34"></a>

### 34. openai/curated/pdf

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 373 entrypoint words; 2,517 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/pdf/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/pdf). 

**Benefit.** Promotes render-and-inspect validation for PDFs where layout matters, avoiding false confidence from text extraction alone.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. Visual inspection, legibility, and clipping checks are genuine output-quality requirements. The blanket ASCII-dash prescription can alter faithful content unnecessarily, and the Poppler-or-user-review fallback is narrower than the set of usable renderers. A completion claim should require adequate visual validation; an explicitly requested unverified draft can still be delivered as a draft.

**Preserve:** Correctly distinguishes text extraction from visual layout fidelity.; Checks tables, page flow, citations, and readable glyphs after meaningful changes.

**Finding 1: Blanket ASCII-only dash rule substitutes content without a demonstrated rendering defect.** Exact text preservation, correct nonbreaking compounds, and professional dash typography can be degraded unnecessarily.

- [SKILL.md, lines 61–61](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/pdf/SKILL.md:61>): “Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other Unicode dashes.”

**Recommended treatment:** Preserve requested characters and use fonts that support them; replace a glyph only when an actual compatibility issue is observed and the substitution is acceptable.

**Finding 2: Renderer fallback and absolute final gate can block an explicitly requested draft.** An available alternative renderer may be ignored, or an honestly labeled draft may be withheld while the agent pursues an unbounded zero-defect condition.

- [SKILL.md, lines 17–17](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/pdf/SKILL.md:17>): “If unavailable, install Poppler or ask the user to review the output locally.”
- [SKILL.md, lines 65–65](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/pdf/SKILL.md:65>): “Do not deliver until the latest PNG inspection shows zero visual or formatting defects.”

**Recommended treatment:** Use any supported renderer that supplies adequate visual evidence, bound inspection to material output requirements, and distinguish a validated final from an explicitly requested unverified draft.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A universal character substitution can reduce typographic or transcription fidelity even when the rendering engine correctly supports the original glyphs.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Strong document reasoning is helped by visual evidence, but should retain discretion over correct typography and supported rendering tools rather than enforce one character set.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-35"></a>

### 35. openai/curated/playwright

**Moderate risk · adapt · Agentic Operator catalog.** Local activation: passed. 522 entrypoint words; 3,771 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/playwright). 

**Benefit.** Provides grounded terminal browser automation using fresh snapshots, element references, and isolated browser sessions.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. Snapshot grounding and explicit browser actions reduce invented selectors and stale references. The required npx check and hardcoded personal-skill wrapper path are avoidable host assumptions; this terminal workflow should be selected when it matches the available tools, not override an already supported browser integration.

**Preserve:** Requires a fresh snapshot before using element references and resnapshots stale state.; References support named sessions and keep operations explicit rather than relying on fabricated element IDs.

**Finding 1: One launcher and installation path are treated as universal prerequisites.** Shared bundle imports can point to a nonexistent wrapper; a host with another approved browser surface may be incorrectly declared blocked.

- [SKILL.md, lines 20–20](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright/SKILL.md:20>): “If it is not available, pause and ask the user to install Node.js/npm”
- [SKILL.md, lines 38–38](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright/SKILL.md:38>): “$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh”

**Recommended treatment:** Resolve the wrapper from the loaded skill root, detect already installed compatible commands, and select this skill only for a supported terminal automation surface.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A missing npx wrapper can trigger an unnecessary installation pause even when the host has a functional browser tool or installed CLI.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Browser reasoning benefits from current snapshots and session reuse, but is not helped by insisting on one package launcher or installation layout.

**Evidence coverage:** 4 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-36"></a>

### 36. openai/curated/playwright-interactive

**High risk · host-only · Agentic Operator catalog.** Local activation: passed. 4,388 entrypoint words; 31,711 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright-interactive/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/playwright-interactive). 

**Benefit.** Supports persistent browser/Electron sessions with real-input functional verification, screenshot-based visual QA, and explicit session cleanup.

**Assessment.** Static inspection only; no Astra or Fable model evaluation was executed. This is a specialized js_repl browser/Electron workflow, not a portable browser skill. Its real-input and visual-evidence requirements are sound, but requiring disabled sandboxing cannot be inherited into a managed operator. The all-controls and timed exploratory rituals also need proportional scope for small fixes.

**Preserve:** Requires visible outcomes from real user controls rather than treating internal state inspection as signoff.; Distinguishes renderer reload from main-process restart, maintains persistent handles, and includes cleanup guidance.

**Finding 1: Skill requires a specific tool and disabled sandboxing.** Activation on a managed or differently configured host can induce unsafe policy changes, repeated restarts, or failure despite an available authorized browser surface.

- [SKILL.md, lines 12–12](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright-interactive/SKILL.md:12>): “`js_repl` must be enabled for this skill.”
- [SKILL.md, lines 22–22](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright-interactive/SKILL.md:22>): “run this workflow with sandboxing disabled: start Codex with `--sandbox danger-full-access`”

**Recommended treatment:** Expose only where the host explicitly supports this workflow; never weaken isolation to satisfy skill text. Use another supported browser workflow when its capabilities meet the task.

**Finding 2: Universal all-controls and timed exploration expand bounded UI fixes.** A small rendering correction can trigger unrelated testing and boilerplate reporting; fixed duration is not evidence of coverage.

- [SKILL.md, lines 299–299](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright-interactive/SKILL.md:299>): “Cover every obvious visible control at least once before signoff”
- [SKILL.md, lines 301–301](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright-interactive/SKILL.md:301>): “do a short exploratory pass using normal input for 30-90 seconds”
- [SKILL.md, lines 341–341](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/playwright-interactive/SKILL.md:341>): “Include a brief negative confirmation of the main defect classes”

**Recommended treatment:** Choose QA breadth from changed behavior, dependencies, and material risks. Keep real user-input and screenshot evidence, but make exploratory scope and final reporting proportional.

**GPT-6 Astra:** Hypothesis for GPT-6 Astra: A mandatory unrestricted session and fixed full-interface QA loop can block safe available tooling or spend substantial effort on unrelated controls instead of resolving the requested defect.

**Fable 5.1:** Hypothesis for Claude Fable 5.1: Persistent sessions can support demanding long-horizon UI work, but the host preconditions and rigid QA breadth should not override actual available tools or the user’s bounded change.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. Exact paths and hashes are in the manifest.

<a id="skill-37"></a>

### 37. openai/curated/render-deploy

**High risk · adapt · Agentic Operator catalog.** Local activation: passed. 2,443 entrypoint words; 17,582 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/render-deploy). 

**Benefit.** Provides concrete Render service selection, Blueprint generation, secrets handling, and deployment verification knowledge.

**Assessment.** The deployment knowledge can extend either model. Several workflow rules nevertheless turn routine inference into mandatory user interactions, privilege MCP even when a CLI fallback exists, and hard-code main-branch publication. Those rules can interrupt an already authorized deployment or conflict with repository change controls. Keep the domain knowledge and branch/context-aware verification; replace the unconditional process.

**Preserve:** Correctly separates single-service and multi-resource deployments.; Requires source evidence for runtime/build commands and validates secrets and port binding.; Contains concrete deployment and runtime health checks.

**Finding 1: Premature clarification and contradictory tool fallback.** The agent may stop for source/infra questions answered by the repo, or demand MCP setup even with authenticated CLI access.

- [SKILL.md, lines 36–38](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md:36>): “Use this short prompt sequence before deep analysis to reduce friction:”
- [SKILL.md, lines 71–71](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md:71>): “stop and guide MCP setup before proceeding.”
- [SKILL.md, lines 191–193](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md:191>): “If MCP isn't available, use the CLI instead”

**Recommended treatment:** Inspect available project evidence first. Ask only for unresolved consequential deployment choices and use a confirmed CLI/API route when MCP is unavailable.

**Finding 2: Branch and resource-plan defaults become unconditional policy.** Deployment can inherit an unsuitable plan or violate a feature-branch/PR workflow. These are contextual choices, not necessary invariants.

- [SKILL.md, lines 243–243](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md:243>): “Always use `plan: free` unless user specifies otherwise”
- [SKILL.md, lines 315–320](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md:315>): “git push origin main”

**Recommended treatment:** Resolve the intended branch and supported plan from repository configuration, app requirements, current provider data, and existing user authorization.

**Finding 3: Verification unnecessarily adds an endpoint.** Even when the existing root or application route provides adequate evidence, the agent may change source and redeploy.

- [post-deploy-checks.md, lines 16–17](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/references/post-deploy-checks.md:16>): “If there is no health endpoint, add one and redeploy.”

**Recommended treatment:** Use an existing suitable route or provider health signal; add a health endpoint when the deployment actually needs one.

**GPT-6 Astra:** Static inference; not benchmarked. Astra may follow the stop/setup rules literally instead of completing a deployment with available tools; the skill can also steer it into an unintended main-branch push.

**Fable 5.1:** Static inference; not benchmarked. A long-horizon Fable workflow can be interrupted by the same imposed setup questions and branch assumptions. No provider-neutral benefit justifies those fixed choices.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/references/codebase-analysis.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/references/direct-creation.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/references/post-deploy-checks.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/render-deploy/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-38"></a>

### 38. openai/curated/screenshot

**Low risk · host-only · Agentic Operator catalog.** Local activation: passed. 983 entrypoint words; 7,754 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/screenshot/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/screenshot). 

**Benefit.** Adds repeatable operating-system capture commands, output locations, window selection, and permission diagnostics.

**Assessment.** A narrow capture utility largely adds capability rather than constraining reasoning. Its preference for integrated capture tools is useful. The remaining concern is portability: desktop capture and escalation depend on the host, and a headless workflow must not invent a screenshot or enter a permission loop. Screen Recording permission is a real platform boundary, not a model capability degradation.

**Preserve:** Explicit screenshot trigger and preference for integrated tools limit unnecessary activation.; Keeps inspection captures temporary and respects user output paths.; Distinguishes capture success from actually viewing the image.

**Finding 1: Host-dependent capture and escalation.** An imported copy can direct an unsupported escalation or capture command on a remote/headless route.

- [SKILL.md, lines 17–17](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/screenshot/SKILL.md:17>): “Prefer tool-specific screenshot capabilities when available”
- [SKILL.md, lines 262–263](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/screenshot/SKILL.md:262>): “rerun the command with escalated permissions.”

**Recommended treatment:** Expose it only to desktop-capable hosts, resolve the actual skill directory, and obey host-specific capture/approval capabilities. Report a missing desktop capability once.

**GPT-6 Astra:** Static inference; not benchmarked. Useful when Astra has a real desktop and image viewer; offers no visual access by itself on headless routes.

**Fable 5.1:** Static inference; not benchmarked. The same commands are usable by Fable only through a compatible execution host; provider choice does not create OS permissions.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/screenshot/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/screenshot/scripts/ensure_macos_permissions.sh": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/screenshot/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-39"></a>

### 39. openai/curated/security-best-practices

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 1,431 entrypoint words; 8,612 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices). 

**Benefit.** Supplies language/framework security references and evidence-oriented reporting while checking application regressions.

**Assessment.** The security constraints are mostly useful domain expertise, especially evidence, uncertainty, auth boundaries and regression awareness. Risks come from a mandatory approval step even when fixes were already requested, always-on language in loaded references, and blanket deployment advice. Entry-point scope is appropriately narrow. Reference review sampled Next.js and React workflow/boundary sections; this is not a comprehensive correctness audit of all ten framework specifications.

**Preserve:** Requires line-numbered evidence and prioritizes impact.; Recognizes infrastructure controls may exist outside application code.; Warns against breaking existing functionality and follows repository tests.

**Finding 1: Already-authorized remediation is re-gated.** A request to review and fix can end with a report and another permission request.

- [SKILL.md, lines 64–64](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/SKILL.md:64>): “let the user read the report and ask to begin performing fixes.”

**Recommended treatment:** Honor existing authorization: report findings and perform in-scope fixes when requested; ask only where scope or impact is unresolved.

**Finding 2: References extend scope after activation.** Once loaded, the reference can keep imposing a passive security review on later non-security edits, increasing context and unrelated commentary.

- [javascript-typescript-nextjs-web-server-security.md, lines 36–40](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/references/javascript-typescript-nextjs-web-server-security.md:36>): “While working anywhere in a Next.js repo (even if the user did not ask for a security scan):”

**Recommended treatment:** Keep reference guidance scoped to selected security work and directly relevant severe findings; do not persist it as a global task policy.

**Finding 3: Broad deployment advice can suppress contextual judgment.** The broad discouragement can omit relevant production hardening in an explicitly scoped HTTPS security review, even though caution about dev TLS and lasting HSTS effects is appropriate.

- [SKILL.md, lines 86–86](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/SKILL.md:86>): “Additionally avoid recommending HSTS.”

**Recommended treatment:** Condition recommendations on deployment ownership, verified HTTPS, domain scope and rollout requirements. Do not treat blanket avoidance as universal security guidance.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can benefit from framework-specific evidence but may pause after reporting instead of performing authorized fixes, or carry passive-audit instructions into unrelated work.

**Fable 5.1:** Static inference; not benchmarked. Fable can use the same grounded review criteria; the imposed fix gate and broad reference mode remain autonomy risks rather than model-specific limitations.

**Evidence coverage:** 4 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/references/javascript-typescript-nextjs-web-server-security.md": "Read lines 1–114 and 460–480; searched normative rule and HSTS mentions across file.", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/references/javascript-typescript-react-web-frontend-security.md": "Read lines 1–100 (scope, boundaries, workflow and finding contract); remaining rule catalog not individually audited.", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-best-practices/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-40"></a>

### 40. openai/curated/security-ownership-map

**Moderate risk · domain-only · Agentic Operator catalog.** Local activation: passed. 932 entrypoint words; 8,736 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-ownership-map). 

**Benefit.** Provides deterministic Git-history graph construction and bounded queries for security ownership investigation.

**Assessment.** The graph and query helpers add computational reach and save context. They estimate historical activity, not actual access rights, knowledge transfer, or employee availability. Their output labels overstate some proxies: unique historical authors are named bus factor, and a share of tagged activity is described as control. Keep this specialized analysis with explicit statistical definitions and repaired skill-relative commands.

**Preserve:** Only triggers for explicit security ownership analysis.; Small JSON queries avoid dumping the full graph into context.; Exclusion rules and windows can be overridden and findings can be compared with CODEOWNERS.

**Finding 1: Proxy metrics presented as real ownership/control.** Commit activity can be mistaken for current authority or resilience, degrading conclusions even with perfect arithmetic.

- [build_ownership_map.py, lines 623–625](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/scripts/build_ownership_map.py:623>): “bus_factor = len(authors)”
- [build_ownership_map.py, lines 775–775](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/scripts/build_ownership_map.py:775>): “"controls": f"{share * 100:.0f}% of {tag} code",”

**Recommended treatment:** Label unique-author count and tagged-touch share as proxies; corroborate with CODEOWNERS, current maintainers and access evidence. State observation window and excluded activity.

**Finding 2: Repository-layout-specific CLI examples.** The documented path is not portable to a namespaced imported skill and can cause failed tool calls.

- [SKILL.md, lines 48–48](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/SKILL.md:48>): “python skills/skills/security-ownership-map/scripts/run_ownership_map.py”

**Recommended treatment:** Resolve scripts from the imported skill root supplied by the runtime.

**GPT-6 Astra:** Static inference; not benchmarked. Astra benefits from bounded graph slices but must reason beyond the numerical labels rather than repeat them as organizational facts.

**Fable 5.1:** Static inference; not benchmarked. Fable can perform the same deeper synthesis; the source-derived proxy labels risk anchoring either model into an unjustified ownership conclusion.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/references/neo4j-import.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/scripts/run_ownership_map.py": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/scripts/build_ownership_map.py": "Read lines 1–52, 620–649 and 730–783; searched metric/default/author definitions. Remaining implementation not exhaustively audited.", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-ownership-map/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-41"></a>

### 41. openai/curated/security-threat-model

**High risk · adapt · onto-work shared.** Local activation: passed. 763 entrypoint words; 5,561 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model). 

**Benefit.** Enables evidence-backed threat models with explicit attacker capabilities, trust boundaries, realistic priority and concrete mitigation locations.

**Assessment.** Its core security reasoning strongly supports capable models. The mandatory user check-in is repeated in both entrypoint and template and can block final delivery even when all context is supplied or the task is an unattended workflow. Fixed quotas and a very wide table also risk padding small threat-model reports. Preserve the grounding and realistic-risk method; condition questions and output size on actual needs.

**Preserve:** Narrow security-specific trigger prevents architecture-review collisions.; Separates runtime, CI and attacker control.; Requires evidence and makes uncertainty and existing mitigations explicit.

**Finding 1: Unconditional final-report pause.** Complete context and standing authorization still lead to an unnecessary interaction; an unattended workflow may never finish.

- [SKILL.md, lines 49–52](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/SKILL.md:49>): “Pause and wait for user feedback before producing the final report.”
- [prompt-template.md, lines 194–198](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/references/prompt-template.md:194>): “Wait for the user response, then produce the final report below using the clarified context.”

**Recommended treatment:** Ask only for unresolved material facts. Produce a conditional report with explicit assumptions when the task authorizes that behavior, and accept already-provided context.

**Finding 2: Fixed threat/output quotas can displace judgment.** Small, well-bounded systems can receive speculative threats or duplicated severity examples merely to meet the template.

- [prompt-template.md, lines 234–234](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/references/prompt-template.md:234>): “5 to 10 short abuse paths”
- [prompt-template.md, lines 247–247](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/references/prompt-template.md:247>): “Include 2 to 3 examples per level”

**Recommended treatment:** Include as many evidenced paths as are material; allow compact output while preserving traceability.

**GPT-6 Astra:** Static inference; not benchmarked. Astra may satisfy the explicit pause rule instead of the user outcome, a direct reduction of autonomous task completion.

**Fable 5.1:** Static inference; not benchmarked. A Fable long-running threat-model workflow faces the same artificial waiting state; stronger reasoning cannot compensate for a rule forbidding finalization.

**Evidence coverage:** 4 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/references/prompt-template.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/references/security-controls-and-assets.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/security-threat-model/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-42"></a>

### 42. openai/curated/sentry

**Low risk · host-only · Agentic Operator catalog.** Local activation: passed. 548 entrypoint words; 3,810 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/sentry/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/sentry). 

**Benefit.** Adds targeted Sentry querying, pagination/schema discovery, bounded results and careful handling of credentials and event details.

**Assessment.** Read-only Sentry investigation and a supported CLI are legitimate scope and host requirements. On a compatible host, the skill adds bounded queries, schema discovery and credential hygiene without a strong unnecessary reasoning restriction. Org/project auto-detection has an explicit override when it selects the wrong target. An already-connected alternative tool is an integration option; lack of that fallback is not by itself evidence of model degradation.

**Preserve:** Uses JSON and field selection to limit context.; Includes API schema discovery when dedicated commands are insufficient.; Protects credentials and avoids leaking raw sensitive event content.

**Finding 1: Residual CLI-host requirement and target verification.** The utility cannot query Sentry without a compatible authenticated host. Defaults need to match the intended incident scope, but the existing instructions allow correction and do not establish a measured degradation.

- [SKILL.md, lines 25–25](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/sentry/SKILL.md:25>): “Use the `sentry` CLI for all queries.”
- [SKILL.md, lines 12–12](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/sentry/SKILL.md:12>): “Only specify `<org>/<project>` if auto-detection fails or picks the wrong target.”

**Recommended treatment:** Bind the skill to the supported CLI or provide a reviewed connector adapter. Honor explicit project/time/environment input, disclose the queried scope, and retain credential redaction and read-only behavior.

**GPT-6 Astra:** Static inference; not benchmarked. Astra gains concrete observability data on a compatible host. Requiring authenticated Sentry access is an execution dependency, not evidence of weaker reasoning.

**Fable 5.1:** Static inference; not benchmarked. Fable can use the same bounded observations through a supported host. No strong unnecessary instruction constraint was identified in this read-only scope.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/sentry/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/sentry/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-43"></a>

### 43. openai/curated/speech

**Moderate risk · host-only · Agentic Operator catalog.** Local activation: passed. 1,006 entrypoint words; 7,241 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/speech). 

**Benefit.** Provides reproducible speech generation, verbatim source preservation, delivery guidance, batch handling and parameter limits.

**Assessment.** TTS is a separate generation service; choosing a speech model does not downgrade Astra or Fable as the reasoning model. The main portability costs are an OpenAI SDK/key dependency, fixed local paths, and a blanket stop if the wrapper lacks a feature. Protecting the vendor script from unsolicited mutation is sensible; forbidding any supported adaptation is broader than necessary.

**Preserve:** Does not rewrite the narration text or invent persona/accent requirements.; Asks only for genuinely blocking missing inputs in the augmentation rule.; Important clips receive audio quality checks.

**Finding 1: Immutable wrapper turns missing features into a task-wide stop.** An otherwise feasible voiceover task can stop instead of using an available supported capability or continuing independent work.

- [SKILL.md, lines 68–68](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/SKILL.md:68>): “If something is missing, ask the user before doing anything else.”

**Recommended treatment:** Keep upstream scripts immutable, but allow an authorized local adapter or equivalent tool with the same contract; ask only when a consequential decision is unresolved.

**Finding 2: Codex-specific path and unconditional rate ceiling.** Imported namespaced paths can fail, and a fixed throughput cap may unnecessarily limit an authorized larger batch. The cap may be a valid conservative default, not a universal account limit.

- [cli.md, lines 16–17](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/references/cli.md:16>): “export TTS_GEN="$CODEX_HOME/skills/speech/scripts/text_to_speech.py"”
- [SKILL.md, lines 63–63](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/SKILL.md:63>): “Enforce 50 requests/minute.”

**Recommended treatment:** Resolve the actual skill root and use a configurable account-appropriate rate budget with backoff; preserve user text, disclosure and key hygiene.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can plan and inspect speech output without changing its reasoning model, but may stall when the required wrapper is missing or incomplete.

**Fable 5.1:** Static inference; not benchmarked. Fable can orchestrate the same TTS service through a compatible host; vendor-specific tool routing and blanket script gates are the potential loss of reach.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/references/cli.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/references/audio-api.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/references/prompting.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/references/codex-network.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/speech/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-44"></a>

### 44. openai/curated/transcribe

**Low risk · host-only · Agentic Operator catalog.** Local activation: passed. 370 entrypoint words; 2,834 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/transcribe/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/transcribe). 

**Benefit.** Provides a compact audio transcription workflow with diarization selection, speaker references and output validation.

**Assessment.** The task workflow is concise and does not impose unnecessary reasoning constraints. OpenAI credentials and the bundled transcription models are a legitimate execution contract for this particular utility, not a downgrade of the main reasoning model. Its remaining concern is installation portability: examples assume a fixed Codex path. Bind it to a compatible transcription host and resolve the actual imported script path. An alternative native transcription route is an integration option, not something this utility must supply.

**Preserve:** Correctly distinguishes fast text transcription from diarization.; Keeps API keys out of chat.; Validates text, labels and segment boundaries instead of assuming a service response is correct.

**Finding 1: Residual installation-path portability, not a reasoning restriction.** The documented Codex path may not exist after namespaced import. Requiring a valid API key for the selected OpenAI service is appropriate; the skill itself does not create credentials or audio access.

- [SKILL.md, lines 13–14](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/transcribe/SKILL.md:13>): “Verify `OPENAI_API_KEY` is set.”
- [SKILL.md, lines 48–48](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/transcribe/SKILL.md:48>): “export TRANSCRIBE_CLI="$CODEX_HOME/skills/transcribe/scripts/transcribe_diarize.py"”

**Recommended treatment:** Resolve the imported script from runtime metadata and expose the utility only where its execution requirements are satisfied. Preserve user-selected quality and diarization requirements.

**GPT-6 Astra:** Static inference; not benchmarked. Astra may gain accurate audio text via the service; the mini-transcribe default is a task tool, not a replacement for Astra.

**Fable 5.1:** Static inference; not benchmarked. Fable can orchestrate the external transcription tool on a compatible host without changing its reasoning model. Installation paths and API credentials must be provided by the runtime.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/transcribe/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/transcribe/references/api.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/transcribe/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-45"></a>

### 45. openai/curated/vercel-deploy

**High risk · adapt · Agentic Operator catalog.** Local activation: passed. 380 entrypoint words; 2,653 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/vercel-deploy). 

**Benefit.** Adds a short Vercel deployment path with preview defaults and a packaged fallback.

**Assessment.** The instruction forbidding deployed-URL verification is a direct capability reduction. The fallback itself fetches the URL and can label any 4xx as ready, so the entrypoint and implementation also conflict. Build receipt, HTTP reachability and correct application behavior must be separated. The no-auth fallback is a specific hosted route whose availability and package scope need verification before use; no deployment was executed in this review.

**Preserve:** Preview deployment is a reasonable default with explicit production override.; Fallback packages into a temporary staging area instead of modifying source.; Excludes .env files from the directory packaging path.

**Finding 1: Explicit suppression of outcome verification.** A deployed but broken page may be reported as complete even when a lightweight check is available and requested.

- [SKILL.md, lines 65–65](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/SKILL.md:65>): “**Do not** curl or fetch the deployed URL to verify it works. Just return the link.”

**Recommended treatment:** Allow a bounded HTTP/browser smoke test when authorized. Report deployment acceptance separately from application health.

**Finding 2: Fallback readiness label exceeds its evidence.** 4xx responses or a timeout can be mistaken for successful delivery; a JSON URL alone does not prove functional readiness.

- [deploy.sh, lines 277–281](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/scripts/deploy.sh:277>): “Deployment ready (returned $HTTP_STATUS)!”
- [deploy.sh, lines 290–293](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/scripts/deploy.sh:290>): “Timed out waiting for deployment, but it may still be building.”

**Recommended treatment:** Return explicit build/readiness/health status, classify expected authentication separately, and never convert timeout or error status into verified success.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can be steered into returning an unverified link despite having browser/HTTP tools that could catch a broken deployment.

**Fable 5.1:** Static inference; not benchmarked. Fable loses the same end-to-end verification ability if it follows the blanket fetch prohibition; this is not a model capacity limit.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/scripts/deploy.sh": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/vercel-deploy/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-46"></a>

### 46. openai/curated/winui-app

**Moderate risk · host-only · Agentic Operator catalog.** Local activation: passed. 1,572 entrypoint words; 11,272 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/winui-app). 

**Benefit.** Supplies Windows-native UI architecture, setup, packaging and objective launch verification guidance.

**Assessment.** The native-control, accessibility and packaging guidance is valuable domain expertise, not arbitrary suppression of design ability: explicit customization and existing design systems are allowed. The hard requirement to launch and leave a window running after any app edit does not account for headless or non-Windows authoring. Setup also privileges the bundled configuration. Keep this on compatible Windows hosts and make remote authoring/verification limits explicit.

**Preserve:** Objective top-level window verification prevents false claims based on process launch alone.; Preserves existing codebase conventions and allows explicit design customization.; Uses modular task-specific references and separates packaging from environment readiness.

**Finding 1: Universal visible-launch completion gate.** A remote source change can enter an unfinishable verification loop even when the missing capability is the host, not the app.

- [SKILL.md, lines 40–41](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/SKILL.md:40>): “build the app and run it before responding to the user.”
- [SKILL.md, lines 84–85](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/SKILL.md:84>): “If the app did not clearly open, keep debugging.”

**Recommended treatment:** Keep actual launch evidence mandatory for a claim that it runs. Permit bounded source/build verification with an explicit environment limitation when GUI execution is unavailable.

**Finding 2: Setup path overrules an already-sufficient toolchain.** New-app work may initiate a broad Visual Studio/Developer Mode bootstrap even when existing tooling is sufficient. Confirmation for a diagnostics-only request is valid, not a degradation.

- [SKILL.md, lines 19–25](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/SKILL.md:19>): “Run the bundled WinGet configuration from the skill directory”
- [SKILL.md, lines 33–33](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/SKILL.md:33>): “For diagnostics-only environment requests”

**Recommended treatment:** Check the existing toolchain before remediating; run only necessary authorized setup and retain non-mutating audit behavior for diagnostics.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can gain reliable WinUI implementation knowledge but cannot satisfy a visible-window condition on a non-Windows/headless worker.

**Fable 5.1:** Static inference; not benchmarked. Fable faces the same platform constraint; a launch gate must not erase useful code review or source editing that can be completed with an explicit unverified-runtime note.

**Evidence coverage:** 6 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/references/_sections.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/references/foundation-environment-audit-and-remediation.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/references/build-run-and-launch-verification.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/config.yaml": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/winui-app/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-47"></a>

### 47. openai/curated/yeet

**High risk · adapt · Agentic Operator catalog.** Local activation: passed. 1,091 entrypoint words; 6,952 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/yeet/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/yeet). 

**Benefit.** Provides an end-to-end GitHub PR workflow with template discovery, existing-PR reuse and net-change descriptions.

**Assessment.** The explicit trigger and PR reuse are useful. Staging all files and responding to workflow authentication errors by pulling master can override contextual Git judgment and incorporate unrelated work. Multiple templates also cause a mandatory stop even when repository conventions could resolve the choice. Preserve the review-writing guidance, but route repository mutations through scoped change ownership and actual error diagnosis.

**Preserve:** Triggers only for an explicit combined stage/commit/push/PR request.; Updates an existing PR and preserves ready/draft state.; Preserves meaningful existing PR content and writes real newlines using body files.

**Finding 1: Unscoped staging overrides intended change ownership.** Unrelated user or parallel-agent changes can enter the commit and PR.

- [SKILL.md, lines 42–42](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/yeet/SKILL.md:42>): “stage everything: `git status -sb` then `git add -A`.”

**Recommended treatment:** Inspect the diff and stage only intended task files/hunks. Preserve unrelated changes; isolate a worktree when appropriate.

**Finding 2: Authentication failure is treated as branch divergence.** Pulling master does not establish missing permissions and may alter the branch with unrelated changes or conflicts.

- [SKILL.md, lines 46–46](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/yeet/SKILL.md:46>): “If git push fails due to workflow auth errors, pull from master and retry the push.”

**Recommended treatment:** Classify the actual failure. Resolve authentication through the existing host flow; fetch/rebase/merge only for an evidenced branch-history issue and repository policy.

**Finding 3: Template multiplicity becomes an unconditional pause.** A repo with documented template routing can still cause an unnecessary user interaction.

- [SKILL.md, lines 36–36](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/yeet/SKILL.md:36>): “If multiple template files are found, stop before PR creation and ask which template to use.”

**Recommended treatment:** Infer the correct template from repository conventions and task type; ask only if the choice remains material and ambiguous.

**GPT-6 Astra:** Static inference; not benchmarked. Astra may follow git add -A literally in a shared dirty checkout, widening the commit beyond the user task; the auth retry can create irrelevant merges.

**Fable 5.1:** Static inference; not benchmarked. Fable is exposed to the same workflow-side regression regardless of reasoning strength. Correct Git operations require task scope, branch and error context.

**Evidence coverage:** 2 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/yeet/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.curated/yeet/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-48"></a>

### 48. openai/system/imagegen

**Low risk · host-only · Agentic Operator catalog.** Local activation: passed. 2,340 entrypoint words; 16,204 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen). 

**Benefit.** Provides raster generation/editing selection, prompt specificity, identity/invariant preservation and durable project asset handling.

**Assessment.** The prompting guidance protects user intent, distinguishes raster work from editable native assets, and adds meaningful inspection and persistence checks. The built-in-first mode and explicit opt-in to an API-key fallback can be legitimate because the fallback changes credential and billing requirements. Those choices are not evidence of reduced model intelligence. Remaining concerns are host portability and honoring an already-explicit fallback choice; bind this copy to a compatible image-generation runtime.

**Preserve:** Preserves detailed prompts instead of inventing creative requirements.; Separates reference images from edit targets.; Requires project-bound outputs to be persisted and inspected.

**Finding 1: Residual image-host and output-location contract.** A route without the documented tool or storage semantics cannot use this copy unchanged. An explicit choice before changing to an API-key-backed service can be justified; no measured autonomy regression is established by this boundary.

- [SKILL.md, lines 24–28](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/SKILL.md:24>): “Proceed only if the user explicitly asks for that fallback.”
- [SKILL.md, lines 31–33](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/SKILL.md:31>): “Codex saves generated images under `$CODEX_HOME/*` by default.”

**Recommended treatment:** Provide a host adapter for actual image tools and output paths. Honor existing explicit fallback authorization; otherwise preserve the meaningful credential/billing choice. Keep raster/vector scope and invariant checks.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can benefit from intent-preserving prompts and asset verification on a compatible image host. The explicit paid fallback boundary is not itself evidence of degradation.

**Fable 5.1:** Static inference; not benchmarked. Fable needs a confirmed image-generation interface and storage adapter; the reasoning model alone does not provide raster generation or Codex file semantics.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/references/prompting.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/references/cli.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/references/codex-network.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/imagegen/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-49"></a>

### 49. openai/system/openai-docs

**High risk · adapt · onto-work shared.** Local activation: passed. 2,617 entrypoint words; 18,747 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/openai-docs). 

**Benefit.** Provides official-source grounding, model freshness checks, target preservation, and careful distinction between public docs and current host capabilities.

**Assessment.** Current documentation is valuable, but this copy owns broad migration work while restricting actual changes to model strings and prompts. It directs a stop when necessary implementation changes are found, even when the user asked for a complete migration. It also installs/restarts Codex to repair missing docs MCP rather than directly completing a lookup through available official web sources. Bundled model guides are explicitly fallback snapshots, not current evidence for Astra or Fable.

**Preserve:** Requires current official sources and preserves explicit model targets.; Keeps bounded uncertainty instead of inventing availability/pricing.; Prompt guide favors outcome-oriented instructions and reserves absolute rules for real invariants.

**Finding 1: Authorized implementation migration declared out of scope.** The agent can identify the required API/schema/tool change and still stop, reducing an end-to-end migration to partial editing.

- [SKILL.md, lines 137–137](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/SKILL.md:137>): “report it as blocked or confirmation-needed.”
- [upgrade-guide.md, lines 22–22](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/references/upgrade-guide.md:22>): “mark it as blocked instead of stretching the scope”

**Recommended treatment:** Use a narrow mode only when the user requests a model/prompt-only change; otherwise continue authorized implementation with compatibility tests or hand off the bounded change without re-gating.

**Finding 2: Documentation retrieval can mutate host setup and require restart.** A factual lookup can stall for a host configuration operation even when official web access can answer it.

- [SKILL.md, lines 114–120](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/SKILL.md:114>): “Run the install command yourself: `codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp`”
- [SKILL.md, lines 119–119](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/SKILL.md:119>): “Ask the user to restart Codex.”

**Recommended treatment:** Use already available official-doc routes; make installing a persistent docs connector a separate host-aware setup choice when actually necessary.

**Finding 3: Fallback model map may bias current selection.** If freshness lookup fails, old named defaults could be repeated as current and inadvertently replace a user-selected stronger route.

- [latest-model.md, lines 9–10](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/references/latest-model.md:9>): “`gpt-5.5`”
- [latest-model.md, lines 3–3](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/references/latest-model.md:3>): “Every recommendation here must be verified against current OpenAI docs”

**Recommended treatment:** Preserve explicit target models; label stale fallback guidance and never infer a current default or downgrade from an unverified snapshot.

**GPT-6 Astra:** Static inference; not benchmarked. Astra may strongly obey the narrow migration gate and stop before accomplishing the authorized integration upgrade; source-route rituals can consume time without improving the answer.

**Fable 5.1:** Static inference; not benchmarked. On a Fable host, Codex installation/restart commands can be irrelevant. Official OpenAI docs remain useful when the target task concerns OpenAI, but the host-specific route should not govern unrelated provider work.

**Evidence coverage:** 5 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/references/latest-model.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/references/upgrade-guide.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/references/prompting-guide.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/openai-docs/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-50"></a>

### 50. openai/system/plugin-creator

**Low risk · host-only · Agentic Operator catalog.** Local activation: passed. 753 entrypoint words; 6,382 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/plugin-creator/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/plugin-creator). 

**Benefit.** Provides deterministic Codex plugin manifests, marketplace schema and local scaffolding conventions.

**Assessment.** This is a Codex scaffold generator, with format-specific manifests and marketplace entries. Such requirements are useful domain constraints. Placeholders are intentional scaffolding: the quick start explicitly tells the agent to replace them, and a follow-up step can occur within the same authorized task. Do not treat the skeleton as a finished implementation or apply its schema to another runtime. No strong unnecessary reasoning constraint was identified in its appropriate scope.

**Preserve:** Normalizes names and preserves existing marketplace display metadata.; Makes overwrite intentional and supports optional components.; Documents exact manifest/marketplace field semantics.

**Finding 1: Residual distinction between scaffold output and complete plugin behavior.** The scaffold has limited scope and does not itself implement requested external tools or business behavior. Mistaking scaffold completion for task completion is a possible integration error, not a proven effect of the instructions.

- [SKILL.md, lines 20–20](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/plugin-creator/SKILL.md:20>): “Open `<plugin-path>/.codex-plugin/plugin.json` and replace `[TODO: ...]` placeholders.”
- [SKILL.md, lines 139–141](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/plugin-creator/SKILL.md:139>): “Keep manifest values as placeholders until a human or follow-up step explicitly fills them.”

**Recommended treatment:** Use it only for an explicitly selected Codex target. Complete the same-task metadata/implementation steps required by the user, resolve the actual imported script location, and state genuinely missing resources.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can use the schema and scaffolder while retaining implementation judgment; it should finish the authorized follow-up steps rather than mistake placeholders for completed behavior.

**Fable 5.1:** Static inference; not benchmarked. Fable can author the same Codex format on a compatible host. Format-specific requirements do not imply general reasoning degradation.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/plugin-creator/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/plugin-creator/references/plugin-json-spec.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/plugin-creator/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-51"></a>

### 51. openai/system/skill-creator

**Moderate risk · adapt · onto-work shared.** Local activation: passed. 2,612 entrypoint words; 18,664 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-creator). 

**Benefit.** Provides concise skill design, task-dependent degrees of freedom, progressive disclosure, deterministic initialization and basic validation.

**Assessment.** The core authoring philosophy explicitly assumes the model is already smart and limits added instructions to useful knowledge. It is therefore a strong reference. It is not by itself evidence of the best creator: validation checks package syntax, not comparative task behavior. Its name/description-only frontmatter instruction conflicts with preserving supported metadata in revisions and even with its own validator. Adapt it to Agentic contracts and use the local creator as the operational authoring policy rather than stacking multiple creators.

**Preserve:** Explicitly assumes Codex is already very smart.; Sets high freedom for contextual decisions and low freedom for fragile operations.; Separates entrypoint, references and executable resources to conserve context.; Allows process steps to be skipped for a clear reason and requires actual script execution before claiming script validity.

**Finding 1: Supported metadata can be stripped during revision.** A revision can discard provenance, compatibility or policy metadata that the validator actually supports.

- [SKILL.md, lines 343–343](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/SKILL.md:343>): “Do not include any other fields in YAML frontmatter.”
- [quick_validate.py, lines 40–40](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/scripts/quick_validate.py:40>): “allowed_properties = {"name", "description", "license", "allowed-tools", "metadata"}”

**Recommended treatment:** Preserve existing supported fields and alter only what the requested behavior requires. Align authoring guidance, validation and runtime schema.

**Finding 2: Basic validation is insufficient evidence of improved capability.** A syntactically valid skill can still over-trigger, stall work, or reduce answer quality; the workflow does not require a controlled no-skill comparison.

- [SKILL.md, lines 357–357](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/SKILL.md:357>): “The validation script checks YAML frontmatter format, required fields, and naming rules.”

**Recommended treatment:** Add realistic positive/near-miss cases, behavioral comparison against no-skill or prior version, and honest separation of proposed versus executed tests. Scale evaluations to material risk.

**GPT-6 Astra:** Static inference; not benchmarked. Astra should benefit from the freedom/conciseness principles, but literal frontmatter rewriting can damage a valid existing skill and syntax checks cannot establish non-degradation.

**Fable 5.1:** Static inference; not benchmarked. Fable benefits from the same sparse, conditional instructions; Codex UI scaffolding and tool assumptions need translation, with model-specific comparative evaluation before quality claims.

**Evidence coverage:** 4 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/references/openai_yaml.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/scripts/quick_validate.py": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-creator/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-52"></a>

### 52. openai/system/skill-installer

**Moderate risk · host-only · Agentic Operator catalog.** Local activation: passed. 431 entrypoint words; 3,240 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/SKILL.md>). [Source revision](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-installer). 

**Benefit.** Provides repeatable GitHub skill downloads, destination checks, sparse-checkout fallback and basic path safety.

**Assessment.** Installation does not improve or degrade model reasoning by itself. The concern is activation scope and provenance: this tool defaults to a Codex-global location and moving main, while Agentic shared/project skill placement needs explicit destinations and pinned records. Its preinstalled-system and next-turn promises are Codex assumptions. Keep the download utility on supported hosts and wrap it in the existing catalog/provenance workflow; do not regard finding SKILL.md as semantic approval.

**Preserve:** Allows explicit destination and revision overrides.; Aborts on existing destination rather than silently replacing it.; Checks archive extraction paths and validates relative source paths.

**Finding 1: Global default and mutable source bypass intended placement/provenance.** New skills may land outside shared/project catalogs and update nondeterministically, changing later agent behavior without an auditable version.

- [SKILL.md, lines 48–50](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/SKILL.md:48>): “Installs into `$CODEX_HOME/skills/<skill-name>`”
- [SKILL.md, lines 50–50](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/SKILL.md:50>): “`--ref <ref>` (default `main`)”

**Recommended treatment:** Pass the correct shared or project destination and a resolved revision; retain license, hashes and source metadata through the catalog import route.

**Finding 2: File existence is not behavioral review.** A download can succeed for an unsafe, overbroad, incompatible or low-quality instruction bundle.

- [install-skill-from-github.py, lines 164–169](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/scripts/install-skill-from-github.py:164>): “if not os.path.isfile(skill_md):”

**Recommended treatment:** Separate download, integrity/provenance verification, semantic review and activation. Preserve the upstream source unchanged while adapting runtime-facing instructions when needed.

**GPT-6 Astra:** Static inference; not benchmarked. Astra can use the downloader effectively with an explicit destination and revision; global defaults may otherwise activate unrelated skills in later tasks.

**Fable 5.1:** Static inference; not benchmarked. Fable requires runtime-appropriate placement and discovery rules. A Codex installation path is not a portable integration or compatibility guarantee.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/scripts/install-skill-from-github.py": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/upstream/openai/skills/.system/skill-installer/agents/openai.yaml": "full text read"} Exact paths and hashes are in the manifest.

<a id="skill-53"></a>

### 53. agentic/skill-creator

**Low risk · retain · Agentic Operator catalog.** Local activation: passed. 1,070 entrypoint words; 7,424 UTF-8 bytes. [Reviewed entrypoint](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/SKILL.md>). [Source revision](https://github.com/kenny9911/agentic-operator/tree/main/packages/skills/builtin/skill-creator). 

**Benefit.** Creates small portable skill proposals with clear triggers, runtime capability checks, revision preservation and honest evaluation design.

**Assessment.** The reviewed local creator is explicitly designed to preserve strong-model judgment: it infers routine choices, uses fixed sequences only when order matters, avoids new approval gates and does not invent tools. Its JSON-only output is a real Skill Builder contract, not an arbitrary limit. It is the strongest operational fit among the reviewed creator policies, but static analysis does not establish universal superiority or measured non-degradation on either named model. Prior authoring-route verification is a separate integration result; this source review does not revalidate that route or establish consumer-model quality.

**Preserve:** Triggers for skill authoring rather than any task that resembles a procedure.; Infers routine choices, preserves revisions and avoids generic tutorials or approval gates.; Provider-neutral capability checks prevent invented host tools and permissions.; Separates proposed tests from executed evaluations and development examples from held-out assessment.; Uses proportional evaluation and preserves user intent over cosmetic wording.

**Finding 1: Residual dependence on the actual authoring-host contract.** The JSON-only output is appropriate inside Skill Builder, but loading this creator globally for ordinary task execution could impose an irrelevant output shape. No broad reasoning restriction is otherwise evidenced.

- [output-contract.md, lines 3–4](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/references/output-contract.md:3>): “Return a single JSON object matching the supplied `SkillCreatorOutputSchema`.”
- [SKILL.md, lines 99–103](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/SKILL.md:99>): “Use only tools and interfaces confirmed by the target capability catalog”

**Recommended treatment:** Bind it to explicit skill-authoring requests and supply the actual host schema/catalog. Keep normal task execution outside this trigger; test schema and discovery separately.

**Finding 2: Comparative quality remains unproven until actual evaluation.** The design is favorable, but source inspection cannot prove the best creator or guarantee no regressions across models and workflows.

- [evaluation.md, lines 53–57](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/references/evaluation.md:53>): “Keep model or route, settings, tools, permissions, input set, and rubric aligned.”
- [SKILL.md, lines 146–148](</Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/SKILL.md:146>): “Never convert a contextual result into a claim of universal superiority.”

**Recommended treatment:** Run held-out no-skill/prior-version comparisons per route with aligned tools and settings, independent criteria and repeated samples where needed; publish measured limits.

**GPT-6 Astra:** Static inference; not benchmarked. Astra receives outcome and contract constraints while retaining implementation judgment; the instructions counter known risks from excessive process and unnecessary pauses.

**Fable 5.1:** Static inference; not benchmarked. Fable receives provider-neutral authoring instructions and the same freedom. Compatibility still depends on the host exposing the promised output schema and capability catalog.

**Evidence coverage:** 3 listed source files; entrypoint read in full, supporting materials selected for relevance. {"/Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/SKILL.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/references/output-contract.md": "full text read", "/Users/kenny/CSI-AICOE/agentic-operator/skills-library/local/skill-creator/references/evaluation.md": "full text read"} Exact paths and hashes are in the manifest.

## Reproduction and acceptance

Run `python3 build-report.py` from this report folder to rebuild the artifacts and verify coverage, hashes and quotations. It does not execute skills or call either model. The runtime probe requires the existing Agentic Operator dependencies and its `tsx` development runner:

```sh
cd /Users/kenny/CSI-AICOE/agentic-operator
pnpm --filter @agentic/api exec tsx /Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/runtime-probes.mts
```

`runtime-probe-results.json` records the actual observations and code digests at review time. Re-running against changed source is a new observation; preserve the old artifacts before accepting an updated review. The manifest is a review record, not an activation policy or a certificate.
