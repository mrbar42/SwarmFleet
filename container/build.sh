#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# SwarmFleet — Build Docker Image
# Internal helper; the supported user-facing launcher is ./swarmfleet.sh
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_NAME="swarmfleet"
IMAGE_TAG="latest"
CACHE_DIR="${SWARMFLEET_BUILDX_CACHE_DIR:-$ROOT_DIR/.buildx-cache}"
CACHE_NEXT_DIR="${CACHE_DIR}.next"

echo "Building $IMAGE_NAME:$IMAGE_TAG..."

rm -rf "$CACHE_NEXT_DIR"

if [[ -d "$CACHE_DIR" ]]; then
  docker buildx build \
    --load \
    --progress="${BUILDKIT_PROGRESS:-auto}" \
    --cache-from "type=local,src=$CACHE_DIR" \
    --cache-to "type=local,dest=$CACHE_NEXT_DIR,mode=max" \
    -f "$SCRIPT_DIR/Dockerfile" \
    -t "$IMAGE_NAME:$IMAGE_TAG" \
    "$ROOT_DIR"
else
  docker buildx build \
    --load \
    --progress="${BUILDKIT_PROGRESS:-auto}" \
    --cache-to "type=local,dest=$CACHE_NEXT_DIR,mode=max" \
    -f "$SCRIPT_DIR/Dockerfile" \
    -t "$IMAGE_NAME:$IMAGE_TAG" \
    "$ROOT_DIR"
fi

rm -rf "$CACHE_DIR"
mv "$CACHE_NEXT_DIR" "$CACHE_DIR"
