#!/usr/bin/env bash
set -euo pipefail

# SwarmFleet persistent tool manager.
# Installs mutable CLIs into /home/user/.swarmfleet/tools, which is backed by
# the persisted /home/user mount. The image can be rebuilt/recreated without
# losing installed tools or user-installed global tools under this prefix.
#
# Hermes Agent is intentionally not installed here: it is part of the Docker
# image and exposed globally at /usr/local/bin/hermes. This service only reports
# Hermes status/auth and manages mutable companion CLIs.

HOME_DIR="${HOME:-/home/user}"
TOOLS_ROOT="${SWARMFLEET_TOOLS_ROOT:-$HOME_DIR/.swarmfleet/tools}"
TOOLS_BIN="$TOOLS_ROOT/bin"
NPM_PREFIX="$TOOLS_ROOT/npm"
PYTHON_VENV="$TOOLS_ROOT/python"
STATE_DIR="$TOOLS_ROOT/state"
LOG_DIR="$TOOLS_ROOT/logs"
CONFIG_FILE="$TOOLS_ROOT/config.json"
STATUS_FILE="$STATE_DIR/status.json"
LOCK_FILE="$STATE_DIR/update.lock"
LOG_FILE="$LOG_DIR/update.log"
USER_MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME_DIR/.local/share/mise}"
USER_MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-$HOME_DIR/.config/mise}"
PUID_VALUE="${PUID:-1000}"
PGID_VALUE="${PGID:-1000}"
RUN_ONCE="${SWARMFLEET_TOOL_MANAGER_RUN_ONCE:-0}"

export MISE_DATA_DIR="$USER_MISE_DATA_DIR"
export MISE_CONFIG_DIR="$USER_MISE_CONFIG_DIR"
export PATH="$USER_MISE_DATA_DIR/shims:/usr/local/sbin:/usr/local/bin:$TOOLS_BIN:$NPM_PREFIX/bin:$PYTHON_VENV/bin:/root/.local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export npm_config_prefix="$NPM_PREFIX"
export NPM_CONFIG_PREFIX="$NPM_PREFIX"
export PIP_DISABLE_PIP_VERSION_CHECK=1

log() {
  local message="$*"
  mkdir -p "$LOG_DIR"
  printf '[tools] %s\n' "$message" | tee -a "$LOG_FILE"
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

ensure_layout() {
  mkdir -p "$TOOLS_BIN" "$NPM_PREFIX" "$PYTHON_VENV" "$STATE_DIR" "$LOG_DIR" "$USER_MISE_DATA_DIR" "$USER_MISE_CONFIG_DIR"
  if command -v npm >/dev/null 2>&1; then
    npm config set prefix "$NPM_PREFIX" >/dev/null 2>&1 || true
  fi
  if [ ! -x "$PYTHON_VENV/bin/python" ]; then
    log "Creating persistent Python venv at $PYTHON_VENV"
    python3 -m venv "$PYTHON_VENV"
  fi
  "$PYTHON_VENV/bin/python" -m pip install --upgrade pip setuptools wheel >/dev/null 2>&1 || true
  if command -v mise >/dev/null 2>&1; then
    mise reshim >/dev/null 2>&1 || true
  fi
  chown -R "$PUID_VALUE:$PGID_VALUE" "$TOOLS_ROOT" "$USER_MISE_DATA_DIR" "$USER_MISE_CONFIG_DIR" 2>/dev/null || true
}

default_config() {
  python3 - <<'PY'
import json, os
from pathlib import Path
home = Path(os.environ.get("HOME", "/home/user"))
claude_signed_in = (home / ".claude.json").exists() or (home / ".claude").exists()
codex_signed_in = (home / ".codex" / "auth.json").exists()
config = {
  "version": 1,
  "autoUpdate": {"enabled": True, "frequencyDays": 7},
  "tools": {
    "hermes": {"enabled": True, "autoUpdate": False, "managedBy": "image"},
    "chrome-devtools-mcp": {"enabled": True, "autoUpdate": True},
    "claude": {"enabled": claude_signed_in, "autoUpdate": True},
    "codex": {"enabled": codex_signed_in, "autoUpdate": True},
  },
  "runtimes": {
    "node": {"enabled": True, "autoInstallProjectVersions": True, "versions": ["22"]},
  },
}
print(json.dumps(config, indent=2))
PY
}

ensure_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    log "Creating tools config at $CONFIG_FILE"
    default_config > "$CONFIG_FILE"
  fi
}

read_config_value() {
  local expr="$1"
  python3 - "$CONFIG_FILE" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except Exception:
    data = {}
cur = data
for part in expr.split('.'):
    if isinstance(cur, dict):
        cur = cur.get(part)
    else:
        cur = None
        break
if isinstance(cur, bool): print('true' if cur else 'false')
elif cur is None: print('')
else: print(cur)
PY
}

write_status_start() {
  python3 - "$STATUS_FILE" "$TOOLS_ROOT" <<'PY'
import json, sys, time
path, tools_root = sys.argv[1], sys.argv[2]
status = {
  "version": 1,
  "state": "updating",
  "message": "Installing/updating persistent tools",
  "updatedAt": int(time.time() * 1000),
  "toolsRoot": tools_root,
  "tools": {},
}
open(path, 'w').write(json.dumps(status, indent=2) + '\n')
PY
}

command_version() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf ''
    return 0
  fi
  "$cmd" --version 2>/dev/null | head -n 1 || true
}

auth_status() {
  local id="$1"
  case "$id" in
    claude)
      [ -f "$HOME_DIR/.claude.json" ] || [ -d "$HOME_DIR/.claude" ] && printf 'true' || printf 'false'
      ;;
    codex)
      [ -f "$HOME_DIR/.codex/auth.json" ] && printf 'true' || printf 'false'
      ;;
    hermes)
      [ -f "$HOME_DIR/.hermes/auth.json" ] && printf 'true' || printf 'false'
      ;;
    *) printf 'unknown' ;;
  esac
}

link_if_exists() {
  local src="$1" dst="$2"
  if [ -e "$src" ]; then
    ln -sf "$src" "$dst"
  fi
}

install_npm_tool() {
  local id="$1" package="$2" binary="$3"
  log "Installing/updating $id from npm: $package"
  npm install -g "$package"
  link_if_exists "$NPM_PREFIX/bin/$binary" "$TOOLS_BIN/$binary"
}

install_pip_tool() {
  local id="$1" package="$2" binary="$3"
  log "Installing/updating $id from pip: $package"
  "$PYTHON_VENV/bin/python" -m pip install --upgrade "$package"
  link_if_exists "$PYTHON_VENV/bin/$binary" "$TOOLS_BIN/$binary"
}

install_enabled_tools() {
  local id enabled
  for id in chrome-devtools-mcp claude codex; do
    enabled="$(read_config_value "tools.$id.enabled")"
    [ "$enabled" = "true" ] || { log "Skipping disabled tool: $id"; continue; }
    case "$id" in
      chrome-devtools-mcp)
        install_npm_tool chrome-devtools-mcp 'chrome-devtools-mcp@latest' chrome-devtools-mcp
        ;;
      claude)
        install_npm_tool claude '@anthropic-ai/claude-code@latest' claude
        ;;
      codex)
        install_npm_tool codex '@openai/codex@latest' codex
        ;;
    esac
  done
}

install_node_versions() {
  [ "$(read_config_value runtimes.node.enabled)" = "true" ] || { log "Skipping disabled runtime: node"; return 0; }
  command -v mise >/dev/null 2>&1 || { log "mise not found; cannot manage Node versions"; return 1; }
  python3 - "$CONFIG_FILE" "${SWARMFLEET_WORKSPACE:-/workspace}" <<'PY' | while IFS= read -r version; do
import json, os, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
workspace = sys.argv[2]
node_cfg = data.get("runtimes", {}).get("node", {})
versions = node_cfg.get("versions", ["22"])
if not isinstance(versions, list): versions = ["22"]
seen = set()
def emit(value):
    value = str(value).strip()
    if value and value not in seen:
        seen.add(value)
        print(value)
for version in versions:
    emit(version)
if node_cfg.get("autoInstallProjectVersions", True) and os.path.isdir(workspace):
    for root, dirs, files in os.walk(workspace):
        rel = os.path.relpath(root, workspace)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if depth >= 3:
            dirs[:] = []
        dirs[:] = [d for d in dirs if d not in {"node_modules", ".git", ".next", "dist", "build"}]
        for filename in (".node-version", ".nvmrc"):
            if filename in files:
                try:
                    emit(open(os.path.join(root, filename), encoding="utf-8").read().splitlines()[0])
                except Exception:
                    pass
PY
    log "Installing/ensuring Node $version via mise"
    mise install "node@$version"
  done
  mise reshim node >/dev/null 2>&1 || mise reshim >/dev/null 2>&1 || true
}

write_status_done() {
  local state="$1" message="$2"
  python3 - "$STATUS_FILE" "$CONFIG_FILE" "$TOOLS_ROOT" "$state" "$message" <<'PY'
import json, os, shutil, subprocess, sys, time
status_path, config_path, tools_root, state, message = sys.argv[1:6]
try:
    config = json.load(open(config_path))
except Exception:
    config = {"tools": {}}
commands = {
    "hermes": "hermes",
    "chrome-devtools-mcp": "chrome-devtools-mcp",
    "claude": "claude",
    "codex": "codex",
}
home = os.environ.get("HOME", "/home/user")
def signed_in(tool):
    if tool == "claude": return os.path.exists(os.path.join(home, ".claude.json")) or os.path.isdir(os.path.join(home, ".claude"))
    if tool == "codex": return os.path.exists(os.path.join(home, ".codex", "auth.json"))
    if tool == "hermes": return os.path.exists(os.path.join(home, ".hermes", "auth.json"))
    return None
def version(cmd):
    path = shutil.which(cmd)
    if not path: return None, None
    try:
        out = subprocess.run([cmd, "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=8).stdout.strip().splitlines()[0]
    except Exception:
        out = None
    return path, out
tools = {}
for tool, cmd in commands.items():
    path, ver = version(cmd)
    cfg = config.get("tools", {}).get(tool, {}) if isinstance(config.get("tools"), dict) else {}
    auth = signed_in(tool)
    tools[tool] = {
        "id": tool,
        "name": {"hermes":"Hermes Agent","chrome-devtools-mcp":"Chrome DevTools MCP","claude":"Claude Code","codex":"Codex"}.get(tool, tool),
        "enabled": bool(cfg.get("enabled")),
        "autoUpdate": cfg.get("autoUpdate") is not False,
        "managedBy": cfg.get("managedBy", "tools-service"),
        "installed": bool(path),
        "binaryPath": path,
        "version": ver,
        "signedIn": auth,
    }
node_cfg = config.get("runtimes", {}).get("node", {"enabled": True, "autoInstallProjectVersions": True, "versions": ["22"]})
mise_data = os.environ.get("MISE_DATA_DIR", os.path.join(home, ".local", "share", "mise"))
node_installs = os.path.join(mise_data, "installs", "node")
installed_versions = []
if os.path.isdir(node_installs):
    installed_versions = sorted([name for name in os.listdir(node_installs) if not name.startswith(".")])
requested_versions = node_cfg.get("versions", ["22"])
if not isinstance(requested_versions, list): requested_versions = ["22"]
default_node_path, default_node_version = version("node")
runtimes = {
    "node": {
        "enabled": bool(node_cfg.get("enabled", True)),
        "autoInstallProjectVersions": bool(node_cfg.get("autoInstallProjectVersions", True)),
        "versions": [str(v) for v in requested_versions if str(v).strip()],
        "installedVersions": installed_versions,
        "miseDataDir": mise_data,
        "defaultBinaryPath": default_node_path,
        "defaultVersion": default_node_version,
    }
}
status = {
    "version": 1,
    "state": state,
    "message": message,
    "updatedAt": int(time.time() * 1000),
    "toolsRoot": tools_root,
    "autoUpdate": config.get("autoUpdate", {"enabled": True, "frequencyDays": 7}),
    "tools": tools,
    "runtimes": runtimes,
}
open(status_path, "w").write(json.dumps(status, indent=2) + "\n")
PY
}

update_once() {
  ensure_layout
  ensure_config
  write_status_start
  if flock -n 9; then
    if install_enabled_tools && install_node_versions; then
      write_status_done ready "Tools ready"
      log "Tools ready"
    else
      write_status_done error "Tool update failed; see $LOG_FILE"
      log "Tool update failed; SwarmFleet will keep running"
    fi
  else
    log "Another tool update is already running"
  fi 9>"$LOCK_FILE"
  chown -R "$PUID_VALUE:$PGID_VALUE" "$TOOLS_ROOT" "$USER_MISE_DATA_DIR" "$USER_MISE_CONFIG_DIR" 2>/dev/null || true
}

due_sleep_seconds() {
  local days
  days="$(read_config_value autoUpdate.frequencyDays)"
  case "$days" in
    ''|*[!0-9]*) days=7 ;;
  esac
  if [ "$days" -lt 1 ]; then days=1; fi
  printf '%s\n' $((days * 86400))
}

main() {
  log "Starting persistent tool manager; tools root: $TOOLS_ROOT"
  update_once
  [ "$RUN_ONCE" = "1" ] && exit 0
  while true; do
    sleep "$(due_sleep_seconds)"
    ensure_config
    if [ "$(read_config_value autoUpdate.enabled)" = "true" ]; then
      update_once
    else
      write_status_done ready "Auto-update disabled"
      log "Auto-update disabled"
    fi
  done
}

main "$@"
