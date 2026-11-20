#!/bin/bash
# An import opens as an untitled project and saving writes a new project: the source file is
# never written over, and the saved project reads back with the edit in it.
set -euo pipefail
app="$1"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
src="$work/stack.ldr"
cp "$repo/native/tests/fixtures/plan/stack.ldr" "$src"
before=$(shasum -a 256 "$src" | cut -d' ' -f1)
first=$(awk '$1 == "1" { print $3; exit }' "$src")
"$app" --open "$src" --edit-move 0 20 0 0 --save-to "$work/out.brickmotion"
after=$(shasum -a 256 "$src" | cut -d' ' -f1)
[ "$before" = "$after" ] || { echo "import_check: the source file changed"; exit 1; }
python3 - "$work/out.brickmotion" "$first" <<'PY'
import json, sys
project = json.load(open(sys.argv[1]))
assert project.get("format") == "brickmotion-project", project.get("format")
first = project["plan"]["steps"][0]["pieces"][0]
assert first["ldu"][0] == float(sys.argv[2]) + 20, first
PY
# The saved project opens with every piece.
[ "$("$app" --open "$work/out.brickmotion")" = "pieces 3" ] || { echo "import_check: the saved project does not open"; exit 1; }

# Saving an existing file uses AppKit's version-preserving write path.
"$app" --open "$work/out.brickmotion" --edit-move 0 20 0 0 --save-to "$work/out.brickmotion"
python3 - "$work/out.brickmotion" "$first" <<'PY'
import json, sys
project = json.load(open(sys.argv[1]))
assert project["plan"]["steps"][0]["pieces"][0]["ldu"][0] == float(sys.argv[2]) + 40
PY

# Structure edits round-trip: a submodel made and renamed, a step inserted with a title and a
# pause, a piece moved to it. The saved plan holds them, its ids are unique, and the web app's
# own reader opens it with every piece.
heli="$repo/samples/helicopter/helicopter.mpd"
"$app" --open "$heli" --edit-structure --save-to "$work/structure.brickmotion"
python3 - "$work/structure.brickmotion" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))["plan"]
sub = plan["submodels"]["Sub A"]
assert sum(len(s["pieces"]) for s in sub["steps"]) == 3, sub
assert plan["steps"][0].get("title") == "Base", plan["steps"][0]
assert plan["steps"][0].get("pauseAfter") == 1.5, plan["steps"][0]
for name, model in [("", plan)] + list(plan["submodels"].items()):
    ids = [i["id"] for s in model["steps"] for i in s["pieces"] if "id" in i]
    assert len(ids) == len(set(ids)), (name, sorted(i for i in ids if ids.count(i) > 1))
PY
want=$("$app" --open "$heli" | awk '{ print $2 }')
if [ -x "$repo/node_modules/.bin/tsx" ]; then
  cat > "$work/read.ts" <<TS
import { readFileSync } from 'node:fs';
import { readProjectFile } from '$repo/src/io/projectFile.ts';
const r = readProjectFile(readFileSync(process.argv[2], 'utf8'));
if (!r.ok) { console.log('error', r.errors.join('; ')); process.exit(1); }
const count = (m: any): number => m.steps.reduce((n: number, s: any) => n + s.pieces.reduce((k: number, i: any) => k + (i.submodel ? count((r.plan as any).submodels[i.submodel]) : 1), 0), 0);
console.log(count(r.plan));
TS
  got=$(cd "$repo" && node_modules/.bin/tsx "$work/read.ts" "$work/structure.brickmotion")
  [ "$got" = "$want" ] || { echo "import_check: the web reader counts $got pieces, the app $want"; exit 1; }
  echo "import_check: web reader reads $got pieces"
else
  echo "import_check: web reader skipped (no node_modules)"
fi
echo "import_check: ok"
