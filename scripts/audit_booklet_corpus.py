"""Audit booklet/OMR step alignment for every matched pair.

cd python && .venv/bin/python ../scripts/audit_booklet_corpus.py --split train,validation,test
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from booklet_mpd.audit import audit_pair
from booklet_mpd.pairing import find_pairs

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--split", default="validation,test")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    wanted = set(args.split.split(","))
    pairs, skips = find_pairs(SOURCES, OMR, ROOT)
    pairs = [p for p in pairs if p.split in wanted][: args.limit]
    OUT.mkdir(parents=True, exist_ok=True)
    rows = [audit_pair(p, OUT / "extract") for p in pairs]
    (OUT / "audit.json").write_text(json.dumps({"pairs": rows, "skips": skips}, indent=1))
    print(f"{'set':8}{'split':11}{'booklet':>8}{'omr':>6}{'blocks':>7}{'sim':>6}  status")
    for r in rows:
        status = "ok" if r["alignment_ok"] else (r["extraction_error"] or r["alignment_reason"])
        print(f"{r['set']:8}{r['split']:11}{r['booklet_steps']:>8}{r['omr_steps']:>6}{r['omr_blocks']:>7}{r['mean_similarity']:>6.2f}  {status}")
    print(f"usable: {sum(r['alignment_ok'] for r in rows)} of {len(rows)}")


if __name__ == "__main__":
    main()
