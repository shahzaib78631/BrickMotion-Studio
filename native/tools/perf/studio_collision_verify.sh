#!/usr/bin/env bash
# Portable C++20 validation, independent of CMake/Metal/Catch2.
# Run from any directory. Requires a C++20 compiler and system zlib.
# Optional: BM_PORTABLE_SANITIZE=1, CXX=clang++, BM_VERIFY_OUT=/path/to/binary
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
if [[ -n "${BM_VERIFY_OUT:-}" ]]; then
  target=$BM_VERIFY_OUT
  mkdir -p "$(dirname "$target")"
else
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/bm-studio-verify.XXXXXXXX")
  trap 'rm -rf "$scratch"' EXIT
  target=$scratch/studio_collision_verify
fi
flags=(-std=c++20 -O2 -Wall -Wextra -Werror -pthread)
if [[ "${BM_PORTABLE_SANITIZE:-0}" == 1 ]]; then
  flags=(-std=c++20 -O0 -g0 -Wall -Wextra -Werror -pthread -fsanitize=address,undefined -fno-omit-frame-pointer)
fi
"${CXX:-c++}" "${flags[@]}" -Itools/perf/compat -Icore/include \
  tools/perf/studio_collision_verify.cpp \
  core/src/io/studio_io.cpp core/src/io/ldraw_io.cpp \
  core/src/collide/geometry_audit.cpp core/src/collide/world.cpp \
  core/src/collide/shape.cpp core/src/collide/pair.cpp core/src/collide/tritri.cpp \
  core/src/ldraw/library.cpp core/src/ldraw/flatten.cpp \
  core/src/ldraw/parse.cpp core/src/ldraw/colors.cpp \
  core/src/cache/part_cache.cpp core/src/model/model.cpp \
  core/src/plan/certify.cpp -lz -o "$target"
"$target" tests/fixtures/lib tests/fixtures/studio "$@"
