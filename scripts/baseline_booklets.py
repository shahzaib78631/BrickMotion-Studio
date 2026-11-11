"""Baseline the current placement solver on audited real booklets (oracle parts list).

cd python && .venv/bin/python ../scripts/baseline_booklets.py --split validation,test
Requires .cache/booklet-mpd/audit.json from audit_booklet_corpus.py.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.baseline import BUDGET_KEYS, error_budget, run_set
from booklet_mpd.pairing import find_pairs
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.reconstruct import steps_from_omr

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def read_image(path):
    pix = pymupdf.Pixmap(str(path))
    if pix.alpha:
        pix = pymupdf.Pixmap(pix, 0)
    if pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3).copy()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--split", default="validation,test")
    args = ap.parse_args()
    wanted = set(args.split.split(","))
    audit = json.loads((OUT / "audit.json").read_text())["pairs"]
    usable = {r["set"]: r for r in audit if r["alignment_ok"] and r["split"] in wanted}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    palette = ldconfig_rgb(str(ROOT / "public/ldraw/LDConfig.ldr"))
    results = []
    for pair in pairs:
        row = usable.get(pair.set_number)
        if not row:
            continue
        folder = OUT / "extract" / f"{pair.set_number}-{pair.booklet}"
        steps = json.loads((folder / "extract.json").read_text())["steps"]
        pictures = [read_image(folder / s["picture"]) if s.get("picture") else None for s in steps]
        result = run_set(lib, palette, steps_from_omr(str(pair.omr)), pictures, row["aligned"])
        result.update(set=pair.set_number, split=pair.split)
        results.append(result)
        print(pair.set_number, pair.split, result["steps_total"], "steps;", result["parts_exact"], "/",
              result["parts_predicted"], "parts exact; first failure:", result["first_failure"])
    statuses = [s for r in results for s in r["statuses"]]
    summary = {"splits": sorted(wanted), "sets": len(results), "budget": error_budget(statuses),
               "parts_predicted": sum(r["parts_predicted"] for r in results),
               "parts_exact": sum(r["parts_exact"] for r in results)}
    (OUT / "baseline.json").write_text(json.dumps({"summary": summary, "sets": results}, indent=1, default=str))
    lines = ["# Baseline: current solver, oracle parts list", "",
             f"Splits: {', '.join(summary['splits'])}. Sets scored: {summary['sets']} (of the audited pairs whose steps aligned).", "",
             f"Parts placed: {summary['parts_predicted']}; exact: {summary['parts_exact']}.", "",
             "## Error budget (share of steps)", "", "| outcome | share |", "|---|---|"]
    lines += [f"| {k} | {summary['budget'][k]:.1%} |" for k in BUDGET_KEYS]
    lines += ["", "## Per set", "", "| set | split | steps | supported | attempted | exact/placed | first failure |", "|---|---|---|---|---|---|---|"]
    for r in results:
        f = r["first_failure"]
        lines.append(f"| {r['set']} | {r['split']} | {r['steps_total']} | {r['steps_supported']} | {r['steps_attempted']} | "
                     f"{r['parts_exact']}/{r['parts_predicted']} | {('step %d: %s' % (f['step'], f['message'][:60])) if f else ''} |")
    (OUT / "baseline.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
