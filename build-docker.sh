#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

IMAGE="${SWARMFLEET_IMAGE:-swarmfleet:latest}"
CACHE_DIR="${SWARMFLEET_BUILDX_CACHE_DIR:-$REPO_ROOT/.buildx-cache}"
CACHE_NEXT_DIR="${CACHE_DIR}.next"

rm -rf "$CACHE_NEXT_DIR"

BUILD_ARGS=(
  docker buildx build
  --load
  --progress="${BUILDKIT_PROGRESS:-auto}"
  --cache-to "type=local,dest=$CACHE_NEXT_DIR,mode=max"
  -t "$IMAGE"
  -f "$REPO_ROOT/container/Dockerfile"
  --target dev
)

if [[ -d "$CACHE_DIR" ]]; then
  BUILD_ARGS+=(
    --cache-from "type=local,src=$CACHE_DIR"
  )
fi

"${BUILD_ARGS[@]}" "$REPO_ROOT"

rm -rf "$CACHE_DIR"
mv "$CACHE_NEXT_DIR" "$CACHE_DIR"
