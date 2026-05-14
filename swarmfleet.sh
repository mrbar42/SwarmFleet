#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_DIR="$REPO_ROOT/manager"
LAUNCH_LABEL="com.swarmfleet.manager"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

STATE_ROOT="${SWARMFLEET_STATE_DIR:-${SWARMFLEET_MANAGER_CONFIG_DIR:-$HOME/.local/swarmfleet}}"
LAUNCH_LOG="$STATE_ROOT/manager-launcher.log"

cd "$MANAGER_DIR"

if command -v uv >/dev/null 2>&1; then
  CMD=(uv run python swarmfleet_manager.py)
else
  python3 -m venv .venv
  . .venv/bin/activate
  python -m pip install -q -e .
  CMD=(python swarmfleet_manager.py)
fi

if [[ "${1:-}" == "--run-manager" ]]; then
  exec "${CMD[@]}"
fi

existing_manager_pids=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] && existing_manager_pids+=("$pid")
done < <(pgrep -f "[s]warmfleet_manager.py" || true)

existing_launchctl_job=0
if command -v launchctl >/dev/null 2>&1 && launchctl list "$LAUNCH_LABEL" >/dev/null 2>&1; then
  existing_launchctl_job=1
fi

if (( ${#existing_manager_pids[@]} > 0 || existing_launchctl_job == 1 )); then
  echo "Stopping existing manager"
  if (( existing_launchctl_job == 1 )); then
    launchctl remove "$LAUNCH_LABEL" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      launchctl list "$LAUNCH_LABEL" >/dev/null 2>&1 || break
      sleep 0.1
    done
  fi

  for pid in "${existing_manager_pids[@]}"; do
    pkill -TERM -P "$pid" >/dev/null 2>&1 || true
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done

  for _ in {1..20}; do
    still_running=0
    for pid in "${existing_manager_pids[@]}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        still_running=1
        break
      fi
    done
    (( still_running == 0 )) && break
    sleep 0.1
  done

  for pid in "${existing_manager_pids[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      pkill -KILL -P "$pid" >/dev/null 2>&1 || true
      kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
  done
fi

mkdir -p "$STATE_ROOT"
if command -v launchctl >/dev/null 2>&1; then
  launchctl submit -l "$LAUNCH_LABEL" -o "$LAUNCH_LOG" -e "$LAUNCH_LOG" -- /bin/bash "$REPO_ROOT/swarmfleet.sh" --run-manager
else
  nohup "${CMD[@]}" >>"$LAUNCH_LOG" 2>&1 &
  manager_pid=$!
  disown "$manager_pid" >/dev/null 2>&1 || true
fi

echo "SwarmFleet launched, check menu bar"
