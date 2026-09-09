# Skill curation and availability update — 9 September 2026

The active Agentic Operator shared collection now contains 17 enabled skills. The 36 excluded imports have been disabled and archived through the running API, and their downloaded source bundles have been removed from the source catalog. Project-authored business and ontology skills are preserved. The maintained creator and the upstream creator references remain available as agentic tools.

Each managed skill now has an enable/disable switch. Availability is enforced during discovery, activation, subsequent resource and script access, captured-run access, evaluation, and managed creator calls. A disable operation cannot recall a model request already in flight. Immutable publications remain historical records.

Retention reflects business, ontology or agentic-tool scope. Performance effects on Fable 5.1 and GPT-6-Astra remain unmeasured: this work made no benchmark model calls. The [original evaluation report](REPORT.md) and [evaluation manifest](evaluation-manifest.json) retain their historical 53-skill baseline and 106 planned cases. Their pre-repair risk findings must not be read as new post-repair measurements.

**Implementation and verification**

- [Agentic Operator PR #10](https://github.com/kenny9911/agentic-operator/pull/10) merged at `68c3f62f479456f50b926970941b82ffdf034e7e`; all required CI passed, including unit coverage, browser tests, typecheck, lint, build, Codex harness and Docker smoke.
- [Onto-work PR #2](https://github.com/kenny9911/onto-work/pull/2) merged at `091bfa3fc2611b0774e734e563762a30fd1f17e9`; its shared subset contains four skills. Native discovery and project isolation were verified without model calls.
- The live Agentic Operator checkout preserves existing local run-input fixes in integration commit `20b4510c664706b317d734a7c039a9af1fa380bc`; 60 additional focused tests and four workspace typechecks passed.
- Live retirement: 36 retired, zero conflicts. Repeat: 36 already retired, zero writes required. All nine tenants returned exactly the 17 retained shared skills, all enabled. All 53 filesystem availability projections matched the API.
- The original onto-work checkout and running server were preserved because of unrelated in-progress edits. The four shared bundles and merged discovery implementation are in `/Users/kenny/CSI-AICOE/onto-work-skills/shared`; they are not yet deployed to that older running onto-work server.
- Runtime evidence is saved at `/Users/kenny/CSI-AICOE/agentic-operator/data/reports/skill-curation-2026-09-09.json`.

**Retained skills**

| Skill | Scope | Rationale |
|---|---|---|
| anthropic/discernment-nudge | agentic-tool | Clarify intended AI assistance and evaluation criteria for business work. |
| anthropic/internal-comms | business | Draft internal business communications from supplied organizational context. |
| anthropic/skill-creator | agentic-tool | Author and evaluate reusable agent skills; retained as an authoring reference, not general coding guidance. |
| openai/curated/define-goal | agentic-tool | Manage sustained agent objectives on a compatible goal-capable runtime. |
| openai/curated/linear | business | Manage business work items and projects through a configured Linear integration. |
| openai/curated/notion-knowledge-capture | business | Capture decisions and reusable business knowledge in Notion. |
| openai/curated/notion-meeting-intelligence | business | Prepare business meeting context and follow-up material from available sources. |
| openai/curated/notion-research-documentation | business | Research and document business knowledge from Notion sources. |
| openai/curated/pdf | business-artifact | Read, create and inspect PDF business artifacts with compatible tools. |
| openai/curated/playwright | agentic-tool | Automate business browser tasks through the Playwright CLI; UI development/testing-specific interactive guidance is excluded. |
| openai/curated/screenshot | agentic-tool | Capture desktop evidence on a compatible, authorized host. |
| openai/curated/speech | business-artifact | Generate narration, accessibility reads and spoken business material. |
| openai/curated/transcribe | business-artifact | Transcribe meetings and other business recordings with optional speaker labels. |
| openai/system/imagegen | business-artifact | Generate or edit raster assets for business deliverables using a supported image tool. |
| openai/system/skill-creator | agentic-tool | Package reusable skills; retained as an authoring reference alongside the maintained creator. |
| openai/system/skill-installer | agentic-tool | Obtain reviewed reusable skills through the governed import workflow; it does not authorize global installs. |
| agentic/skill-creator | agentic-tool | Maintain portable skill drafts, output contracts and proposed evaluations for agents and workflows. |

**Removed imports**

| Skill | Rationale |
|---|---|
| anthropic/academy-guide | Provider product education is outside business, ontology and agentic-tool execution scope. |
| anthropic/algorithmic-art | Creative coding and algorithmic artwork are outside the selected business/runtime scope. |
| anthropic/brand-guidelines | Applies the vendor brand identity rather than an authored business brand policy. |
| anthropic/canvas-design | Standalone graphic-design methodology is outside the selected runtime tool collection. |
| anthropic/claude-api | Application/API implementation guidance is development-time. |
| anthropic/frontend-design | Frontend UI implementation and aesthetic direction are development-time. |
| anthropic/mcp-builder | Building MCP servers and integrations is development-time. |
| anthropic/slack-gif-creator | Decorative GIF production is outside the selected business/runtime collection. |
| anthropic/theme-factory | General visual theme styling is outside the selected business/runtime collection. |
| anthropic/web-artifacts-builder | Building frontend web artifacts is development-time. |
| anthropic/webapp-testing | Application UI testing is development-time. |
| openai-plugins/openai-developers/build-chatgpt-app | Building ChatGPT SDK applications is development-time. |
| openai-plugins/openai-developers/chatgpt-app-submission | Publishing developer applications is development-time. |
| openai/curated/aspnet-core | ASP.NET application/framework implementation is development-time. |
| openai/curated/chatgpt-apps | ChatGPT application SDK development is development-time. |
| openai/curated/cli-creator | Command-line application implementation is development-time. |
| openai/curated/cloudflare-deploy | Cloudflare deployment and infrastructure operations are DevOps. |
| openai/curated/gh-address-comments | GitHub pull-request review workflow is development-time. |
| openai/curated/gh-fix-ci | GitHub CI repair is development-time DevOps. |
| openai/curated/hatch-pet | Codex decorative pet customization is outside business/runtime tasks. |
| openai/curated/jupyter-notebook | Notebook scaffolding and development environment setup are outside the selected runtime collection. |
| openai/curated/migrate-to-codex | Developer tool and agent-harness migration is development-time. |
| openai/curated/netlify-deploy | Netlify deployment and hosting operations are DevOps. |
| openai/curated/notion-spec-to-implementation | Software specification-to-implementation planning is development-time. |
| openai/curated/openai-docs | Provider API and Codex development/configuration guidance is development-time. |
| openai/curated/playwright-interactive | Persistent interactive UI debugging and app verification are development-time; Playwright CLI is retained for business browser automation. |
| openai/curated/render-deploy | Render deployment and infrastructure provisioning are DevOps. |
| openai/curated/security-best-practices | Secure coding and repository security implementation review are development-time. |
| openai/curated/security-ownership-map | Git-history security ownership analysis is development-time. |
| openai/curated/security-threat-model | Source-repository threat modeling is development-time. |
| openai/curated/sentry | Production software error monitoring and diagnostics are DevOps. |
| openai/curated/vercel-deploy | Vercel deployment and hosting operations are DevOps. |
| openai/curated/winui-app | Windows application setup, implementation and testing are development-time. |
| openai/curated/yeet | Git staging, commits, pushes and pull requests are development-time. |
| openai/system/openai-docs | Provider API and Codex development/configuration guidance is development-time. |
| openai/system/plugin-creator | Codex plugin scaffolding and marketplace metadata creation are development-time. |
