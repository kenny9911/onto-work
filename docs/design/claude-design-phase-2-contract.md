# Claude Design Phase 2 implementation contract

Updated: 2026-09-02  
Design project: [Agent Harness Operations System](https://claude.ai/design/p/c75d6a94-c6ee-4a69-a118-a6473e988267?file=Agent+Harness.dc.html)  
System specification: [Agent Harness System Spec](https://claude.ai/design/p/c75d6a94-c6ee-4a69-a118-a6473e988267?file=Agent+Harness+System+Spec.dc.html)

## Product truth model

Every visible action or data surface must use one of three states:

- **LIVE** — a named Agent Harness API exists, validates authorization, and delegates to a pinned stable Codex app-server method.
- **READ-ONLY** — the UI projects runtime or control-plane data without implying mutation support.
- **FUTURE** — the control is disabled and explains the missing product-owned safety boundary.

The application must never synthesize spend, health, diffs, review findings, child agents, capabilities, or successful actions. Missing data has an explicit empty, unavailable, or partial state.

## Phase 2 information architecture

| Group | Destination | Route | Initial state |
| --- | --- | --- | --- |
| Work | Tasks | `/workspace`, `/tasks/:threadId` | LIVE |
| Work | Projects | `/projects` | LIVE registry; Git state READ-ONLY |
| Work | Reviews | `/reviews` | LIVE inline review start; evidence READ-ONLY |
| Operate | Agents | `/agents` | READ-ONLY hierarchy projection |
| Operate | Model routes | `/settings/providers` | LIVE |
| Operate | Environments | `/settings/environments` | READ-ONLY effective state |
| Operate | Capabilities | `/settings/capabilities` | READ-ONLY stable runtime inventory |
| Manage | Team | `/settings/team` | LIVE, admin |
| Manage | Usage | `/settings/usage` | READ-ONLY metered state |
| Manage | Billing | `/settings/billing` | LIVE where Stripe is configured |
| Manage | Audit | `/settings/audit` | READ-ONLY, admin |

## Stable task lifecycle contract

Browser components call named product APIs; they never receive an arbitrary Codex RPC proxy.

| Product API | Pinned Codex method | Safety rule |
| --- | --- | --- |
| `PATCH /api/tasks/:threadId/name` | `thread/name/set` | Bound thread; bounded name; idempotent; audited |
| `POST /api/tasks/:threadId/actions/fork` | `thread/fork` | Server-owned options; verify returned cwd; bind fork before exposure |
| `POST /api/tasks/:threadId/actions/archive` | `thread/archive` | Recheck workspace grant; explain descendant archival; audited |
| `POST /api/tasks/:threadId/actions/unarchive` | `thread/unarchive` | Existing trusted binding; audited |
| `POST /api/tasks/:threadId/turns/:turnId/actions/steer` | `turn/steer` | Exact active turn precondition; bounded text input |
| `POST /api/tasks/:threadId/turns/:turnId/actions/interrupt` | `turn/interrupt` | Exact active turn precondition; audited |

`thread/revert` is not presented as a file revert. Hard delete, compaction, detached review, and browser-driven worktree mutation remain FUTURE until their retention, recovery, quota, and ownership semantics are durable.

## Surface contracts

### Reviews

List only task states and evidence reported by Codex. Persisted `fileChange` items and command events are acceptable evidence. Review scores and findings remain absent until a real review item reports them. Opening the source task and starting a normalized, metered inline review are LIVE; the current card starts an uncommitted-changes review and returns to that task. Detached review threads and product-owned review worktrees remain FUTURE.

### Agents

Render a semantic nested list only from stable `parentThreadId`, `agentNickname`, `agentRole`, `source`, and collaboration item events. There is no public browser RPC for spawning, messaging, or merging agents. Opening a child task is LIVE, and a proven active child turn can be interrupted from its task cockpit; all other orchestration controls remain model-owned or FUTURE.

### Environments

Show the supervised local runtime, runtime-reported task workspaces, and fields the supervisor actually knows. The separate Projects view is the durable saved-project authority. Remote environment mutation and managed worktree creation remain FUTURE because the pinned app server exposes no complete stable lifecycle.

### Capabilities

Use stable `model/list`, `modelProvider/capabilities/read`, `permissionProfile/list`, `skills/list`, and `mcpServerStatus/list`. Inventory is per authenticated user and uses only server-owned canonical workspace grants. Paths, commands, environment variables, secrets, resource schemas, and detailed load errors are removed before returning data. One failed section must not hide successful sections.

## Responsive and accessibility rules

- Desktop keeps a 272 px navigation rail, flexible work pane, and 320 px inspector.
- Navigation becomes a labelled drawer below `lg`; the inspector becomes a focus-trapped drawer below `xl`.
- Every page has exactly one vertically scrolling content owner.
- Record tables stack into cards on narrow screens; diffs own horizontal scrolling.
- Status never relies on color alone. Disabled actions expose a reason.
- Route changes focus the page heading; overlays restore focus to their trigger.
- Streaming updates preserve Run Spine scroll position and composer text. Approval state changes are announced once; token deltas are not.

## React/Radix mapping

- `AppShell`: route state, responsive navigation, command palette, session boundary.
- `WorkspaceView`: Run Spine, task header actions, composer steer/follow-up semantics.
- `OperationsView`: Reviews, Agents, Environments, and Capabilities projections.
- `ControlPlaneView`: Projects, model routes, Team, Usage, Billing, and Audit.
- Radix Dialog: confirmations, rename, registration, and mobile drawers.
- Radix Dropdown Menu: secondary task actions.
- Radix Tabs: inspector modes with a bounded scroll owner.
- Command: global navigation and task lookup.

## Delivery order

1. Stable named task controls and exact-turn steering/interruption.
2. Saved projects and existing-workspace registration.
3. Stable read-only capability inventory.
4. Real review evidence and normalized review execution.
5. Parent/child event normalization and read-only agent supervision.
6. Product-owned managed worktrees and remote environments only after jobs, locks, retention, and recovery are specified.
