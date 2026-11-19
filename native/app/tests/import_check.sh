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
echo "import_check: ok"
