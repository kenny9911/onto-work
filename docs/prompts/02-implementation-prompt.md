# Agent Harness — Implementation Prompt

You are the principal engineer responsible for evolving the checked-out OpenAI Codex codebase into Agent Harness, a multi-user, provider-neutral agent platform. Implement the product incrementally and verify each slice. The source product requirements are in `docs/prompts/01-product-requirements.md`; the design brief is in `docs/prompts/03-claude-design-prompt.md`. Treat requirement and acceptance-criterion IDs as traceability keys in plans and test reports.

## Mission

Build on the existing Codex harness rather than replacing its proven task runtime, streaming, tool, approval, sandbox, and diff behavior. Add a product-owned layer for identity, organizations, RBAC, provider routing, metering, subscriptions, administration, and web UI. Keep the result maintainable against upstream Codex.

Do not implement future application, skill, or template marketplaces in this phase. Define versioned extension boundaries only.

## Non-negotiable outcomes

1. Multi-user authentication and strict organization isolation.
2. Centralized RBAC across HTTP, streaming, background jobs, artifacts, exports, and admin operations.
3. Organization-owned provider connections with encrypted server-side credentials.
4. OpenAI-compatible gateway support plus correct native protocol handling for Anthropic and Gemini where needed.
5. Support paths for OpenRouter, NewAPI, OpenAI, Anthropic, Google Gemini, DeepSeek, Doubao, Qwen, GLM, and Ollama/local endpoints.
6. A normalized model catalog, capability-aware selection, allowlists, defaults, prioritized fallback, limits, and metering.
7. Subscription, plan, seat, entitlement, quota, usage-ledger, invoice-reference, and webhook lifecycle management.
8. A Codex-familiar task UI with organization/provider/usage additions and original Agent Harness branding.
9. A first-run platform administrator named `admin` using the exact user-supplied temporary secret from private deployment context, implemented through a secure bootstrap mechanism with mandatory first-login rotation.
10. An upstream inventory, small-patch strategy, test coverage, observability, security hardening, and operational documentation.

## Delivery rules

- Inspect before changing. Do not assume the repository's language, frontend framework, database, protocol version, or deployment topology.
- If the Codex repository is already checked out, use it in place; do not destructively reclone it.
- Read and follow every applicable repository instruction file before editing within its scope.
- Preserve user changes and unrelated work. Keep commits/diffs reviewable by milestone and avoid broad rewrites.
- Prefer composition and adapters over editing central Codex modules. Record unavoidable upstream edits in a patch ledger.
- Keep all secrets out of source, fixtures, client bundles, snapshots, logs, analytics, URLs, exception messages, and generated docs.
- Do not claim a provider, payment path, security control, accessibility target, or acceptance criterion is complete until a representative test passes.
- When a business decision is unresolved, create a typed configuration point and a safe disabled state; list the decision clearly.

## Phase 0: Repository and product audit

Before implementation, produce a concise evidence-backed audit containing:

1. repository structure, languages, build/test commands, instruction files, and current dirty state;
2. exact Codex upstream revision, license/notice obligations, and update mechanism;
3. reusable execution, app-server, protocol, thread, event, tool, approval, sandbox, configuration, persistence, and UI surfaces;
4. gaps against every PRD requirement group;
5. likely extension seams and any high-conflict upstream files to avoid;
6. current authentication, persistence, realtime, secret handling, and deployment capabilities;
7. proposed architecture, data-flow diagram, trust boundaries, threat model, and migration sequence;
8. technology decisions with alternatives and reasons, based on what the repository actually contains; and
9. a requirement-to-milestone traceability table.

Do not start a wholesale implementation until this audit identifies the smallest end-to-end vertical slice.

## Target logical architecture

Adapt names and process boundaries to the repository, but preserve these responsibilities:

### Codex runtime boundary

- Owns agent task execution, model interaction hooks, typed run events, tool invocation, approvals, workspace/file operations, sandboxing, interruption, and resume.
- Exposes a versioned interface to the product control plane.
- Receives an immutable execution context containing organization, user, project, entitlement snapshot, provider routing decision, budget, and policy identifiers.
- Does not query billing or web-session state directly during low-level execution.

### Product control plane

- Owns users, sessions, organizations, memberships, roles, projects, tasks, provider connections, routing policies, subscriptions, entitlements, usage, and audit.
- Authorizes and reserves quota before dispatch, then reconciles actual usage after terminal run events.
- Creates short-lived execution grants rather than passing browser sessions or raw provider credentials into arbitrary tools.

### Provider gateway

- Implements a versioned adapter interface and capability model.
- Resolves an organization routing policy to an eligible connection/model.
- Decrypts a credential only at dispatch, keeps it in the smallest possible scope, and zeroizes/releases it where runtime support permits.
- Normalizes streaming events, usage, cancellation, finish reasons, and error categories while retaining redacted provider diagnostics.
- Enforces timeout, concurrency, rate, cost, capability, health, and data-routing policy.

### Persistence and asynchronous work

- Uses migrations and constraints for tenant ownership, uniqueness, ledger integrity, idempotency, and lifecycle state.
- Uses durable jobs for invitations, webhook processing, reconciliation, usage aggregation, cleanup, and long-running run coordination where appropriate.
- Uses an outbox or equivalent atomic event publication mechanism when a database state change and asynchronous event must agree.

### Web/product UI

- Uses server-authorized data and never derives privilege from hidden controls alone.
- Consumes typed APIs/events, handles reconnect/resume, and renders persistent blocked/error states.
- Has distinct personal, organization, billing, and platform administration scopes.
- Uses a shared token/component layer based on the approved Claude Design output.

## Required implementation sequence

### Slice 1: Secure foundation

Implement schema/migrations, user authentication, sessions, password security, bootstrap, organizations, memberships, invitations, RBAC policy checks, organization switching, and audit events.

Requirements:

- Make tenant-scoped repository/query APIs require an organization context.
- Add database constraints and indexes that reduce accidental cross-tenant access.
- Make authorization policy calls explicit and testable; avoid role checks scattered in route handlers.
- Implement the bootstrap as a concurrency-safe, idempotent server-side command or startup transaction that runs only when no platform administrator exists.
- Accept the initial `admin` credential and its user-supplied temporary secret through deployment secrets or a one-shot command. Store only an adaptive password hash, never repeat the secret in tracked artifacts, and require rotation before normal access.
- Ensure tests inject a distinct test password; never snapshot the requested password.

Verification gate:

- Unit tests for policy semantics and password/bootstrap state.
- Integration tests for sessions, invitations, role changes, owner transfer, suspension, and immediate revocation.
- A parameterized cross-tenant negative test suite covering list, get, mutate, delete, stream, artifact, export, and guessed-ID paths.

### Slice 2: Provider gateway

Implement provider types, organization connections, encrypted credential envelopes, model records, discovery/manual registration, allowlists, routing policies, connection tests, adapter contract, normalized events/errors, usage capture, and endpoint policy.

Use protocol families rather than one-off branding conditionals:

- OpenAI-compatible: OpenAI-compatible endpoints, OpenRouter, NewAPI, DeepSeek/Qwen/GLM/Doubao endpoints where they expose that contract, and Ollama-compatible APIs.
- Native Anthropic: Messages semantics, streaming, tools, usage, and errors.
- Native Gemini: content/parts, streaming, function calls, usage, safety/finish reasons, and errors.
- Additional provider-specific behavior belongs in adapter modules with contract fixtures.

The adapter interface must expose or negotiate:

- model capability metadata;
- streaming text and supported reasoning metadata;
- structured output and tool calls/results;
- cancellation and timeout;
- normalized usage and finish/error categories;
- provider request/correlation metadata safe for logs; and
- health/validation behavior.

Protect custom endpoints from SSRF. Validate URL schemes, ports, redirects, DNS resolution, loopback/link-local/private ranges, and resolution changes. Provide an explicit deployment-controlled private-network mode for approved Ollama/customer-hosted endpoints. Never accept raw arbitrary request headers without allowlisting.

Verification gate:

- Adapter contract tests with recorded/synthetic streams for every protocol family.
- Secret-canary tests across API responses, client bundles, logs, traces, analytics hooks, errors, exports, and persisted transcripts.
- Connection test, credential rotation, model allowlist, capability mismatch, rate limit, timeout, cancellation, endpoint-policy, and deterministic fallback tests.

### Slice 3: Tenant-scoped Codex run

Connect authorized tasks to the Codex runtime. Implement project/task/run persistence, typed event streaming, reconnect cursors, approvals, interruption, resume/retry, artifacts/diffs, status, errors, and usage reconciliation.

Requirements:

- Bind each run to immutable organization/user/project/policy/provider/model/entitlement snapshots.
- Reserve quota before provider dispatch and reconcile the reservation from terminal usage.
- Use stable event IDs plus per-run sequence numbers. Reconnection must not duplicate visible events.
- Apply server-side execution/tool/network/sandbox policy before and during the run.
- Do not automatically replay non-idempotent tool effects after ambiguous failure.
- Preserve provider and runtime correlation IDs without showing secrets or unrestricted provider bodies.
- Make cancellation effective server-side even when the initiating browser disconnects.

Verification gate:

- End-to-end task covering stream, tool request, approval, artifact/diff, usage, and completion.
- Reconnect, duplicate submission, cancel, deny, timeout, provider failure, fallback-safe/unsafe, quota exhaustion, and session-revocation scenarios.
- Regression tests around adapted Codex protocol boundaries.

### Slice 4: Product UI and administration

Implement the approved desktop-first UI:

- application shell with organization switcher, projects/tasks, search, create action, usage/plan indicator, and account menu;
- task pane with model/router context, typed event stream, approval blocks, diffs/artifacts, composer, and run controls;
- contextual inspector for files/artifacts, timeline, environment, and usage;
- provider setup, model allowlist, router/fallback editor, connection health, and audit views;
- member, invitation, role, security/session, and agent-policy settings;
- billing/usage console; and
- clearly separate platform administration.

Implement light/dark themes, responsive behavior, command palette, keyboard shortcuts, semantic focus management, reduced motion, WCAG 2.2 AA contrast, non-color status cues, and live-region behavior that does not announce every token.

Use Agent Harness identity and original assets. Codex is a behavioral reference, not permission to copy restricted branding or private assets.

Verification gate:

- Component tests for permission and entitlement states.
- Automated accessibility checks plus manual keyboard and screen-reader smoke paths.
- Visual regression snapshots for desktop and narrow layouts in light/dark themes.
- Browser end-to-end tests for onboarding, task run, provider configuration, member administration, quota block, billing state, and platform admin scope.

### Slice 5: Plans, subscriptions, and usage

Implement versioned plan definitions, prices, subscription states, entitlements, seats, quotas, immutable usage ledger/corrections, billing provider interface, hosted/tokenized checkout or portal flow, verified webhooks, invoices/receipt references, and reconciliation.

Requirements:

- Keep plan/price values configurable until the product owner approves them.
- Persist the external billing account/subscription/event references needed for reconciliation, not raw card data.
- Verify webhook signatures against the raw body; store/deduplicate event IDs; handle retries and out-of-order events.
- Make entitlement state derivable and auditable. Never grant access solely because a client returns from checkout.
- Define explicit trial, active, grace, past-due, suspended, canceled, upgrade, downgrade, excess-seat, and quota-exhaustion transitions.
- Enforce entitlements in API and dispatch layers and mirror the result in UI explanations.
- Version model price metadata and label estimated versus provider-reported cost.

Verification gate:

- Subscription state-machine tests.
- Webhook signature, replay, duplicate, out-of-order, retry, and reconciliation tests.
- Seat counting, quota reservation/reconciliation, ledger correction, upgrade/downgrade, grace/past-due, and authorization tests.

### Slice 6: Production hardening

Add structured redacted telemetry, metrics, traces, dashboards/alerts, rate limiting, abuse controls, health/readiness checks, graceful shutdown, backup/restore, migration runbooks, dependency/license/secret scans, SBOM/dependency inventory, performance/load tests, data lifecycle jobs, and upstream update automation/documentation.

Verification gate:

- Restore drill in a non-production environment.
- Load test with a documented baseline and bounded streaming memory.
- Threat-model review and no unresolved critical/high security findings.
- License/notice and original-brand review.
- Upstream update rehearsal against a newer safe revision or a simulated patch change.

## Data and authorization requirements

- Use opaque identifiers at external boundaries.
- Store timestamps in UTC and retain billing/provider price effective dates.
- Every tenant record has a direct `organization_id` or a constrained ownership path; joins must include tenant ownership.
- Prefer database row-level security only as defense in depth unless repository architecture supports it comprehensively; application policy remains explicit and tested.
- Separate platform administration from organization roles. Platform administrators do not automatically receive tenant-content or secret-read permissions.
- Provider secrets are write/replace-only in product APIs. Store ciphertext, key version, safe fingerprint, creator, rotation time, and validation state.
- Audit events include actor, tenant/platform scope, action, target type/ID, outcome, reason where required, request correlation ID, timestamp, and redacted metadata.
- Usage is append-only. Corrections reference original entries. Aggregates can be rebuilt from the ledger.
- Use idempotency/deduplication for task creation, run dispatch, billing changes, webhooks, quota reservation, and retryable jobs.

## API and event contract requirements

- Define typed request/response schemas and a stable error envelope with machine code, safe message, correlation ID, and recoverability metadata.
- Keep authentication failures, authorization failures, missing resources, quota blocks, provider errors, and internal errors distinguishable without leaking protected existence or details.
- Version event schemas and make consumers tolerate additive fields.
- Stream typed run events with run ID, event ID, sequence, timestamp, type, safe payload, and terminal/retry metadata.
- Use resumable cursor semantics and define retention/compaction behavior.
- Include entitlement and routing decision IDs in protected run metadata for audit; do not include raw credentials.
- Generate client types from contracts or share types through a repository-native mechanism to prevent drift.

## Security checklist

- Threat-model browser, API, realtime transport, database, cache/queue, runtime workers, provider egress, custom endpoints, billing webhooks, artifacts, exports, and admin/support paths.
- Prevent IDOR/BOLA through server-derived tenant scope and deny-by-default authorization.
- Protect sessions with secure, HTTP-only, same-site cookies or an equivalently reviewed mechanism; address CSRF and session fixation.
- Rate-limit and monitor login, password reset, invitation, provider validation, run dispatch, approvals, export, and webhook paths.
- Validate and escape untrusted model/tool/repository content in terminal, Markdown, diff, and link rendering.
- Prevent prompt/tool output from changing authorization, provider routing, subscription state, or system policy.
- Enforce artifact path canonicalization and content-disposition/content-type safety.
- Redact known secret patterns and install canary-based regression tests.
- Keep bootstrap, signing, encryption, database, billing, and provider secrets in the deployment secret store with rotation procedures.

## Quality strategy

Maintain a traceability table mapping PRD requirements and acceptance criteria to implementation modules, migrations, automated tests, and manual evidence.

At minimum, use:

- unit tests for pure policy, state-machine, capability, routing, pricing, and redaction logic;
- integration tests for database constraints, tenancy, authentication, provider adapters, run lifecycle, webhooks, and ledger behavior;
- contract tests for Codex runtime, provider adapters, billing provider, and streaming event schemas;
- end-to-end browser tests for core personas and blocked/error paths;
- property/fuzz tests where parser, stream, URL/endpoint, money/usage, or policy inputs benefit;
- accessibility and visual regression testing for required layouts/states;
- concurrency tests for bootstrap, invitations, quota reservation, webhook deduplication, and run dispatch; and
- migration, backup/restore, load, and security regression checks before release.

Do not rely only on mocked happy paths. Use safe sandbox/test credentials for live smoke tests where available, keep them out of artifacts, and make network-dependent tests opt-in and clearly reported.

## Required implementation artifacts

- Repository/upstream audit and gap map.
- Architecture decision records and trust/data-flow diagrams.
- Threat model and security control matrix.
- Versioned database migrations and rollback/recovery notes.
- API/event/provider/billing contracts.
- Codex upstream patch ledger and update runbook.
- Provider support/capability matrix.
- RBAC permission matrix and authorization test inventory.
- Plan/entitlement/subscription state documentation.
- Design tokens, component/state inventory, and visual/a11y evidence.
- Deployment, secret bootstrap/rotation, backup/restore, incident, and reconciliation runbooks.
- Requirement-to-test traceability report and a release-readiness checklist.

## Reporting format after each slice

Report:

1. outcome and user-visible behavior;
2. requirement/acceptance IDs covered;
3. changed architecture and migrations;
4. security and tenant-isolation considerations;
5. tests run and exact results;
6. screenshots or visual evidence for UI changes;
7. unresolved decisions, known limitations, and risks; and
8. the smallest safe next slice.

The implementation is complete only when the PRD acceptance criteria are demonstrably satisfied, the temporary administrator password is not embedded in source or client artifacts, and the production runbooks can reproduce bootstrap, upgrade, backup, restore, and rollback behavior.
