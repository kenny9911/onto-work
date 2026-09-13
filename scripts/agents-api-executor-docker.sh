#!/usr/bin/env bash
set -euo pipefail

# This trusted host launcher is never mounted inside the executor. Image pulls/builds
# are operator actions; a missing, unreviewed or mutable image fails closed.
image_ref="${1:?A reviewed image digest is required}"
shift
[[ "$image_ref" =~ ^([a-zA-Z0-9._:/-]+@)?sha256:[a-f0-9]{64}$ ]] || { echo 'A digest-pinned executor image is required.' >&2; exit 64; }
[[ -n "${CODEX_API_KEY:-}" ]] || { echo 'Executor key is missing.' >&2; exit 64; }
[[ "${HARNESS_WORKSPACE_DIRECTORY:-}" == /* && -d "$HARNESS_WORKSPACE_DIRECTORY" ]] || { echo 'Snapshot directory is missing.' >&2; exit 64; }
[[ "$HARNESS_WORKSPACE_DIRECTORY" != *,* ]] || { echo 'Snapshot path contains an unsupported character.' >&2; exit 64; }
container_name="harness-agent-$(basename "$(dirname "$HARNESS_WORKSPACE_DIRECTORY")")"
[[ "$container_name" =~ ^harness-agent-[a-f0-9-]{36}$ ]] || exit 64
docker image inspect "$image_ref" >/dev/null

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Keep stdin attached: exec-server exits when its supervising process closes it.
# Noninteractive Bash otherwise connects an asynchronous command's stdin to
# /dev/null. Duplicate it before starting the background process explicitly.
exec 3<&0
docker run --rm --init --interactive --pull=never --name "$container_name" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user 10001:10001 --pids-limit 128 --memory 2g --cpus 2 \
  --tmpfs /tmp:rw,nosuid,nodev,size=268435456 \
  --tmpfs /home/codex:rw,nosuid,nodev,mode=700,uid=10001,gid=10001,size=268435456 \
  --mount "type=bind,source=$HARNESS_WORKSPACE_DIRECTORY,target=/workspace,readonly" \
  --workdir /workspace --env CODEX_API_KEY \
  --env HOME=/home/codex --env CODEX_HOME=/home/codex/.codex \
  --entrypoint codex "$image_ref" "$@" <&3 &
executor_pid=$!
exec 3<&-
wait "$executor_pid"
