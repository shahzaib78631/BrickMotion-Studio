"""Why do some sets with ~perfect part identity score low on visible-IoU? (train sets only)

cd python && .venv/bin/python ../scripts/low_iou_diagnosis.py 42105 40386 ...
For sampled steps: IoU of (a) scoped visible parts at the fixed camera, (b) cumulative parts, (c) scoped
visible parts at the best FREE camera. Every orientation of the 24 is tried; best foreground component wins.
"""
import json
import statistics
import sys
from pathlib import Path

import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.baseline import group_visible
from booklet_mpd.camera_fit import _clouds, normalise, silhouette
from booklet_mpd.pairing import find_pairs
from booklet_mpd.protocol import assert_tuning_allowed
from booklet_mpd.rawimages import main_model_image
from booklet_mpd.stepimage import model_components
from booklet_mpd.truth import build_scoped_steps
from brickheadz.instruction_place import _rotations24, iou

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"
SIZE = 80
ROT = [np.asarray(r, float)[:3, :3] for r in _rotations24()]
FREE = [(y, p) for y in range(0, 360, 15) for p in (20, 30, 40, 50)]


def best_iou(clouds, targets, camera):
    if not clouds or not targets:
        return 0.0
    return max(iou(normalise(silhouette([c @ R.T for c in clouds], *camera, SIZE), SIZE), t) for R in ROT for t in targets)


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
        visible = group_visible(scoped, row["groups"])
        eligible = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and steps[g[0][0]].get("pictureBox") and 0 < len(visible[i]) <= 150]
        chosen = eligible[:: max(1, len(eligible) // 8)][:8]
        rows = []
        for gi, bi in chosen:
            step = steps[bi]
            image = main_model_image(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            if image is None:
                continue
            targets = [normalise(c, SIZE) for c in model_components(image)]
            first_omr = row["groups"][gi][1][0]
            cumulative = [p for s in scoped[:first_omr] for p in s["added"]]
            a = best_iou(_clouds(lib, visible[gi]), targets, (35, 35))
            b = best_iou(_clouds(lib, cumulative), targets, (35, 35)) if cumulative else 0.0
            c = max(best_iou(_clouds(lib, visible[gi]), targets, cam) for cam in FREE)
            rows.append((step["number"], len(visible[gi]), len(cumulative), a, b, c))
            print(f"{setno} step {step['number']:3} visible {len(visible[gi]):3} cumulative {len(cumulative):3} | scoped@35/35 {a:.2f}  cumulative@35/35 {b:.2f}  scoped@best-free-camera {c:.2f}", flush=True)
        if rows:
            m = lambda k: statistics.median(r[k] for r in rows)
            print(f"== {setno}: median scoped {m(3):.2f} | cumulative {m(4):.2f} | free camera {m(5):.2f}\n", flush=True)


if __name__ == "__main__":
    main()
