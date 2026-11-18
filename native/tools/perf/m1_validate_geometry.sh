#!/usr/bin/env bash
# Native M1 geometry validation. Produces per-model JSON, an auditable CSV,
# and optional overlap logs. Does not use a planning budget or change geometry.
# Usage: BM_LDRAW_DIR=/full/ldraw bash tools/perf/m1_validate_geometry.sh \
#          /path/to/bm model1.mpd model2.io ...
set -euo pipefail
if (( $# < 2 )); then
  echo 'usage: BM_LDRAW_DIR=/full/ldraw bash tools/perf/m1_validate_geometry.sh /path/to/bm model1.mpd [model2.io ...]' >&2
  exit 2
fi
bm=$1
shift
if [[ ! -x "$bm" ]]; then echo "bm is not executable: $bm" >&2; exit 2; fi
if [[ -z "${BM_LDRAW_DIR:-}" || ! -d "$BM_LDRAW_DIR" ]]; then
  echo 'BM_LDRAW_DIR must point to a complete installed LDraw library.' >&2
  exit 2
fi
out=${BM_VERIFY_DIR:-"./bm-geometry-verify-$(date +%Y%m%d-%H%M%S)"}
mkdir -p "$out"
: > "$out/index.bin"
index=0
for model in "$@"; do
  ((index+=1))
  if [[ ! -f "$model" ]]; then
    echo "model not found: $model" >&2
    printf '%s\0%s\0%s\0' "$model" '-' 2 >> "$out/index.bin"
    continue
  fi
  file=$(printf '%03d.json' "$index")
  log=$(printf '%03d.stderr.log' "$index")
  if "$bm" load "$model" --check-geometry --json > "$out/$file" 2> "$out/$log"; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\0%s\0%s\0' "$model" "$file" "$rc" >> "$out/index.bin"
  if (( rc != 0 )); then cat "$out/$log" >&2; fi
  if [[ "${BM_RUN_OVERLAPS:-0}" == 1 && $rc == 0 ]]; then
    "$bm" overlaps "$model" > "$out/$(printf '%03d' "$index").overlaps.log" 2>&1 || true
  fi
done
python3 - "$out" <<'PY'
import csv
import json
import os
import sys
from pathlib import Path

out = Path(sys.argv[1])
# NUL-terminated manifest: valid file paths can contain tabs and newlines.
raw = (out / 'index.bin').read_bytes().split(b'\0')
if raw[-1] != b'' or (len(raw) - 1) % 3:
    raise RuntimeError('malformed result manifest')
values = [os.fsdecode(value) for value in raw[:-1]]
entries = [dict(model=values[i], json_file=values[i + 1], load_exit_code=values[i + 2])
           for i in range(0, len(values), 3)]
fields = ['model', 'pieces', 'customAvailable', 'customLoaded', 'structurallyComplete',
          'distinctPartTypes', 'typesWithMissingDependencies', 'typesWithoutShape',
          'malformedEmbeddedLines', 'auditMs', 'error']
failures = 0
with (out / 'summary.csv').open('w', newline='', encoding='utf-8') as dest:
    writer = csv.DictWriter(dest, fieldnames=fields)
    writer.writeheader()
    for entry in entries:
        row = {'model': entry['model'], 'error': ''}
        status = int(entry['load_exit_code'])
        try:
            if status:
                raise ValueError(f'bm load returned {status}; see stderr log')
            doc = json.loads((out / entry['json_file']).read_text(encoding='utf-8'))
            audit = doc['geometryAudit']
            custom = doc.get('studioCustomParts', {})
            row.update(pieces=doc['pieces'], customAvailable=custom.get('available', 0),
                       customLoaded=custom.get('loaded', 0),
                       structurallyComplete=audit['structurallyComplete'],
                       distinctPartTypes=audit['distinctParts'],
                       typesWithMissingDependencies=audit['partsWithMissingDependencies'],
                       typesWithoutShape=audit['partsWithoutCollisionShapes'],
                       malformedEmbeddedLines=audit['malformedEmbeddedLines'],
                       auditMs=round(doc.get('geometryAuditMs', 0), 2))
            if not audit['structurallyComplete']:
                failures += 1
        except (KeyError, ValueError, OSError, json.JSONDecodeError) as exc:
            failures += 1
            row['error'] = str(exc)
        writer.writerow(row)
        print(f"{row['model']}: complete={row.get('structurallyComplete', 'N/A')} "
              f"missing={row.get('typesWithMissingDependencies', 'N/A')} "
              f"no-shape={row.get('typesWithoutShape', 'N/A')}")
print(f'Geometry audit: {out / "summary.csv"}; {failures} incomplete or failed model(s)')
if failures:
    print('Use the full LDraw library before treating an incomplete audit as a code defect.')
if failures and os.environ.get('BM_FAIL_ON_INCOMPLETE') == '1':
    sys.exit(1)
PY
