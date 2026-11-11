"""Offline check: does each booklet's printed parts list have the same shape as its OMR?

cd python && .venv/bin/python ../scripts/verify_part_identity.py
Needs .cache/booklet-mpd/audit.json and the cached booklet extractions.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from booklet_mpd.audit import TRUTH_LOADERS
from booklet_mpd.inventory_check import count_signature, omr_counter
from booklet_mpd.pairing import find_pairs

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def main():
    audit = {r["set"]: r for r in json.loads((OUT / "audit.json").read_text())["pairs"]}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    rows = []
    for pair in pairs:
        extract = json.loads((OUT / "extract" / f"{pair.set_number}-{pair.booklet}" / "extract.json").read_text())
        inventory = extract["inventory"]
        if not inventory:
            rows.append({"set": pair.set_number, "status": "no printed parts list found"})
            continue
        truth = TRUTH_LOADERS["expand"](str(pair.omr), warnings=[])
        rows.append({"set": pair.set_number, "status": "checked", **count_signature(inventory, omr_counter(truth))})
    (OUT / "part-identity-signature.json").write_text(json.dumps(rows, indent=1))
    print(f"{'set':7}{'bk total':>9}{'omr total':>10}{'bk dist':>8}{'omr dist':>9}{'counts shared':>14}  result")
    for r in rows:
        if r["status"] != "checked":
            print(f"{r['set']:7}  {r['status']}")
            continue
        verdict = "SAME SHAPE" if r["same_signature"] else ("same total" if r["same_total"] else "differs")
        print(f"{r['set']:7}{r['booklet_total']:>9}{r['omr_total']:>10}{r['booklet_distinct']:>8}{r['omr_distinct']:>9}"
              f"{r['shared_counts']:>10}/{r['omr_total']:<4} {verdict}")
    checked = [r for r in rows if r["status"] == "checked"]
    print(f"same shape: {sum(r['same_signature'] for r in checked)} of {len(checked)} checked; same total: {sum(r['same_total'] for r in checked)}")


if __name__ == "__main__":
    main()
