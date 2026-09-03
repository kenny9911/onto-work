# Agent Harness

Agent Harness is a production-foundation preview of a multi-user control plane and Codex-inspired agent operations interface built around the open-source Codex runtime. Codex remains a pinned Git submodule and runs behind the server as a supervised `codex app-server` process; authentication, tenant data, workspace authority, provider connections, entitlement admission, usage records, and subscription state live in the Agent Harness control plane.

The repository has moved beyond a UI-only MVP: it includes a hardened product shell, a narrow Codex bridge, and the first durable tenancy and spend-admission slice. It is still a developer preview for local use and trusted pilots—not a feature-complete product, an official OpenAI product, or a system ready for hostile, internet-facing multi-tenancy. Read the [architecture decision](docs/architecture/ADR-0001-codex-runtime-boundary.md), [full-product blueprint](docs/architecture/full-product-blueprint.md), and [threat model](docs/security/threat-model.md) before deploying it anywhere shared.

## Implemented production foundation

- React/Vite web application with stable workspace/task/settings URLs, browser-history navigation, a semantic Run Spine, command palette, responsive sidebar/inspector behavior, bounded scrolling, login, mandatory first-login password rotation, provider settings, administrator-managed Saved Projects, Reviews, Agents, Environments, Capabilities, team administration, aggregate Usage, administrator Audit log, and Stripe-ready billing views.
- Deep-linked or selected tasks hydrate their authorized Codex history through a typed server endpoint. Cross-task turn liveness is reconciled from authenticated runtime events while timeline rendering remains isolated to the selected task; the browser queue is bounded by count and bytes.
- Fastify control plane with signed HttpOnly sessions, origin checks, login rate limiting, tenant-scoped users, `admin`/`member` roles, transactional seat admission, encrypted provider credentials, a tenant-scoped administrator audit API, and SQLite persistence.
- A supervised Codex app-server manager using stdio, an isolated `CODEX_HOME` and process home per tenant user, an allow-listed child environment, controlled workspace roots, and Responses-compatible provider configuration.
- A tenant-bound, narrow Codex HTTP bridge. New tasks start only through an opaque saved-project ID at `POST /api/tasks`; the browser cannot supply a filesystem path, model, sandbox, or raw `thread/start`. Typed routes cover resume, turns, inline reviews, rename, fork, archive/restore, interrupt, steer, server-sent runtime events, and command/file approval responses with per-user expiry, capacity, and replay guards. Arbitrary app-server methods are not exposed to the browser.
- Ordered, checksummed SQLite migrations through version 7 plus entitlement snapshots, tenant workspace grants, saved projects, thread/workspace ownership bindings, durable mutation receipts, idempotent usage reservations, usage events, seat/active-run/request limits, and server-selected route/model admission. Task-start binding, receipt, usage, and audit commit atomically after the returned workspace and model are verified against admission.
- Provider catalog entries for OpenAI, OpenRouter, NewAPI, Anthropic, Gemini, DeepSeek, Doubao, Qwen, GLM, and Ollama. Non-Responses providers cross an explicit translation-gateway boundary.
- Optional Stripe Checkout and billing portal plus signature verification, durable event-ID deduplication/outcome records, stale-event rejection, Stripe billing-period preservation, and atomic subscription/entitlement/audit updates when Stripe variables are configured.
- Shared TypeScript contracts and server/runtime/UI tests.

Detached review worktrees, an archived-task browser, durable event replay, route failover/health, finance-grade billing reconciliation, an isolated runtime fleet, browser-driven agent spawning, applications, installable skills, reusable templates, and a production extension catalog remain staged in the roadmap; they are not implemented merely because the design prototype shows them.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/web` | React 19, Vite, Tailwind, and Radix-based interface |
| `apps/server` | Fastify control plane, SQLite store, Stripe routes, and Codex runtime adapter |
| `packages/contracts` | Shared API and UI types plus the provider catalog |
| `codex` | Pinned `openai/codex` Git submodule |
| `infra/litellm` | Optional loopback-only LiteLLM evaluation scaffold |
| `docs/architecture` | Runtime boundary, full-product blueprint, capability roadmap, and upstream upgrade policy |
| `docs/design` | Claude Design artifact handoff and binding visual direction |
| `docs/operations` | Operator runbooks, including model routing and LLM gateway setup |
| `docs/security` | Threat model and production exit criteria |
| `docs/prompts` | Product, implementation, and design prompts |

## Product and design references

- [Full Claude Design product brief](docs/prompts/04-claude-design-full-product-brief.md)
- [Claude Design handoff and prototype links](docs/design/claude-design-handoff.md)
- [Claude Design Phase 2 implementation contract](docs/design/claude-design-phase-2-contract.md)
- [Full-product architecture blueprint](docs/architecture/full-product-blueprint.md)
- [Codex full-capability roadmap](docs/architecture/codex-full-capability-roadmap.md)
- [Model routing and LLM gateway runbook](docs/operations/model-routing-and-gateway.md)

The Claude prototype is a design specification with fictional data, not evidence that every destination is backed by a working service. The live interface adopts its graphite/lime/violet/amber state language while implementation proceeds through the release-gated roadmap.

## Prerequisites

- Git with submodule support.
- Node.js 22.13 or newer; Node.js 24 or newer is recommended because the server uses the built-in `node:sqlite` module.
- pnpm 9.15.0, matching the root `packageManager` field.
- A compatible `codex` executable on `PATH`, or Rust tooling to build the pinned submodule.
- Docker Compose v2 only if using the optional LiteLLM scaffold.
- Stripe CLI/account only if testing subscriptions.

Codex's upstream platform requirements apply: macOS or Linux, and Windows through WSL2.

## Local setup

### 1. Initialize and install

```sh
git submodule update --init --recursive
pnpm --version
pnpm install --frozen-lockfile
```

The expected pnpm version is `9.15.0`. Install or activate that version before continuing if the version check differs.

### 2. Configure the environment

```sh
cp .env.example .env
```

Edit the ignored root `.env` and replace the development placeholders. Generate independent values for `SESSION_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`; for example, run `openssl rand -hex 32` separately for each value.

The requested local bootstrap username is `admin`; both account fields are configured through `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in `.env`. The password is intentionally not printed or committed in this README. The value in `.env.example` is a placeholder, not the planning-time password. Supply the requested password only in the ignored local `.env`, then treat it as a one-time local credential.

Important bootstrap behavior:

- `pnpm seed` hashes the password before storing it and creates the default tenant, free subscription record, and administrator only when that username does not already exist.
- Seeding an existing username does not reset its password.
- The seeded account has `must_change_password` set. After login, every protected route except session inspection and password change returns `403 password_change_required` until a different password of at least 12 characters is set.
- If login fails after changing `.env`, remember that changing or reseeding `BOOTSTRAP_ADMIN_PASSWORD` does not modify an existing account. For an intentional local-only recovery, put the desired temporary value in the ignored `.env`, then pass the exact configured username as the one-shot confirmation shown below. Do not persist the confirmation in `.env` or put the password on the command line.
- The planning-time bootstrap password has already been disclosed in conversation context. Never reuse it in shared staging or production, and never bake it into an image, migration, fixture, or client bundle.

Local administrator recovery is explicit and audited:

```sh
CONFIRM_BOOTSTRAP_ADMIN_RESET=admin pnpm reset-admin
```

Replace `admin` with the exact `BOOTSTRAP_ADMIN_USERNAME` when customized. The command refuses to run when `NODE_ENV=production`, refuses an unknown or non-administrator username, hashes the temporary password from `.env`, invalidates that administrator's sessions, records `auth.bootstrap_password_reset`, and requires another password change at the next login. Remove or rotate the temporary value in `.env` after recovery; this command is not a production account-recovery mechanism.

For shared or production environments, inject all secrets through a secret manager and fail deployment if bootstrap mode or placeholder values are present.

### 3. Use the pinned Codex runtime

The repository currently pins `openai/codex` at commit `e8b3253fed5aeef7e914441bc3b73b3b0a718b51`. A globally installed `codex` works for quick local development, but it may not match that protocol version. Building the submodule is the reproducible option:

```sh
cargo build --manifest-path codex/codex-rs/Cargo.toml -p codex-cli
realpath codex/codex-rs/target/debug/codex
```

Set `CODEX_BINARY` in `.env` to the absolute path printed by `realpath`. A relative path is unsafe here because the supervised child process starts inside a per-user workspace.

If using an installed binary instead, leave `CODEX_BINARY=codex` and verify it explicitly:

```sh
codex --version
```

### 4. Seed and start

```sh
pnpm seed
pnpm dev
```

Open `http://127.0.0.1:4173`, sign in with the bootstrap values from `.env`, and replace the temporary password when prompted.

| Service | Default address | Configuration |
| --- | --- | --- |
| Web/Vite | `http://127.0.0.1:4173` | Fixed by `apps/web/package.json` |
| Control-plane API | `http://127.0.0.1:4310` | `HOST` and `PORT` |
| Health check | `http://127.0.0.1:4310/api/health` | Includes runtime status |
| LiteLLM, optional | `http://127.0.0.1:4000` | `infra/litellm/.env` |
| Ollama, optional | `http://127.0.0.1:11434` | Local Ollama service |

Vite proxies `/api` to the control-plane server during development. If a port or origin changes, keep `WEB_ORIGIN`, `PUBLIC_APP_URL`, Vite proxy settings, and the browser URL aligned.

`DATABASE_PATH` defaults to `./data/agent-harness.db`; `RUNTIME_DATA_DIR` defaults to `./data/runtimes`. Both are ignored by Git. `ALLOWED_WORKSPACE_ROOTS` can be added to `.env` as a comma-separated list of absolute directories; when omitted during the root development command, it resolves to this repository.

## Provider and gateway setup

Start with the [model routing and LLM gateway runbook](docs/operations/model-routing-and-gateway.md). It covers direct Responses routes, the LiteLLM translation boundary, Ollama host/container addressing, compatibility checks, production gateway identity, and common setup failures.

Codex accepts the Responses wire protocol. An endpoint that implements only `/v1/chat/completions` is not compatible merely because it uses OpenAI-shaped JSON.

Public provider/router endpoints require HTTPS. Private, loopback, and local HTTP endpoints are rejected unless the operator—not the browser—sets `ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true`; link-local/metadata, multicast, and unspecified targets remain blocked. LiteLLM-backed catalog entries always use the operator-configured `LITELLM_BASE_URL`, not a tenant-supplied gateway address. The private-endpoint flag is appropriate for a trusted local Ollama/LiteLLM setup, not a substitute for production egress enforcement.

| Provider path | Adapter | Requirement |
| --- | --- | --- |
| OpenAI | Direct `responses` | Native `/v1/responses` behavior |
| OpenRouter and NewAPI | Direct `responses` | The selected router/model must expose a compatible Responses endpoint |
| Anthropic, Gemini, DeepSeek, Doubao, Qwen, and GLM | `litellm` | LiteLLM must translate the exact Codex Responses, streaming, reasoning, tool, usage, error, and cancellation surface |
| Ollama | Codex `ollama` provider | Ollama must be reachable from the server host and the selected model must support the requested agent behavior |

Provider credentials are encrypted before SQLite storage and are not returned by the API. The local encryption key is still a single environment secret, not a production KMS. When a direct route is selected, its credential is decrypted server-side and passed through the configured Codex `env_key`; a LiteLLM route passes a gateway credential. The key is not written into `config.toml`, but it does enter the app-server process environment.

Generated Codex configuration currently sets `shell_environment_policy.inherit = "core"`, keeps Codex's default secret-name exclusions enabled, and explicitly excludes `AGENT_HARNESS_PROVIDER_API_KEY` and `CODEX_OSS_BASE_URL` from tool shells. A live `command/exec` canary using `/usr/bin/env` verified that `PATH` remains available while the provider-key variable is absent. This protects the command-tool boundary; it does not protect a provider secret from a compromised app-server process, diagnostic, or crash dump. Direct provider credentials therefore remain a local/trusted-pilot design. Production should give Codex only a short-lived, tenant- and route-scoped gateway identity.

Every provider/model alias must pass an end-to-end Codex compatibility test before enablement. In particular, do not assume that a LiteLLM chat adapter preserves Responses streaming events or tool-call semantics.

### Optional LiteLLM

The scaffold is independent of the normal web/server process:

```sh
cd infra/litellm
cp .env.example .env
# Edit .env and configure high-entropy gateway secrets plus at least one route.
docker compose up -d
```

Then set the root `.env` values `LITELLM_BASE_URL=http://127.0.0.1:4000/v1` and `LITELLM_MASTER_KEY` as needed. See [the LiteLLM scaffold guide](infra/litellm/README.md) for aliases, a Responses smoke test, and shutdown instructions.

The Compose setup is loopback-only, uses one shared master key, and has no database-backed virtual keys or durable budget enforcement. It is an evaluation option, not the production entitlement or usage ledger.

For a shared deployment, the credential entered for a LiteLLM route must be a **LiteLLM virtual key**, not the tenant's upstream provider key and never the master key. Restrict that virtual key to the tenant's allowed public model aliases, budget, and expiry. Keep the upstream key on the gateway and bind it using a named credential plus [team/project credential routing](https://docs.litellm.ai/docs/proxy/credential_routing), or provision a unique tenant deployment/alias through the [model-management API](https://docs.litellm.ai/docs/proxy/model_management). This requires database-backed LiteLLM management and control-plane automation that the optional Compose scaffold does not implement.

LiteLLM also documents a BYOK form in which `Authorization` carries the proxy virtual key while an `api_key` field in the `/v1/responses` JSON body carries the upstream key; the narrow opt-in is `configurable_clientside_auth_params: ["api_key"]` on the selected deployment. Agent Harness does **not** use that form. The pinned LiteLLM `v1.99.0` does not reject body `api_key` without opt-in, and [LiteLLM issue #36794](https://github.com/BerriAI/litellm/issues/36794) reports cross-caller credential persistence; the proposed `/v1/responses` fix in [PR #36812](https://github.com/BerriAI/litellm/pull/36812) is still open. Stock Codex also maps its provider `env_key` to the HTTP `Authorization` header and cannot add the separate JSON field. Do not enable proxy-wide `allow_client_side_credentials` as a workaround.

## Optional Stripe subscriptions

Leave Stripe variables blank to run without billing. To use Stripe test mode, configure these root `.env` values:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PRO`
- `STRIPE_PRICE_TEAM`
- `PUBLIC_APP_URL`

The server exposes Checkout and billing-portal creation for administrators and receives signed events at `POST /api/billing/webhook`. Subscription state produces versioned entitlement snapshots; seat creation/reactivation and runtime admission enforce their limits transactionally. Processed Stripe events have durable unique IDs and outcomes, older events cannot overwrite newer subscription state, and subscription, entitlement, and audit mutations commit atomically. The billing path is still not a finance-grade ledger: complete webhook ingestion/reconciliation, deterministic same-timestamp ordering, monetary budgets, token/cost reconciliation, refunds/credits, pricing versions, and processor reconciliation remain release gates.

## Commands and tests

| Command | What it runs |
| --- | --- |
| `pnpm dev` | Web and server development processes in parallel |
| `pnpm seed` | Idempotent local bootstrap administrator seed |
| `pnpm reset-admin` | Guarded, audited local bootstrap-admin password reset; requires `CONFIRM_BOOTSTRAP_ADMIN_RESET=<exact username>` and is disabled in production |
| `pnpm build` | TypeScript builds and the Vite production bundle |
| `pnpm typecheck` | Type checks every workspace package |
| `pnpm test` | Server Node tests, web Vitest tests, and package tests |
| `pnpm lint` | Current TypeScript-based lint gate for every package |

Target one workspace when iterating:

```sh
pnpm --filter @agent-harness/server test
pnpm --filter @agent-harness/web test
```

The test suite covers control-plane authorization/password/provider-secret paths; guarded administrator reset/session invalidation/audit; tenant-scoped audit reads; ordered migration compatibility and newer-schema refusal; tenant workspace/thread binding and history authorization; idempotent quota and seat races; durable Stripe deduplication/stale-event/rollback behavior; Codex configuration and workspace-path safety; per-user app-server lifecycle and JSON-RPC correlation; stable-by-default protocol handling; constrained Codex routes and approval replay rejection; selected-task event isolation and bounded buffering; and key navigation/workspace UI behavior. A separate live pinned-Codex canary verified the generated shell policy against `command/exec /usr/bin/env`. Provider compatibility and a complete pinned Codex end-to-end run remain separate release gates.

## Production limitations

Do not treat this production-foundation preview as production-ready without addressing at least the following:

- SQLite and local runtime directories are single-host development storage, without PostgreSQL row-level isolation, high availability, encrypted backup/restore, or tenant deletion workflows.
- Per-user process homes reduce accidental leakage but are not container, microVM, kernel, or egress isolation for hostile code execution.
- Direct provider and gateway credentials currently enter the Codex app-server environment. The generated core-inheritance/default-exclusion/exact-exclusion policy has passed a live tool-shell canary, but production still requires a privileged gateway and short-lived tenant-scoped runtime tokens so upstream keys never enter Codex at all.
- Authentication has no MFA, OIDC/SSO, account recovery, device/risk controls, or dedicated platform-admin boundary.
- Provider encryption uses one application secret; there is no KMS/HSM envelope encryption, automatic key rotation, or tenant-scoped short-lived gateway identity.
- Transactional seat/active-run/request admission and append-only token usage events are present. The Usage view exposes a current-period aggregate, not a per-event ledger; monetary budgets, price versions, exports, gateway/provider invoice reconciliation, and a complete immutable finance ledger are not implemented.
- Processed Stripe event IDs/outcomes are durable and older events are rejected, but there is no durable raw-event inbox, background reconciliation job, deterministic tie-break for distinct events with the same Stripe timestamp, refunds/credits ledger, or finance export.
- Saved Projects are durable, tenant-scoped, administrator-managed records whose paths must remain inside operator-configured roots and active tenant workspace grants. Members receive read-only access. Workspace grants themselves remain operator-managed, and product-owned worktree lifecycle is not implemented.
- One host renews correlated run leases and fails orphaned reservations closed on restart; multi-host lease ownership/fencing is not implemented. Incremental token totals remain in process until completion, so interrupted work still needs gateway-side reconciliation.
- Selected/deep-linked tasks hydrate an authorized snapshot, cross-task start/completion events reconcile turn liveness, and timeline events are filtered to the selected thread, but history is capped to the latest 160 normalized items. SSE still has no event IDs or replay cursor, overflow produces a warning rather than automatic reconciliation, background-task attention beyond liveness is not surfaced, and the item reducer and pending interactions are not durable or complete.
- The browser retains stable task/turn idempotency keys across uncertain retries in the current tab, but does not persist those keys across a full page reload or browser restart.
- The administrator Audit view exposes the latest 100 tenant events with bounded, redacted scalar metadata; the API supports an older-events cursor that the UI does not yet expose. There is no search/export, retention control, tamper-evident storage, or separate platform audit surface.
- Store methods enforce same-tenant actors and provider ownership for audit/usage writes, but direct SQL is not yet protected by equivalent composite constraints. Retained usage reservation response payloads also lack a bounded retention and content-classification policy.
- Stripe signatures authenticate event provenance, but tenant selection still relies on operator-supplied Stripe metadata. Production provisioning must bind processor objects to tenants independently and reconcile that mapping before entitlement mutation.
- The optional LiteLLM deployment is single-instance evaluation infrastructure with a shared master key. It has no tenant-scoped virtual-key, named-credential, or alias-provisioning workflow, and LiteLLM `v1.99.0` client-supplied BYOK is not an acceptable substitute.
- Provider URL admission blocks obvious local/metadata targets by default, but URL parsing alone cannot stop DNS rebinding or an allowed endpoint redirecting to a private address. Production requires resolver/connect-time egress enforcement and redirect revalidation.
- Provider compatibility is configuration-driven and must be proven per exact provider/model version.
- Approval responses are user/runtime-bound and use a capped per-user in-memory pending set with a 30-minute expiry, method match, single-use consumption/replay rejection, and an audit record containing thread/turn/item IDs plus a canonical action digest. Pending state is not durable or shared across server replicas, so restart/failover cannot recover it.
- Hooks, arbitrary MCP servers, repository-selected plugins/skills, and future applications/templates require a signed allow-list and capability isolation before enablement.
- Ordered checksummed local migrations are supplied through version 7, and startup rejects an unknown/newer schema version. Production rolling-upgrade orchestration, tested rollback, PostgreSQL migration policy, built-asset serving, TLS, reverse proxying, observability, application-wide abuse controls, backup, disaster recovery, and deployment automation are not.

The non-negotiable security boundary and production exit criteria are maintained in [ADR-0001](docs/architecture/ADR-0001-codex-runtime-boundary.md) and the [threat model](docs/security/threat-model.md).

## Updating the Codex submodule

Codex upgrades must be dedicated, reviewed changes—not an automatic move to upstream `main`.

1. Record the old SHA, candidate SHA/tag, release notes, and compare URL.
2. Review app-server protocol, configuration/provider types, thread storage, sandbox/environment behavior, approvals, hooks, MCP/plugins/skills, telemetry, and licensing changes.
3. Check out the reviewed commit in `codex/` and stage only the submodule pointer:

   ```sh
   git -C codex fetch origin
   git -C codex checkout <reviewed-commit-sha>
   git add codex
   ```

4. Build that exact commit and regenerate app-server TypeScript and JSON schemas from its binary.
5. Classify every protocol diff, then run `pnpm typecheck`, `pnpm test`, `pnpm build`, runtime isolation tests, existing-thread migration/rollback tests, and the Responses contract suite for every enabled route.
6. Update the recorded pin, SBOM/notices, runtime image digest, and canary rollout notes in the same upgrade review.

The complete procedure, current pin, Apache-2.0 attribution requirements, and brand boundary are documented in [Codex upstream attribution and upgrade policy](docs/architecture/codex-upstream.md).

## Attribution

The `codex/` submodule is OpenAI Codex, licensed under Apache-2.0. Preserve its license and notices. Agent Harness is a separate project and must not use OpenAI branding or imply official affiliation without explicit authorization.

Official references: [Codex app-server documentation](https://developers.openai.com/codex/app-server) and [Codex configuration reference](https://developers.openai.com/codex/config-reference).
