# Shared skills

This is onto-work's reviewed shared collection. All 14 skills are available to
its agents through their supervised Codex runtime. The complete retained source
archive and the managed agent/workflow library remain in
`agentic-operator/skills-library/` in the sibling repository.

| Location | Owner and purpose |
| --- | --- |
| `onto-work/shared/skills/<publisher-name>/` | Shared, reviewed instructions and complete resources. |
| `onto-work/shared/skill-sources.json` | Selected sources, immutable Git revisions, and reviewed source-lock hash. |
| `onto-work/shared/skill-catalog.json` | Runtime allow-list with every imported file's size and SHA-256. |
| `<saved-project>/.agents/skills/<name>/` | Skills specific to that project. Keep business examples and project context here. |
| `agentic-operator/skills-library/` | Full official archive and Agentic Operator's import catalog. |
| `agentic-operator/data/shared/skills/` | Agentic Operator's managed shared publications. |
| `agentic-operator/data/tenants/<slug>/skills/` | Agentic Operator's managed tenant skills, respecting configured data roots. |

Each shared bundle keeps its scripts, references, assets and licenses. The only
change to its instructions is the frontmatter name, prefixed with the publisher
to avoid collisions, with a modification notice in that file. Publisher notices are retained in `.source-notices/` inside
each bundle. Untouched originals remain in Agentic Operator's source archive.
Do not edit these imported files directly: runtime integrity validation rejects
modified or unlisted files. An import is not permission to execute a script,
install a service, access credentials, or publish an external artifact.

## Included capabilities

| Skills | Runtime requirements |
| --- | --- |
| Anthropic Frontend Design, Internal Comms | Instructions and bundled reference examples. |
| Anthropic MCP Builder | Documentation access plus the selected Python or TypeScript SDK for implementation. |
| Anthropic Webapp Testing | Python, Playwright, and browser binaries when running tests. |
| Anthropic Skill Creator | Evaluation reference; some optimization scripts require Claude CLI and independent agents. |
| OpenAI Skill Creator | Packaging guidance; Python and PyYAML for its helper scripts. |
| OpenAI PDF | PDF tooling such as Poppler, ReportLab, pdfplumber and pypdf when required. |
| OpenAI GitHub CI and review comments | Authenticated `gh` CLI and access to the relevant repository. |
| OpenAI Security Best Practices and Threat Model | Repository inspection and relevant language references. |
| OpenAI Docs | Official documentation access; optional documentation connector depends on the host. |
| OpenAI Build ChatGPT App and App Submission | Current plugin examples; SDKs and integrations are installed only for a relevant project task. |

Availability in the skill catalog does not prove every vendor-specific script
or connector works in the selected agent. The server imports instructions and
resources without installing dependencies or copying credentials.

## Refresh

Run these commands from onto-work using Python 3 and the repository's pnpm:

```sh
pnpm skills:check
pnpm skills:import --source ../agentic-operator/skills-library
pnpm skills:test
CODEX_BINARY=/path/to/pinned/codex pnpm skills:verify-runtime
```

The import verifies the exact reviewed Agentic Operator source lock and all
selected source files. It creates the local catalog once, then returns unchanged
for identical imports. It never executes a downloaded script. Offline checking
needs no sibling repository or network.
The native verifier creates temporary projects and isolated runtime homes, lists
skills through the real app-server, and checks project boundaries. It makes no
model calls and removes its scratch files when finished.

For new sources or revisions, first research and refresh the central Agentic
Operator archive with its `skills:discover`, `skills:sync`, `skills:check` and
`skills:import` commands. Verify vendor ownership, copying terms, changed
instructions and runtime dependencies. Then update this repository's selection
and reviewed source-lock hash, run `pnpm skills:import --update`, inspect the diff,
test, and merge a PR. The command refuses to overwrite locally modified bundles.
Restart supervised runtimes after a reviewed catalog update; their current
processes hold a fixed catalog configuration.

Shared authoring belongs in a reviewed catalog update. For a project-specific
skill, create `SKILL.md` and supporting files under that saved project's
`.agents/skills/<name>/` and test it in that project. Never put a project's
private content in a shared skill or a runtime-global extra root.

## Pro creator

Agentic Operator's maintained creator is separate from these vendor examples.
Its default route is `custom/openai/gpt-5.6-sol-pro`; failures and missing raw Pro
evidence fail explicitly. The authoring service preserves the selected route for
its bounded format repair and persists provider evidence with the generated
draft. A skill file cannot select or upgrade an onto-work task's model: model
selection remains a control-plane decision.

The verified Pro generation and quality limits are documented in
[the source review](../docs/research/2026-09-09-shared-skills.md). Model settings
for unrelated tasks are unchanged.
