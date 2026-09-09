# Official skill review and onto-work integration

Reviewed September 9, 2026 against the upstream Git trees and the already
retained Agentic Operator archive. All three source commit pins still matched
their current default branches when independently checked through GitHub.

| Source | Pinned revision | Available inventory | Retained in Agentic Operator |
| --- | --- | --- | --- |
| [Anthropic skills](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f) | `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` | 19 skills and a template | 14 with verified Apache terms |
| [OpenAI legacy skills](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431) | `49f948faa9258a0c61caceaf225e179651397431` | 44 skills | 36 with Apache or MIT terms |
| [OpenAI plugins](https://github.com/openai/plugins/tree/d416fd5a43426019986b1e489506db3db66dee3d) | `d416fd5a43426019986b1e489506db3db66dee3d` | 534 SKILL.md files under plugins | 2 current OpenAI developer examples |

OpenAI's legacy repository points readers to plugins as its successor. Its
pinned skills still provide useful portable material. Anthropic's document
bundles carry restrictive terms; the existing central selection records their
exclusion and uses the permissive OpenAI PDF skill. The unlicensed Anthropic
coauthoring/template entries and separately licensed OpenAI Figma entries are
also outside this import. Complete selection and copying evidence remain in
Agentic Operator's `skills-library/sources.json` and per-bundle license files.

The central offline verifier passed for 52 upstream skills, 1,002 files and
12,488,772 bytes. Its catalog also includes the maintained platform creator,
for 53 entries. Onto-work imports 14 useful instruction bundles from that
archive, retaining their resources and notices in 125 files. These local imports
are namespaced and file-hashed, and do not register arbitrary upstream plugins,
install connectors or execute bundled scripts.

## Creator evidence

The existing maintained creator combines compact, reusable packaging with
positive/negative trigger checks, realistic task evaluation, and appropriately
scoped comparisons. Its checked-in builtin and library snapshot match the
recorded Pro-authored bundle digest
`9e69be4…`.
The complete verified digest is retained in Agentic Operator's creator evidence;
the authoring result used `custom/openai/gpt-5.6-sol-pro` with a provider request
identifier and token usage. That original run predates raw provider attestation,
so it establishes the gateway-normalized route.

A later default HTTP generation returned 201 and saved a draft with raw
`reportedModel=openai/gpt-5.6-sol-pro`, persisted unchanged through the API.
Its request identifier was `gen-1788907452-nHBVuJeEs5x3FLJCIop6`, taking 78,746 ms
with 21,035 input and 7,632 output tokens reported. The verification draft was
then archived. The local evidence is retained outside Git under Agentic
Operator's `data/skill-creator-research/`, and the reviewed explanation is in
its `docs/research/2026-09-09-skill-creator-pro.md`.

These observations verify genuine Pro routing, package provenance and draft
persistence. An independent invoice rehearsal also exists. They do not establish
that this creator is universally best; there is no aligned held-out comparative
benchmark against all alternatives. The upstream [OpenAI creator](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-creator)
and [Anthropic creator](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/skill-creator)
remain available locally for comparison and task-specific evaluation.

## Continuing research

Research stays reviewable: establish official ownership, inspect complete
bundles and licenses, pin a commit, retain file hashes and provenance, verify
representative tasks, and publish selected updates through the existing import
lifecycle. A popularity ranking alone does not establish trust. No periodic
download or automatic publication job is created by this change.

GitHub's unauthenticated API returned a rate-limit error during fresh discovery;
authenticated `gh api` inventory checks succeeded. Offline verification remains
independent of network availability.

## Integration verification

- All 7 importer tests passed; repeated import returned unchanged.
- Independent comparison verified all 125 imported files against the retained
  originals, with only the declared namespace and modification-notice edits.
- All 211 server tests and 86 web tests passed, plus workspace typechecking.
- Native `codex-cli 0.153.0-alpha.6` discovered all 14 shared skills in two
  isolated user runtimes, each inspecting two projects. Each project saw its
  own canary skill, no sibling's canary, and no parent-repository canary.
  The check made zero model calls.

These checks establish import, discovery, runtime registration and placement.
They do not execute every optional vendor script or install its dependencies.
