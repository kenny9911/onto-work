# Model routing and LLM gateway operations

This runbook describes the current Agent Harness provider boundary. It separates
what is safe for local evaluation from what must exist before a shared production
deployment.

## Choose the connection path

| Path | Use it for | Agent Harness adapter |
| --- | --- | --- |
| Direct Responses endpoint | OpenAI and routers that implement the Responses API, including a compatible OpenRouter or NewAPI deployment | `responses` |
| Translation gateway | Anthropic, Gemini, DeepSeek, Doubao, Qwen, GLM, or any route whose native API is not the Responses API | `litellm` |
| Local Ollama | Models running on the same trusted runtime host | `ollama` |

“OpenAI-compatible” is not sufficient by itself. Codex requires the Responses
wire contract used by the pinned runtime: streaming events, reasoning and tool
items, usage, cancellation, and error behavior must all be compatible.

## Configure Agent Harness

1. Copy the root environment template and set independent session/encryption
   secrets.
2. Set `CODEX_BINARY` to the pinned Codex binary.
3. Set `ALLOWED_WORKSPACE_ROOTS` to the exact server-side directories that may be
   granted to tenants.
4. Leave `CODEX_EXPERIMENTAL_API=false` unless a reviewed feature explicitly
   requires an experimental app-server method.
5. Start Agent Harness, sign in as an organization administrator, and open
   **Model routes**.
6. Add the provider connection, enter its server-reachable base URL, write-only
   credential, and exact model or gateway alias.
7. Enable one compatible route as the organization default. New threads use the
   server-selected default; browser-supplied model overrides are rejected.

The browser never receives the stored credential. The control plane encrypts it
before database storage and supplies it only to the supervised runtime boundary.

## Direct Responses routes

For OpenAI, use the provider's documented Responses base URL and exact model ID.
For OpenRouter or NewAPI, first prove that the selected deployment implements the
same Responses behavior required by Codex. A chat-completions-only endpoint must
go through a translation gateway or remain disabled.

Recommended connection checks:

1. non-streaming text response;
2. streamed text deltas and terminal event;
3. reasoning-capable response when the model advertises reasoning;
4. tool call plus tool result continuation;
5. command/file approval pause and resume;
6. cancellation and timeout;
7. input/output token reporting;
8. rate-limit and provider-error normalization;
9. retry safety after a non-idempotent tool side effect.

Do not add a route to fallback policy until every required check passes for the
exact provider, alias, model, and pinned Codex version.

## LiteLLM evaluation gateway

The repository includes a loopback-only evaluation scaffold:

```sh
cd infra/litellm
cp .env.example .env
# Configure a high-entropy master key, salt key, and at least one provider.
docker compose up -d
docker compose ps
```

Set these values in the root Agent Harness `.env`:

```dotenv
LITELLM_BASE_URL=http://127.0.0.1:4000/v1
LITELLM_MASTER_KEY=replace-with-the-local-evaluation-key
ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true
```

`ALLOW_PRIVATE_PROVIDER_ENDPOINTS` is a deployment-owned switch, defaults to
`false`, and is never accepted from the browser. It permits loopback, RFC1918,
and IPv6 unique-local endpoints (and HTTP only for those private destinations)
for trusted self-hosted evaluation. Link-local/metadata, multicast, and
unspecified targets remain blocked. Public provider and router endpoints must use
HTTPS. Gateway-backed catalog entries always use `LITELLM_BASE_URL`; an
organization administrator cannot replace that endpoint in a provider request.

In **Model routes**, choose the desired gateway-backed provider and use the stable
alias from `infra/litellm/config.yaml`, such as `codex-anthropic`,
`codex-gemini`, or `codex-deepseek`.

For a shared deployment, never place the LiteLLM master key in a tenant provider
record. Provision a tenant-scoped virtual key limited to approved aliases, budget,
and expiry. Keep upstream provider keys inside the gateway. The current Compose
scaffold is intentionally not a production identity, entitlement, or financial
ledger.

## Ollama

Start Ollama on the runtime host, install a model suited to coding/tool use, and
verify its API locally. The default Agent Harness connection is:

```text
Base URL: http://127.0.0.1:11434/v1
Model:    qwen3-coder
```

In a containerized gateway, `127.0.0.1` refers to that container, not the Mac or
Linux host. The LiteLLM scaffold therefore uses `host.docker.internal` for its
example Ollama route. In a hosted Agent Harness deployment, “local” means local to
the server/worker—not to the user's browser. Set
`ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true` on the server before enabling Ollama;
there is intentionally no tenant-facing override.

## Production routing boundary

Before exposing provider setup to mutually untrusted tenants:

- put provider traffic behind a privileged gateway with TLS/mTLS and egress policy;
- issue short-lived tenant, route, model, and budget-scoped runtime credentials;
- block metadata, loopback, link-local, private-network, redirect, and DNS-rebinding
  attacks unless a deployment-controlled private-route policy explicitly permits
  the destination;
- maintain versioned model capability and price records;
- reserve quota before dispatch and reconcile provider/gateway truth afterward;
- audit connection, credential, allowlist, fallback, and policy changes without
  logging secrets;
- circuit-break unhealthy routes and stop fallback after an unsafe side effect;
- continuously run the Codex Responses contract suite against every enabled alias.

The URL admission checks reject literal and obvious local/private hostnames, but
they do not eliminate DNS rebinding or control redirects after connection. A
production deployment still needs resolver-aware runtime egress enforcement,
redirect revalidation, and a gateway/network policy that applies at connect time.

The Agent Harness control plane remains the authority for tenancy, entitlement,
budget, routing policy, and audit. Codex remains the execution harness and must not
become the public multi-tenant API.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `provider_setup_required` | An enabled default connection has a base URL, credential when required, and model/alias. |
| `model_override_forbidden` | Remove the client model override; change the organization route instead. |
| `workspace_not_granted` | Grant the canonical server path to the tenant and keep it inside `ALLOWED_WORKSPACE_ROOTS`. |
| 404 or schema errors from a router | Confirm `/v1/responses` support; a chat-only API is not compatible. |
| Ollama connection refused | Confirm whether the runtime is on the host, in Docker, or remote; use the address visible from that runtime. |
| Gateway route returns 401 | Rotate the tenant-scoped gateway key and confirm the public alias is allowed. |
| Task waits forever on an interaction | Check the event stream and supported approval type; unsupported app-server requests are failed closed by the runtime bridge. |

See also [`infra/litellm/README.md`](../../infra/litellm/README.md), the
[`full-product blueprint`](../architecture/full-product-blueprint.md), and the
[`Codex capability roadmap`](../architecture/codex-full-capability-roadmap.md).
