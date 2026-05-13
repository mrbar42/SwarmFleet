#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORKSPACE_ROOT="$REPO_ROOT/workspace"
DEFAULT_STATE_DIR="$HOME/.local/swarmfleet"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

STATE_DIR="${SWARMFLEET_STATE_DIR:-${SWARMFLEET_MANAGER_CONFIG_DIR:-$DEFAULT_STATE_DIR}}"
ENV_STATE_DIR="${SWARMFLEET_ENV_STATE_DIR:-$STATE_DIR/env-default}"

derive_container_name() {
  if [[ -n "${SWARMFLEET_CONTAINER_NAME:-}" ]]; then
    printf '%s\n' "$SWARMFLEET_CONTAINER_NAME"
    return 0
  fi

  if [[ "$STATE_DIR" == "$DEFAULT_STATE_DIR" && "$ENV_STATE_DIR" == "$STATE_DIR/env-default" ]]; then
    printf '%s\n' "swarmfleet"
    return 0
  fi

  local base safe hash
  base="$(basename "$STATE_DIR")"
  safe="$(printf '%s' "$base" | tr -cs '[:alnum:]_.-' '-' | sed -e 's/^-*//' -e 's/-*$//')"
  [[ -n "$safe" ]] || safe="state"
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$STATE_DIR" | shasum -a 256 | awk '{print substr($1,1,8)}')"
  else
    hash="$(printf '%s' "$STATE_DIR" | cksum | awk '{print $1}')"
  fi
  printf 'swarmfleet-%s-%s\n' "$safe" "$hash"
}

NAME="$(derive_container_name)"
IMAGE="${SWARMFLEET_IMAGE:-swarmfleet:latest}"
HOST_PORT="${SWARMFLEET_HOST_PORT:-${SWARMFLEET_VITE_PORT:-7070}}"
if [[ -n "${SWARMFLEET_HOST_DEV_PORT_START:-}" ]]; then
  HOST_DEV_PORT_START="$SWARMFLEET_HOST_DEV_PORT_START"
else
  if [[ "$HOST_PORT" =~ ^[0-9]+$ && "$HOST_PORT" -ge 7070 ]]; then
    HOST_DEV_PORT_START="$((42000 + (HOST_PORT - 7070) * 10))"
  else
    HOST_DEV_PORT_START="42000"
  fi
fi
HOST_DEV_PORT_END="${SWARMFLEET_HOST_DEV_PORT_END:-$((HOST_DEV_PORT_START + 9))}"
CONFIG_DIR="${SWARMFLEET_CONFIG_DIR:-$ENV_STATE_DIR/config}"
WORKSPACE_ROOT="${SWARMFLEET_WORKSPACE_ROOT:-${SWARMFLEET_WORKSPACE:-$DEFAULT_WORKSPACE_ROOT}}"
HOME_DIR="${SWARMFLEET_HOME_DIR:-$ENV_STATE_DIR/home}"
SHM_SIZE="${SWARMFLEET_SHM_SIZE:-2g}"
NODE_MEM="${SWARMFLEET_NODE_MEM:-8192}"
TZ_VALUE="${TZ:-UTC}"
PUID_VALUE="${PUID:-$(id -u)}"
PGID_VALUE="${PGID:-$(id -g)}"
DETACH="${SWARMFLEET_DOCKER_DETACH:-0}"
BACKEND_DEPS_VOLUME="${SWARMFLEET_BACKEND_DEPS_VOLUME:-${NAME}-backend-deps}"
FRONTEND_DEPS_VOLUME="${SWARMFLEET_FRONTEND_DEPS_VOLUME:-${NAME}-frontend-deps}"
TAILSCALE_INVALID_HOST="disabled.tailscale.localhost"
TAILSCALE_MACOS_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
TAILSCALE_STATE_DIR="${SWARMFLEET_TAILSCALE_STATE_DIR:-$STATE_DIR/tailscale}"

find_tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return 0
  fi

  if [[ -x "$TAILSCALE_MACOS_CLI" ]]; then
    printf '%s\n' "$TAILSCALE_MACOS_CLI"
    return 0
  fi

  return 1
}

get_tailscale_bind_ip() {
  local tailscale_bin="${TAILSCALE_BIN:-}"
  local ip=""

  if [[ -n "${SWARMFLEET_TAILSCALE_BIND_IP:-}" ]]; then
    printf '%s\n' "$SWARMFLEET_TAILSCALE_BIND_IP"
    return 0
  fi

  if [[ -z "$tailscale_bin" ]]; then
    tailscale_bin="$(find_tailscale_cli || true)"
  fi
  [[ -n "$tailscale_bin" ]] || return 1
  "$tailscale_bin" status >/dev/null 2>&1 || return 1

  ip="$("$tailscale_bin" ip -4 2>/dev/null | sed -n '1p' || true)"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    "$tailscale_bin" status --json 2>/dev/null \
      | jq -r '.Self.TailscaleIPs[]? | select(test(":"; "n") | not)' \
      | sed -n '1p'
    return 0
  fi

  "$tailscale_bin" status --json 2>/dev/null \
    | tr -d '\n' \
    | sed -n 's/.*"TailscaleIPs"[[:space:]]*:[[:space:]]*\[[[:space:]]*"\([0-9.]*\)".*/\1/p'
}

get_tailscale_dns() {
  local tailscale_bin="${TAILSCALE_BIN:-}"

  if [[ -n "${SWARMFLEET_TAILSCALE_HOST:-}" ]]; then
    printf '%s\n' "$SWARMFLEET_TAILSCALE_HOST"
    return 0
  fi

  if [[ -z "$tailscale_bin" ]]; then
    tailscale_bin="$(find_tailscale_cli || true)"
  fi
  [[ -n "$tailscale_bin" ]] || return 1
  "$tailscale_bin" status >/dev/null 2>&1 || return 1

  if command -v jq >/dev/null 2>&1; then
    "$tailscale_bin" status --json 2>/dev/null \
      | jq -r '.Self.DNSName // empty' \
      | sed -e 's/\.$//' -e '/^null$/d' -e '/^$/d' \
      | sed -n '1p'
    return 0
  fi

  "$tailscale_bin" status --json 2>/dev/null \
    | tr -d '\n' \
    | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | sed -e 's/\.$//' -e '/^null$/d' -e '/^$/d' \
    | sed -n '1p'
}

cert_valid_for_host() {
  local cert_file="$1"
  local host="$2"

  [[ -n "$host" && -f "$cert_file" ]] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  openssl x509 -checkend 2592000 -noout -in "$cert_file" >/dev/null 2>&1 || return 1
  openssl x509 -checkhost "$host" -noout -in "$cert_file" 2>/dev/null \
    | grep -Fq "does match certificate"
}

key_file_valid() {
  local key_file="$1"

  [[ -f "$key_file" ]] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  openssl pkey -noout -in "$key_file" >/dev/null 2>&1
}

generate_tailscale_cert() {
  local host="$1"
  local cert_file="$2"
  local key_file="$3"
  local cert_dir key_dir bundle_file cert_tmp key_tmp err_file

  [[ -n "$TAILSCALE_BIN" ]] || return 1
  cert_dir="$(dirname "$cert_file")"
  key_dir="$(dirname "$key_file")"
  mkdir -p "$cert_dir" "$key_dir"

  bundle_file="$(mktemp "$cert_dir/tailscale-cert-bundle.XXXXXX")"
  cert_tmp="$(mktemp "$cert_dir/cert.pem.tmp.XXXXXX")"
  key_tmp="$(mktemp "$key_dir/key.pem.tmp.XXXXXX")"
  err_file="$(mktemp "$cert_dir/tailscale-cert-error.XXXXXX")"

  cleanup_tailscale_cert_tmp() {
    rm -f "$bundle_file" "$cert_tmp" "$key_tmp" "$err_file"
  }

  if ! "$TAILSCALE_BIN" cert --cert-file - --key-file - "$host" >"$bundle_file" 2>"$err_file"; then
    cat "$err_file" >&2
    cleanup_tailscale_cert_tmp
    return 1
  fi

  awk -v cert="$cert_tmp" -v key="$key_tmp" '
    /-----BEGIN .*PRIVATE KEY-----/ { in_key = 1 }
    { print > (in_key ? key : cert) }
  ' "$bundle_file"

  if ! cert_valid_for_host "$cert_tmp" "$host" || ! key_file_valid "$key_tmp"; then
    echo "tailscale cert output did not contain a valid certificate/key for $host" >&2
    cleanup_tailscale_cert_tmp
    return 1
  fi

  chmod 0644 "$cert_tmp"
  chmod 0600 "$key_tmp"
  mv "$cert_tmp" "$cert_file"
  mv "$key_tmp" "$key_file"
  rm -f "$bundle_file" "$err_file"
}

tailscale_note() {
  local msg="${1:-}"
  local note_file="$TAILSCALE_STATE_DIR/tailscale-error.txt"

  if [[ -z "$msg" ]]; then
    rm -f "$note_file"
    return 0
  fi

  mkdir -p "$TAILSCALE_STATE_DIR"
  printf '%s\n' "$msg" | sed -n '1,8p' >"$note_file"
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  "$REPO_ROOT/build-docker.sh"
fi

TAILSCALE_BIN="$(find_tailscale_cli || true)"
TAILSCALE_BIND_IP="$(get_tailscale_bind_ip || true)"

TAILSCALE_HOST="${SWARMFLEET_TAILSCALE_HOST:-}"
if [[ -z "$TAILSCALE_HOST" && -f "$TAILSCALE_STATE_DIR/tailscale-host.txt" ]]; then
  TAILSCALE_HOST="$(cat "$TAILSCALE_STATE_DIR/tailscale-host.txt" 2>/dev/null || true)"
fi
if [[ -z "$TAILSCALE_HOST" && -f "$CONFIG_DIR/tailscale-host.txt" ]]; then
  TAILSCALE_HOST="$(cat "$CONFIG_DIR/tailscale-host.txt" 2>/dev/null || true)"
fi
if [[ "$TAILSCALE_HOST" == "$TAILSCALE_INVALID_HOST" ]]; then
  TAILSCALE_HOST=""
fi
if [[ -z "$TAILSCALE_HOST" ]]; then
  TAILSCALE_HOST="$(get_tailscale_dns || true)"
fi
TAILSCALE_HOST="${TAILSCALE_HOST%.}"

mkdir -p "$CONFIG_DIR" "$TAILSCALE_STATE_DIR/certs" "$WORKSPACE_ROOT" "$HOME_DIR"
TAILSCALE_CERT="$TAILSCALE_STATE_DIR/certs/cert.pem"
TAILSCALE_KEY="$TAILSCALE_STATE_DIR/certs/key.pem"
CONTAINER_TAILSCALE_CERT_DIR="$CONFIG_DIR/certs/tailscale"
CONTAINER_TAILSCALE_CERT="$CONTAINER_TAILSCALE_CERT_DIR/cert.pem"
CONTAINER_TAILSCALE_KEY="$CONTAINER_TAILSCALE_CERT_DIR/key.pem"
if [[ -n "$TAILSCALE_HOST" ]]; then
  if cert_valid_for_host "$TAILSCALE_CERT" "$TAILSCALE_HOST" && [[ -f "$TAILSCALE_KEY" ]]; then
    mkdir -p "$CONTAINER_TAILSCALE_CERT_DIR"
    cp "$TAILSCALE_CERT" "$CONTAINER_TAILSCALE_CERT"
    cp "$TAILSCALE_KEY" "$CONTAINER_TAILSCALE_KEY"
    printf '%s\n' "$TAILSCALE_HOST" >"$CONFIG_DIR/tailscale-host.txt"
    printf '%s\n' "$TAILSCALE_HOST" >"$TAILSCALE_STATE_DIR/tailscale-host.txt"
    tailscale_note
  elif [[ -n "$TAILSCALE_BIN" ]]; then
    CERT_OUTPUT="$(generate_tailscale_cert "$TAILSCALE_HOST" "$TAILSCALE_CERT" "$TAILSCALE_KEY" 2>&1)" && CERT_STATUS=0 || CERT_STATUS=$?
    if [[ "$CERT_STATUS" == "0" ]]; then
      mkdir -p "$CONTAINER_TAILSCALE_CERT_DIR"
      cp "$TAILSCALE_CERT" "$CONTAINER_TAILSCALE_CERT"
      cp "$TAILSCALE_KEY" "$CONTAINER_TAILSCALE_KEY"
      printf '%s\n' "$TAILSCALE_HOST" >"$CONFIG_DIR/tailscale-host.txt"
      printf '%s\n' "$TAILSCALE_HOST" >"$TAILSCALE_STATE_DIR/tailscale-host.txt"
      tailscale_note
    else
      tailscale_note "${CERT_OUTPUT:-tailscale cert failed for $TAILSCALE_HOST}"
      rm -f "$CONFIG_DIR/tailscale-host.txt" "$TAILSCALE_STATE_DIR/tailscale-host.txt" "$CONTAINER_TAILSCALE_CERT" "$CONTAINER_TAILSCALE_KEY"
      TAILSCALE_HOST=""
    fi
  else
    tailscale_note "tailscale CLI not found"
    rm -f "$CONFIG_DIR/tailscale-host.txt" "$TAILSCALE_STATE_DIR/tailscale-host.txt" "$CONTAINER_TAILSCALE_CERT" "$CONTAINER_TAILSCALE_KEY"
    TAILSCALE_HOST=""
  fi
else
  if [[ -n "$TAILSCALE_BIN" ]]; then
    tailscale_note "no Tailscale DNSName"
  else
    tailscale_note "tailscale CLI not found"
  fi
  rm -f "$CONFIG_DIR/tailscale-host.txt" "$TAILSCALE_STATE_DIR/tailscale-host.txt" "$CONTAINER_TAILSCALE_CERT" "$CONTAINER_TAILSCALE_KEY"
  TAILSCALE_HOST=""
fi

PORT_FLAGS=(
  -p "127.0.0.1:${HOST_PORT}:443"
)
if [[ -n "$TAILSCALE_BIND_IP" ]]; then
  PORT_FLAGS+=(
    -p "${TAILSCALE_BIND_IP}:${HOST_PORT}:443"
  )
fi

docker volume create "$BACKEND_DEPS_VOLUME" >/dev/null 2>&1 || true
docker volume create "$FRONTEND_DEPS_VOLUME" >/dev/null 2>&1 || true

docker rm -f "$NAME" >/dev/null 2>&1 || true

ENV_FLAGS=(
  -e "TZ=$TZ_VALUE"
  -e "NODE_OPTIONS=--max-old-space-size=$NODE_MEM"
  -e "PUID=$PUID_VALUE"
  -e "PGID=$PGID_VALUE"
  -e "SWARMFLEET_FRONTEND_PORT=7070"
  -e "SWARMFLEET_WORKSPACE=/workspace"
  -e "WORKSPACES_ROOT=/workspace"
  -e "PORT=7080"
  -e "API_PORT=7080"
  -e "SWARMFLEET_CONFIG_DIR=/config"
  -e "SWARMFLEET_PUBLIC_PORT=$HOST_PORT"
  -e "SWARMFLEET_CADDY_HTTPS_PORT=7443"
  -e "SWARMFLEET_TAILSCALE_HOST=${TAILSCALE_HOST:-$TAILSCALE_INVALID_HOST}"
  -e "SWARMFLEET_HOST_DEV_PORT_START=$HOST_DEV_PORT_START"
  -e "SWARMFLEET_HOST_DEV_PORT_END=$HOST_DEV_PORT_END"
  -e "SWARMFLEET_HARNESS_DIR=/opt/swarmfleet/harness"
  -e "SWARMFLEET_BACKEND_DIR=/opt/swarmfleet/harness/backend"
  -e "SWARMFLEET_FRONTEND_DIR=/opt/swarmfleet/harness/frontend"
)

for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
           CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX \
           OPENROUTER_API_KEY OPENROUTER_BASE_URL OPENROUTER_MODEL \
           GEMINI_API_KEY OPENAI_API_KEY; do
  if [[ -n "${!var:-}" ]]; then
    ENV_FLAGS+=(-e "$var=${!var}")
  fi
done

DOCKER_RUN_ARGS=(
  --name "$NAME"
  --hostname "$NAME"
  --shm-size "$SHM_SIZE"
  --cap-add SYS_PTRACE
  --sysctl net.ipv6.conf.all.disable_ipv6=1
  "${PORT_FLAGS[@]}"
  -p "127.0.0.1:${HOST_DEV_PORT_START}-${HOST_DEV_PORT_END}:${HOST_DEV_PORT_START}-${HOST_DEV_PORT_END}"
  -v "$CONFIG_DIR:/config"
  -v "$HOME_DIR:/home/user"
  -v "$WORKSPACE_ROOT:/workspace"
  -v "$REPO_ROOT/harness:/opt/swarmfleet/harness"
  -v "$BACKEND_DEPS_VOLUME:/opt/swarmfleet/harness/backend/node_modules"
  -v "$FRONTEND_DEPS_VOLUME:/opt/swarmfleet/harness/frontend/node_modules"
  "${ENV_FLAGS[@]}"
  "$IMAGE"
)

if [[ -n "$TAILSCALE_BIND_IP" ]]; then
  echo "Starting $NAME (HTTP+HTTPS port $HOST_PORT on 127.0.0.1 and Tailscale $TAILSCALE_BIND_IP, dev ports $HOST_DEV_PORT_START-$HOST_DEV_PORT_END, workspace: $WORKSPACE_ROOT)"
else
  echo "Starting $NAME (HTTP+HTTPS port $HOST_PORT on 127.0.0.1 only, dev ports $HOST_DEV_PORT_START-$HOST_DEV_PORT_END, workspace: $WORKSPACE_ROOT)"
fi

if [[ "$DETACH" == "1" ]]; then
  docker run -d "${DOCKER_RUN_ARGS[@]}"
  exit 0
fi

cleanup() {
  local status=$?
  trap - EXIT SIGINT SIGTERM SIGHUP
  echo ""
  echo "Stopping $NAME..."
  docker stop -t 10 "$NAME" >/dev/null 2>&1 || true
  docker rm "$NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT SIGINT SIGTERM SIGHUP

echo "Press Ctrl+C to stop"
echo ""

docker run -t "${DOCKER_RUN_ARGS[@]}"
