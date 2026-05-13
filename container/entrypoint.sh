#!/bin/bash
set -e

# ==============================================================================
# SwarmFleet — Container Entrypoint
# Handles: UID/GID remapping, first-boot bootstrap, s6-overlay handoff
# ==============================================================================

CLAUDE_USER="user"
CLAUDE_HOME="/home/user"
WORKSPACE_DIR="/workspace"
HARNESS_DIR="${SWARMFLEET_HARNESS_DIR:-/opt/swarmfleet/harness}"
TOOLS_ROOT="${SWARMFLEET_TOOLS_ROOT:-$CLAUDE_HOME/.swarmfleet/tools}"
export SWARMFLEET_TOOLS_ROOT="$TOOLS_ROOT"
export EDITOR="${EDITOR:-nano}"
export VISUAL="${VISUAL:-nano}"
export PATH="/command:/usr/local/sbin:/usr/local/bin:$TOOLS_ROOT/bin:$TOOLS_ROOT/npm/bin:$TOOLS_ROOT/python/bin:$PATH"
export npm_config_prefix="$TOOLS_ROOT/npm"
export NPM_CONFIG_PREFIX="$TOOLS_ROOT/npm"

# ---------- UID/GID remapping ----------
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

CURRENT_UID=$(id -u "$CLAUDE_USER")
CURRENT_GID=$(id -g "$CLAUDE_USER")

if [ "$PGID" != "$CURRENT_GID" ]; then
    echo "[entrypoint] Changing user GID from $CURRENT_GID to $PGID"
    groupmod -o -g "$PGID" user
fi

if [ "$PUID" != "$CURRENT_UID" ]; then
    echo "[entrypoint] Changing user UID from $CURRENT_UID to $PUID"
    usermod -o -u "$PUID" user
fi

# ---------- Fix home directory ownership ----------
chown "$PUID:$PGID" "$CLAUDE_HOME"
mkdir -p "$CLAUDE_HOME/.claude" "$CLAUDE_HOME/.hermes" "$TOOLS_ROOT/bin" "$TOOLS_ROOT/npm" "$TOOLS_ROOT/python" "$TOOLS_ROOT/state" "$TOOLS_ROOT/logs"
mkdir -p "$CLAUDE_HOME/.local/share/mise" "$CLAUDE_HOME/.config/mise"
chown "$PUID:$PGID" "$CLAUDE_HOME/.claude"
chown "$PUID:$PGID" "$CLAUDE_HOME/.hermes"
chown -R "$PUID:$PGID" "$CLAUDE_HOME/.swarmfleet"
chown -R "$PUID:$PGID" "$CLAUDE_HOME/.local" "$CLAUDE_HOME/.config"

# ---------- Ensure /workspace is writable ----------
# Docker creates missing bind-mount directories as root on the host.
# Fix the top-level workspace ownership here so the mapped claude user can write.
mkdir -p "$WORKSPACE_DIR"
if ! runuser -u "$CLAUDE_USER" -- test -w "$WORKSPACE_DIR"; then
    echo "[entrypoint] /workspace is not writable for $CLAUDE_USER — attempting ownership fix"
    chown "$PUID:$PGID" "$WORKSPACE_DIR" 2>/dev/null || true
fi

if ! runuser -u "$CLAUDE_USER" -- test -w "$WORKSPACE_DIR"; then
    echo "[entrypoint] WARNING: /workspace is still not writable; fix host ownership or PUID/PGID"
fi

# ---------- Ensure ~/.claude.json exists with onboarding completed ----------
if [ ! -f "$CLAUDE_HOME/.claude.json" ]; then
    echo '{"hasCompletedOnboarding":true,"numStartups":10,"installMethod":"native"}' > "$CLAUDE_HOME/.claude.json"
    chown "$PUID:$PGID" "$CLAUDE_HOME/.claude.json"
fi
# Ensure onboarding is always marked complete (even if file exists from older version)
if command -v jq >/dev/null 2>&1; then
    CLAUDE_JSON="$CLAUDE_HOME/.claude.json"
    NEEDS_UPDATE=$(jq -r '.hasCompletedOnboarding // false' "$CLAUDE_JSON" 2>/dev/null)
    if [ "$NEEDS_UPDATE" != "true" ]; then
        TMPFILE=$(mktemp)
        jq '.hasCompletedOnboarding = true | .numStartups = (.numStartups // 10)' "$CLAUDE_JSON" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_JSON"
        chown "$PUID:$PGID" "$CLAUDE_JSON"
    fi
fi

# Ensure baseline Claude MCPs survive fresh ignored-data boots.
if command -v jq >/dev/null 2>&1; then
    CLAUDE_JSON="$CLAUDE_HOME/.claude.json"
    TMPFILE=$(mktemp)
    jq '
      .mcpServers = (.mcpServers // {}) |
      .mcpServers["chrome-devtools"] = (.mcpServers["chrome-devtools"] // {
        "type": "stdio",
        "command": "chrome-devtools-mcp",
        "args": [
          "--isolated",
          "--headless",
          "--executablePath=/usr/bin/chromium",
          "--chromeArg=--no-sandbox",
          "--chromeArg=--disable-dev-shm-usage"
        ],
        "env": {}
      })
    ' "$CLAUDE_JSON" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_JSON"
    chown "$PUID:$PGID" "$CLAUDE_JSON"
fi

# Pre-accept trust dialog for workspace directories so claude never prompts
if command -v jq >/dev/null 2>&1; then
    CLAUDE_JSON="$CLAUDE_HOME/.claude.json"
    # Trust the workspace root, mounted backend source dir, and all top-level project dirs
    TRUST_DIRS="$WORKSPACE_DIR $HARNESS_DIR"
    for subdir in "$WORKSPACE_DIR"/*/; do
        [ -d "$subdir" ] && TRUST_DIRS="$TRUST_DIRS ${subdir%/}"
    done
    UPDATED=false
    for dir in $TRUST_DIRS; do
        ACCEPTED=$(jq -r --arg d "$dir" '.projects[$d].hasTrustDialogAccepted // false' "$CLAUDE_JSON" 2>/dev/null)
        if [ "$ACCEPTED" != "true" ]; then
            TMPFILE=$(mktemp)
            jq --arg d "$dir" '
              .projects[$d] = (.projects[$d] // {}) |
              .projects[$d].hasTrustDialogAccepted = true |
              .projects[$d].projectOnboardingSeenCount = 1 |
              .projects[$d].allowedTools = (.projects[$d].allowedTools // [])
            ' "$CLAUDE_JSON" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_JSON"
            UPDATED=true
        fi
    done
    if [ "$UPDATED" = "true" ]; then
        chown "$PUID:$PGID" "$CLAUDE_JSON"
    fi
fi

# ---------- Ensure theme is set in settings.json to skip theme picker ----------
SETTINGS_JSON="$CLAUDE_HOME/.claude/settings.json"
if [ -f "$SETTINGS_JSON" ] && command -v jq >/dev/null 2>&1; then
    HAS_THEME=$(jq -r '.theme // empty' "$SETTINGS_JSON" 2>/dev/null)
    if [ -z "$HAS_THEME" ]; then
        TMPFILE=$(mktemp)
        jq '.theme = "dark"' "$SETTINGS_JSON" > "$TMPFILE" && mv "$TMPFILE" "$SETTINGS_JSON"
        chown "$PUID:$PGID" "$SETTINGS_JSON"
    fi
fi

# ---------- Hermes Agent global configuration ----------
# ~/.hermes lives under /home/user, which is bind-mounted by the Docker launcher,
# so sessions/auth/config persist with the rest of SwarmFleet data.
configure_hermes() {
    export HERMES_HOME_DIR="$CLAUDE_HOME/.hermes"
    export HERMES_MCP_ENTRY="${SWARMFLEET_BACKEND_DIR:-$HARNESS_DIR/backend}/mcp/bin.ts"
    python3 <<'PY'
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import yaml

home = Path(os.environ["HERMES_HOME_DIR"])
home.mkdir(parents=True, exist_ok=True)
config_path = home / "config.yaml"

try:
    config = yaml.safe_load(config_path.read_text("utf-8")) if config_path.exists() else {}
except Exception:
    config = {}
if not isinstance(config, dict):
    config = {}

model = config.setdefault("model", {})
if isinstance(model, dict):
    model.setdefault("default", "gpt-5.5")
    model.setdefault("provider", "openai-codex")
    model.setdefault("base_url", "https://openrouter.ai/api/v1")

terminal = config.setdefault("terminal", {})
if isinstance(terminal, dict):
    terminal.setdefault("backend", "local")
    terminal.setdefault("cwd", ".")
    terminal.setdefault("timeout", 180)
    terminal.setdefault("lifetime_seconds", 300)

platform_toolsets = config.setdefault("platform_toolsets", {})
if isinstance(platform_toolsets, dict):
    cli_tools = platform_toolsets.get("cli")
    if not isinstance(cli_tools, list) or not cli_tools:
        platform_toolsets["cli"] = ["hermes-cli"]
    elif "hermes-cli" not in cli_tools:
        cli_tools.append("hermes-cli")

tsx_command = os.environ.get("HERMES_TSX_COMMAND") or str(Path(os.environ.get("SWARMFLEET_BACKEND_DIR", "/opt/swarmfleet/harness/backend")) / "node_modules" / ".bin" / "tsx")
mcp_entry = Path(os.environ.get("HERMES_MCP_ENTRY", ""))
mcp_command = tsx_command
mcp_args = [str(mcp_entry)]
mcp_servers = config.setdefault("mcp_servers", {})
if isinstance(mcp_servers, dict):
    existing = mcp_servers.get("swarmfleet")
    swarmfleet = existing if isinstance(existing, dict) else {}
    swarmfleet.update({
        "enabled": True,
        "command": mcp_command,
        "args": mcp_args,
        "env": {
            "SWARMFLEET_PARENT_SESSION_ID": "${SWARMFLEET_PARENT_SESSION_ID}",
            "SWARMFLEET_INTERNAL_TOKEN": "${SWARMFLEET_INTERNAL_TOKEN}",
            "SWARMFLEET_BACKEND_URL": "${SWARMFLEET_BACKEND_URL}",
        },
        "timeout": int(swarmfleet.get("timeout") or 300),
        "connect_timeout": int(swarmfleet.get("connect_timeout") or 60),
    })
    mcp_servers["swarmfleet"] = swarmfleet

config_path.write_text(yaml.safe_dump(config, sort_keys=False), "utf-8")

codex_auth_path = Path("/home/user/.codex/auth.json")
hermes_auth_path = home / "auth.json"
try:
    codex_auth = json.loads(codex_auth_path.read_text("utf-8"))
except Exception:
    codex_auth = {}
tokens = codex_auth.get("tokens") if isinstance(codex_auth, dict) else None
if not isinstance(tokens, dict):
    tokens = codex_auth if isinstance(codex_auth, dict) else None
has_codex_tokens = (
    isinstance(tokens, dict)
    and isinstance(tokens.get("access_token"), str)
    and tokens.get("access_token")
    and isinstance(tokens.get("refresh_token"), str)
    and tokens.get("refresh_token")
)
if has_codex_tokens:
    try:
        store = json.loads(hermes_auth_path.read_text("utf-8")) if hermes_auth_path.exists() else {}
    except Exception:
        store = {}
    if not isinstance(store, dict):
        store = {}
    providers = store.setdefault("providers", {})
    if isinstance(providers, dict) and not isinstance(providers.get("openai-codex"), dict):
        providers["openai-codex"] = {
            "tokens": tokens,
            "last_refresh": codex_auth.get("last_refresh") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "auth_mode": "chatgpt",
        }
        store.setdefault("active_provider", "openai-codex")
        store["version"] = 1
        store["updated_at"] = datetime.now(timezone.utc).isoformat()
        hermes_auth_path.write_text(json.dumps(store, indent=2) + "\n", "utf-8")
        hermes_auth_path.chmod(0o600)
PY
    chown -R "$PUID:$PGID" "$CLAUDE_HOME/.hermes"
}

configure_hermes

# ---------- TLS certificates ----------
# Generates localhost certs. Tailscale certs, when enabled, are host-provided under /config/certs/tailscale.
if ! SWARMFLEET_CONFIG_DIR="${SWARMFLEET_CONFIG_DIR:-/config}" /usr/local/bin/setup-certs.sh; then
    echo "[entrypoint] WARNING: setup-certs.sh failed — HTTPS may not start"
fi

# ---------- Ensure DISPLAY is set ----------
export DISPLAY=:99

# ---------- First-boot bootstrap ----------
SENTINEL="$CLAUDE_HOME/.claude/.swarmfleet-bootstrapped"
if [ ! -f "$SENTINEL" ]; then
    echo "[entrypoint] First boot detected — running bootstrap.sh"
    if ! /usr/local/bin/bootstrap.sh; then
        echo "[entrypoint] WARNING: bootstrap.sh failed — continuing anyway"
    fi
fi

# ---------- Hand off to s6-overlay ----------
echo "[entrypoint] Starting s6-overlay..."
exec /init "$@"
