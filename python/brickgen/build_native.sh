#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/python/brickgen/_brickgen_native.dylib"
SRC="$ROOT/python/brickgen/_brickgen_native.cpp"

clang++ -std=c++20 -O3 -shared -fPIC \
  -I"$ROOT/native/core/include" \
  -I"$ROOT/native/build/_deps/json-src/include" \
  "$SRC" \
  "$ROOT/native/build/core/libbmcore.a" \
  "$ROOT/native/build/_deps/miniz-build/libminiz.a" \
  -o "$OUT.new"

mv "$OUT.new" "$OUT"
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
