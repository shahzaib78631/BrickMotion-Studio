#!/usr/bin/env bash
# Generate a batch of BrickHeadz with learned headwear/hair patterns, then
# certify and repair them: the mesh validator names the offending pieces and the
# generator drops exactly those, iterating until every model is CLEAR.
#
#   scripts/brickheadz-cast.sh [count] [seed] [--face]
set -euo pipefail
cd "$(dirname "$0")/.."

COUNT=20
SEED=7
FACE=""
case "${1:-}" in ''|--*) ;; *) COUNT="$1"; shift ;; esac
case "${1:-}" in ''|--*) ;; *) SEED="$1"; shift ;; esac
for arg in "$@"; do [ "$arg" = "--face" ] && FACE="--face"; done

OUT=.cache/brickheadz/cast
REPAIRS=.cache/brickheadz/repairs.json

echo "Generating $COUNT models (seed $SEED) $FACE"
rm -rf "$OUT"
(cd python && uv run python -m brickheadz sample --count "$COUNT" --seed "$SEED" --cast $FACE --out "../$OUT")

for pass in 1 2 3; do
  if npx tsx scripts/validate-brickheadz.ts public/ldraw "$OUT" --repairs="$REPAIRS"; then
    echo "All clear (after $((pass - 1)) repair pass(es))."
    exit 0
  fi
  echo "Repair pass $pass"
  (cd python && uv run python -m brickheadz repair --repairs "../$REPAIRS" --dir "../$OUT")
done

npx tsx scripts/validate-brickheadz.ts public/ldraw "$OUT"
