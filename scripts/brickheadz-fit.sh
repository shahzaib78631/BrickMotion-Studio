#!/usr/bin/env bash
# photo OR video + inventory -> best model -> certify with the Phase-3 mesh oracle,
# repairing only flagged pattern pieces until CLEAR. The MPD is emitted from the
# certified plan through the studio's own placement.
#
#   scripts/brickheadz-fit.sh <image-or-video> <inventory> [extra args...]
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${1:?usage: brickheadz-fit.sh <image-or-video> <inventory> [args]}
INVENTORY=${2:?usage: brickheadz-fit.sh <image-or-video> <inventory> [args]}
shift 2
IMAGE="$(cd "$(dirname "$IMAGE")" && pwd)/$(basename "$IMAGE")"
INVENTORY="$(cd "$(dirname "$INVENTORY")" && pwd)/$(basename "$INVENTORY")"

OUT=.cache/brickheadz/fit
REPAIRS=.cache/brickheadz/fit-repairs.json
rm -rf "$OUT"

case "$IMAGE" in
  *.mp4|*.mov|*.m4v|*.webm|*.mkv)
    (cd python && uv run python -m brickheadz video --video "$IMAGE" --inventory "$INVENTORY" --out "../$OUT" "$@") ;;
  *)
    (cd python && uv run python -m brickheadz fit --image "$IMAGE" --inventory "$INVENTORY" --out "../$OUT" "$@") ;;
esac

for pass in 1 2 3; do
  if npx tsx scripts/validate-brickheadz.ts public/ldraw "$OUT" --repairs="$REPAIRS"; then
    npx tsx scripts/validate-brickheadz.ts public/ldraw "$OUT" --emit-mpd >/dev/null
    npx tsx scripts/validate-brickheadz.ts public/ldraw "$OUT"
    echo "Certified (after $((pass - 1)) repair pass(es))."
    exit 0
  fi
  echo "Repair pass $pass"
  (cd python && uv run python -m brickheadz repair --repairs "../$REPAIRS" --dir "../$OUT")
done

echo "Still blocked after repairs." >&2
exit 1
