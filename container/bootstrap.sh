#!/bin/bash
set -e

# ==============================================================================
# SwarmFleet — First-Boot Bootstrap
# Runs once on first container start, then creates a sentinel to skip next time.
# Delete ~/.claude/.swarmfleet-bootstrapped to re-trigger.
# ==============================================================================

CLAUDE_HOME="/home/user"
CLAUDE_USER="user"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DEFAULTS_DIR="${SWARMFLEET_DEFAULTS_DIR:-/opt/swarmfleet/defaults}"

echo "[bootstrap] Running first-boot initialization..."

# ---------- Create directory structure ----------
mkdir -p "$CLAUDE_HOME/.claude" "$CLAUDE_HOME/.codex" "$CLAUDE_HOME/.hermes"

# ---------- Copy settings.json ----------
[ -f "$CLAUDE_HOME/.claude/settings.json" ] && cp "$CLAUDE_HOME/.claude/settings.json" "$CLAUDE_HOME/.claude/settings.json.bak"
cp "$DEFAULTS_DIR/claude-settings.json" "$CLAUDE_HOME/.claude/settings.json"
echo "[bootstrap] Copied settings.json"

# ---------- Git configuration ----------
GIT_USER_NAME="${GIT_USER_NAME:-SwarmFleet User}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-noreply@localhost}"
runuser -u "$CLAUDE_USER" -- git config --global --replace-all safe.directory '*'
runuser -u "$CLAUDE_USER" -- git config --global user.name "$GIT_USER_NAME"
runuser -u "$CLAUDE_USER" -- git config --global user.email "$GIT_USER_EMAIL"
echo "[bootstrap] Configured git as '$GIT_USER_NAME <$GIT_USER_EMAIL>'"

# ---------- Codex CLI default configuration ----------
CODEX_CONFIG="$CLAUDE_HOME/.codex/config.toml"
export CODEX_CONFIG
python3 <<'PY'
from pathlib import Path
import os
import re

path = Path(os.environ["CODEX_CONFIG"])
text = path.read_text("utf-8") if path.exists() else ""

def split_lines(value: str) -> list[str]:
    return value.splitlines()

def finish(lines: list[str]) -> str:
    return "\n".join(lines).rstrip() + "\n"

def set_top_level(text: str, key: str, value: str) -> str:
    lines = split_lines(text)
    assignment = f"{key} = {value}"
    first_section = len(lines)

    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            first_section = index
            break
        if re.match(rf"^{re.escape(key)}\s*=", stripped):
            lines[index] = assignment
            return finish(lines)

    lines.insert(first_section, assignment)
    return finish(lines)

def set_section_value(text: str, section: str, key: str, value: str) -> str:
    lines = split_lines(text)
    header = f"[{section}]"
    assignment = f"{key} = {value}"

    try:
        section_index = next(
            index for index, line in enumerate(lines) if line.strip() == header
        )
    except StopIteration:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend([header, assignment])
        return finish(lines)

    insert_at = len(lines)
    for index in range(section_index + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped.startswith("["):
            insert_at = index
            break
        if re.match(rf"^{re.escape(key)}\s*=", stripped):
            lines[index] = assignment
            return finish(lines)

    lines.insert(insert_at, assignment)
    return finish(lines)

text = set_top_level(text, "approval_policy", '"never"')
text = set_top_level(text, "sandbox_mode", '"danger-full-access"')
text = set_top_level(text, "web_search_request", "true")
text = set_section_value(text, "sandbox_workspace_write", "network_access", "true")
text = set_section_value(text, "features", "codex_hooks", "true")
path.write_text(text, "utf-8")
PY
echo "[bootstrap] Enforced Codex CLI yolo config (approval never, no sandbox, network enabled, hooks enabled)"

# ---------- Codex CLI notification hook ----------
if [ ! -f "$CLAUDE_HOME/.codex/hooks.json" ]; then
    cat > "$CLAUDE_HOME/.codex/hooks.json" <<'JSON'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/notify.py stop",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
JSON
    echo "[bootstrap] Created Codex CLI notification hook"
fi

# ---------- Gemini CLI notification hook ----------
# DISABLED: @google/gemini-cli removed. Uncomment if re-enabled.
# if [ ! -f "$CLAUDE_HOME/.gemini/settings.json" ]; then
#     cat > "$CLAUDE_HOME/.gemini/settings.json" <<'JSON'
# {
#   "hooks": {
#     "SessionEnd": [
#       {
#         "matcher": "*",
#         "hooks": [
#           {
#             "name": "notify",
#             "type": "command",
#             "command": "/usr/local/bin/notify.py stop",
#             "timeout": 30000
#           }
#         ]
#       }
#     ]
#   }
# }
# JSON
#     echo "[bootstrap] Created Gemini CLI notification hook"
# fi

# ---------- Cursor CLI hooks ----------
# DISABLED: Cursor CLI removed. Uncomment if re-enabled.
# if [ ! -f "$CLAUDE_HOME/.cursor/hooks.json" ]; then
#     cat > "$CLAUDE_HOME/.cursor/hooks.json" <<'JSON'
# {
#   "version": 1,
#   "hooks": {
#     "stop": [
#       {
#         "type": "command",
#         "command": "/usr/local/bin/notify.py stop",
#         "timeout": 30
#       }
#     ]
#   }
# }
# JSON
#     echo "[bootstrap] Created Cursor CLI hooks (pre-configured)"
# fi

# ---------- Fix ownership ----------
chown -R "$PUID:$PGID" "$CLAUDE_HOME/.claude" "$CLAUDE_HOME/.codex" "$CLAUDE_HOME/.hermes"

# ---------- Create sentinel ----------
touch "$CLAUDE_HOME/.claude/.swarmfleet-bootstrapped"
chown "$PUID:$PGID" "$CLAUDE_HOME/.claude/.swarmfleet-bootstrapped"

echo "[bootstrap] First-boot initialization complete."
