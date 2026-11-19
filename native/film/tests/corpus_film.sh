#!/bin/bash
# The camera director measured: bm film --correct at 16:9 and 9:16 on the owner's 19 projects
# and the corpus smoke tier, gathered into one table.
#   film/tests/corpus_film.sh <out dir> [jobs] [owner]   (owner: the 19 projects only)
# Run from native/ after building bm. BM_DATA_DIR overrides /Users/mac/Projects/BrickMotion-Data.
set -u
out=${1:?usage: corpus_film.sh <out dir> [jobs]}
jobs=${2:-6}
only=${3:-}
here=$(cd "$(dirname "$0")/../.." && pwd)
repo=$(dirname "$here")
data=${BM_DATA_DIR:-/Users/mac/Projects/BrickMotion-Data}
export BM_LDRAW_DIR=${BM_LDRAW_DIR:-$repo/public/ldraw}
export BM_SHADOW_DIR=${BM_SHADOW_DIR:-$repo/vendor/LDCadShadowLibrary}
bm="$here/build/tools/bm/bm"
mkdir -p "$out"

# One line a model: <set> <id> <file>
list="$out/models.txt"
: > "$list"
for f in "$data"/*/*.brickmotion; do
  printf 'owner\t%s\t%s\n' "$(basename "$(dirname "$f")")/$(basename "$f")" "$f" >> "$list"
done
[ "$only" = owner ] || python3 - "$here/corpus/manifest.json" "$repo" "$data" >> "$list" <<'EOF'
import json, os, sys
manifest, repo, data = sys.argv[1:]
for e in json.load(open(manifest)):
    if e.get("tier") != "smoke": continue
    external = e.get("source") in ("omr", "bricknet", "moc")
    print("smoke\t%s\t%s" % (e["id"], os.path.join(data if external else repo, e["path"])))
EOF

run() {
  local set=$1 id=$2 file=$3 aspect=$4
  local name
  name=$(printf '%s' "$set-$id-$aspect" | tr '/: ' '___')
  "$bm" film "$file" --correct --aspect "$aspect" --threads 1 --out "$out/$name.json" > "$out/$name.txt" 2>&1
  printf '%s\t%s\t%s\t%s\t%s\n' "$set" "$id" "$aspect" "$?" "$name" >> "$out/runs.tsv"
}
export -f run
export bm out
: > "$out/runs.tsv"
while IFS=$'\t' read -r set id file; do
  for aspect in 16:9 9:16; do printf '%s\0%s\0%s\0%s\0' "$set" "$id" "$file" "$aspect"; done
done < "$list" | xargs -0 -n 4 -P "$jobs" bash -c 'run "$@"' _

python3 - "$out" <<'EOF'
import json, os, sys
out = sys.argv[1]
rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(out, "runs.tsv")) if l.strip()]
rows.sort(key=lambda r: (r[0] != "owner", r[1], r[2]))
table = []
print("%-6s %-58s %-5s %9s %9s %6s %8s %6s %7s %5s %7s %8s" % ("set", "model", "shape", "in frame", "seen", "inside", "jerk", "cuts", "short", "rules", "ms", "plan ms"))
for set_, id_, aspect, code, name in rows:
    path = os.path.join(out, name + ".json")
    if code != "0" or not os.path.exists(path):
        print("%-6s %-58s %-5s  FAILED (exit %s): %s" % (set_, id_[-58:], aspect, code, open(os.path.join(out, name + ".txt")).read().strip().splitlines()[-1:] or ""))
        table.append({"set": set_, "id": id_, "aspect": aspect, "failed": int(code)})
        continue
    r = json.load(open(path))["report"]
    print("%-6s %-58s %-5s %4d/%-4d %4d/%-4d %6d %8.1f %6.1f %7.2f %5d %7.0f %8.0f" % (set_, id_[-58:], aspect, r["landingsInFrame"], r["landings"], r["landingsSeen"], r["landings"], r["insideFrames"], r["maxJerk"], r["cutsPerMinute"], r["shortestShot"], len(r["rules"]), r["ms"], r["planMs"]))
    table.append(dict(set=set_, id=id_, aspect=aspect, **{k: r[k] for k in ("landings", "landingsInFrame", "landingsSeen", "insideFrames", "maxJerk", "maxTargetJump", "cutsPerMinute", "shortestShot", "ms", "planMs")}, rules=len(r["rules"])))
json.dump(table, open(os.path.join(out, "table.json"), "w"), indent=1)
for s in ("owner", "smoke"):
    t = [x for x in table if x["set"] == s and "failed" not in x]
    if t: print("%s: seen as they land %d/%d" % (s, sum(x["landingsSeen"] for x in t), sum(x["landings"] for x in t)))
    t = [x for x in table if x["set"] == s and "failed" not in x]
    if not t: continue
    land = sum(x["landingsInFrame"] for x in t), sum(x["landings"] for x in t)
    print("%s: %d runs, landings in frame %d/%d (%.1f%%), inside %d, rule misses %d, worst jerk %.1f, ms p50 %.0f max %.0f, failed %d" % (
        s, len(t), land[0], land[1], 100.0 * land[0] / max(1, land[1]), sum(x["insideFrames"] for x in t), sum(x["rules"] for x in t),
        max(x["maxJerk"] for x in t), sorted(x["ms"] for x in t)[len(t) // 2], max(x["ms"] for x in t), sum(1 for x in table if x["set"] == s and "failed" in x)))
EOF
