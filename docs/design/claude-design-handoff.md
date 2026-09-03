# Claude Design handoff: Agent Harness Operations System

## Source brief

The production design request is captured in
[`docs/prompts/04-claude-design-full-product-brief.md`](../prompts/04-claude-design-full-product-brief.md).
It asks for a multi-user agent operations product built on the Codex harness, not
a generic dashboard or a visual copy of Codex.

## Design outputs

- [Navigable Agent Harness prototype](https://claude.ai/design/p/c75d6a94-c6ee-4a69-a118-a6473e988267?file=Agent+Harness.dc.html)
- [Agent Harness system specification](https://claude.ai/design/p/c75d6a94-c6ee-4a69-a118-a6473e988267?file=Agent+Harness+System+Spec.dc.html)

The prototype contains 16 destinations, including the active and completed task
cockpits, projects/worktrees, reviews, orchestration, model routes, environments,
capabilities, team access, usage, billing, audit, platform administration,
onboarding, and narrow layouts. The system specification contains the rationale,
information architecture, Run Spine anatomy, token architecture, component/state
inventory, keyboard and focus behavior, responsive and streaming rules, a
React/Radix implementation mapping, and a six-phase build sequence.

## Binding visual direction

The generated system deliberately uses a cool graphite instrument-panel palette:

- lime means an agent is acting or a healthy execution path is available;
- violet means a human decision, administrative authority, or privileged scope;
- amber means waiting, degraded health, budget pressure, or risk;
- red is reserved for destructive or failed states;
- Geist is the interface typeface and JetBrains Mono is used for operational data.

This supersedes the brief's proposed Oxide/Tide accent pairing. The change is
accepted because the new semantics are more legible in the dense operations
cockpit and give Agent Harness a distinct identity. Product behavior, accessibility,
and the Codex/Agent Harness responsibility boundary remain unchanged.

## Interaction smoke test

The generated prototype was exercised in Claude Design after generation:

- the active task cockpit rendered without the earlier transient `DIFF` runtime
  error;
- Projects switched to the projects/worktrees inventory;
- Model routes switched to provider connections, model allowlists, fallback policy,
  route analytics, and the test console;
- Usage switched to tenant budget, route/model breakdown, immutable ledger, and
  forecast states;
- Organizations switched to the visually distinct platform scope with break-glass,
  tenant inventory, runtime/jobs, and feature flags.

The prototype is a design artifact and uses fictional operational data. It is not
evidence that the corresponding backend capability is implemented.

## Implementation rules

1. Preserve the Run Spine as the primary task narrative. Inspector views supplement
   it; they do not replace it.
2. Keep blocking human decisions expanded and visible.
3. Keep route, model, policy, budget, and approval provenance near the event they
   affected.
4. Never use color as the only status signal.
5. Keep task content and provider secrets hidden from platform scope by default.
6. Implement a destination only when its underlying state is truthful; otherwise
   render a clearly labeled unavailable, incomplete, or unknown state.
7. Retain stable URL-addressable views, keyboard operation, bounded scrolling, and
   a drawer treatment at narrow widths.

## Delivery mapping

The first code foundation implements URL-addressable task/control-plane views, a
semantic Run Spine, command navigation, responsive task inspection, versioned
database migrations, tenant workspace and thread bindings, entitlement snapshots,
transactional usage reservations, exact-turn token correlation, stable-by-default
Codex protocol handling, server-owned model admission, authorized selected-task
history, and selected-thread live-event isolation. Projects now truthfully shows
authorized runtime roots, Usage shows current-period request/run/seat/token
aggregates, and Audit shows recent scalar-safe tenant events to administrators.
These are bounded read surfaces: they are not project/worktree management, a cost
ledger, a tamper-evident audit system, or SSE replay. Durable interactions, complete
task lifecycle, and most prototype destinations remain staged according to
[`docs/architecture/full-product-blueprint.md`](../architecture/full-product-blueprint.md)
and
[`docs/architecture/codex-full-capability-roadmap.md`](../architecture/codex-full-capability-roadmap.md).
