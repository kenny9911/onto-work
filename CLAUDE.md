# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
pnpm install --frozen-lockfile   # pnpm 9.15.0 exactly (root `packageManager`)
pnpm dev                         # web (127.0.0.1:4173) + server (127.0.0.1:4310) in parallel
pnpm seed                        # idempotent bootstrap admin from BOOTSTRAP_ADMIN_* in .env
pnpm build | typecheck | lint | test
```

`lint` is `tsc --noEmit` in every package — there is no ESLint/Prettier. `typecheck` and `lint` run the same thing.

Target one workspace: `pnpm --filter @agent-harness/server test`, `pnpm --filter @agent-harness/web test`.

Single test file (test runners differ per workspace):

```sh
cd apps/server && node --import tsx --test src/routes/codex.test.ts
```

```sh
cd apps/web && npx vitest run src/lib/routes.test.ts
```

Server/contracts use `node:test` + `node:assert/strict`; web uses Vitest + Testing Library (jsdom). Server tests build a real Fastify app with `buildApp({ config, store, runtime, logger: false })` against a temp-dir SQLite file and drive it with `app.inject`; they do not need `.env`.

Requires Node 24+ (the server uses built-in `node:sqlite`). All server entry points load the **root** `.env` via `--env-file=../../.env`.

## Architecture

pnpm workspace: `apps/server` (Fastify control plane), `apps/web` (React/Vite), `packages/contracts` (shared types + `PROVIDER_CATALOG`), and `codex/` — a pinned `openai/codex` submodule that is a supervised child process, never a library.

### The security boundary (read `docs/architecture/ADR-0001-codex-runtime-boundary.md` before changing route or runtime code)

The browser talks only to the control plane, which owns tenancy, entitlements, workspace authority, and model selection. **The browser can never supply a filesystem path, model, sandbox policy, or a raw `thread/start`.** `POST /api/tasks` takes an opaque saved-project UUID; `POST /api/codex/request` accepts exactly three methods via a Zod discriminated union (`turn/start`, `thread/resume`, `review/start`). Arbitrary app-server methods are not proxied. Preserve this when adding endpoints.

`turn/start` also accepts `attachments` — **opaque upload UUIDs only**. The server resolves each to a path immediately before dispatch. Never widen the input union to `localImage`/`localAudio`/`mention`/`skill`: each carries a `PathBuf` the app-server reads with a bare `std::fs::read`, with no sandbox and no allow-list.

### Task start flow (`apps/server/src/routes/codex.ts` → `admission.ts` → `database.ts`)

1. Saved project → active workspace grant → `resolveAllowedWorkspacePath` (realpath + containment in `ALLOWED_WORKSPACE_ROOTS`).
2. `RunAdmissionPolicy.admit` runs inside `BEGIN IMMEDIATE`: user/tenant check, entitlement snapshot vs. subscription, route entitlement, server-selected model (a client-supplied model that differs is rejected), active-run and request quotas, then inserts a `usage_reservations` row keyed by `Idempotency-Key`.
3. Dispatch to Codex, then **verify the returned `cwd` and `model` against the admission** — a mismatch is a 409, not a warning.
4. `store.commitThreadStart` atomically writes the thread↔workspace binding, the reservation receipt, the usage event, and the audit row. Failure paths call `failUsageReservation`.

There are **two independent idempotency ledgers**, both driven by the `Idempotency-Key` header: `usage_reservations` (runs, in `admission.ts`) and `task_mutations` (`TaskMutationLedger` — rename/fork/archive/interrupt/steer). Reuse the matching one rather than inventing a third.

`thread_workspace_bindings` is the authorization anchor for every per-thread operation. `authorizedThreadBridge` re-canonicalizes the bound path on each use; a thread with no binding is lazily bound from `thread/read`'s `cwd` only if that path still passes the allow-list.

### Codex runtime isolation (`apps/server/src/codex/`)

`CodexRuntimeManager` spawns one `codex app-server --listen stdio://` per user and speaks newline-delimited JSON-RPC over stdio. Per-user state lives under `RUNTIME_DATA_DIR/users/<sha256(userId)>/` — user IDs never become path components directly. The child env is an explicit allow-list (`SAFE_INHERITED_ENVIRONMENT`) plus a redirected `CODEX_HOME`/`HOME`/`XDG_*`. `config.ts` renders `config.toml` (0600, atomic rename) with a `shell_environment_policy` that excludes the provider key from tool shells; changing that policy invalidates a live security canary documented in the README.

`adapter.ts` (`CodexHarnessAdapter`) implements the `HarnessRuntime` seam from `runtime.ts` and hands routes a `CodexUserRouteBridge`. `forUser(identity, expectedRoute)` re-verifies that the provider route/model has not changed since admission. Routes must go through this seam — never construct a manager or touch a raw runtime from a route.

### Persistence (`migrations.ts`, `database.ts`)

Ordered, checksummed migrations through version 8. **Never edit an applied migration** — the checksum check throws at startup, and an unknown/newer version is refused. Add a new numbered entry instead. `HarnessStore` is the only SQL surface; it enforces same-tenant actors on audit/usage writes.

### Uploads (`apps/server/src/uploads/`, `routes/uploads.ts`)

Bytes live under `UPLOAD_DATA_DIR`, which **must not overlap `ALLOWED_WORKSPACE_ROOTS` in either direction** — `buildApp` asserts this over `realpath`'d paths and refuses to start otherwise. Per-user shard uses the same double hash as the runtime tree; blob names are server-generated UUIDs; the client filename is a display label that never touches the filesystem. Blobs are AES-256-GCM at rest.

Two things that look like bugs and are not: the upload route uses a **pass-through content-type parser, so Fastify's `bodyLimit` does not apply** and the route counts bytes itself (the payoff is that `requireUser` runs before any byte is read); and content type is sniffed from the bytes, never taken from the client, because the wire type is fixed to `application/octet-stream`.

Extraction is an ordinary turn — uploading performs no model call and no dispatch. The server stages decrypted plaintext per turn, appends a server-authored envelope from `uploads/prompt.ts` **last**, and the agent reads the files with the shell, so content arrives as tool output rather than as an input item. Do not auto-dispatch on upload, and do not relax the `acceptForSession` refusal on a thread holding an attachment — those are the load-bearing controls against injection from file content.

### Web (`apps/web/src`)

No router library: `lib/routes.ts` maps pathnames ↔ `AppView` over the History API, and `App.tsx` owns session, route, dashboard, and SSE state; `WorkspaceView` / `ControlPlaneView` / `OperationsView` are lazy-loaded. Live events arrive on `GET /api/codex/events` (SSE) and pass through `lib/codex-notifications.ts`, which is bounded by count *and* bytes and filters timeline rendering to the selected thread while still reconciling cross-task turn liveness. Path alias is `@/*` → `src/*`. UI is shadcn/ui (new-york) + Radix + Tailwind v4; add components under `components/ui`.

`src/typography.contract.test.ts` is an enforced design contract: it pins the Geist/JetBrains Mono pairing, requires the `--text-ui-*` semantic tokens in `styles.css`, and fails any `text-[…]` under 12px in `App.tsx` or `components/`. Design rules it backs come from `docs/design/claude-design-handoff.md` and `claude-design-phase-2-contract.md`.

## Conventions and gotchas

- Server is ESM with `moduleResolution: NodeNext` — **relative imports need the `.js` extension** (`./codex/adapter.js`), including in tests.
- `strict` + `noUncheckedIndexedAccess` are on repo-wide; indexed access yields `T | undefined`.
- Errors: throw `ApiHttpError(status, code, message)`. The central handler in `app.ts` also maps `ZodError` → 400 `validation_error` and `SQLITE_CONSTRAINT` → 409 `conflict`. Client-visible codes are part of the contract with `apps/web/src/lib/api.ts`.
- Every unsafe method is origin-checked in an `onRequest` hook; `POST /api/billing/webhook` is the only CSRF-exempt path (it uses `fastify-raw-body` for signature verification).
- `NODE_ENV !== "production"` unlocks two conveniences in `app.ts`: localhost/127.0.0.1 origin equivalence and auto-granting/registering the repo as a workspace + saved project. Keep new dev affordances behind the same guard.
- Provider base URLs are SSRF-screened in `routes/providers.ts` (private/loopback/metadata scopes). Private endpoints require the operator-set `ALLOW_PRIVATE_PROVIDER_ENDPOINTS`, never a tenant field.
- Provider credentials are AES-256-GCM encrypted at rest and never returned by any API; passwords are scrypt with `timingSafeEqual`.
- Pending Codex approvals are in-memory, per-user, single-use, and expire in 30 minutes (`routes/codex.ts`) — they do not survive a restart.
- Adding an API type means editing `packages/contracts/src/index.ts` first; both apps import it as `@agent-harness/contracts`.
- Bumping the `codex/` submodule is a dedicated reviewed change with protocol-diff classification — follow `docs/architecture/codex-upstream.md`, not a plain `git submodule update --remote`.
