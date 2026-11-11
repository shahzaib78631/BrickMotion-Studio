"""Which parts does a booklet picture show? Compare visibility hypotheses per step (train sets only).

cd python && .venv/bin/python ../scripts/visibility_hypotheses.py 42105 42120 40456 40386
A child-only (submodel's own progress, BEFORE the step)  B in-context  C cumulative before the step  D AFTER the step (A + the parts the step adds, seated).
Each is scored by the scale-constrained view fit; infeasible fits score 0.
"""
import json
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.baseline import group_context, group_visible
from booklet_mpd.pairing import find_pairs
from booklet_mpd.protocol import assert_tuning_allowed
from booklet_mpd.rawimages import main_model_image_info
from booklet_mpd.truth import build_scoped_steps
from booklet_mpd.viewfit import BOOKLET_SCALE, fit_view

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/booklet-mpd/sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def main():
    grades = json.loads((OUT / "grades.json").read_text())
    audit = {r["set"]: r for r in json.loads((OUT / "audit.json").read_text())["pairs"]}
    pairs = {p.set_number: p for p in find_pairs(SOURCES, OMR, ROOT)[0]}
    lib = load_library(str(ROOT / "public/ldraw"))
    for setno in sys.argv[1:]:
        assert_tuning_allowed(setno, grades)
        pair, row = pairs[setno], audit[setno]
        pdf = pymupdf.open(pair.pdf)
        steps = json.loads((OUT / "extract" / f"{setno}-{pair.booklet}" / "extract.json").read_text())["steps"]
        scoped = build_scoped_steps(str(pair.omr), expand_submodels=row["truth_mode"] == "expand", warnings=[])
        visible, context = group_visible(scoped, row["groups"]), group_context(scoped, row["groups"])
        eligible = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and steps[g[0][0]].get("pictureBox")
                    and 0 < len(visible[i]) + len(context[i]) <= 150]
        wins = {"A": 0, "B": 0, "C": 0, "D": 0, "none": 0}
        for gi, bi in eligible[:: max(1, len(eligible) // 8)][:8]:
            step = steps[bi]
            image, ppx = main_model_image_info(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            if image is None:
                continue
            first = row["groups"][gi][1][0]
            added = [p for o in row["groups"][gi][1] for p in scoped[o]["added"]]
            hyp = {"A": visible[gi], "B": context[gi] + visible[gi],
                   "C": [p for s in scoped[:first] for p in s["added"]], "D": visible[gi] + added}
            scores = {}
            for name, parts in hyp.items():
                scores[name] = fit_view(lib, parts, image, pts_per_px=ppx, scale_prior=BOOKLET_SCALE)["iou"] if parts else 0.0
            best = max(scores, key=scores.get)
            wins[best if scores[best] > 0 else "none"] += 1
            print(f"{setno} step {step['number']:3} file {scoped[first]['file'][-22:]:22} ctx {len(context[gi]):3} vis {len(visible[gi]):3} | added {len(added):3} | A {scores['A']:.2f}  B {scores['B']:.2f}  C {scores['C']:.2f}  D(after) {scores['D']:.2f}  -> {best if scores[best] > 0 else 'none'}", flush=True)
        print(f"== {setno}: wins {wins}\n", flush=True)


if __name__ == "__main__":
    main()
