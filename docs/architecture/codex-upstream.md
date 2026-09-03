# Codex upstream attribution and upgrade policy

## Upstream identity

This repository includes [OpenAI Codex](https://github.com/openai/codex) as the `codex/` Git submodule.

| Field | Value |
| --- | --- |
| Upstream | `https://github.com/openai/codex.git` |
| Pinned commit | `e8b3253fed5aeef7e914441bc3b73b3b0a718b51` (tag `rust-v0.153.0-alpha.6`) |
| Pin recorded | 2026-09-03 |
| Upstream license | Apache License 2.0 |
| Primary integration | `codex app-server` JSON-RPC protocol |
| Previous pin | `6127478086e611323e3bff40c943588606c1c571` (2026-09-02) |

The open repository provides the Codex CLI/TUI, Rust agent runtime, app-server, protocol schemas, and supporting libraries. It does not provide the source code for OpenAI's hosted service or a clonable implementation of the proprietary Codex desktop/web interface. Product copy and design must describe Agent Harness accurately and must not imply that it is an official OpenAI product.

## Attribution and brand rules

- Preserve the upstream `LICENSE` and any `NOTICE` files in source and redistributions as required by Apache-2.0.
- Mark files modified from upstream and retain applicable copyright notices.
- Include license texts and third-party notices in shipped source and binary distributions.
- Treat OpenAI names, logos, icons, screenshots, and trade dress separately from the source-code license. Do not ship them without an explicit brand/legal review.
- Attribute the upstream software without using OpenAI branding as this product's identity.

This note is an engineering policy, not legal advice. A release owner must complete the applicable open-source and trademark review.

## Integration policy

Keep upstream as a pinned submodule. Prefer an adapter in Agent Harness over a patch in `codex/`. If an upstream change is unavoidable:

1. keep it as a small, reviewable patch series on a documented fork;
2. add a regression test demonstrating why the patch exists;
3. record the upstream issue or pull request;
4. remove the patch when upstream supplies an equivalent behavior.

Runtime-specific configuration belongs in a supervisor-created `CODEX_HOME`, not in an untrusted project checkout. The control plane owns provider configuration, permissions, feature flags, and trust decisions. This is especially important because project-local Codex configuration deliberately cannot override provider/auth metadata, while project contents can still affect agent behavior through instructions and tools.

## Upgrade procedure

Never update the submodule to an unreviewed moving branch in a release build.

1. Record the old and candidate commit SHA, upstream release/tag, release notes, and compare URL.
2. Review changes to app-server protocol, configuration types, provider handling, shell/sandbox behavior, approvals, hooks, MCP/plugins/skills, thread-store formats, telemetry, and licenses.
3. Verify the candidate commit and its release provenance according to the project's supply-chain policy.
4. Update the submodule in a dedicated pull request. Do not combine the pin change with product features.
5. Build the candidate Codex binary from the pinned source using the locked upstream toolchain.
6. Generate both protocol artifacts from that binary:

   ```sh
   codex app-server generate-ts --out <temporary-ts-directory>
   codex app-server generate-json-schema --out <temporary-schema-directory>
   ```

7. Diff generated schemas against the version consumed by the control plane. Classify every change as compatible, migrated, feature-gated, or rejected.
8. Run the app-server contract suite and all security/tenant isolation tests described in ADR-0001.
9. Run the Responses gateway suite against every enabled provider alias. Codex rejects the legacy chat wire API; a chat-completions-only route is not compatible merely because it is OpenAI-shaped.
10. Test existing thread resume/fork and local-store migration against a copy of production-like data. Test rollback before promotion.
11. Update this file's pinned commit, the software bill of materials, third-party notices, runtime image digest, and deployment provenance.
12. Promote through canary tenants, watch protocol/error/usage deltas, then roll out gradually.

The release artifact must use the reviewed SHA even if upstream `main` advances after review.

## Upgrade acceptance checklist

- [ ] App-server initialization and notification ordering match the generated schema.
- [ ] Thread start, resume, fork, archive, interrupt, approvals, and reconnect behavior pass.
- [ ] Sandbox and shell-environment policies fail closed.
- [ ] No new repository-controlled hook, skill, plugin, MCP, or config surface is enabled accidentally.
- [ ] Model routes use `wire_api = "responses"` and pass streaming/tool/usage tests.
- [ ] Old thread history remains readable and rollback has been exercised.
- [ ] Tenant identifiers and gateway credentials remain outside model-visible prompts and tool environments.
- [ ] New telemetry and logs have data classification, redaction, and retention decisions.
- [ ] License/notice/SBOM changes have been reviewed.

## Useful upstream sources

- [OpenAI Codex repository](https://github.com/openai/codex)
- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- `codex/codex-rs/app-server/README.md`
- `codex/codex-rs/model-provider-info/src/lib.rs`
- `codex/codex-rs/protocol/src/config_types.rs`
- `codex/codex-rs/thread-store/README.md`


## Upgrade record: 2026-09-03

| Field | Value |
| --- | --- |
| From | `6127478086e611323e3bff40c943588606c1c571` (2026-09-01) |
| To | `e8b3253fed5aeef7e914441bc3b73b3b0a718b51` — tag `rust-v0.153.0-alpha.6` (2026-09-02) |
| Commits | 48 |
| Compare | https://github.com/openai/codex/compare/6127478086e611323e3bff40c943588606c1c571...e8b3253fed5aeef7e914441bc3b73b3b0a718b51 |
| Verified binary | `@openai/codex@0.153.0-alpha.6-darwin-arm64` (`codex-cli 0.153.0-alpha.6`) |

### Candidate selection

The previous pin sat on the `0.153.0-alpha` line and is **not** contained in
`rust-v0.152.1`, the newest stable tag — that tag is a patch release cut from a
divergent branch, so adopting it would have been a downgrade. Upstream `main`
(`dcfcb570`) was 21 commits further ahead but is untagged, has no published
build, and cannot be verified without a full source build.

`rust-v0.153.0-alpha.6` was pinned instead because it is a tagged release with a
published, architecture-matched binary, and it already contains every protocol
change this upgrade adopts. The only surface `main` adds on top is
`ResponseItem::configuration_update`, the `ConfigurationReasoning` type, and the
`PermissionsRequestApprovalParams.cwd` type rename — none of which the control
plane consumes.

### Binary/source correspondence (steps 5–6)

No Rust toolchain matching `rust-toolchain.toml` (1.95.0) is installed — the host
has 1.90.0 — so the candidate was not compiled locally. Instead the published
build for this exact tag was used, and its generated protocol artifacts were
compared against the pinned source:

```sh
codex app-server generate-ts --out <dir>
codex app-server generate-json-schema --out <dir>
```

706 TypeScript files and 304 JSON schemas were emitted and matched the pinned
commit's `schema/precomputed/app-server-exports-stable.json` **byte for byte**
(0 files only in binary, 0 only in source, 0 differing). The binary therefore
corresponds to the pinned source.

### Protocol classification (step 7)

Property-level and enum-level diff of every schema the control plane parses:

| Check | Result |
| --- | --- |
| Types or schemas removed | **0** |
| Newly required request/response fields | **0** |
| Removed properties | **0** |
| New `ThreadItem` variants | **0** (19 both sides) |
| New `ThreadStatus` / `ThreadActiveFlag` / `TurnStatus` variants | **0** |
| Enum value changes anywhere | 1 — `ResponseItem` gains `configuration_update`, which is not consumed |
| Methods moved behind `experimentalApi` | **0** — all 24 called methods remain in the stable surface |

`v2/Thread` additively gains `model` and `reasoningEffort`. `shell_environment_policy.rs`
is byte-identical and the top-level `shell_environment_policy` TOML key is
unchanged. `LICENSE` and `NOTICE` are unchanged.

### Live contract results (step 8)

Run through the real `CodexRuntimeManager` against the pinned binary, using the
control plane's own generated `config.toml`:

| Probe | Result |
| --- | --- |
| `initialize` handshake | pass |
| `thread/list`, `model/list`, `skills/list` | pass |
| `mcpServerStatus/list`, `permissionProfile/list` | pass |
| `modelProvider/capabilities/read` | pass |

A thread started the way the control plane starts one (`model` + `cwd` only)
resolves to `sandbox = readOnly`, `networkAccess = false`,
`approvalPolicy = on-request`, `approvalsReviewer = user`. **The sandbox default
fails closed.** `permissionProfile/list` reports `:danger-full-access` in the
profile catalog, but that is the catalog of known profiles — it is not what a
thread receives, and the control plane never selects a profile.

### Thread history compatibility (step 10)

Three rollout files written by the previous pin were copied to a scratch
`CODEX_HOME` and read with the new binary: `thread/list` returned all three,
and `thread/read` returned 4 turns / 8 items with `cwd` preserved. Item types
resolved to `userMessage` and `agentMessage`, both mapped by the adapter. Old
threads also now populate `model` (`openai/gpt-5.6-luna`), which previously fell
back to the tenant route. The user's real runtime directory was never modified.

### Adopted

`ThreadSummary.model` previously always fell back to the tenant's configured
route because `Thread.model` did not exist; it now resolves to real per-thread
data, confirmed live. `reasoningEffort` is surfaced on the task model chip.

### Still open before promotion

- **Step 9 (Responses gateway suite)** for every enabled provider alias — needs
  real provider credentials and was not run.
- **Step 12 (canary rollout).**
- Rollback was not exercised. Upstream changed `thread-store` rollout migration
  and added `rollback_plan.rs`; reading old history forward is verified above,
  but downgrading afterwards is not.
- `.tools/` holds the published binary used for verification and is gitignored.
  A release build should compile the pinned source with Rust 1.95.0 rather than
  consuming the npm artifact.
