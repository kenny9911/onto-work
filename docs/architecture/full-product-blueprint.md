# Agent Harness Full-Product Blueprint

**Status:** living implementation blueprint  
**Scope:** the path from the current production-foundation preview to a production-grade, multi-user agent operations platform  
**Upstream:** OpenAI Codex pinned as a reviewed Git submodule

## Product boundary

Agent Harness is the application and control plane. Codex is the agent runtime.

Agent Harness owns:

- identities, organizations, memberships, roles, active organization, and sessions;
- subscriptions, entitlements, quota reservations, usage/cost reconciliation, and billing;
- projects, workspace grants, worktrees, environment placement, and runtime admission;
- provider connections, model records, route policies, gateway identities, and health;
- product URLs, navigation, task supervision, human-attention queues, audits, and notifications;
- durable normalized events and pending interactions used by browsers and operators;
- authorization for every browser/API/background-job action;
- deployment, secret management, jobs, observability, backup, restore, and incident response.

Codex owns:

- the thread/turn/item agent loop;
- model context, compaction, reasoning, and tool orchestration;
- command and file-change execution inside its configured sandbox;
- app-server protocol events and server-initiated interaction requests;
- Codex-native goals, reviews, local skills/apps/MCP integration, and collaboration items;
- enforcement of the sandbox and approval policy passed to the runtime.

The browser never receives provider secrets and never receives a generic JSON-RPC tunnel. It calls typed Agent Harness APIs. The server maps those domain actions to an allow-listed, version-matched Codex app-server protocol.

## Target architecture

```text
Browser / desktop shell
        │ HTTPS + typed REST/SSE/WebSocket domain contracts
        ▼
Agent Harness API
  ├── authentication + organization context
  ├── authorization + recent-auth checks
  ├── entitlement and quota admission
  ├── project/workspace/worktree service
  ├── provider/model/router control plane
  ├── task/thread domain adapter
  ├── approval/permission/user-input service
  ├── usage + audit writer
  └── admin and billing APIs
        │
        ├──────────────► PostgreSQL authority
        │                  memberships, projects, grants, policies,
        │                  events, interactions, usage, audit, billing
        │
        ├──────────────► Durable jobs/outbox
        │                  runtime lifecycle, reconciliation, retention,
        │                  webhooks, health checks, exports
        │
        ├──────────────► Object/artifact storage
        │                  safe file snapshots, patches, reports, exports
        │
        ├──────────────► Provider gateway
        │                  tenant/route/model/budget-scoped short-lived token
        │                  upstream credentials remain here
        │
        └──────────────► Runtime supervisor
                           one isolated execution identity per admitted task/user
                           reviewed Codex binary + app-server over stdio
                           tenant workspace mount + egress policy + resource limits
```

SQLite and ordinary same-user child processes remain supported for local development only. Production mode must fail closed when the required external authority, gateway identity, or isolation backend is not configured.

## Stable product model

### Organization and access

- A person may belong to multiple organizations through memberships.
- Platform administration is separate from organization roles.
- Organization roles are owner, organization administrator, billing administrator, member/operator, and viewer/auditor.
- Project grants further constrain task operation and artifact visibility.
- Active organization is resolved server-side from an authenticated membership.
- Sensitive actions require recent authentication, reason, target-specific confirmation, and audit.

### Project and execution environment

- A project represents a governed source/workspace root, not an arbitrary client-supplied path.
- A workspace grant binds an organization/project/user or role to a canonical server-known path or remote environment identity.
- Worktree creation and cleanup belong to Agent Harness. The selected verified `cwd` is passed to Codex.
- A permission profile is a versioned effective policy assembled from platform, organization, project, and per-task inputs.
- Runtime admission reserves concurrency and budget before a process or turn begins.

### Task and runtime state

```text
draft → queued → starting → running
                         ├── waiting_approval
                         ├── waiting_permission
                         ├── waiting_user_input
                         ├── steering
                         ├── reconnecting
                         └── interrupted

running/waiting → completed | partial_success | failed | canceled
terminal state  → archived → restored
```

Codex thread, turn, and item identifiers are retained as runtime references. Agent Harness stores its own opaque task/run/event identifiers and normalized state so authorization, billing, replay, and support do not depend on parsing Codex rollout files.

### Event and interaction envelope

Every browser-visible event has:

- event ID and monotonically increasing thread/run sequence;
- organization, project, user, task, thread, turn, and item scope where applicable;
- schema version, type, timestamp, safe payload, and terminal/recoverability metadata;
- correlation ID plus route, entitlement, and runtime decision references in protected metadata;
- redaction classification and retention class.

SSE responses include IDs and bounded replay. Clients reconnect with a cursor and reconcile through a thread snapshot endpoint. User-wide attention events and thread-specific transcript events are separate feeds.

Every server-initiated Codex request becomes a durable pending interaction before it is shown to a client. Supported interactions include command approval, file approval, structured permission approval, user input, and MCP elicitation. Unknown/disabled requests fail closed with an explicit response to Codex; they are never left pending indefinitely.

### Provider, model, and routing model

- Provider type: versioned protocol/adapter definition managed by the platform.
- Provider connection: organization-scoped endpoint and write-only credential/gateway identity.
- Model record: canonical alias, provider model ID, capabilities, context/output limits, modalities, availability, price version, and validation status.
- Routing policy: allowed candidate routes, priority/fallback order, capability requirements, health/circuit state, timeout/retry boundaries, geography/data policy, and cost ceiling.
- Routing decision: immutable record of the policy version and candidate evaluation used for one run.

Browser model IDs are never forwarded unchecked. The server derives the permitted route and stable model alias from organization policy and task requirements. A fallback cannot occur after an ambiguous or non-idempotent side effect unless safe continuation is proven.

Production runtimes receive only short-lived, tenant/route/model/budget-scoped gateway tokens. Upstream keys and shared gateway master keys never enter Codex.

### Subscription and usage model

- Plan and entitlement versions are data, not UI constants.
- Admission atomically reserves the dimensions that can be enforced before dispatch: active turns, request/run count, and configured budget.
- Usage events are append-only. Corrections reference earlier events.
- Gateway/provider measurements reconcile reservations into input/output/cached/reasoning tokens, latency, and actual or estimated cost.
- Subscription state, seat limits, route/model access, retention, concurrency, and feature gates are enforced at API and job boundaries.
- Stripe redirects never grant access. Signed events are durably deduplicated, ordered, applied transactionally, and reconciled.

## Codex integration policy

1. Pin and build one reviewed Codex revision.
2. Generate and vendor the matching app-server TypeScript types and JSON schemas.
3. Default to stable methods and fields.
4. Gate experimental capability groups by deployment flag, organization entitlement, and pinned-version compatibility test.
5. Maintain an exhaustive server-request dispatcher. Its default is a safe error/decline, not silence.
6. Use supported stdio transport until a reviewed transport change is required.
7. Preserve user-managed Codex configuration. Merge only Harness-owned stanzas rather than rewriting the entire file.
8. Disable unsandboxed `thread/shellCommand` and `process/spawn` for ordinary product flows.
9. Represent collaboration from Codex collaboration/subagent items; do not invent a conflicting spawn protocol.
10. Record upstream protocol changes and product adapter changes in the Codex upgrade review.

## Product architecture and visual system

The application shell follows the full Claude Design brief in `docs/prompts/04-claude-design-full-product-brief.md`.

Primary information architecture:

```text
Work
├── Tasks
├── Projects
├── Reviews
└── Artifacts

Operate
├── Agents
├── Model routes
├── Environments
└── Capabilities

Manage
├── Team and access
├── Usage
├── Billing
└── Audit log

Platform
├── Organizations and users
├── Plans and provider catalog
├── Runtime fleet and jobs
├── Feature flags
└── System audit and upstream version
```

The signature interaction is the Run Spine: a semantic execution rail connecting turns, tool clusters, file changes, approvals, failures, and child-agent branches. It is paired with a bounded three-pane cockpit, resizable inspector, optional terminal dock, stable composer, and a human-attention queue.

The token architecture is primitive → semantic → component. The accepted Claude Design direction uses graphite surfaces, lime for agent execution, violet for human or privileged decisions, amber for waiting/risk, green/cyan for healthy state, and red only for destructive or failed state. Light and dark themes are intentional variants. Geist Sans and Geist Mono remain the implementation fonts unless the design review establishes an accessible, licensed replacement.

## Implementation sequence

### Phase 0 — protocol and data safety

- versioned migrations and schema compatibility checks;
- generated version-matched Codex protocol artifacts;
- stable-only default and exhaustive server-request handling;
- durable normalized events, cursors, replay, and pending interactions;
- server-derived project/workspace/model/route inputs;
- subscription, concurrency, request-budget, and idempotency admission;
- runtime termination on user, route, or entitlement revocation;
- SSRF-safe provider endpoint policy and production gateway identity requirement.

### Phase 1 — complete task lifecycle

- task/project URLs and browser history;
- thread pagination/read, resume, rename, pin/section, fork, archive/restore/delete;
- turn start/steer/interrupt with idempotent client IDs;
- goals, budgets, compaction/revert, and reviews;
- complete typed item reducer and Run Spine rendering;
- reconnect reconciliation and user-wide attention inbox.

### Phase 2 — execution surfaces

- project/workspace/worktree service;
- environment and permission profiles;
- durable command/file/permission/user-input/MCP interactions;
- sandboxed interactive `command/exec` terminal;
- file tree, real patch/diff viewer, artifacts, and review findings;
- collaboration/subagent supervision derived from Codex events.

### Phase 3 — model gateway and routing

- provider connection test, edit/delete/rotation, and protected fingerprint;
- model discovery/manual registration and capability validation;
- allowlists and route-policy versions;
- ordered fallback, timeouts, health, circuit state, and safe retry rules;
- route/test console and per-route operational analytics;
- gateway virtual identity lifecycle and reconciliation.

### Phase 4 — organizations and economics

- organizations, memberships, invitations, compatible roles, project grants, sessions, and revocation;
- usage ledger, price versions, budgets, forecasts, alerts, and quota UX;
- seat and subscription enforcement;
- durable Stripe receipts, idempotent processing, ordering, reconciliation, invoices, and portal;
- organization audit and visibly separate platform console.

### Phase 5 — capabilities and automation

- installed local skills, apps, and MCP inventory/configuration;
- capability trust, permission, version, health, and organization availability;
- goal-driven long-running work and notifications;
- signed extension policy and catalog contracts;
- public marketplace, skill authoring, templates, and connector catalog only after the trust model is implemented.

### Phase 6 — production operations

- PostgreSQL authority, RLS defense in depth, HA, encrypted backups, PITR, and restore/deletion jobs;
- isolated runtime identity/container or microVM, resource limits, tenant mounts, and egress policy;
- durable worker leases/outbox, retries, dead-letter handling, and crash recovery;
- OIDC/MFA/recovery and later SAML/SCIM;
- KMS envelope encryption and key rotation;
- security headers, application-wide rate limits, abuse controls, redacted logs, metrics, traces, SLOs, and alerting;
- load, migration, backup/restore, dependency/license, secret, and threat-model release gates.

## Implemented foundation checkpoint

The implemented checkpoint combines **hard tenancy and spend admission** with truthful operator read surfaces:

1. ordered, checksummed SQLite migrations preserve the current local database;
2. entitlement snapshots, workspace grants, thread/workspace bindings, usage reservations, and usage events provide durable control-plane records;
3. workspace, route, and model are derived or verified server-side before Codex dispatch;
4. seat creation/reactivation and active-run/request capacity are enforced transactionally, with idempotency keys on run and Checkout invocations;
5. arbitrary model overrides, cross-tenant threads, and ungranted paths are rejected;
6. turn reservations bind to the exact returned turn, renew while activity continues, and settle from terminal events with Codex token-usage measurements where present;
7. selected/deep-linked tasks hydrate an authorized, bounded history snapshot; cross-task turn liveness is reconciled while live timeline events stay filtered and buffered for the selected thread;
8. named lifecycle APIs cover saved-project task creation, resume, rename, fork, archive/unarchive, inline review, exact-turn steer, and interrupt with durable idempotency receipts;
9. Saved Projects is a tenant-scoped administrator registry; Reviews, Agents, Environments, and Capabilities expose only runtime evidence; Usage aggregates current-period request/run/seat/token records; and administrators can read the latest tenant audit events;
10. Stripe processing durably deduplicates processed event IDs, rejects older state, preserves billing periods, and applies subscription/entitlement/audit changes atomically; and
11. automated tests cover tenant isolation, quota/seat races, revocation, history authorization, hostile task-start responses, atomic rollback/replay, protocol defaults, unsupported server requests, audit redaction, and Stripe replay/staleness/rollback.

This checkpoint materially improves the foundation but does not make same-user local child processes safe for hostile internet multi-tenancy. Saved Projects registers existing workspaces but is not a checkout/worktree service; Usage is not a cost ledger; Audit is not a searchable/tamper-evident platform log; and history snapshots are not a product-owned event store. Durable event/interaction replay, the remaining advanced lifecycle operations, provider failover, finance-grade reconciliation, and production isolation remain mandatory release gates.

## Release gates

The product is not production-ready until all are true:

- two organizations cannot discover or access each other's users, workspaces, threads, events, interactions, artifacts, provider metadata/secrets, usage, audit, or billing;
- every runtime start and turn is admitted against server-derived policy, entitlements, concurrency, and budget;
- revocation terminates active work and invalidates streams/interactions;
- provider egress cannot reach prohibited/private/metadata destinations and Codex never receives an upstream/master credential;
- every supported Codex server request is durably resolved; unsupported requests fail closed;
- event replay, approval recovery, runtime restart, and worker failover have tested behavior;
- billing webhooks are durable, unique, ordered, idempotent, and reconciled;
- backup/restore and tenant deletion/export are rehearsed;
- no unresolved critical/high threat-model findings remain;
- accessibility, visual regression, load, migration, dependency/license, and secret scans pass;
- the Codex attribution, pin, generated protocol artifacts, and upgrade evidence agree.

## Official basis

- [Codex as a platform: build on the open agent harness](https://developers.openai.com/blog/codex-as-a-platform)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Open-source Codex repository](https://github.com/openai/codex)

The official platform guidance treats app-server as the integration layer for products that need persistent conversations, streaming, interruption, tools, and approvals. Agent Harness uses that runtime layer while retaining application ownership of business context, policy, consent, governance, and user experience.
