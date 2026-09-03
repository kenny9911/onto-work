# Agent Harness — Product Requirements Prompt

**Status:** Draft for implementation  
**Audience:** Product, design, architecture, engineering, security, and QA  
**Working product name:** Agent Harness  
**System foundation:** OpenAI Codex open-source repository, maintained as an auditable upstream dependency

## How to use this document

Use this as the source product prompt for planning, designing, and implementing Agent Harness. Resolve requirements by their IDs, record material assumptions in an architecture decision record, and do not silently reduce scope. If the repository or upstream license makes a requirement impractical, document the evidence, propose the smallest compliant alternative, and preserve the user outcome.

## Product mandate

Build a multi-user agent harness based on the open-source Codex harness. Preserve the interaction quality and workflow familiarity of Codex while evolving it into a provider-neutral, tenant-aware product with administration, subscriptions, metering, and extensibility.

The initial product must let a user:

1. Sign in to an isolated organization or personal workspace.
2. configure one or more direct LLM providers or LLM gateways;
3. choose a model or routing policy;
4. create, run, pause, resume, and inspect agent tasks;
5. review streaming output, tool activity, diffs, approvals, and usage;
6. manage members, roles, plans, quotas, and billing; and
7. administer the installation safely.

Applications/connectors, reusable skills, and agent templates are explicitly planned for later releases. The initial architecture must expose stable extension points for them without implementing a marketplace or authoring experience now.

## Product outcomes

### Goals

- Deliver a credible Codex-derived agent workspace rather than a superficial chat application.
- Make model access provider-neutral and safe for both hosted and local inference.
- Support multiple organizations and users with strict tenant isolation and role-based access control.
- Make subscriptions, entitlements, quotas, and usage visible and enforceable.
- Keep the upstream Codex relationship maintainable through a documented update strategy.
- Establish extension contracts for future applications, skills, and templates.

### Success indicators

- A new organization can reach a successful streamed agent response after completing guided setup.
- An organization administrator can add a provider, validate it, limit available models, and assign a default routing policy without exposing credentials to a client.
- Two organizations can use the same installation without being able to discover or access each other's users, secrets, tasks, artifacts, usage, or billing data.
- A billing administrator can understand current plan, seats, quota consumption, and invoice/subscription status from one place.
- A platform administrator can diagnose failed runs from metadata and correlated logs without viewing provider secrets or unrestricted tenant content.
- Upstream Codex changes can be evaluated and merged without repeatedly rewriting product-specific tenant, provider, or billing features.

## Product principles

1. **Codex-derived, not Codex-branded.** Reuse code and interaction patterns only within license and attribution requirements. Use original product naming, logos, copy, icons, and visual assets.
2. **Tenant context is explicit.** Every protected resource and operation has an organization scope; platform-scoped operations are visibly distinct.
3. **Secrets stay server-side.** Provider and billing credentials never enter browser storage, URLs, logs, analytics payloads, or agent transcripts.
4. **Provider portability is a core capability.** Agent behavior depends on normalized model capabilities, not provider-specific conditionals scattered through the product.
5. **Human control is preserved.** Tool permissions, approvals, interruption, and auditability remain first-class.
6. **Entitlements are enforced centrally.** UI affordances mirror server-side policy but never substitute for it.
7. **Upstream stays mergeable.** Prefer adapters, interfaces, and product-owned modules over invasive edits to Codex core.

## Personas

### Platform administrator

Operates the installation across all organizations. Manages platform defaults, supported provider types, plan catalog, system health, abuse controls, and audited break-glass support. Does not receive routine access to organization secrets or task content.

### Organization owner

Owns an organization, its membership, provider connections, security settings, and subscription. Can transfer ownership and delete/export the organization through protected flows.

### Organization administrator

Manages members, workspaces/projects, provider connections, model availability, routing policies, and organization-level agent defaults. Cannot perform platform administration.

### Billing administrator

Manages plan, seats, payment status, invoices, usage alerts, and billing details. Has no provider-secret or member-role privileges unless separately granted.

### Member / agent operator

Creates and operates agent tasks within assigned projects, selects allowed models, responds to approval requests, and reviews resulting artifacts and usage.

### Viewer / auditor

Can inspect explicitly shared projects, tasks, audit events, or usage reports, but cannot start runs, approve tools, mutate configuration, or reveal secrets.

## Scope

### MVP / first production release

- Codex-derived task lifecycle and streaming agent experience.
- Secure authentication, session management, password reset, logout, and a first-run admin bootstrap.
- Organizations, memberships, invitations, active-organization switching, and RBAC.
- Projects/workspaces and tenant-scoped tasks, messages, run events, approvals, artifacts, and diffs.
- Provider connections for OpenAI-compatible endpoints and native adapters where protocol differences require them.
- Provider support targets: OpenRouter, NewAPI, OpenAI, Anthropic, Google Gemini, DeepSeek, Doubao, Qwen, GLM, and Ollama/local OpenAI-compatible servers.
- Model catalog, capability metadata, connection tests, per-organization allowlists, defaults, and basic prioritized fallback routing.
- Configurable plans, subscriptions, seats, entitlements, quotas, metering, invoices/receipts metadata, and verified billing webhooks.
- User settings, organization settings, billing console, and platform administration console.
- Security audit log, correlated operational logs, health reporting, backups, and documented recovery.
- Light and dark themes, keyboard-first operation, responsive layouts, and accessible states.

### Explicitly deferred

- Application/connector marketplace and third-party OAuth catalog.
- Skill marketplace, skill authoring, distribution, and trust scoring.
- Agent template marketplace or public template gallery.
- Mobile-native clients.
- Fully autonomous cross-organization collaboration.
- Complex optimization routers, model bidding, or arbitrage beyond deterministic rules and fallback.
- Customer-specific enterprise features such as SAML, SCIM, legal hold, data residency, and customer-managed encryption keys unless separately prioritized.

The deferred capabilities must not be represented as available in the UI. Their future integration points may be documented and feature-flagged.

## Core user journeys

### J-01: First-run bootstrap

On a fresh installation, a one-shot server-side bootstrap creates the platform administrator with username `admin` and the user-supplied temporary password injected through an ignored local environment file or deployment secret. The credential is never repeated in tracked source, client code, fixtures, logs, images, or documentation. The password is hashed with a modern password hashing function, bootstrap becomes unavailable after success, and the account must change the password at first sign-in. Production deployments must inject a distinct temporary secret through a secret manager or equivalent one-shot channel.

### J-02: Organization onboarding

An authenticated owner creates an organization, chooses a plan or trial, invites members, configures a provider connection, validates it, selects allowed models, and runs a guided smoke-test task. Setup progress is resumable.

### J-03: Run an agent task

A member opens a project, creates a task, selects an allowed model or organization routing policy, enters instructions, and receives streamed agent output. Tool requests, permission gates, terminal events, file changes, diffs, errors, token/cost usage, cancellation, and retry are represented as distinct, inspectable states.

### J-04: Configure provider routing

An organization administrator creates a provider connection, supplies credentials or an endpoint, tests the connection, imports or manually registers models, sets capability/price metadata, restricts model availability, and chooses a default plus ordered fallbacks. Changing policy affects future runs and is audit logged.

### J-05: Manage subscription and usage

A billing administrator views the current plan, seat allocation, billing cycle, invoices, quota/credit balances, per-model usage, and forecast alerts. Plan changes and billing events update entitlements idempotently. Grace periods and hard limits produce explicit, recoverable UI states.

### J-06: Platform operations

A platform administrator reviews organizations, plan status, provider-type health, job queues, system usage, audit events, and version information. Any support impersonation or tenant-content access requires a time-limited, reasoned, prominently indicated break-glass flow and immutable audit event.

## Functional requirements

### Identity, tenancy, and RBAC

- **IAM-001:** Support secure sign-in, logout, password change/reset, session revocation, and account status controls.
- **IAM-002:** Model users and organizations separately, with many-to-many memberships and exactly one active organization in each tenant-scoped session or request context.
- **IAM-003:** Resolve tenant scope on the server from authenticated membership. Never trust a client-supplied organization identifier by itself.
- **IAM-004:** Enforce authorization in a centralized policy layer for UI, API, background jobs, realtime channels, artifact access, and exports.
- **IAM-005:** Support platform administrator, organization owner, organization administrator, billing administrator, member, and viewer roles. Allow a user to hold compatible organization roles without gaining platform privileges.
- **IAM-006:** Support expiring, single-use invitations and membership removal that immediately revokes tenant access and active sessions where feasible.
- **IAM-007:** Prevent the last organization owner from leaving or being removed until ownership is transferred.
- **IAM-008:** Audit authentication events, role and membership changes, organization switches, secret changes, routing changes, billing changes, and privileged support actions.
- **IAM-009:** Provide a platform-level account suspension and an organization-level member suspension with distinct effects.
- **IAM-010:** Design the identity boundary so OIDC/SAML and SCIM can be added later without replacing tenant membership or policy models.

#### Minimum permission matrix

| Capability | Platform admin | Org owner | Org admin | Billing admin | Member | Viewer |
| --- | --- | --- | --- | --- | --- | --- |
| Operate platform and plan catalog | Yes | No | No | No | No | No |
| View organization metadata | Audited | Yes | Yes | Billing subset | Assigned | Assigned |
| Manage ownership / delete organization | No by default | Yes | No | No | No | No |
| Manage members and roles | No by default | Yes | Yes, except owner | No | No | No |
| Manage provider connections and routing | No secret reveal | Yes | Yes | No | No | No |
| Manage subscription and invoices | Plan controls only | Yes | Optional | Yes | No | No |
| Create and operate tasks | Support-only | Yes | Yes | No by default | Yes | No |
| Approve privileged tools | No by default | Policy-based | Policy-based | No | Policy-based | No |
| View assigned task content | No by default | Policy-based | Policy-based | No | Yes | Read-only |
| View audit log | Platform events | Yes | Yes | Billing events | Own events | If granted |

All `No by default`, `Optional`, and `Policy-based` entries must have an explicit policy and test; there must be no implicit privilege inheritance.

### Projects, tasks, and agent runtime

- **RUN-001:** Preserve the Codex task/thread mental model and core lifecycle: create, stream, inspect, interrupt, resume, retry, archive, and restore where supported by the base.
- **RUN-002:** Scope every project, task, message, run, event, approval, artifact, workspace reference, and usage record to an organization.
- **RUN-003:** Stream typed events with stable identifiers, ordering metadata, reconnect/resume semantics, and terminal states.
- **RUN-004:** Show tool calls and approvals distinctly from assistant text. Record the actor, policy, decision, timestamp, and result for each approval.
- **RUN-005:** Preserve sandboxing and execution-policy boundaries from Codex; tenant features must not bypass them.
- **RUN-006:** Allow an organization to define defaults and limits for sandbox mode, network access, tools, model, maximum run budget, and approval policy.
- **RUN-007:** Support user cancellation and enforce server-side time, token, cost, and concurrency limits even if a client disconnects.
- **RUN-008:** Persist sufficient normalized run metadata for reliable resume, usage reporting, support, and audit without storing provider secrets.
- **RUN-009:** Make failure states actionable: authentication failure, rate limit, provider outage, unsupported model capability, quota exhaustion, tool denial, timeout, cancellation, and internal error.
- **RUN-010:** Reserve versioned extension interfaces for future applications, skills, and templates. A run records which extension versions participated, but MVP exposes no marketplace.

### Provider gateway and model routing

- **LLM-001:** Separate a platform provider type (protocol/adapter definition) from an organization provider connection (endpoint, credentials, and policy).
- **LLM-002:** Provide an OpenAI-compatible adapter for OpenRouter, NewAPI, compatible direct providers, and local endpoints; implement native Anthropic and Gemini adapters where needed for feature correctness.
- **LLM-003:** Accommodate OpenAI, Anthropic, Google Gemini, DeepSeek, Doubao, Qwen, GLM, Ollama, OpenRouter, NewAPI, and additional providers through a versioned adapter contract.
- **LLM-004:** Normalize streaming text, reasoning where permitted, structured output, tool calls/results, finish reasons, errors, usage, and cancellation while retaining provider-specific diagnostics in protected metadata.
- **LLM-005:** Maintain canonical model records with provider model ID, display name, capabilities, context/output limits, modality support, status, pricing source, and pricing effective date.
- **LLM-006:** Allow model discovery when supported and manual registration when not. Discovery never automatically enables a model for members.
- **LLM-007:** Let organization administrators test a connection without persisting plaintext credentials or returning them to the client.
- **LLM-008:** Encrypt provider credentials at rest using an application encryption key kept outside the database. Display only a non-sensitive fingerprint and last validation status; replacement is allowed, retrieval is not.
- **LLM-009:** Support organization-level model allowlists, a default model/routing policy, and deterministic prioritized fallbacks filtered by required capabilities, health, and entitlement.
- **LLM-010:** Do not retry or fall back after a non-idempotent tool-side effect unless the runtime can prove safe continuation. Surface ambiguity to the user.
- **LLM-011:** Meter requests, input/output/cached/reasoning tokens when available, latency, provider/model, result, and estimated/actual cost. Mark estimates clearly and version price data.
- **LLM-012:** Apply provider-specific rate and concurrency limits plus organization/user/run budgets before dispatch.
- **LLM-013:** Protect custom and local endpoints against SSRF with explicit policy, validated schemes/hosts, DNS/IP checks, redirect restrictions, and a documented private-network mode. Never assume `localhost` in a server deployment refers to the user's machine.
- **LLM-014:** Supply health checks, exponential backoff, circuit-breaking signals, redacted error messages, request correlation IDs, and provider timeout controls.
- **LLM-015:** Never send data to a fallback provider that is not enabled for the organization or allowed by its data-routing policy.

### Subscription, entitlement, and usage management

- **BILL-001:** Represent plans, prices, billing intervals, features, quota dimensions, seat rules, and provider/model restrictions as versioned data rather than UI constants.
- **BILL-002:** Support free/trial, paid, grace-period, past-due, suspended, canceled, and enterprise/manual subscription states without hardcoding public prices before business approval.
- **BILL-003:** Keep a provider-neutral billing interface. The first payment processor may be selected during implementation, but webhook verification, idempotency, reconciliation, and test mode are mandatory.
- **BILL-004:** Enforce entitlements centrally at API and job dispatch boundaries. The UI explains unavailable actions and provides an upgrade/contact path.
- **BILL-005:** Track seats independently of invited, active, suspended, and removed memberships according to plan policy.
- **BILL-006:** Meter usage in an immutable ledger with correction entries; derive summaries rather than mutating historical totals.
- **BILL-007:** Support configurable soft warnings, hard quotas, per-run budgets, organization budgets, and concurrency limits.
- **BILL-008:** Process billing webhooks with signature verification, replay protection, idempotency keys, event retention, retry handling, and reconciliation jobs.
- **BILL-009:** Expose plan, renewal/cancellation state, seats, quota consumption, invoices/receipts metadata, and usage breakdowns only to authorized roles.
- **BILL-010:** Define downgrade behavior before accepting a downgrade: excess seats, disabled models/features, retained data, running tasks, and grace periods.
- **BILL-011:** Do not store raw payment-card data. Use the processor's hosted or tokenized flows.
- **BILL-012:** Audit subscription, entitlement, quota, billing-role, and manual-credit changes.

### Administration

- **ADM-001:** Provide separate organization and platform administration surfaces with unmistakable scope labels.
- **ADM-002:** Organization settings include profile, members, roles, invitations, security/session controls, provider connections, models, routing, usage, subscription, and audit log.
- **ADM-003:** Platform settings include organizations, users, plan catalog, provider types, system feature flags, jobs, version/upstream status, system audit, and operational health.
- **ADM-004:** Sensitive mutations require recent authentication or step-up confirmation. Destructive operations require target-specific confirmation and are auditable.
- **ADM-005:** List and search pages use server-side pagination and authorization-filtered queries; counts must not leak inaccessible tenant data.
- **ADM-006:** Support structured, scoped data export and account/organization deletion workflows with retention and legal-policy hooks.

## Information architecture and required surfaces

### Primary application shell

- Left rail/sidebar: organization switcher, projects, task history, search/filter, create task, archive, settings entry, usage/plan indicator, and user menu.
- Main task pane: task header, project/workspace context, model/router indicator, event stream, approvals, diffs/artifacts, errors, composer, run controls, and status.
- Contextual inspector: task metadata, changed files/artifacts, tool/run timeline, usage/cost, and environment details. It may collapse into a drawer on narrower screens.
- Global command palette and keyboard navigation for frequent actions.

### Required settings surfaces

- Personal: profile, password/security, sessions, appearance, notifications, and defaults.
- Organization: general, members and roles, invitations, agent policy, providers, models and routing, usage, billing, and audit.
- Platform: overview, organizations, users, plans/entitlements, provider types, health/jobs, feature flags, audit, and system version.

### Required UI states

Design and implement empty, setup, loading, streaming, reconnecting, paused, awaiting approval, success, partial success, canceled, rate-limited, quota-blocked, permission-denied, provider-failed, offline, and destructive-confirmation states. Do not rely on toast messages as the only persistent explanation for a failed or blocked action.

## Codex UX parity and originality boundaries

### Preserve

- The task/thread-oriented workflow, dense developer-tool feel, incremental event streaming, prominent composer, clear tool-call/approval treatment, diff review, keyboard efficiency, and calm neutral hierarchy.
- Familiar relative placement of navigation, conversation/run history, primary work surface, run state, and contextual details when it improves migration and learnability.
- Existing Codex safety semantics, execution-policy concepts, and accessible interaction behavior where the base provides them.

### Intentionally modify

- Add organization switching and tenant scope indicators.
- Add provider/model/router selection with visible policy constraints.
- Add plan/usage status, member management, organization settings, billing, and platform administration.
- Make connection health, quota blocks, and fallback behavior visible.
- Use the Agent Harness identity and a dedicated design-token layer.

### Do not copy

- OpenAI/Codex names as the product name, logos, trademarks, proprietary icons, private copy, unavailable product behavior, or assets not licensed for reuse.
- Pixel-level layouts where a distinct implementation better serves multi-user or billing workflows.
- Undocumented service behavior inferred from screenshots as though it were an API contract.

Before release, complete source/license attribution, dependency notices, trademark review, and an upstream-diff review. Product parity means functional familiarity, not misrepresentation or brand imitation.

## Conceptual domain model

The implementation may rename entities to fit repository conventions, but must preserve these boundaries:

- `User`, `Credential`, `Session`, `RecoveryToken`
- `Organization`, `Membership`, `Role`, `Invitation`
- `Project`, `Workspace`, `Task`, `Run`, `RunEvent`, `Approval`, `Artifact`
- `ProviderType`, `ProviderConnection`, `Model`, `OrganizationModel`, `RoutingPolicy`
- `Plan`, `PlanVersion`, `Price`, `Subscription`, `Entitlement`, `SeatAllocation`
- `UsageEvent`, `UsageLedgerEntry`, `InvoiceReference`, `BillingWebhookEvent`
- `AuditEvent`, `FeatureFlag`, `BackgroundJob`

Every tenant-owned row must carry an organization identifier or be reachable only through a tenant-owned parent with database and application-level enforcement. Globally unique opaque IDs are preferred at external boundaries. Timestamps are stored in UTC.

## Non-functional requirements

### Security and privacy

- **NFR-SEC-001:** Follow OWASP ASVS-aligned controls for authentication, authorization, input validation, CSRF, XSS, SSRF, injection, session protection, and security headers.
- **NFR-SEC-002:** Hash passwords using Argon2id or an equivalently reviewed adaptive password hash with per-password salts and an upgrade path.
- **NFR-SEC-003:** Encrypt high-value secrets at rest, use TLS in transit, support encryption-key rotation, and redact sensitive values from all observability channels.
- **NFR-SEC-004:** Use deny-by-default authorization and include cross-tenant negative tests for every resource family.
- **NFR-SEC-005:** Apply rate limits and abuse controls to authentication, invitations, provider tests, task creation, tool approvals, exports, and billing endpoints.
- **NFR-SEC-006:** Treat model output, tool output, uploaded content, repository content, and provider error bodies as untrusted data.
- **NFR-SEC-007:** Define data retention, deletion, export, backup encryption, and restore validation. Record security-relevant actions in tamper-resistant audit storage.
- **NFR-SEC-008:** Run dependency, secret, license, and supply-chain checks in CI; generate an SBOM or equivalent dependency inventory for releases.

### Reliability and data integrity

- **NFR-REL-001:** Use idempotency keys or equivalent deduplication for task submission, subscription changes, webhooks, and retryable background operations.
- **NFR-REL-002:** Make streamed runs reconnectable without duplicate visible events; preserve monotonic per-run event ordering.
- **NFR-REL-003:** Use transactional updates for membership/role, entitlement, quota reservation, and billing-ledger changes.
- **NFR-REL-004:** Provide health/readiness checks, graceful shutdown, bounded retries, dead-letter handling, backup/restore runbooks, and migration rollback guidance.
- **NFR-REL-005:** Target 99.9% service availability for production deployments, excluding configured upstream provider outages, and report provider-dependent degradation separately.

### Performance and scale

- **NFR-PERF-001:** Target p95 under 500 ms for ordinary non-inference API requests under the agreed baseline load.
- **NFR-PERF-002:** Target application-shell LCP under 2.5 seconds on a representative desktop connection and immediate visible feedback after task submission.
- **NFR-PERF-003:** Stream incrementally with bounded buffers and backpressure; a slow or disconnected client must not exhaust server memory.
- **NFR-PERF-004:** Establish and load-test a documented initial capacity baseline for concurrent users, streams, queued runs, tenant count, and audit/usage volume before production launch.
- **NFR-PERF-005:** Paginate high-cardinality tasks, events, users, usage, invoices, and audit records; avoid unbounded context or payloads.

### Accessibility and localization readiness

- **NFR-AX-001:** Meet WCAG 2.2 AA for core journeys, including contrast, focus visibility, semantic labeling, keyboard operation, reduced motion, and non-color status cues.
- **NFR-AX-002:** Preserve focus and announce meaningful streaming, approval, error, and completion states without flooding assistive technology.
- **NFR-AX-003:** Externalize user-facing copy and format dates, numbers, currencies, and time zones through locale-aware utilities even if MVP ships in one language.

### Maintainability and operability

- **NFR-OPS-001:** Emit correlated structured logs, metrics, and traces for request, run, provider, webhook, and background-job paths with tenant-safe redaction.
- **NFR-OPS-002:** Version public/internal contracts that cross process boundaries and keep migrations forward-safe for rolling deployment where applicable.
- **NFR-OPS-003:** Isolate upstream Codex modifications, maintain a patch/upstream inventory, and document the update/rebase procedure.
- **NFR-OPS-004:** Keep provider, billing, storage, identity, and future extension boundaries replaceable through interfaces plus contract tests.

## Admin bootstrap and credential handling

The requested initial credential is:

- Username: `admin`
- Temporary password: the exact user-supplied value from the private deployment context, injected out of band and deliberately omitted from tracked documentation

This is a bootstrap requirement, not permission to hardcode a permanent shared credential. Implement it with all of the following controls:

1. the bootstrap runs only when no platform administrator exists;
2. the production secret is supplied through a secret manager, deployment secret, or one-shot initialization command, with the requested value usable as the explicit initial deployment value;
3. only a password hash is persisted;
4. plaintext is not logged, returned by an API, bundled into frontend assets, or committed to source configuration;
5. bootstrap is concurrency-safe and idempotent;
6. first login requires a password change and invalidates other sessions;
7. the bootstrap credential can be disabled/rotated before external exposure; and
8. automated tests use an injected test secret, not the production bootstrap value.

## Upstream Codex strategy

- Record the exact upstream repository URL, revision, license, and local modifications.
- If the repository is already present, inspect and use it; do not replace or reclone it destructively.
- Establish a clean boundary between upstream-derived runtime code and Agent Harness product modules.
- Prefer protocol adapters and composition. Keep any unavoidable upstream patches small, tested, and listed in a patch ledger with rationale.
- Preserve relevant Codex sandbox, approval, process-hardening, event, and thread semantics.
- Add contract and regression tests around every adapted upstream boundary.
- Define a recurring upstream update process: fetch, review release/security changes, reapply minimal patches, run compatibility tests, and record the adopted revision.

## Milestones and release gates

### M0 — Discovery, compliance, and architecture

- Inventory the repository, Codex execution surfaces, app-server/protocol boundaries, licenses, reusable UI, and existing test/deployment tooling.
- Produce an architecture decision record, threat model, data-flow diagram, upstream integration plan, and product gap map.
- Produce approved Claude Design artifacts and an implementation-ready design specification.

**Gate:** Architecture, license/trademark approach, threat model, and incremental delivery plan are reviewed before broad implementation.

### M1 — Identity and tenant foundation

- Database/migration foundation, authentication, sessions, bootstrap admin, organizations, memberships, invitations, RBAC, and audit log.
- Tenant-scoped API/query helpers and automated cross-tenant isolation suite.

**Gate:** All IAM acceptance criteria and cross-tenant negative tests pass.

### M2 — Provider gateway

- Provider adapter contract, secret storage, OpenAI-compatible path, native Anthropic/Gemini paths as required, model catalog, connection test, policy/allowlist, fallback, normalized streaming/errors, and usage capture.

**Gate:** Contract tests and at least one real or sandbox smoke test per supported protocol family pass; no credential appears in client bundles or logs.

### M3 — Codex task experience

- Tenant-scoped projects/tasks, Codex runtime integration, streaming/reconnect, composer, approvals, tool timeline, artifacts/diffs, cancellation/retry, usage, and error states.

**Gate:** Core agent journey passes end to end with interruption, reconnect, denial, failure, and quota scenarios.

### M4 — Subscription and administration

- Plan catalog, entitlements, seats, usage ledger, billing integration, verified webhooks, billing UI, organization administration, and platform console.

**Gate:** Subscription lifecycle and entitlement enforcement pass idempotency, downgrade, past-due, and authorization tests.

### M5 — Hardening and release

- Accessibility, performance/load testing, observability, backups/restores, security testing, dependency/license inventory, deployment runbooks, upgrade procedure, and release documentation.

**Gate:** No unresolved critical/high security findings; restore drill, accessibility review, release smoke tests, and operations sign-off complete.

## Acceptance criteria

### Bootstrap and authentication

- **AC-001:** Given a fresh database and explicitly supplied bootstrap values, when the system initializes concurrently, exactly one platform administrator named `admin` is created and the stored credential is not plaintext.
- **AC-002:** Given the bootstrapped administrator, when they first sign in with the requested temporary password, access is limited to the password-change flow; after change, the temporary password no longer works.
- **AC-003:** Given an initialized installation, when bootstrap is attempted again, no account or password is changed and the event is safely rejected/audited.

### Tenant isolation and RBAC

- **AC-010:** Given members of two organizations, neither can enumerate, fetch, mutate, stream, approve, export, or infer identifiers/counts for the other's resources through API, UI, realtime, artifact, or job paths.
- **AC-011:** Given each defined role, its permission matrix is enforced server-side and covered by positive and negative tests.
- **AC-012:** Given a removed or suspended membership, existing organization access is revoked and subsequent realtime/API actions fail without leaking data.

### Providers and routing

- **AC-020:** An organization administrator can configure, validate, rotate, and disable an OpenAI-compatible provider connection; a member can use an allowed model but cannot retrieve connection secrets.
- **AC-021:** The Anthropic and Gemini protocol families can stream normalized content/tool events or return a precise unsupported-capability state.
- **AC-022:** When a primary provider fails before unsafe side effects and policy permits fallback, the ordered eligible fallback is used and displayed/audited; otherwise the run stops safely.
- **AC-023:** A custom/local endpoint that violates endpoint policy is rejected, and redirects/DNS resolution cannot bypass the policy.
- **AC-024:** Provider credentials are absent from browser storage, client bundles, URLs, traces, logs, analytics, errors, exports, and task transcripts in automated secret-canary tests.

### Agent task experience

- **AC-030:** A permitted member can create a task, receive ordered streamed events, inspect tools and diffs, approve/deny gated actions, cancel, reconnect, and resume without duplicated visible events.
- **AC-031:** Provider, permission, quota, timeout, network, and internal failures render distinct actionable states and retain correlation metadata for authorized support.
- **AC-032:** Server-side limits stop over-budget or over-concurrency dispatch even when clients forge UI state or disconnect.

### Subscription and usage

- **AC-040:** A verified billing event changes subscription/entitlement state once even if delivered repeatedly or out of order, with reconciliation resolving discrepancies.
- **AC-041:** A plan limit is enforced consistently in the UI, API, and background dispatcher, and the blocked user sees the responsible limit and allowed next action.
- **AC-042:** Authorized billing users can reconcile seat count, usage ledger totals, quota status, and processor invoice/subscription references for a billing period.
- **AC-043:** A downgrade with excess seats or disallowed features follows the documented grace/remediation policy without deleting data unexpectedly.

### UX, accessibility, and operations

- **AC-050:** The primary task workflow is recognizably Codex-like in interaction model, uses Agent Harness branding, and contains none of the prohibited OpenAI/Codex brand assets.
- **AC-051:** All core journeys are keyboard-operable with visible focus, semantic labels, non-color-only status, and tested light/dark contrast.
- **AC-052:** Operational dashboards and alerts distinguish application failure, provider failure, quota block, and billing/webhook failure using redacted correlated telemetry.
- **AC-053:** A documented backup restore and an upstream update rehearsal complete successfully in a non-production environment.

## Product decisions still requiring owner approval

Do not invent these silently during implementation:

- Public product name, logo, and final visual identity.
- Initial plan names, pricing, included quotas, overage rules, trial length, currencies, and taxes.
- First payment processor and supported countries.
- Whether self-service organization creation is open, invite-only, or administrator-provisioned.
- Data retention/deletion periods and enterprise compliance commitments.
- Deployment topology and whether local providers are reached from a desktop runtime, customer-hosted worker, or central server.
- The precise list of models enabled by default and whether estimated provider costs are passed through, marked up, or informational only.
- Required enterprise identity features and launch scale/SLO commitments.

Where these decisions block production behavior, implement explicit configuration and safe disabled states rather than placeholder claims.
