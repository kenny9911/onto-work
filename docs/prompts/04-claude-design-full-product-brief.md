# Agent Harness — Claude Design Full Product Brief

**Design target:** production-grade, multi-user agent operating system  
**Product:** Agent Harness  
**Foundation:** the open-source OpenAI Codex harness and `codex app-server`  
**Implementation stack:** React 19, Vite, TypeScript, Tailwind CSS 4, Radix/shadcn-style primitives, Lucide icons, Geist Sans, and Geist Mono  
**Primary canvas:** responsive desktop web application, with a usable narrow/mobile task surface

## Mission

Design a complete, implementation-ready Agent Harness application that moves well beyond a chat MVP. It should feel like a focused operating environment for starting, supervising, steering, reviewing, and governing many agent tasks across projects, users, models, and organizations.

The audience is a technical team that operates coding, research, data, security, and operations agents. Their main job is not merely to exchange messages with an LLM. Their job is to understand what agents are doing, intervene at the right moments, compare outcomes, review changes, manage risk and cost, and reliably continue work over time.

Agent Harness is built on the open-source Codex agent runtime. Preserve the excellent interaction ideas that naturally follow from Codex's thread/turn model, streaming event protocol, approvals, sandboxing, terminal execution, diffs, and review workflow. Do not copy OpenAI or Codex branding, logos, exact visual assets, trademarked product identity, or marketing language. This must be an original product with its own visual system.

## Product thesis

This is an **agent operations cockpit**, not a generic SaaS dashboard and not a chat page with settings bolted on.

The central object is a durable task thread. A thread contains turns; turns contain typed events such as user instructions, agent messages, reasoning summaries, command execution, file changes, tool calls, approvals, permission requests, user questions, errors, and usage. A user should be able to create, resume, steer, interrupt, fork, archive, restore, compact, and review work without losing context.

The full product combines five layers:

1. **Work:** projects, repositories, workspaces, worktrees, threads, turns, files, diffs, artifacts, and reviews.
2. **Execution:** models, provider routes, sandboxes, network/filesystem permissions, terminals, tools, MCP servers, and installed skills.
3. **Orchestration:** goals, budgets, child agents, parallel work, dependency state, retries, notifications, and human handoffs.
4. **Control:** organizations, memberships, roles, policies, approvals, audit events, retention, and security posture.
5. **Economics:** subscriptions, seats, entitlements, quotas, usage, latency, token and cost accounting, forecasts, and invoices.

## Information architecture

Create a coherent application shell with these primary destinations. Avoid a long undifferentiated icon rail. Group navigation by user intent and make the active organization and project obvious.

### Work

- Tasks
- Projects
- Reviews
- Artifacts

### Operate

- Agents
- Model routes
- Environments
- Capabilities

### Manage

- Team and access
- Usage
- Billing
- Audit log

### Platform administration

- Organizations
- Users
- Plans and entitlements
- Provider catalog
- Runtime fleet and jobs
- Feature flags
- System audit and upstream version

Applications, public skill/template marketplaces, and third-party catalog authoring are planned for a later release. For this design, **Capabilities** may show installed and organization-approved MCP servers, tools, and skills, but do not invent a public marketplace or empty template gallery.

## Signature interaction: the Run Spine

Make the product memorable through one original structural device: a **Run Spine** running vertically through the task transcript.

The Run Spine is not decoration. It is a compact, semantic execution map that:

- connects turns and their nested items;
- distinguishes agent narrative from commands, tools, file changes, approvals, and errors;
- shows parallel child-agent branches without turning the transcript into a graph editor;
- communicates streaming, waiting, blocked, completed, and failed states through shape, icon, label, and restrained motion;
- lets users collapse completed tool clusters while preserving a readable summary;
- provides anchors used by the inspector minimap and deep links;
- becomes a simple progress rail on narrow screens.

The surrounding interface should stay quiet so this one signature element carries the product identity.

## Core layout

Design a resizable three-pane desktop workspace:

```text
┌──────────────────────┬──────────────────────────────────────┬────────────────────────┐
│ Organization/project │ Task header + run state              │ Inspector tabs         │
│ navigation           ├──────────────────────────────────────┤ Files / Diff / Context │
│                      │                                      │ Agents / Usage / Events│
│ New task             │ Run Spine + transcript               │                        │
│ Search / filters     │                                      │                        │
│ Pinned / active      │                                      │                        │
│ Recent / archived    ├──────────────────────────────────────┤                        │
│                      │ Persistent composer + run controls    │                        │
├──────────────────────┴──────────────────────────────────────┴────────────────────────┤
│ Optional bottom dock: terminal sessions / diagnostics / background processes          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Pane behavior:

- Left navigation defaults to 272 px, can collapse to a compact rail, and supports search/filter without shifting the transcript.
- Main pane has a readable content width but tool, terminal, table, and diff items may expand to the available width.
- Inspector defaults to roughly 320 px and can be collapsed, resized, or opened as a drawer on narrower layouts.
- Bottom dock is hidden until needed and must not cover the composer or pending approvals.
- Every vertical region must have an explicit bounded scroll owner. Avoid document-level clipping and nested scroll traps.

## Required product views

### 1. Task cockpit — active multi-step run

Show a realistic running task in a Git project. Include:

- task title, editable thread name, project, branch/worktree, model route, goal, budget, status, elapsed time, and overflow actions;
- a Run Spine with a user turn, an agent progress update, a grouped command sequence, a tool call, a file-change item, a pending permission or approval request, a child-agent branch, and a streaming assistant response;
- persistent composer with attachments, slash/skill invocation, model/router picker, execution mode, send/steer action, interrupt action, and keyboard hints;
- inspector tabs for changed files/diff, context, child agents, usage, and raw event timeline;
- optional bottom terminal dock with multiple sessions and a background-process indicator;
- reconnecting and partial-stream recovery that does not erase completed events or move keyboard focus;
- clear distinction between "the request was accepted", "the run is active", "the agent is waiting", and "the run is complete".

### 2. Task cockpit — completed and review-ready

Show the same task after completion:

- concise result summary and verification evidence;
- changed-file list and high-quality unified/split diff viewer;
- review action that starts a Codex review pass and renders findings by severity and file;
- actions to open artifacts, create a follow-up turn, fork from a selected turn, retry safely, compact history, archive, and share/export according to policy;
- token/cost/latency totals with the route actually used, including any safe fallback metadata;
- a small "what changed" summary that is derived from real task events rather than generic celebration copy.

### 3. Task creation and project/worktree selection

Design a fast, keyboard-first new-task flow rather than a wizard:

- recent and searchable projects;
- saved project, local checkout, or isolated worktree choice;
- branch/ref selection and visible dirty-working-tree warning;
- model route or policy, reasoning effort, collaboration mode, sandbox/permission profile, network policy, and budget;
- goal objective and optional token budget;
- installed capability summary (MCP servers, tools, skills) with organization policy indicators;
- validation and explainers for options that conflict or are unavailable under the current plan/policy;
- reusable last-used defaults without silently escalating permissions.

### 4. Projects and worktrees

Create a dense project browser with:

- repository health, current branch, dirty state, remote/upstream, workspace roots, active worktrees, running tasks, and recent files;
- task activity grouped by project;
- worktree creation/handoff/cleanup state;
- project-level instructions and effective configuration sources;
- safe empty, detached, unavailable, permission-denied, and repository-moved states.

### 5. Agent orchestration

Design a supervision view for one root task with parallel child agents:

- hierarchical task tree with status, owner, model, budget, elapsed time, current step, and attention state;
- compact dependency relationships and a chronological activity feed;
- actions to open, message/steer, interrupt, fork, retry, compare results, and merge a chosen result into the parent workflow;
- human-attention queue that prioritizes approval, permission, user-input, conflict, quota, and failure requests;
- no decorative node graph. Optimize for scanning and acting under load.

### 6. Model routes and gateway operations

Design a production model-routing console with separate concepts for provider connections, model records, and routing policies.

Include:

- provider connections for OpenAI, OpenRouter, NewAPI, Anthropic, Google Gemini, DeepSeek, Doubao, Qwen, GLM, and Ollama/local OpenAI-compatible endpoints;
- direct, gateway, and local connection types;
- write-only credential entry with fingerprint, rotation, owner, last test, last successful request, health, and safe error summary;
- connection test and model discovery/manual registration;
- model capability fields: context/output limits, modalities, tools, structured output, reasoning, streaming, pricing/effective date, and availability;
- organization allowlists and visibility by role/project;
- a drag/reorder fallback policy editor with required-capability filters, retry boundaries, timeout, health/circuit state, and cost ceiling;
- clear protection against unsafe fallback after non-idempotent side effects;
- route analytics for request volume, success, p50/p95 latency, token volume, spend, error class, and fallback rate;
- a test console that never displays or returns raw credentials.

### 7. Environments and permission profiles

Show runtime policies as understandable presets plus inspectable detail:

- local runtime and future isolated/container runtime targets;
- workspace roots, filesystem grants, network hosts/protocols, sandbox mode, command policy, approval policy, environment variables, secret redaction, and session-scoped grants;
- active terminal/background process inventory with explicit termination controls;
- effective policy view showing platform, organization, project, and per-task sources;
- requests for command, file, network, additional permissions, and user input as distinct UI patterns.

### 8. Capabilities registry

Show installed capabilities without building a marketplace:

- installed MCP servers, tools, and skills;
- source, version, trust/approval status, organization availability, required/optional state, health, and last use;
- capability detail drawer with permissions, tool names, configuration source, audit history, and disable action;
- clear organization-policy blocks and runtime initialization errors;
- future marketplace entry point may be mentioned only as roadmap copy, not active navigation.

### 9. Team, organizations, and access

Design:

- organization switcher and organization settings;
- member table, invitations, owner transfer, compatible multi-role presentation, project access, status, last active, sessions, and revocation;
- roles for platform admin, organization owner, organization admin, billing admin, member/operator, and viewer/auditor;
- concise permission summaries with drill-down, not a wall of checkboxes;
- prominent scope labels so platform actions can never be confused with organization actions;
- recent-authentication and target-specific confirmation for sensitive changes.

### 10. Usage, budgets, and billing

Create an operator-friendly economics view:

- current plan, subscription state, seats, renewal/cancellation, quota dimensions, credit balance, and concurrency;
- usage by organization, project, user, route, provider, model, and task;
- input/output/cached/reasoning tokens, estimated versus actual cost, p50/p95 latency, and success rate;
- per-run and organization budgets, threshold alerts, forecast, soft warning, hard block, grace, past-due, and suspended states;
- immutable usage ledger drill-down and correction entries;
- invoices/receipt metadata, hosted billing portal, and role-aware controls;
- a quota-blocked task state that tells a member what happened and tells an authorized billing admin what action is available.

### 11. Audit and observability

Design a searchable event explorer spanning:

- authentication, membership, route/configuration, credential rotation, policy, approval, task, billing, export, and privileged support events;
- actor, scope, action, target, outcome, correlation ID, timestamp, reason, and redacted metadata;
- saved filters and export according to authorization;
- operational health for runtime processes, event-stream connections, queues/jobs, providers, database, billing webhooks, and upstream Codex version;
- a clear boundary between tenant audit data and platform operational telemetry.

### 12. Platform administration

Make platform scope visually unmistakable. Include:

- organizations, users, plan catalog, entitlements, provider types, system feature flags, runtime fleet/jobs, version/upstream status, and system audit;
- tenant content and provider secrets hidden by default;
- an exceptional, reasoned, time-limited break-glass access flow with a persistent banner, countdown, revocation, and immutable audit record;
- deployment/runtime health without pretending a single-host local process manager is a production fleet.

### 13. Authentication and first-run onboarding

Design:

- sign in, mandatory bootstrap-password replacement, signed-out/session-expired, password reset placeholder, and locked/suspended states;
- organization setup, first provider route, connection test, allowed model, default/fallback choice, project selection, and a real smoke-test task;
- resumable progress and a setup checklist that disappears after completion;
- security copy stating that secrets remain server-side and saved credentials cannot be revealed;
- an explanation that `localhost` on a hosted server is not the user's computer.

### 14. Command palette and responsive task view

Create a keyboard-first command palette that can:

- navigate to tasks/projects/settings;
- search and open threads;
- create a task;
- switch project/organization;
- run safe task actions such as rename, fork, archive, interrupt, or open review;
- show disabled reasons for role, policy, state, or plan restrictions.

At tablet and phone widths, preserve the transcript, composer, run state, and human-attention requests. Move navigation, inspector, and terminal into labeled drawers/sheets. Never hide an approval or quota error behind an unlabeled icon.

## Component and state inventory

Specify and demonstrate these components with default, hover, active, selected, focus-visible, disabled, loading, error, warning, and destructive states where applicable:

- organization and project switchers;
- task row, task group, status badge, attention marker, and archive/pin controls;
- task header, goal/budget meter, model route chip, collaboration indicator, and elapsed timer;
- composer, attachment item, model/policy picker, mode picker, send/steer/interrupt controls;
- Run Spine node, grouped event cluster, child-agent branch, and transcript anchor;
- agent message, reasoning summary, command block, terminal block, tool-call block, MCP call, approval card, permission card, user-input card, file-change card, diff viewer, artifact card, review finding, error recovery card, and usage summary;
- provider connection card, model row, health indicator, secret input, credential fingerprint, connection test, fallback editor, circuit state, and route analytics;
- role badge, permission summary, invitation row, audit event, session row, and confirmation dialog;
- plan card, entitlement gate, quota meter, budget editor, usage chart/table, ledger row, invoice row, and billing status;
- skeletons matching final geometry, inline validation, reconnect banners, empty states, and durable recovery messages.

## State model to visualize

Include examples for:

- task: draft, queued, starting, running, steering, waiting for approval, waiting for permission, waiting for user input, paused, reconnecting, interrupted, completed, partial success, failed, canceled, archived;
- route: unconfigured, testing, healthy, degraded, rate-limited, circuit open, unauthorized, incompatible, disabled;
- environment: preparing, ready, disconnected, policy blocked, over capacity, cleaning up;
- subscription: trialing, active, grace, past due, quota warning, quota exhausted, suspended, canceled;
- membership: invited, active, suspended, removed, owner transfer pending;
- data: loading, empty, stale, offline, partially available, permission denied, destructive confirmation.

Errors must explain the failure, what was preserved, whether retry is safe, and the next action. Do not rely on toast-only feedback.

## Visual system

The product should feel like a precise technical instrument: calm, dense, and trustworthy, with enough warmth to avoid a cold security-console aesthetic.

Use this direction as the starting point, then refine it into a complete three-layer token system (primitive → semantic → component):

- **Graphite 950 — `#0D1014`:** dark workspace background.
- **Iron 900 — `#15191F`:** panels and navigation.
- **Steel 700 — `#303741`:** borders, controls, and inactive structure.
- **Mist 100 — `#EEF1F4`:** primary dark-theme text and light-theme canvas family.
- **Oxide 500 — `#D17A45`:** original product accent for active execution and primary action; use sparingly.
- **Tide 500 — `#4FA6A0`:** healthy/verified state; not interchangeable with the primary accent.
- Semantic amber, red, blue, and violet roles must remain distinguishable in both themes and never carry meaning without text/icon/shape.

Typography:

- Geist Sans for interface and long-form agent output.
- Geist Mono for code, commands, identifiers, timestamps, model names, tokens, cost, and compact utility labels.
- Use a restrained scale optimized for long work sessions. Do not create oversized dashboard headings or marketing-style hero sections inside the product.

Shape and depth:

- thin, low-contrast borders;
- small-to-medium radii, with tighter radii for code and dense controls;
- near-flat layers with elevation reserved for popovers, drawers, and urgent human-attention requests;
- no glassmorphism, decorative gradients, neon bloom, fake 3D chrome, or excessive card grids;
- motion only for meaningful transitions: streaming, running, panel opening, item completion, and attention arrival;
- reduced-motion mode must preserve all state information.

Create intentionally designed light and dark themes rather than simple inversions. Code, terminal, and diff surfaces may retain specialized syntax backgrounds while meeting contrast requirements.

## Accessibility and interaction requirements

- Meet WCAG 2.2 AA contrast and keyboard requirements.
- Use semantic landmarks, skip links, visible focus, logical focus order, and stable focus through streaming updates.
- Support keyboard navigation across the sidebar, Run Spine anchors, composer, inspector tabs, approvals, diffs, and command palette.
- Announce meaningful state changes and incoming approval/user-input requests through an appropriate live region; do not announce every streamed token.
- Preserve user scroll position when older events load or streaming content grows unless the user is already pinned to the latest output.
- Provide minimum usable targets on touch layouts without making desktop rows oversized.
- Do not use color alone for task, health, role, approval, billing, diff, or error state.
- Long model output, file paths, commands, tables, and diffs must wrap or scroll in their own deliberate region without breaking the app shell.

## Realistic fixture content

Use fictional data such as:

- Organization: **Northstar Research**
- Project: **market-pulse** on branch `codex/provider-health`
- Root task: **Add resilient provider failover and usage telemetry**
- Child agents: **Protocol audit**, **Migration plan**, and **UI verification**
- Routes: **OpenRouter Primary**, **OpenAI Direct**, **DeepSeek Gateway**, and **Local Ollama**
- Models: plausible fictional aliases rather than claims about current availability or pricing

Never include a real API key, route token, session cookie, secret fingerprint copied from a real system, or bootstrap administrator password in any frame, annotation, fixture, layer name, or export.

## Implementation constraints

- Produce designs that can be implemented in the existing React/Vite/Tailwind/Radix codebase. Do not redesign this as a Next.js site or mobile-native application.
- Prefer reusable component anatomy and semantic tokens over one-off frame styling.
- Distinguish stable Codex app-server capabilities from experimental ones. Experimental controls should be feature-gated and visibly described in implementation notes.
- The browser talks only to the Agent Harness control plane. It must not receive provider secrets or arbitrary access to the Codex JSON-RPC surface.
- Organization scope, role, entitlement, and effective runtime policy must be visible where they affect an action.
- Do not imply that UI-hidden actions are secure; implementation notes must call for server-side authorization and entitlement enforcement.
- Keep the original Agent Harness wordmark/mark abstract and non-derivative.

## Deliverables

Create a cohesive, navigable design system and prototype, not disconnected concept frames. Deliver:

1. product rationale and information architecture;
2. the Run Spine concept and interaction specification;
3. high-fidelity desktop frames for views 1–13;
4. a narrow/tablet frame for the active task and one administration table;
5. light and dark variants of the task cockpit;
6. a three-layer design-token sheet covering color, typography, spacing, size, radius, borders, elevation, motion, z-index, breakpoints, syntax, terminal, and diff roles;
7. component inventory with anatomy, variants, and state tables;
8. keyboard/focus annotations for task creation, active execution, approvals, diff review, route setup, and command palette;
9. responsive rules for navigation, transcript, inspector, terminal dock, data tables, diffs, charts, and composer;
10. empty/loading/offline/error/blocked/destructive examples;
11. content hierarchy, truncation/wrapping, overflow, virtualization, and streaming behavior notes;
12. implementation mapping to React components and existing Tailwind/Radix primitives;
13. an originality/compliance note listing retained agent-workflow patterns and deliberately distinct brand/visual decisions; and
14. a prioritized build sequence: foundation, task cockpit, project/runtime operations, router, organization/billing, and platform administration.

Before finalizing, critique the design against three failure modes and revise it:

- **Generic dashboard:** too many interchangeable cards, charts, and navigation sections with no agent-specific hierarchy.
- **Chat veneer:** a transcript/composer that hides execution, approvals, artifacts, branching, and operational state.
- **Visual clone:** superficial imitation of Codex/OpenAI branding rather than an original system built around shared runtime concepts.

The final result should make a Codex user immediately understand the workflow while clearly recognizing Agent Harness as a separate, more operational, multi-user product.
