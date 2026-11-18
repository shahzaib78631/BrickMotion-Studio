#!/usr/bin/env bash
# Portable baseline for running the same BrickMotion CLI against real models on an M1.
# This only uses standard shell, awk, and /usr/bin/time.
set -u
if [ "$#" -lt 2 ]; then
  echo 'usage: BM_LDRAW_DIR=/path/to/ldraw bash tools/perf/m1_profile.sh /path/to/bm model1.mpd [model2.io ...]' >&2
  echo 'Optional: BM_PLAN_BUDGET=15 BM_PERF_OUT=/path/to/results BM_RUN_OVERLAPS=1' >&2
  exit 2
fi
BM_BIN=$1
shift
if [ ! -x "$BM_BIN" ]; then echo "not executable: $BM_BIN" >&2; exit 2; fi
if [ -z "${BM_LDRAW_DIR:-}" ] || [ ! -d "$BM_LDRAW_DIR" ]; then
  echo 'Set BM_LDRAW_DIR to the full LDraw parts library before running.' >&2
  exit 2
fi
BUDGET=${BM_PLAN_BUDGET:-15}
OUT=${BM_PERF_OUT:-"./bm-m1-profile-$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$OUT"
CSV=$OUT/results.csv
printf 'model,scenario,wall_seconds,exit_code,log\n' > "$CSV"
number=0
for model in "$@"; do
  if [ ! -f "$model" ]; then echo "missing model: $model" >&2; continue; fi
  number=$((number+1))
  name=$(basename "$model")
  safe=$(printf '%s' "$name" | tr -cs '[:alnum:]._' '_')
  run() {
    scenario=$1
    shift
    log="$OUT/${number}_${safe}_${scenario}.log"
    timing="$OUT/${number}_${safe}_${scenario}.time"
    /usr/bin/time -p "$BM_BIN" "$@" > "$log" 2> "$timing"
    rc=$?
    wall=$(awk '$1 == "real" { print $2; exit }' "$timing")
    [ -n "$wall" ] || wall=NA
    escaped=$(printf '%s' "$name" | sed 's/"/""/g')
    printf '"%s",%s,%s,%s,"%s"\n' "$escaped" "$scenario" "$wall" "$rc" "$log" >> "$CSV"
    echo "${name}: ${scenario} wall=${wall}s status=${rc}"
    if [ "$rc" -ne 0 ]; then cat "$timing" >&2; fi
  }
  run load load "$model"
  run plan_4 plan "$model" --threads 4 --budget "$BUDGET"
  run plan_8 plan "$model" --threads 8 --budget "$BUDGET"
  run plan_4_no_certify plan "$model" --threads 4 --budget "$BUDGET" --no-certify
  if [ "${BM_RUN_OVERLAPS:-0}" = 1 ]; then
    run overlaps overlaps "$model"
  fi
done
echo "Results: $CSV"
echo "Send the CSV and log files back for an M1-specific diagnosis."
