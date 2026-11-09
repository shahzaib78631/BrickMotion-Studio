#!/bin/sh
# Waits until enough EyeSight teacher images exist, then trains a larger ShadeNet and exports it.
#   sh scripts/neural/auto-train.sh 30 v3 "16,32,48,80,128" 10000
MIN=${1:-30}; NAME=${2:-v3}; WIDTHS=${3:-16,32,48,80,128}; STEPS=${4:-10000}
cd "$(dirname "$0")/../.." || exit 1
# a scene is usable once it has its EyeSight target and the dome-visibility buffer
count() { n=0; for d in data/neuralshade/scene_*/; do [ -f "$d/target.png" ] && [ -f "$d/vis.bin.gz" ] && n=$((n+1)); done; echo $n; }
until [ "$(count)" -ge "$MIN" ]; do sleep 120; done
echo "$(date) $(count) targets: training $NAME"
cd python/neuralshade || exit 1
uv run python -m neuralshade.train --steps "$STEPS" --holdout 2 --batch 8 --crop 320 --widths "$WIDTHS" --mode mul --half --cache 9 --out "../../data/neuralshade/shadenet_$NAME.pt" &&
uv run python -m neuralshade.export "../../data/neuralshade/shadenet_$NAME.pt" --out "../../public/models/shadenet_$NAME" &&
echo "$(date) done: public/models/shadenet_$NAME"
