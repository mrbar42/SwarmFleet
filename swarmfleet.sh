#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_DIR="$REPO_ROOT/manager"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

cd "$MANAGER_DIR"

if command -v uv >/dev/null 2>&1; then
  CMD=(uv run python swarmfleet_manager.py)
else
  python3 -m venv .venv
  . .venv/bin/activate
  python -m pip install -q -e .
  CMD=(python swarmfleet_manager.py)
fi

manager_pid=""

stop_manager() {
  local status="${1:-130}"
  trap - INT TERM
  if [[ -n "$manager_pid" ]] && kill -0 "$manager_pid" >/dev/null 2>&1; then
    pkill -TERM -P "$manager_pid" >/dev/null 2>&1 || true
    kill -TERM "$manager_pid" >/dev/null 2>&1 || true
    sleep 1
    pkill -KILL -P "$manager_pid" >/dev/null 2>&1 || true
    kill -KILL "$manager_pid" >/dev/null 2>&1 || true
    wait "$manager_pid" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

trap 'stop_manager 130' INT
trap 'stop_manager 143' TERM

"${CMD[@]}" &
manager_pid=$!
echo "SwarmFleet launched, check menu bar"
wait "$manager_pid"
status=$?
trap - INT TERM
exit "$status"
