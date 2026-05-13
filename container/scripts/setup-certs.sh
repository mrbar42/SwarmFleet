#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${SWARMFLEET_CONFIG_DIR:-$HOME/.config/swarmfleet}"
CERT_DIR="$CONFIG_DIR/certs"
TAILSCALE_CERT_DIR="$CERT_DIR/tailscale"
TAILSCALE_CERT="$TAILSCALE_CERT_DIR/cert.pem"
TAILSCALE_KEY="$TAILSCALE_CERT_DIR/key.pem"
TAILSCALE_HOST_FILE="$CONFIG_DIR/tailscale-host.txt"
TAILSCALE_INVALID_HOST="disabled.tailscale.localhost"

mkdir -p "$CERT_DIR" "$TAILSCALE_CERT_DIR"

cert_valid_for_host() {
  local cert_file="$1"
  local host="$2"

  [[ -n "$host" && -f "$cert_file" ]] || return 1
  openssl x509 -checkend 2592000 -noout -in "$cert_file" >/dev/null 2>&1 || return 1
  openssl x509 -checkhost "$host" -noout -in "$cert_file" 2>/dev/null \
    | grep -Fq "does match certificate"
}

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'EOF'
mkcert is required to generate trusted localhost TLS certificates.

macOS:
  brew install mkcert nss
EOF
  exit 1
fi

mkcert -install

if ! cert_valid_for_host "$CERT_DIR/cert.pem" localhost; then
  (
    cd "$CERT_DIR"
    mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1
  )
fi

CAROOT="$(mkcert -CAROOT)"
ROOT_CA="$CAROOT/rootCA.pem"

echo "cert.pem: $CERT_DIR/cert.pem"
echo "key.pem: $CERT_DIR/key.pem"
echo "rootCA.pem: $ROOT_CA"

# Tailscale certs are host-owned. The container only verifies mounted files.
if [[ -n "${SWARMFLEET_TAILSCALE_HOST:-}" && "${SWARMFLEET_TAILSCALE_HOST:-}" != "$TAILSCALE_INVALID_HOST" ]]; then
  TS_HOST="${SWARMFLEET_TAILSCALE_HOST%.}"
  if ! cert_valid_for_host "$TAILSCALE_CERT" "$TS_HOST" || [[ ! -f "$TAILSCALE_KEY" ]]; then
    echo "missing host-provided Tailscale cert for $TS_HOST at $TAILSCALE_CERT / $TAILSCALE_KEY" >&2
    exit 1
  fi
  printf '%s\n' "$TS_HOST" >"$TAILSCALE_HOST_FILE"
  echo "Tailscale hostname: $TS_HOST"
  echo "tailscale cert.pem: $TAILSCALE_CERT"
  echo "tailscale key.pem: $TAILSCALE_KEY"
else
  # Dummy files keep the disabled Caddy placeholder site parseable.
  cp "$CERT_DIR/cert.pem" "$TAILSCALE_CERT"
  cp "$CERT_DIR/key.pem" "$TAILSCALE_KEY"
  printf '%s\n' "$TAILSCALE_INVALID_HOST" >"$TAILSCALE_HOST_FILE"
fi
