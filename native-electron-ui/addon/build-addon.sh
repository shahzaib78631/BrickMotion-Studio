#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NATIVE_BUILD="${BM_NATIVE_BUILD:-$REPO_ROOT/native/build-app}"
OUT_DIR="$SCRIPT_DIR/build"
OUT_FILE="$OUT_DIR/bm_native.node"

# Locate Node-API headers (works with Homebrew Node, nvm, or NODE_INCLUDE_DIR)
NODE_INCLUDE="${NODE_INCLUDE_DIR:-}"
if [[ -z "$NODE_INCLUDE" ]]; then
  for candidate in \
    /opt/homebrew/include/node \
    /usr/local/include/node \
    "$(dirname "$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)")/../include/node"; do
    if [[ -f "$candidate/node_api.h" ]]; then
      NODE_INCLUDE="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_INCLUDE" || ! -f "$NODE_INCLUDE/node_api.h" ]]; then
  echo "error: could not find node_api.h; set NODE_INCLUDE_DIR" >&2
  exit 1
fi

if [[ ! -f "$NATIVE_BUILD/app/libbmapp.a" ]]; then
  echo "error: native library $NATIVE_BUILD/app/libbmapp.a not found." >&2
  echo "Build it first with:" >&2
  echo "  cmake -S native -B native/build-app -G Ninja -DBM_APP=ON" >&2
  echo "  cmake --build native/build-app --target bmapp bm bmshot bmexport" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Building $OUT_FILE against $NATIVE_BUILD ..."
clang++ \
  -std=c++20 \
  -O2 \
  -arch arm64 \
  -mmacosx-version-min=15.0 \
  -fobjc-arc \
  -bundle \
  -undefined dynamic_lookup \
  -DNAPI_VERSION=8 \
  -I"$NODE_INCLUDE" \
  -I"$REPO_ROOT/native/app/bmapp/include" \
  "$SCRIPT_DIR/binding.mm" \
  "$NATIVE_BUILD/app/libbmapp.a" \
  "$NATIVE_BUILD/render/libbmrender.a" \
  "$NATIVE_BUILD/render/libbmtools_common.a" \
  "$NATIVE_BUILD/film/libbmfilm.a" \
  "$NATIVE_BUILD/sound/libbmsound.a" \
  "$NATIVE_BUILD/core/libbmcore.a" \
  "$NATIVE_BUILD/_deps/miniz-build/libminiz.a" \
  -framework Metal \
  -framework QuartzCore \
  -framework Foundation \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework AppKit \
  -framework UniformTypeIdentifiers \
  -o "$OUT_FILE"

echo "Built $OUT_FILE successfully."
