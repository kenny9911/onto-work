# ADR-0002: Reviewed shared skills with project-local authoring

- Status: Accepted for the controlled preview
- Date: 2026-09-09
- Extends: [ADR-0001](ADR-0001-codex-runtime-boundary.md)

## Decision

Keep the curated business/agentic-tool source collection in Agentic Operator.
Onto-work retains four complete bundles under `shared/skills/`: Internal Comms,
the two upstream Skill Creator references and PDF. Ten former development-time
shared entries are removed; their source identities and rationale remain in
`shared/skill-curation.json`. Authored business and ontology skills in project
folders are preserved. No additional central skills are globally installed.
A Git-reviewed
manifest lists immutable source revisions, copying terms and every file's hash
and size. No model-generated path or browser request may choose this shared root.

Each supervised user runtime validates the configured shared catalog and then
registers those individual verified bundle roots through the pinned app-server's
`skills/extraRoots/set` method. Registration occurs after initialization and
before the runtime becomes ready. Unsupported registration or invalid bundles
fail startup and close the process. Successful parsing or discovery does not
claim execution support for vendor-specific tools.

The registration contains shared roots only. Project-specific skills are authored
inside the saved project's `.agents/skills/<name>/` directory and discovered by
Codex for the authorized task cwd. They are never copied into a user's global
skill roots or another project's directory. The existing capabilities endpoint
uses server-resolved granted workspaces and strips absolute skill paths from
its browser response. Skill invocation remains normal task text; the public
request schema still refuses raw skill/path input items and arbitrary RPC methods.

When shared skills are configured, the server sets `project_root_markers = []`.
This makes the authorized task cwd the project root, preventing a nested saved
project from inheriting a parent repository's skills. It also narrows upstream
project-configuration discovery to that cwd. Users who need an entire repository's
skills should save the repository root as their project. Nested projects should
carry their own project instructions and skills.

The server's authoring guidance names both destinations: reusable shared skills
require an operator-reviewed catalog update; project-specific skills belong in
the current project's folder. A skill cannot select a model, provide credentials,
authorize external changes, or expand the server's tool/sandbox permissions.
Agentic Operator's Pro creator remains that application's authoring service;
onto-work's control plane continues to select models for its own tasks.

## Integrity and lifecycle

The offline importer validates the reviewed source lock and exact selected files,
requires selection to match the retained curation identities, binds that curation
hash into the generated catalog,
retains licenses and notices, namespaces names with an in-file modification notice,
and stages a complete replacement. Identical imports are no-ops. Updates require
an explicit reviewed selection and refuse to overwrite locally modified files.
Ordinary rename/write failures restore the prior skills tree. A process crash
between the skills-directory swap and manifest replacement can leave an invalid
projection; runtime validation fails closed until the operator restores the
committed catalog. Neither importer nor runtime executes upstream scripts during
installation.

Runtime validation enforces file-count/byte/depth limits, complete file closure,
immutable revision metadata, hashes, and rejection of symbolic and hard links.
The catalog contributes to the runtime configuration fingerprint. A running
process must be restarted after a reviewed catalog change; it cannot silently
reuse a different configuration. Reacquisition revalidates the catalog and
closes that user's runtime if integrity has failed.

## Boundaries and limitations

This extends ADR-0001's preview capability policy for this explicit reviewed
catalog. It is an operator-owned Git allow-list, not a signature authority or a
hostile-tenant security boundary. The shared directory must be deployed read-only
to agent processes. The existing local preview runs under the same OS identity;
hash checking cannot stop that identity from replacing both bundles and their
manifest, or writing files after validation. Native project skill discovery also
accepts repository symlinks. Kernel/process isolation and artifact signing remain
production requirements under ADR-0001.

Per-user runtime homes and tenant/workspace grants remain independent. Project
skill placement is not a way to share tenant secrets, and shared skill files must
contain no private project context. External dependencies remain subject to the
existing execution and approval policy. The central curated collection need not be
automatically activated: the curated subset bounds context and host assumptions.

## Verification

Importer tests cover binary resources/notices, idempotency, source tampering,
unreviewed revisions, local edits, extra files/links, and reviewed replacement.
Runtime tests cover complete catalog validation, traversal and link rejection,
size limits, startup registration, per-user homes, failed-registration cleanup,
and tampering on reacquisition. A no-model-call native smoke verifies all shared
names in separate projects, project canaries scoped to their own cwd, and no
parent-skill inheritance in a nested project.

Source-format reference: [OpenAI skills documentation](https://learn.chatgpt.com/docs/build-skills).
Implementation evidence comes from the pinned local
`codex/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs` and
`codex/codex-rs/ext/skills/src/loader/host.rs`, plus the native smoke.
