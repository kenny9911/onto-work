# Optional LiteLLM gateway scaffold

This directory runs a loopback-only LiteLLM proxy with stable Agent Harness aliases and provider values supplied through environment variables. It is useful for local Responses API compatibility testing and a trusted-pilot MVP.

It is **not** the production subscription authority, financial ledger, or sufficient tenant-isolation layer. This no-database setup does not provide durable virtual keys, spend tracking, or distributed budget enforcement. The Agent Harness control plane must continue to authorize tenants, reserve quota, record usage, and issue scoped runtime credentials.

## Start locally

Requirements: Docker Engine with Docker Compose v2, plus credentials for at least one provider or a reachable Ollama instance.

```sh
cd infra/litellm
cp .env.example .env
```

Edit `.env`:

1. Set `LITELLM_MASTER_KEY` to a high-entropy value beginning with `sk-`.
2. Set an independent stable `LITELLM_SALT_KEY`.
3. Configure at least one provider key and review its model identifier.
4. Leave unused provider keys blank. Never commit `.env`.

Do not paste `docker compose config`, `docker inspect`, or environment dumps into tickets or logs: those views can contain the interpolated secrets even though `config.yaml` does not.

Then start the gateway:

```sh
docker compose up -d
docker compose ps
docker compose logs --tail=100 gateway
```

The port binds to `127.0.0.1:4000` by default. Test the exact Responses path Codex uses, replacing the token and alias:

```sh
curl --fail-with-body http://127.0.0.1:4000/v1/responses \
  -H 'Authorization: Bearer REPLACE_WITH_LOCAL_MASTER_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex-openai","input":"Reply with exactly: ready"}'
```

Stop it with:

```sh
docker compose down
```

## Connect a supervised Codex runtime

Provision this in the runtime's isolated `CODEX_HOME/config.toml`, not in the checked-out project:

```toml
model = "codex-openai"
model_provider = "agent-harness-gateway"

[model_providers.agent-harness-gateway]
name = "Agent Harness gateway"
base_url = "http://127.0.0.1:4000/v1"
env_key = "CODEX_GATEWAY_TOKEN"
wire_api = "responses"
```

For local evaluation only, `CODEX_GATEWAY_TOKEN` can contain the LiteLLM master key. In a multi-user deployment it must instead be a short-lived token scoped to one tenant, allowed aliases, budget, and expiry. The provider key must never enter the Codex process or agent shell.

Codex supports the Responses wire API, not the legacy chat wire API. LiteLLM can translate Responses requests for some providers, but provider/model support is not uniform. An alias must remain disabled until it passes streaming, reasoning, tool-call, usage, error, cancellation, and retry tests with the pinned Codex version.

## Alias model

The public alias is the `model_name` in `config.yaml`; the upstream identifier is the corresponding `*_MODEL` environment variable.

| Public alias | Environment-backed target |
| --- | --- |
| `codex-openai` | `OPENAI_MODEL` |
| `codex-anthropic` | `ANTHROPIC_MODEL` |
| `codex-gemini` | `GEMINI_MODEL` |
| `codex-openrouter` | `OPENROUTER_MODEL` |
| `codex-newapi` | `NEWAPI_MODEL` + `NEWAPI_API_BASE` |
| `codex-deepseek` | `DEEPSEEK_MODEL` |
| `codex-doubao` | `DOUBAO_MODEL` + `DOUBAO_API_BASE` |
| `codex-qwen` | `QWEN_MODEL` + `QWEN_API_BASE` |
| `codex-glm` | `GLM_MODEL` + `GLM_API_BASE` |
| `codex-ollama` | `OLLAMA_MODEL` + `OLLAMA_API_BASE` |

The `replace.invalid` endpoints fail closed until configured. Model examples are starting points only; provider catalogs and Responses support change independently.

## MVP versus production

This Compose file adds useful local defaults: a pinned image version, loopback binding, read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, and a health check. Environment variables are still visible to sufficiently privileged Docker operators, and the single master key is shared. Those are accepted only for local evaluation or a tightly controlled pilot.

Before production:

- verify the image digest/signature and admit by digest, not only by tag;
- inject secrets from KMS/Vault or an orchestrator secret store and rotate them;
- put the gateway on a private authenticated network with TLS/mTLS and egress controls;
- issue short-lived tenant/route-scoped credentials rather than the master key;
- add supported PostgreSQL/Redis backing where required for HA/rate limits, while keeping the control-plane usage ledger authoritative;
- disable administrative endpoints from runtime credentials and review gateway RBAC independently;
- add replicas, readiness, disruption policy, resource limits, autoscaling, backups, and disaster-recovery tests;
- export redacted audit/metrics/traces and alert on alias, credential, budget, and policy changes;
- continuously run the Codex Responses contract suite for every provider/model version;
- perform a gateway-specific security review before allowing untrusted tenants.

## Version and source

The scaffold pins `ghcr.io/berriai/litellm:v1.99.0`, the current reviewed tag when this file was written. Check [LiteLLM releases](https://github.com/BerriAI/litellm/releases) and [official Docker deployment guidance](https://docs.litellm.ai/docs/proxy/docker_quick_start) before upgrading. LiteLLM documents the `os.environ/NAME` configuration indirection and its [Responses API](https://docs.litellm.ai/docs/response_api); support must still be verified with Agent Harness's exact Codex request surface.
