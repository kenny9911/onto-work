# Agent Harness — Claude Design Prompt

Design a high-fidelity, implementation-ready desktop web application called **Agent Harness**. It is a multi-user, provider-neutral agent coding/work harness built on the open-source Codex runtime.

The product should feel immediately familiar to a Codex user: calm, dense, keyboard-efficient, task/thread oriented, with an agent event stream, a strong composer, visible tool calls and approvals, file diffs/artifacts, and restrained developer-tool aesthetics. Do not copy OpenAI/Codex logos, trademarks, proprietary icons, exact marketing copy, or unlicensed assets. Create an original Agent Harness identity and token system. Familiarity should come from interaction quality and information hierarchy, not a pixel clone.

## What changes from a single-user Codex experience

- Multiple users and organizations with an always-clear active organization.
- Roles: platform admin, organization owner/admin, billing admin, member, and viewer.
- Configurable LLM gateways and direct providers: OpenRouter, NewAPI, OpenAI, Anthropic, Gemini, DeepSeek, Doubao, Qwen, GLM, and Ollama/local endpoints.
- Model allowlists, model/router selection, ordered fallbacks, provider health, and connection testing.
- Plans, subscriptions, seats, quotas, token/cost usage, invoices, and upgrade/block states.
- Separate personal, organization, billing, and platform administration surfaces.
- Future applications, skills, and templates are out of scope; leave no empty marketplace navigation.

## Design these primary views

1. **Main agent workspace — active run**
   - Left sidebar: Agent Harness mark, organization switcher, new task, project list, searchable/filterable task history, archive, plan/usage indicator, settings, and user menu.
   - Main pane: task title and context, current model/router, compact run state, typed streaming event timeline, assistant messages, tool calls, approval card, terminal activity, diff/artifact cards, recoverable error treatment, and persistent composer with run controls.
   - Right inspector: tabs for changed files/artifacts, run/tool timeline, environment, and tokens/cost. Make it collapsible.
   - Show an active streamed response, one approval request, one changed-file diff, and subtle provider fallback metadata without overwhelming the primary narrative.

2. **First-run provider setup**
   - Guided, resumable flow: choose gateway/direct/local provider; endpoint and credential entry; privacy explanation; test connection; model discovery/manual model ID; model allowlist; choose default and fallbacks; run smoke test.
   - Credentials are write-only after save. Show a fingerprint, last validation time, connection health, and rotation action—never reveal the secret.
   - Explain that server-hosted `localhost` is not the user's computer and provide a safe local-provider deployment hint.

3. **Organization members and access**
   - Member table, invitation flow, roles, status, last active, pending invites, owner-transfer protection, and an audit side panel.
   - Make role scope understandable without a giant wall of permissions.

4. **Usage and billing**
   - Current plan and subscription state, seats, renewal, quota/credit progress, usage by model/provider/user/project, cost estimates versus actuals, alerts, invoices, plan comparison, and upgrade/downgrade states.
   - Include a quota-blocked state with a clear reason and role-aware next action; members should not see billing controls they cannot use.

5. **Platform administration**
   - Visually distinct platform scope with global health, organizations, users, plan catalog, provider types, background jobs, version/upstream status, feature flags, and system audit.
   - Platform administrators do not see provider secrets or tenant task content by default. Represent audited break-glass access as exceptional and time-limited.

6. **Responsive/narrow task view**
   - Preserve composer and run state. Collapse the sidebar and inspector into labeled drawers without hiding approval requests or quota errors.

## Required states and components

Include coherent designs for:

- empty/new organization, setup incomplete, loading, streaming, reconnecting, paused, awaiting approval, success, partial success, canceled, provider outage, rate limit, quota exhausted, permission denied, offline, and destructive confirmation;
- organization switcher, project/task navigation, command palette, model/router picker, status badge, provider card, health indicator, secret input, fallback-order editor, usage meter, role badge, audit event, approval card, tool-call block, terminal block, diff viewer, artifact card, composer, and plan card;
- skeletons that match final geometry and persistent inline error/recovery states instead of toast-only failures.

## Visual direction

- Desktop-first professional developer tool: precise, quiet, fast, and trustworthy.
- Neutral low-chroma base with one original accent hue and restrained semantic colors.
- Light and dark themes designed intentionally, not simple inversions.
- Compact density with generous separation between semantic groups; avoid oversized cards and generic dashboard grids.
- Crisp typography suitable for long reading plus a true monospace face for code, commands, IDs, and usage figures.
- Thin borders, controlled elevation, subtle radii, and limited motion. Avoid glassmorphism, decorative gradients, and gratuitous animation.
- Make streaming feel alive through small state cues, not constant layout movement.
- Use original icons/assets with consistent optical weight.

## Accessibility and interaction requirements

- Meet WCAG 2.2 AA contrast and target sizes for core flows.
- Complete keyboard navigation, visible focus, logical focus order, skip links, semantic landmarks, and a command palette.
- Never use color alone for provider health, role, billing, run, approval, or error status.
- Respect reduced motion.
- Announce meaningful run-state transitions and approval requests, not every streamed token.
- Preserve focus after streaming updates, drawer changes, errors, and reconnects.
- Include exact hover, focus, active, selected, disabled, loading, validation, and destructive states for interactive components.

## Deliverables

Produce:

1. a concise rationale and information architecture;
2. high-fidelity desktop frames for views 1–5 and a narrow frame for view 6;
3. light and dark variants of the main workspace;
4. a token sheet covering color roles, typography, spacing, radii, borders, elevation, motion, breakpoints, and code/diff syntax roles;
5. a component inventory with variants and state behavior;
6. keyboard and focus annotations for the main task and provider-setup flows;
7. responsive rules for sidebar, inspector, tables, diffs, composer, and admin navigation;
8. empty/loading/error/blocked examples, including permission and quota states;
9. implementation notes with dimensions, grid, density, truncation/wrapping, overflow, and content priorities; and
10. an originality/compliance note listing which Codex interaction patterns were retained and which brand/visual elements were deliberately made distinct.

Use realistic but fictional organization, project, task, provider, model, usage, and invoice data. Do not put real API keys or the bootstrap administrator password in any frame, layer name, annotation, or export.

