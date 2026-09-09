#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$project_root"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required but was not found on PATH." >&2
  exit 1
fi

if [[ ! -f "$project_root/.env" ]]; then
  echo "Error: $project_root/.env is missing. Create it before starting the services." >&2
  exit 1
fi

if [[ ! -e "/proc/$$/cwd" ]] && ! command -v lsof >/dev/null 2>&1; then
  echo "Error: lsof is required to identify this checkout's services on this platform." >&2
  exit 1
fi

# Keep runtime bookkeeping inside Git metadata so it stays local to this checkout.
pid_file="$(git -C "$project_root" rev-parse --git-path agent-harness-dev.pid 2>/dev/null || true)"
if [[ -z "$pid_file" ]]; then
  pid_file="$project_root/.agent-harness-dev.pid"
elif [[ "$pid_file" != /* ]]; then
  pid_file="$project_root/$pid_file"
fi
lock_dir="${pid_file}.restart-lock"
lock_owner="$lock_dir/owner"
lock_held=false

pid_cwd() {
  local pid="$1"
  local cwd=""

  if [[ -e "/proc/$pid/cwd" ]]; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  else
    cwd="$( { lsof -a -p "$pid" -d cwd -Fn 2>/dev/null || true; } | sed -n 's/^n//p' | head -n 1)"
  fi
  printf '%s\n' "$cwd"
}

pid_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

pid_start_time() {
  ps -p "$1" -o lstart= 2>/dev/null || true
}

pid_is_running() {
  local pid="$1"
  local state=""

  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
  [[ -n "$state" && "$state" != Z* ]]
}

is_project_dev_process() {
  local pid="$1"
  local cwd command

  cwd="$(pid_cwd "$pid")"
  [[ "$cwd" == "$project_root" ]] || return 1

  command="$(pid_command "$pid")"
  [[ "$command" =~ (^|[[:space:]/])pnpm([.]cjs)?([[:space:]]|$) ]] &&
    [[ "$command" =~ [[:space:]]dev[[:space:]]*$ ]]
}

is_starting_launcher() {
  local pid="$1"
  [[ "$(pid_cwd "$pid")" == "$project_root" && "$(pid_command "$pid")" == *"restart.sh"* ]]
}

release_lock() {
  local owner=""

  if [[ "$lock_held" == true ]]; then
    owner="$(sed -n '1p' "$lock_owner" 2>/dev/null || true)"
    if [[ "$owner" == "$$" ]]; then
      rm -f "$lock_owner"
      rmdir "$lock_dir" 2>/dev/null || true
    fi
    lock_held=false
  fi
}

acquire_lock() {
  local owner=""

  if ! mkdir "$lock_dir" 2>/dev/null; then
    owner="$(sed -n '1p' "$lock_owner" 2>/dev/null || true)"
    if [[ -z "$owner" ]]; then
      sleep 0.1
      owner="$(sed -n '1p' "$lock_owner" 2>/dev/null || true)"
    fi
    if [[ "$owner" =~ ^[0-9]+$ ]] && pid_is_running "$owner"; then
      echo "Error: another restart is already in progress (PID $owner)." >&2
      exit 1
    fi

    echo "Error: stale restart lock at $lock_dir; remove it after confirming no restart is running." >&2
    exit 1
  fi

  printf '%s\n' "$$" >"$lock_owner"
  lock_held=true
  trap release_lock EXIT
}

acquire_lock

saved_pid=""
if [[ -f "$pid_file" ]]; then
  saved_pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  if [[ "$saved_pid" =~ ^[0-9]+$ && "$saved_pid" != "$$" ]] &&
    pid_is_running "$saved_pid" && is_starting_launcher "$saved_pid"; then
    echo "Error: another restart is already starting the services (PID $saved_pid)." >&2
    exit 1
  fi
fi

root_pids=""
add_root_pid() {
  local pid="$1"
  case " $root_pids " in
    *" $pid "*) ;;
    *) root_pids="${root_pids:+$root_pids }$pid" ;;
  esac
}

if [[ "$saved_pid" =~ ^[0-9]+$ ]] && is_project_dev_process "$saved_pid"; then
  add_root_pid "$saved_pid"
fi

# This fallback also finds a stack originally launched with `pnpm dev`.
while read -r pid command; do
  if [[ "$pid" =~ ^[0-9]+$ ]] &&
    [[ "$command" =~ (^|[[:space:]/])pnpm([.]cjs)?([[:space:]]|$) ]] &&
    [[ "$command" =~ [[:space:]]dev[[:space:]]*$ ]] &&
    is_project_dev_process "$pid"; then
    add_root_pid "$pid"
  fi
done < <(ps -Ao pid=,command=)

target_pids=""
target_records=""
add_target_pid() {
  local pid="$1"
  local started

  case " $target_pids " in
    *" $pid "*) return ;;
  esac

  started="$(pid_start_time "$pid")"
  [[ -n "$started" ]] || return
  target_pids="${target_pids:+$target_pids }$pid"
  target_records="${target_records}${target_records:+$'\n'}${pid}|${started}"
}

collect_process_tree() {
  local pid="$1"
  local child

  pid_is_running "$pid" || return
  add_target_pid "$pid"
  for child in $(ps -Ao pid=,ppid= | awk -v parent="$pid" '$2 == parent { print $1 }'); do
    collect_process_tree "$child"
  done
}

same_process() {
  local pid="$1"
  local started="$2"
  pid_is_running "$pid" && [[ "$(pid_start_time "$pid")" == "$started" ]]
}

signal_tree() {
  local signal="$1"
  local pid started

  while IFS='|' read -r pid started; do
    if [[ -n "$pid" ]] && same_process "$pid" "$started"; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done <<<"$target_records"
}

refresh_remaining() {
  local pid started

  remaining_pids=""
  while IFS='|' read -r pid started; do
    if [[ -n "$pid" ]] && same_process "$pid" "$started"; then
      remaining_pids="${remaining_pids:+$remaining_pids }$pid"
    fi
  done <<<"$target_records"
}

for pid in $root_pids; do
  collect_process_tree "$pid"
done

if [[ -n "$target_records" ]]; then
  echo "Stopping Agent Harness services..."
  signal_tree TERM

  shutdown_deadline=$((SECONDS + 10))
  while :; do
    refresh_remaining
    if [[ -z "$remaining_pids" || "$SECONDS" -ge "$shutdown_deadline" ]]; then
      break
    fi
    sleep 0.25
  done

  if [[ -n "$remaining_pids" ]]; then
    echo "Graceful shutdown timed out; forcing the remaining services to stop..." >&2
    signal_tree KILL
    force_deadline=$((SECONDS + 3))
    while :; do
      refresh_remaining
      if [[ -z "$remaining_pids" || "$SECONDS" -ge "$force_deadline" ]]; then
        break
      fi
      sleep 0.1
    done
    if [[ -n "$remaining_pids" ]]; then
      echo "Error: failed to stop service PID(s): $remaining_pids" >&2
      exit 1
    fi
  fi
else
  echo "No running Agent Harness services found."
fi

mkdir -p "$(dirname -- "$pid_file")"
printf '%s\n' "$$" >"$pid_file"

echo "Starting Agent Harness services..."
release_lock
trap - EXIT
exec pnpm dev
