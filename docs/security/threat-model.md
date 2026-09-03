# Agent Harness threat model

- Status: Production-foundation preview threat model
- Date: 2026-09-02
- Review cadence: before each production release and whenever an execution, identity, gateway, billing, or plugin boundary changes

## Scope and assumptions

This model covers the browser application, control plane, authentication and authorization, runtime supervisor, isolated Codex app-server processes, workspaces and thread stores, model gateway, provider credentials, Stripe integration, and administration surface.

Applications, user-installable skills/templates, arbitrary plugins, arbitrary MCP servers, and repository hooks are not part of the current preview trust set. They are untrusted and disabled unless an administrator has explicitly allow-listed a version and permission manifest.

The production-foundation preview is limited to local development and trusted pilot tenants. That reduces exposure; it does not waive the release-blocking controls listed below. Implemented controls and required future controls are deliberately separated in the README and [full-product blueprint](../architecture/full-product-blueprint.md).

## Assets

- user identities, password hashes, sessions, MFA/recovery material, and organization memberships;
- provider, gateway, Stripe, signing, encryption, and database credentials;
- source repositories, uncommitted changes, generated patches, artifacts, and terminal output;
- prompts, agent reasoning where retained, thread history, approvals, and audit records;
- subscription status, entitlements, usage, quotas, prices, invoices, and webhook events;
- runtime images, Codex binaries/configuration, workspace mounts, thread-store volumes, and sockets;
- administrative privileges and supply-chain provenance.

## Trust boundaries and principal rules

1. **Browser to control plane:** all input is attacker-controlled; authentication is not authorization.
2. **Control plane to runtime:** only the supervisor can create a process, choose its tenant/workspace, and send app-server messages.
3. **Runtime to workspace:** repository content and generated code are untrusted; the runtime has only the selected workspace and permission profile.
4. **Runtime to gateway:** the runtime gets a short-lived scoped credential and public alias, never a provider key.
5. **Gateway to provider:** the gateway owns provider secrets, egress, route policy, usage capture, and upstream error normalization.
6. **Stripe to control plane:** only signature-verified, replay-safe webhooks affect subscription state.
7. **Administrator to platform:** platform admin is a separately audited privilege, not an organization role shortcut.

Every durable record and authorization decision is keyed by organization. Product IDs are opaque; possession of an ID conveys no authority.

## Primary threats and controls

| Threat | Required preview controls | Additional production hardening |
| --- | --- | --- |
| Cross-tenant IDOR or confused deputy | Central authorization middleware; scope every query by organization and membership; server-derived owner/tenant fields; negative tests for every endpoint | Database row-level security; policy-as-code review; continuous cross-tenant canaries |
| Shared runtime data leak | Dedicated process/container, OS identity, `CODEX_HOME`, volume, socket, and workspace per tenant workspace; no public app-server listener | MicroVM-grade isolation where warranted; per-job nodes; attested images and runtime identity |
| Container/sandbox escape | Non-root runtime, least-capability seccomp/AppArmor profile, read-only base filesystem, bounded writable mounts, CPU/memory/PID/time limits | Dedicated worker pools, kernel isolation, rapid patch SLA, external sandbox service |
| Shell secret exfiltration | Generated policy inherits only Codex's `core` set, retains default secret exclusions, and explicitly removes the provider/base-URL variables; a live environment canary verifies the provider key is absent and `PATH` remains | Move upstream keys out of Codex entirely; recurring secret canaries, egress identity, DLP, automated environment and layer scanning |
| Prompt or repository injection | Treat prompts, `AGENTS.md`, code, tool output, diffs, and web content as data; server-selected permissions; approval for high-impact tools | Content provenance, policy engine, high-risk dual control, behavioral detection |
| Malicious hook/plugin/skill/MCP server | Disabled by default; signed allow-list by exact version; declare filesystem/network/process capabilities | Sandboxed extension workers, review pipeline, revocation, tenant-specific catalogs |
| Provider credential disclosure | Direct-route keys are encrypted at rest and omitted from config/tool-shell output; gateway routes give Codex only a scoped virtual key while upstream keys remain in gateway credential storage | Remove direct provider keys from Codex entirely; KMS/HSM envelope encryption, workload identity, automatic rotation, egress allow-list |
| Gateway alias bypass | Server chooses alias; tenant-scoped token has allowed aliases and limits; reject arbitrary base URLs and headers | Policy enforcement point independent of gateway implementation; signed route config |
| Gateway/provider credential confusion | Treat LiteLLM `Authorization` as gateway authentication only; never place an upstream provider key there; bind a model-restricted virtual key to a server-provisioned tenant credential/route | Short-lived workload identity; transactional provisioning/revocation; continuously test tenant/model isolation |
| Client-supplied LiteLLM BYOK leakage | Do not use request-body `api_key` or proxy-wide client credential passthrough on the pinned `v1.99.0`; do not rely on Codex to emit a second body credential | Adopt only after the upstream fix is released, pinned, independently tested for concurrent cross-tenant calls, and supported by an explicit broker adapter |
| Responses translation mismatch | Contract-test streaming, tools, reasoning, cancellation, errors, and usage per provider/model before enablement | Canary/shadow traffic, automated quarantine, schema compatibility SLOs |
| SSRF and local-network access | Runtime and gateway egress allow-lists; reject user-controlled provider base URLs; block metadata/private networks | Egress proxy with DNS rebinding protection and workload identity |
| Log or telemetry disclosure | Structured logs with deny-list/allow-list fields; redact auth/cookies/prompts/tool data by policy; restricted retention | Field-level encryption, tenant log partitions, automated privacy scans |
| Approval spoofing/replay | Per-user pending set, 30-minute TTL, 128-entry cap, method match, single-use consume/replay rejection, and audit binding to thread, turn, item, and canonical action digest | Durable shared pending state, failover recovery, step-up authentication, and dual approval for destructive/high-value actions |
| Session theft or privilege escalation | Secure HttpOnly/SameSite cookies, CSRF protection, rotation, short privileged sessions, password rate limits, revoke on role change | MFA/passkeys, device/risk signals, SSO/SCIM, just-in-time platform admin |
| Bootstrap administrator compromise | No credential in source/image/logs; one-time secret injection; salted scrypt hash; forced change; guarded local reset only | Production refuses startup when bootstrap/default credential is enabled; Argon2id policy, MFA, and audited break-glass accounts |
| Stripe webhook forgery/replay | Verify signature against raw body and endpoint secret; timestamp tolerance; unique event ID; transactional handler | Reconciliation jobs, alerting, multiple-endpoint key rotation, finance audit trail |
| Double spend or quota race | Reserve quota transactionally before dispatch; idempotency key per attempt; immutable usage reconciliation | Distributed reservation service, provider invoice reconciliation, anomaly limits |
| Supply-chain compromise | Pin Codex submodule and LiteLLM image version; lock dependencies; scan source/images; retain provenance | Verify signed releases/digests, SBOM and attestations, admission policy, reproducible builds |
| Data remanence | Tenant retention policy; encrypted storage/backups; explicit workspace/runtime cleanup; deletion audit | Cryptographic erasure, legal-hold workflow, regularly tested deletion SLA |
| Malicious upload path or filename | Client filename is a display label only, never a path component; blob names are server-generated UUIDs and extensions come from a server-decided content type; every directory component is created non-recursively and re-resolved, with `O_EXCL` plus an `nlink` check at the leaf and `fchmod` through a descriptor | `openat2`/`RESOLVE_BENEATH`-class atomic path resolution, or a store on a filesystem the runtime user cannot write |
| Upload storage exhaustion | Route-level byte counter independent of `bodyLimit` (a streaming content-type parser bypasses it), declared-versus-actual length equality, throughput floor and wall clock, per-user concurrency cap, per-route rate limit, and a transactional storage reservation settled or released per attempt | Per-tenant object storage with hard quota enforcement, upload lifecycle SLOs, and abuse detection |
| Upload content-type confusion | The wire type is fixed to `application/octet-stream` so the client declares nothing; the server classifies from the bytes and admits only a UTF-8 text allow-list; no binary parser and no magic-number dependency runs in the control plane | Archive and document support behind an isolated extraction worker, never in the trusted process |
| Injection via uploaded file content | Bytes reach the model as tool output, never as an input item; a server-authored envelope frames them as data and is appended last; forgery of that envelope is refused across the concatenation of all input items after normalization; `acceptForSession` is refused while a thread holds an attachment; no turn is auto-dispatched on upload | Content provenance and policy engine; dual control for high-risk actions in a turn that consumed untrusted content |
| Cross-tenant upload disclosure | Per-user double-hashed storage shard, composite foreign keys and scope triggers, re-authorization on every read with 404 rather than 403 so IDs are not oracle-able, and blobs encrypted at rest | Per-tenant OS identity or kernel isolation — the pinned Codex has unconditional full-disk read, so this is not solved by placement |
| Local Ollama bridge compromise | “Local” means local to the isolated runtime host; no implicit access to a user's laptop | Authenticated outbound-only local runner/tunnel with device binding, consent, rotation, and revocation |

## Bootstrap administrator policy

The bootstrap username/password supplied during product planning is already disclosed in conversation context and must be treated as compromised. This document intentionally does not reproduce it.

- It may be used only as a local-development convenience, supplied through ignored environment/secret storage.
- Never commit it, bake it into a container, migration, fixture, client bundle, screenshot, documentation, or CI log.
- The preview hashes passwords with Node's salted scrypt implementation. The production target is Argon2id through a maintained password library with calibrated parameters and unique salts. Never encrypt or log plaintext passwords.
- On first boot, create the account only when the user table is empty and an explicit bootstrap flag plus secret are present.
- Mark it `must_change_password`, expire the bootstrap session after the change, and permanently record bootstrap completion.
- Production and shared staging must fail closed if a known/default password or bootstrap mode is present.
- Platform administrators require MFA before broad production, short sessions, rate limits, alerting, and immutable audit events.
- Prefer a one-time setup URL/token or external identity provider over a reusable password.

The preview includes `pnpm reset-admin` only for deliberate local recovery. It is disabled when `NODE_ENV=production`, requires the one-shot `CONFIRM_BOOTSTRAP_ADMIN_RESET` value to exactly match the configured bootstrap username, accepts only an existing administrator, invalidates that user's sessions, records `auth.bootstrap_password_reset`, and restores mandatory password rotation. The temporary password stays in ignored environment/secret storage and must never be placed on the command line. This control does not replace production recovery, MFA, or break-glass governance.

## Codex-specific security decisions

- Use stdio or a permission-restricted Unix socket. Do not put the experimental app-server WebSocket listener on a tenant or public network.
- Generate runtime configuration outside the checkout. Project configuration cannot be trusted to choose provider/auth/host metadata.
- The generated config sets `shell_environment_policy.inherit = "core"`, leaves default secret exclusions enabled with `ignore_default_excludes = false`, and explicitly excludes `AGENT_HARNESS_PROVIDER_API_KEY` and `CODEX_OSS_BASE_URL`. A live `command/exec /usr/bin/env` canary confirmed that the provider-key variable is absent while `PATH` is present.
- The shell policy reduces tool-command exposure but does not remove the credential from the app-server process. Production must give Codex only a scoped gateway identity; a provider key in the child environment remains exposed to app-server compromise, diagnostics, and crash handling.
- Codex provider `env_key` becomes the outbound bearer `Authorization` value. For LiteLLM this value must be a tenant-scoped virtual key, not an upstream provider key or the master key.
- The pinned LiteLLM `v1.99.0` accepts a provider `api_key` in a Responses request body and has an unresolved cross-caller persistence report ([#36794](https://github.com/BerriAI/litellm/issues/36794)); its hardening PR ([#36812](https://github.com/BerriAI/litellm/pull/36812)) remains open. Use gateway-side named credentials with team/project routing or a unique tenant deployment/alias, and keep proxy-wide `allow_client_side_credentials` disabled.
- Keep repository hooks, arbitrary MCP endpoints, plugins, and skills disabled until their permission and isolation model has been reviewed.
- Do not expose global `thread/list` results. The control plane resolves only the product thread IDs owned by the requesting tenant.
- Treat thread JSONL, SQLite state, terminal transcripts, patches, screenshots, and generated artifacts as tenant-confidential data.
- `SandboxPolicy::has_full_disk_read_access()` is unconditionally true in the pinned Codex — the seatbelt profile carries a bare `(allow file-read*)` and the bubblewrap profile a `--ro-bind / /`. Nothing is hidden from the agent by where it is placed; only writes are constrained. Any control that depends on the agent not finding a file is not a control.
- Uploaded files live under `UPLOAD_DATA_DIR`, which startup refuses to run with if it overlaps `ALLOWED_WORKSPACE_ROOTS` in either direction. Keeping them out of a workspace protects the user's tree, the review scope, and the retention story — not confidentiality from the agent.
- The upload route uses a pass-through content-type parser, which means Fastify's `bodyLimit` does **not** apply to it. The route counts bytes itself. The compensating benefit is that the handler runs before any body byte is consumed, so authentication happens first; do not "simplify" this back to a buffering parser.
- Extraction is deliberately not automatic. A person must send a turn before uploaded bytes are placed in front of a shell-capable agent.

## Target billing and entitlement invariants

- The authenticated organization, not a request body field, selects the subscription.
- Stripe events update a versioned entitlement snapshot; they do not directly execute user work.
- Entitlement checks and quota reservation happen before runtime dispatch.
- Usage records are append-only and reference the request, route alias, provider/model, pricing version, token measurements, reservation, and reconciliation state.
- Duplicate and out-of-order webhooks are safe. Subscription downgrades and revocations converge deterministically.
- Failed, cancelled, retried, cached, and partially streamed calls have explicit accounting rules.
- The browser never decides price, balance, plan, or whether a paid capability is allowed.

The current preview satisfies a subset: seat creation/reactivation and active-run/request admission are serialized; processed Stripe event IDs/outcomes are durable; older event timestamps are rejected; billing-period boundaries are preserved; and subscription, entitlement, and audit mutations are atomic. It does not yet persist a raw webhook inbox, deterministically order distinct same-timestamp events, independently resolve Stripe metadata to an operator-provisioned tenant mapping, reconcile provider invoices/prices, or account for partial in-flight token use after a restart.

Current Projects, Usage, Audit, and task-history reads remain narrow security boundaries. Projects exposes only roots derived from currently authorized thread bindings; Usage is a tenant aggregate rather than a downloadable ledger; Audit is administrator-only and scalar-filters, redacts, and bounds metadata; history rechecks tenant, user, canonical workspace, and current grant before returning a bounded snapshot. Same-tenant actor/provider ownership is enforced at store boundaries, not yet by composite database constraints against direct SQL. Usage reservation response payloads have no retention or content-classification policy. Cross-tenant guessed-ID and secret-canary tests remain required for each expansion of these surfaces.

## Abuse cases to test

1. User A guesses User B's organization, project, workspace, thread, artifact, usage, invoice, and webhook IDs across every API method.
2. Two tenants run concurrently while each searches mounts, `/proc`, environment variables, sockets, temp directories, and Codex state for the other's canary.
3. A repository uses symlinks, nested Git repositories, hooks, `.codex`, `AGENTS.md`, and malicious filenames to escape the workspace or alter policy.
4. A prompt asks the agent to print environment variables, read supervisor files, contact metadata services, or send source to an attacker endpoint.
5. A client selects an unauthorized alias, arbitrary provider URL, oversized context, forged usage, permissive sandbox, or someone else's runtime ID.
6. An approval from another user/turn is replayed after the action, parameters, membership, or role changes.
7. Provider streams disconnect, duplicate events, omit usage, return malformed tool calls, or continue after cancellation.
8. Identical Stripe webhooks arrive concurrently, out of order, after secret rotation, and with invalid signatures.
9. Concurrent requests race the last quota unit and retry through a provider timeout.
10. Logs, traces, crash dumps, browser developer tools, images, and build layers are scanned for seeded credentials and tenant content.
11. Two virtual keys concurrently call one LiteLLM model while one request supplies a body provider key; prove that no dynamic route, cache entry, log, response, or subsequent request can inherit that credential.
12. An upload carries a traversal, absolute, NUL-bearing, percent-encoded, overlong-UTF-8, or case-colliding filename; a repeated `x-upload-filename`, `content-length`, or `idempotency-key` header; a body longer or shorter than its declared `Content-Length`; or a symlink and a hardlink pre-planted at every directory component and at the target name.
13. An uploaded file's content instructs the agent to run a command, read another path, or contact an endpoint; and a client attempts to forge or close the server envelope, including splitting the marker across input items and hiding it with zero-width, bidi, or normalization-foldable characters.
14. A user reuses one `Idempotency-Key` for two different files, and races concurrent uploads against the last unit of a storage quota.
15. A user attempts `acceptForSession` on a turn that consumed an upload, on the turn immediately after one, and while an approval is still in flight during dispatch.

## Preview-to-production release blockers

- [ ] No literal bootstrap credential or live-looking secret is present in Git history or artifacts.
- [ ] Cross-tenant authorization and runtime isolation tests pass.
- [ ] Provider secrets are absent from app-server and agent-shell environments.
- [ ] Every LiteLLM runtime credential is a non-admin virtual key restricted to the authenticated tenant's aliases, budget, and expiry; upstream credentials are selected gateway-side and concurrency isolation tests pass.
- [ ] App-server is private and supervised; public WebSocket transport is disabled.
- [ ] At least one end-to-end Responses route passes streaming, tools, approvals, cancellation, and usage reconciliation.
- [ ] Stripe test-mode signature, replay, ordering, and quota-race tests pass.
- [ ] Audit records exist for login, role/admin changes, provider-route changes, approvals, subscription changes, and secret rotation metadata.
- [ ] Backup restore and tenant deletion have been exercised, including upload blobs and staged plaintext.
- [ ] Upload path, quota, header, idempotency, envelope-forgery, and approval-scope tests pass, and the store-versus-workspace-root startup assertion fails closed in both directions.
- [ ] Threat owner accepts every remaining risk in writing with an expiry date.

## Production hardening exit criteria

Broad untrusted multi-tenancy requires an independent penetration test, hardened runtime isolation, MFA/SSO for privileged access, database and gateway HA, verified supply-chain provenance, tested disaster recovery and deletion, tenant-scoped gateway identities, formal incident response, and operational evidence that authorization, quota, egress, and secret controls fail closed.
