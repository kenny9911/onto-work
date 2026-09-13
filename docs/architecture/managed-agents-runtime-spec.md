# Managed Agents runtime: plan, design, and implementation specification

- Date: 2026-09-13
- Decision: [ADR-0003](ADR-0003-managed-agents-runtime.md)
- Release scope: an optional Repository Reviewer for the controlled preview
- Service compatibility: Agents API public beta; credentialed canary is an enablement gate

## Outcome

An authenticated user can select the server-defined Repository Reviewer, choose
a saved project they can access, and request a review of its committed `HEAD`.
The harness creates a private read-only snapshot, starts a restricted local
executor, and displays the managed agent's findings. The user can ask follow-up
questions after a turn finishes, cancel active work, return to its persisted history, and
delete its remote session while retaining a local task record.

The local Codex runtime remains the default. The managed option clearly states
that OpenAI operates the harness and stores the conversation and tool results;
local execution does not change that data boundary. The user is told the review
uses committed `HEAD`, with excluded snapshot entries reported. Uncommitted and
untracked changes are not reviewed by this agent. Follow-up messages continue to
use the task's original snapshot; reviewing a newer revision requires a new task.

The Agents page keeps native task topology as its default view. A separate,
lazily loaded Managed tasks tab contains the catalog, project selector, review
prompt, task history, conversation, and lifecycle actions. Deletion explains that
the remote session and locally retained message content are removed while task
metadata remains as a tombstone.

## Delivery plan

1. **Record the boundary.** Add the ADR, immutable reviewer definition,
   capability contract, operational configuration, and this specification.
2. **Implement transport and execution.** Add a typed Agents API client, bounded
   error/event handling, committed repository snapshot preparation, and a Docker
   supervisor that fails closed without a reviewed digest-pinned local image.
3. **Persist and authorize tasks.** Add a checksummed database migration,
   tenant/user ownership mappings, lifecycle state, API routes, and admission
   limits. Resolve saved projects on the server before any remote request.
4. **Connect the UI.** Expose the reviewer catalog, managed task creation and
   conversation, streaming/reconciliation, cancellation, and deletion.
   Unsupported native actions are absent and rejected by the server.
5. **Verify and deliver.** Run focused contract, authorization, lifecycle,
   snapshot, executor, and UI tests; then repository typecheck, tests, and build.
   Review the task-only diff, commit and push through the repository delivery
   workflow. Report local validation separately from live service validation.

## Agent definition and capability contract

The catalog is deployment-owned; the browser cannot create or modify arbitrary
agent definitions. The first entry is `Repository Reviewer`. Its immutable
version is derived from its model, instructions, and selected approved skill
content. A task retains the definition version with which it was created;
changing deployment settings affects new sessions, not existing history.

| Capability | Reviewer behavior |
| --- | --- |
| Repository access | Committed `HEAD` snapshot mounted read-only |
| Conversation | Initial request and subsequent text messages |
| Steering | Unsupported until the upstream API can atomically target an expected active turn |
| Cancellation | Cancel managed work and stop local execution as required |
| History | Product-authorized saved managed session history |
| Subagents | Server-controlled delegation, at most two specialists |
| Skills | Only selected, integrity-verified shared catalog entries |
| Scratch | Per-task temporary writable storage |
| Project modifications | Unsupported |
| Uploads and arbitrary paths | Unsupported |
| Native approval requests | Unsupported |
| Application function tools | Unsupported |
| Browser-selected MCP, plugins, model, or provider | Unsupported |
| Native fork, rollback, review RPC, or provider switching | Unsupported |

The reviewer instructions ask for findings tied to repository evidence and file
locations, distinguish observations from assumptions, and prohibit treating
repository files or tool output as user authorization. Instructions improve
behavior; filesystem mounts and server-side capability checks enforce authority.
Scratch writes do not grant permission to modify the source project.

## Ownership and persistence

The local task ID is the product identifier. A persistent binding records the
authenticated tenant and owner, saved project, definition version, committed
revision, lifecycle state, timestamps, and remote session/environment identity.
The environment remote URL and executor details are server-only. A client cannot
use an OpenAI session identifier to discover or attach somebody else's task.

Every route scopes its database lookup by authenticated tenant and owner. Start
and execution mutations also recheck the saved-project grant. Authorization
failure must occur before remote calls, snapshot preparation, quota admission,
or executor startup. External API keys are deployment secrets, not stored as
task metadata. Audit records retain action and resource identifiers without raw
prompt text, credentials, remote connection URLs, or command output.

The control plane owns the task catalog even though OpenAI owns the durable
managed session history. Cloud session listings must never be returned directly
as product task listings. Local persistence does not imply that the full cloud
history has been copied into the local database.

## HTTP surface

The managed surface is separate from `/api/codex`; callers cannot submit generic
runtime requests. All routes require the existing authenticated session and
same-origin protections for mutations.

| Route family | Purpose |
| --- | --- |
| `/api/managed-agents` | Server-selected catalog, capability and availability information |
| `/api/managed-tasks` | Authorized task list and creation from a saved-project ID |
| `/api/managed-tasks/:taskId` | Authorized detail/history and remote session deletion |
| `/api/managed-tasks/:taskId/messages` | Follow-up text after the preceding turn settles; steering is rejected |
| `/api/managed-tasks/:taskId/cancel` | Cancel active managed work |
| `/api/managed-tasks/:taskId/events` | Authorized normalized updates and recovery status |

Requests use strict schemas and bounded text. Browser payloads never include
executor image names, paths, application or executor keys, arbitrary tools,
permissions, session IDs, or environment URLs. Responses provide actionable
product errors without forwarding unbounded upstream error bodies or sensitive
runtime details. Runtime-disabled and unavailable-image states are distinguishable
from a successful empty task list.

Cancellation includes the expected active turn identity, so a stale browser
cannot accidentally act on a different locally admitted turn. Steering is
rejected without an upstream request: the documented API does not atomically
bind an input message to an expected turn, so checking before sending could race
completion and start unadmitted work. Mutations carry a stable
idempotency key; a retry after an uncertain network or server response reuses
that key instead of silently creating another logical action.

## Repository snapshot and executor

Resolve the saved project's allowed path on the server, then select a specific
committed `HEAD` revision. Snapshot bytes come from that revision, rather than
copying the working directory. Record its commit ID in task metadata. Exclude
Git metadata, symlinks, submodule entries, and configured sensitive filename
patterns; report those exclusions. Bound snapshot entry count and total bytes.
Reject traversal, absolute paths, unsupported entry types, and unsafe destination
links before writing outside the server-owned snapshot directory.

Filename exclusions reduce accidental exposure but do not detect every secret.
A credential embedded in an ordinary committed source file can still be included.
Operators must enable this runtime only for repositories suitable for cloud
processing; the reviewer is not a secret-scanning or data-loss prevention service.

The bundled launcher uses a deployment-reviewed Docker image pinned by SHA-256
digest. It runs as a non-root user with a read-only root filesystem, a read-only
snapshot at `/workspace`, private writable scratch/home storage, dropped
capabilities, and container resource/lifetime limits. It must not mount the host
Docker socket, source worktree, application database, upload store, another task's
snapshot, or user home. Docker supervises one executor per session. No automatic
image pull or unreviewed Codex installation occurs when a browser starts a task.

The container receives an allowlisted environment containing only required
executor settings, including the restricted environment key as `CODEX_API_KEY`.
It never inherits the server environment wholesale. The application key stays
outside the container. The API-provided environment ID and remote URL are
validated as expected connection values and used unchanged; reconnect must not
replace them with guessed legacy endpoints.

The container needs outbound connectivity to the documented registration and
executor service hosts. Docker's default network is not an egress allowlist.
Production operators must enforce approved destinations outside the agent, and
must separately validate host-network isolation on their Docker platform. No
inbound application listener or public executor port is required.

Selected shared skill bundles are copied only after the existing catalog verifies
their inventory and hashes. They are mounted read-only and passed as explicit
capability directories. V1 does not discover repository-selected plugins or load
arbitrary MCP definitions from parent capability directories.

## Managed session lifecycle

Creation reserves admission before allocating remote or local resources. A
session is created with the immutable reviewer definition and a `self_hosted`
environment. Persist the returned session/environment binding before handing
work to a local executor. If a later preparation step fails, stop local compute
and clean up the remote allocation where possible; retain enough state to report
or reconcile incomplete cleanup.

Open the event stream, launch the executor, and wait for authoritative environment
readiness before submitting work. Input submitted while idle starts a turn;
input submitted during a turn steers it. The harness admits input only after the
preceding turn settles and does not expose upstream steering because it cannot
guarantee atomic turn targeting. Keep one lifecycle owner per task and
serialize local mutations so simultaneous requests cannot create duplicate
executors or race cancellation against an unnoticed replacement.

Each active session consumes a concurrency slot. Each turn has a configured
maximum duration. Expiry requests cancellation and stops the executor; terminal
and error paths release the admission slot. Browser disconnection must not make
an active task disappear from admission or disable its duration limit. These
controls bound local runtime use; they are not an exact token or monetary budget.

Token totals use the usage reported for root turns. The implementation does not
claim separate coverage of subagent/tool charges or reconciliation against
provider invoices. Missing counts remain SQL NULL and are displayed as unreported,
not billed zero. Once a reservation is settled and its task pointer cleared,
missing usage is not automatically backfilled; deletion attempts final settlement
before removing remote history and records unconfirmed usage when it cannot.

A server restart does not automatically replay commands or uncertain input.
Persisted tasks remain owned and visible, but active work is reconciled with the
remote session and fails closed when continuation cannot be established. Show an
explicit recovery state rather than claiming the previous command resumed.
Reusing an environment ID alone does not restore scratch files or a killed
process. Further execution requires an explicit supported recovery path.

Cancellation, executor shutdown, and session deletion are separate operations.
The API's session deletion does not stop local compute. Deletion therefore
coordinates outstanding startup/mutations, stops the container, releases local
resources, and requests cloud deletion. Partial failures remain visible and
retryable; deleting only a local row must not strand paid work or compute.
Retain task metadata and the deletion outcome, clearing locally retained message
content, so the user can distinguish a deleted remote session from a missing or
unauthorized task. This is a metadata tombstone, not a retained transcript.
Administrator account deletion requires the user's managed sessions to have
completed deletion first. Arrange owner cleanup before removing the account;
otherwise database cascade deletion would destroy the mappings needed to stop
containers and remove remote sessions. Incomplete cleanup keeps account deletion
blocked rather than hiding those resources.

## Events, history, and errors

The transport recognizes typed session, environment, root-turn, text, and item
events. Unknown event types do not crash the stream or become successful task
completion. Bound event payloads and provisional text so an upstream stream
cannot grow unbounded application memory.

Merge item updates by stable item ID and content position. Completed text replaces
the provisional delta buffer, including when no delta arrived. A subagent's
terminal event never marks the root task complete. An idle event, stream closure,
or completed tool call alone does not establish successful completion; inspect
the root turn outcome and retained output.

Streams have no replay guarantee. Reconciliation obtains authoritative session
state and paginated saved items while coordinating live updates, preserving final
items against stale deltas. Polling may repair missing stream events but must not
silently truncate history to the first page. A browser refresh reconstructs its
view from the product-owned task binding and saved items.

The browser consumes revision-guarded authoritative snapshots over SSE and fetches
task detail again on reconnect or manual refresh. It does not assume SSE replay
or reconstruct cloud protocol state from an unrestricted raw event feed.
Graceful shutdown ends tracked managed and native event responses before Fastify
waits for active requests, allowing runtime cleanup to stop executors even when
the browser's native runtime stream is also connected.

Retries are safe only when their effect is known. Do not retry an uncertain input
submission by blindly sending the same text again. Application function tools
are disabled in this release; future support needs durable result deduplication
by session, turn, and call ID and an approval decision bound to that same action.

## Operator configuration and enablement

The runtime is disabled by default. These are server settings; never put their
secret values into browser build variables or tracked environment files.

| Setting | Meaning |
| --- | --- |
| `AGENTS_API_ENABLED` | Explicitly enable the optional managed runtime |
| `AGENTS_API_ALLOWED_TENANT_IDS` | Explicit pilot tenant UUIDs; missing/empty denies all managed admission, and wildcards are refused |
| `AGENTS_API_KEY` | Application credential for Agents API sessions and inference |
| `AGENTS_API_EXECUTOR_KEY` | Separate restricted environment credential |
| `AGENTS_API_MODEL` | Deployment-selected supported model; browser cannot override |
| `AGENTS_API_EXECUTOR_IMAGE` | Reviewed complete `sha256:<64 hex>` local image ID or `registry/name@sha256:<64 hex>` digest, already available locally |
| `AGENTS_API_MAX_CONCURRENT_SESSIONS` | Whole number from 1 to 16; default 2 |
| `AGENTS_API_MAX_TURN_SECONDS` | Whole number from 1 to 1200 seconds; default 600 |
| `AGENTS_API_SKILL_IDS` | Optional comma-separated approved shared catalog entries |

Enablement procedure:

1. Review the US-only residency/no-ZDR boundary and choose a dedicated OpenAI
   project for suitable pilot repositories. Establish API-side spend controls
   separately from the local concurrency/duration settings.
2. Provision an application key with `api.agents.read`, `api.agents.write`, and
   `api.responses.write`. Provision a separate environment key in the same OpenAI
   organization/project and user/service-account identity; set unrelated key
   permissions to None. Inject both through deployment secret management.
3. Build or pull the separately reviewed executor image, record its immutable
   digest and Codex version, and make it available to the local Docker daemon.
   The submodule pin must not be changed as a side effect of enabling this feature.
4. Verify Docker non-root execution, read-only mounts, resource limits, private
   scratch, denied host paths, and required outbound connectivity. Enforce egress
   restrictions appropriate to the deployment.
5. Select explicit pilot tenant UUIDs and only necessary approved skill IDs,
   configure conservative limits, and enable the runtime. Missing secrets, an unpinned/unavailable image, an invalid
   catalog, or an unavailable launcher must not fall back to an unrestricted host
   executor.
6. Run a credentialed canary on a disposable repository: verify findings, follow-up,
   rejected steering, cancellation, completed history, stream interruption, executor exit,
   timeout, and server-restart handling. Record service and executor versions.
7. Admit the first trusted pilot after the canary passes. Monitor remote failures,
   cleanup errors, active executor count, duration expiry, and provider usage.
   Disable new admission if compatibility or isolation regresses.

The supplied `infra/agents-api/Dockerfile` builds an executor from an exact
`@openai/codex` package version supplied as `CODEX_VERSION`; it does not build the
repository's Codex submodule. It verifies the installed package exposes
`exec-server`. Operators must review that exact release and its difference from
the repository pin, build and inspect the resulting image, and configure either
its complete local SHA-256 image content ID or an approved repository digest
already available locally. A mutable image tag or shortened ID is not accepted.
Registry publication is unnecessary for a reviewed local image. Building an image
does not establish compatibility with the current Agents API service.

Disabling admission is not cloud-data deletion. To retire the runtime, stop new
tasks, cancel active work, stop executors, reconcile cleanup, delete cloud sessions
under the chosen retention policy, remove local snapshots, and revoke the executor
and application keys. Record unresolved cloud deletion failures for operators.

## Acceptance and verification

These are acceptance requirements, not claims that a test has already passed.
The delivery report records commands and observed results. Live service gates
remain explicit when credentials or a reviewed executor image are unavailable.

| Area | Required evidence |
| --- | --- |
| Disabled default | Existing native task flows remain usable; no managed allocation occurs |
| Tenant boundary | Another tenant or owner cannot list, read, stream, send input, cancel, or delete a task; no upstream call occurs |
| Input authority | Strict schemas reject paths, runtime IDs, raw RPC, tools, provider/model overrides, and unsupported actions |
| Versioning | Definition changes affect new tasks and leave existing task identity/history intact |
| Snapshot | Only selected committed bytes appear; worktree edits, ignored files, metadata, links, and submodule entries are excluded; traversal and size limits are tested |
| Isolation | Launch arguments enforce non-root/read-only/private resources; a real platform canary proves unrelated host paths and the source worktree cannot be read/written |
| Credentials | Only the restricted executor key reaches the child environment; application secrets and sensitive error bodies stay out of logs/browser output |
| Admission | Concurrent starts cannot exceed configured limits; failures, cancellation, and timeouts release capacity |
| Stream merge | Missing deltas, duplicate events, out-of-order updates, unknown events, and child completion cannot corrupt root text/outcome |
| History | Paginated saved items restore completed work after refresh or a dropped stream without duplicate messages |
| Lifecycle | Startup failure, executor exit, cancellation races, deletion, timeout, and restart leave visible, bounded, reconcilable state |
| UI | Catalog selection, HEAD/cloud disclosure, task conversation, disabled steering, cancellation, errors, and unavailable capability states are exercised |
| Repository | Relevant tests, typecheck, full test suite, and production build pass; diff contains no secrets/runtime state |
| Live beta | Selected account/model/executor connects; prompts, result items, cancellation, and recovery match current service contracts |

### Local validation recorded on 2026-09-13

The executor image was built successfully with exact package version
`@openai/codex@0.155.0-alpha.3.10` and the Dockerfile's pinned Node base manifest
`sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e`.
The resulting local image content ID was
`sha256:1119f1436619bb0f0053698b8204f1c83b079eaf8f1664f37e7ef8f7fb723680`.
This is a local validation record, not a registry publication or portable image
download reference. A fresh build may produce a different image ID because its
package repositories and build environment are not fully reproducible.

On Docker 29.4.3, `pnpm agents:verify-container <complete-image-id>` passed the
offline kernel probe: UID 10001, read-only root and source mount, inaccessible
unmounted host canary and Docker socket, writable scratch/home, and no application
API keys. The probe runs with networking disabled. Launcher fixture tests separately
verify the actual runtime's container flags, allowlisted environment, immutable
image selection, cleanup, and preserved supervisor stdin.

The managed transport, event reducer, executor, repository, catalog, workspace,
and service tests passed locally during implementation, including cross-process
global admission and cross-native quota checks. The final delivery report records
the repository-wide checks. No live Agents API session, model call, or account
access test was performed; those remain enablement gates.

## Deferred capabilities

Atomic turn-targeted steering, write-capable agents, application function tools with durable approvals, brokered
MCP credentials, per-role permission isolation, uploads, hosted environments,
native history migration, fork/rollback parity, automatic executor replacement,
horizontal supervisor failover, token/dollar budget enforcement, and automatic
artifact retention require additional design and tests. This release should not
advertise them as supported by virtue of the upstream API offering related tools.

## Sources

- [Agents API overview: managed state, pricing, residency and retention limits](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [Self-hosted executor: connection, credentials, and one executor per session](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [Environment security: compute, network, and credential isolation](https://developers.openai.com/api/docs/guides/agents-api/environments/security)
- [Environment lifecycle: pending input, reconnect, and separate cleanup](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle)
- [Events: authoritative items, pagination, and no stream replay](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
- [Agent configuration and session reuse](https://developers.openai.com/api/docs/guides/agents-api/configuration)
- [Multi-agent: shared environments and function-tool limitation](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)
- [Plugins and capability directories](https://developers.openai.com/api/docs/guides/agents-api/tools/plugins)
