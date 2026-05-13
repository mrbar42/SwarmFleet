# SwarmFleet user-shell mise integration.
# SwarmFleet services use the baked /usr/local/bin Node runtime; interactive
# user/agent shells use persisted mise state and honor project files such as
# .node-version, .nvmrc, .tool-versions, and mise.toml.

if [ -n "${HOME:-}" ]; then
  export EDITOR="${EDITOR:-nano}"
  export VISUAL="${VISUAL:-nano}"
  export MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
  export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-$HOME/.config/mise}"
  case ":$PATH:" in
    *":$HOME/.local/share/mise/shims:"*) ;;
    *) export PATH="$HOME/.local/share/mise/shims:$PATH" ;;
  esac
fi

if [ -n "${BASH_VERSION:-}" ] && command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)"
fi
