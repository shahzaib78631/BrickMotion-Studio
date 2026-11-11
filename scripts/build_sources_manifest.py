"""Write benchmarks/booklet-mpd/sources.json: the union of the arrow catalog and the OMR-targeted catalog."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from booklet_mpd.manifest import merge_manifests

merged = merge_manifests([ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json",
                          ROOT / "benchmarks/booklet-mpd/catalog-omr-sources.json"])
out = ROOT / "benchmarks/booklet-mpd/sources.json"
out.write_text(json.dumps(merged, indent=1))
print(f"{len(merged['booklets'])} booklets -> {out}")
