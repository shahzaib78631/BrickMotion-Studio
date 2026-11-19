#!/bin/bash
# The app's gates: open to first frame (warm part cache: the second of two runs) and edit to
# frame, on the helicopter and on 10030-1 four times over. Prints one JSON line per run.
set -euo pipefail
app="$1"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
big="$work/10030-x4.ldr"
"$repo/native/build/render/bmshot" "$repo/public/data/omr/10030-1/10030-1.mpd" --out "$work/x4.png" --size 64x64 --repeat 2x2 --save-model "$big" > /dev/null
for model in "$repo/samples/helicopter/helicopter.mpd" "$big"; do
  "$app" --bench-open "$model" > /dev/null  # warms the part cache
  "$app" --bench-open "$model"
  "$app" --bench-edit "$model"
done
