#!/usr/bin/env bash
# Renders every scene in data/neuralshade that lacks target_blender.png with Blender Cycles on
# the Metal GPU (render.py), one scene at a time. Resumable: finished scenes are skipped and a
# render only appears under its final name once complete.
#
#   scripts/neural/blender/render-all.sh [--dir data/neuralshade] [--samples 128] [--force] [--only "03000 03013"] [extra render.py args]
#
# Run from the repository root. Geometry is exported once per batch (all missing scenes in one
# Node process) into /private/tmp/claude-501/blender/geom.
set -euo pipefail
cd "$(dirname "$0")/../../.."
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
DIR=data/neuralshade
SAMPLES=128
FORCE=0
ONLY=""
GEOM=/private/tmp/claude-501/blender/geom
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --samples) SAMPLES=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    --only) ONLY=" $2 "; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

todo=()
for d in "$DIR"/scene_*/; do
  d=${d%/}
  [ -f "$d/scene.json" ] || continue
  if [ -n "$ONLY" ]; then id=$(basename "$d"); [[ "$ONLY" == *" ${id#scene_} "* ]] || continue; fi
  if [ $FORCE = 0 ] && [ -f "$d/target_blender.png" ]; then continue; fi
  todo+=("$d")
done
echo "${#todo[@]} scene(s) to render"
[ ${#todo[@]} -gt 0 ] || exit 0

# export the geometry of every scene that has none yet, in one Node run
need=()
for d in "${todo[@]}"; do
  id=$(basename "$d"); id=${id#scene_}
  [ -f "$GEOM/$id/scene.json" ] || need+=("$d")
done
[ ${#need[@]} -gt 0 ] && npx tsx scripts/neural/blender/export-scene.ts "${need[@]}" --out "$GEOM"

n=0
for d in "${todo[@]}"; do
  n=$((n + 1))
  tmp="$d/target_blender.partial.png"
  t0=$(date +%s)
  if "$BLENDER" -b --factory-startup --python scripts/neural/blender/render.py -- "$d" "$tmp" --samples "$SAMPLES" ${EXTRA[@]+"${EXTRA[@]}"} 2>&1 | grep -E "BLENDER_RENDER_DONE|Error|error:" ; then :; fi
  if [ -f "$tmp" ]; then
    mv "$tmp" "$d/target_blender.png"
    echo "::progress $n/${#todo[@]}  ✓ $d in $(( $(date +%s) - t0 )) s"
  else
    echo "✗ $d failed" >&2
  fi
done
