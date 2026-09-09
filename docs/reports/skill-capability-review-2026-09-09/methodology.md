# Skill capability review — Fable 5.1 and GPT-6 Astra

Reviewed: 9 September 2026. Scope: all 53 imported Agentic Operator catalog entries, including the 14 shared copies selected for onto-work. The remaining skills installed personally in Codex and the repositories' development-assistant skills are outside this review.

Source location matters: the onto-work shared copies are in the completed import worktree at `/Users/kenny/CSI-AICOE/onto-work-skills/shared`, associated with merged revision `e18db784f510da71a120ef708aee866c8b048b47`. The current `/Users/kenny/CSI-AICOE/onto-work` checkout has other work in progress and does not contain that shared directory. This report does not synchronize or alter either checkout. Shared-copy hashes and instruction-body correspondence are verified separately from the Agentic Operator runtime probes.

**The catalog cannot currently be certified as non-degrading.** Some skills supply valuable domain knowledge, reusable resources and reliable procedures. Others introduce unnecessary stops, fixed approaches, incompatible host assumptions or restrictions on verification. A stronger model can follow those instructions more effectively and therefore still deliver a worse result. Correct installation, licensing and a Pro authoring model do not establish behavioral quality.

This is an evidence-backed instruction review with local runtime probes, **not a completed Fable-versus-Astra benchmark**. No paid model calls were made. Per-skill risk levels are review judgments, not measured regression rates. The report does not change imported files, activation settings, models or production records.

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
