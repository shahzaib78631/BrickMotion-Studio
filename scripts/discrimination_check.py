"""Does the consistency check still discriminate? Matched vs mismatched step parts (train sets only).

cd python && .venv/bin/python ../scripts/discrimination_check.py 40349 40348 40350
For sampled steps: fit_view(parts of the step, its own picture) vs fit_view(parts of a DIFFERENT step of the
same set, same picture). A useful check has matched IoU well above mismatched IoU.
"""
import json
import statistics
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.baseline import group_visible
from booklet_mpd.pairing import find_pairs
from booklet_mpd.protocol import assert_tuning_allowed
from booklet_mpd.rawimages import main_model_image
from booklet_mpd.truth import build_scoped_steps
from booklet_mpd.viewfit import fit_view

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def main():
    grades = json.loads((OUT / "grades.json").read_text())
    audit = {r["set"]: r for r in json.loads((OUT / "audit.json").read_text())["pairs"]}
    pairs = {p.set_number: p for p in find_pairs(SOURCES, OMR, ROOT)[0]}
    lib = load_library(str(ROOT / "public/ldraw"))
    matched, mismatched = [], []
    for setno in sys.argv[1:]:
        assert_tuning_allowed(setno, grades)
        pair, row = pairs[setno], audit[setno]
        pdf = pymupdf.open(pair.pdf)
        steps = json.loads((OUT / "extract" / f"{setno}-{pair.booklet}" / "extract.json").read_text())["steps"]
        visible = group_visible(build_scoped_steps(str(pair.omr), expand_submodels=row["truth_mode"] == "expand", warnings=[]), row["groups"])
        eligible = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and steps[g[0][0]].get("pictureBox") and 4 <= len(visible[i]) <= 90]
        chosen = eligible[:: max(1, len(eligible) // 6)][:6]
        for k, (gi, bi) in enumerate(chosen):
            step = steps[bi]
            image = main_model_image(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            if image is None:
                continue
            other_gi = chosen[(k + len(chosen) // 2) % len(chosen)][0]      # a different step, far away in the sequence
            a = fit_view(lib, visible[gi], image)["iou"]
            b = fit_view(lib, visible[other_gi], image)["iou"]
            matched.append(a)
            mismatched.append(b)
            print(f"{setno} step {step['number']:3} matched {a:.2f}   mismatched {b:.2f}", flush=True)
    print(f"matched: median {statistics.median(matched):.2f}, min {min(matched):.2f} | mismatched: median {statistics.median(mismatched):.2f}, max {max(mismatched):.2f}")
    for t in (0.7, 0.8, 0.85):
        print(f"threshold {t}: matched pass {sum(v >= t for v in matched) / len(matched):.0%}, mismatched pass (false accept) {sum(v >= t for v in mismatched) / len(mismatched):.0%}")


if __name__ == "__main__":
    main()
