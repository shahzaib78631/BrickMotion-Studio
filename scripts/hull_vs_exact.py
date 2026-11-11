"""Is the convex-hull renderer what holds visible-IoU down? (train sets only)

cd python && .venv/bin/python ../scripts/hull_vs_exact.py 40349 42105 40386
For sampled steps: best hull IoU over 24 orientations x 15 cameras, then the exact-polygon IoU at that
setting and at +-5 degrees around it.
"""
import itertools
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
from booklet_mpd.camera_fit import _clouds, exact_silhouette, normalise, silhouette
from booklet_mpd.pairing import find_pairs
from booklet_mpd.protocol import assert_tuning_allowed
from booklet_mpd.rawimages import main_model_image
from booklet_mpd.stepimage import model_components
from booklet_mpd.truth import build_scoped_steps
from brickheadz.instruction_place import _rotations24, iou

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/booklet-mpd/sources.json"
OUT = ROOT / ".cache/booklet-mpd"
SIZE = 96
ROT = [np.asarray(r, float)[:3, :3] for r in _rotations24()]
CAMS = [(y, p) for y in (5, 20, 35, 50, 65) for p in (20, 35, 50)]


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
        visible = group_visible(build_scoped_steps(str(pair.omr), expand_submodels=row["truth_mode"] == "expand", warnings=[]), row["groups"])
        eligible = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and steps[g[0][0]].get("pictureBox") and 4 <= len(visible[i]) <= 120]
        rows = []
        for gi, bi in eligible[:: max(1, len(eligible) // 6)][:6]:
            step = steps[bi]
            image = main_model_image(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            if image is None:
                continue
            targets = [normalise(c, SIZE) for c in model_components(image)]
            clouds = _clouds(lib, visible[gi])
            best = (0.0, None)
            for ri, cam in itertools.product(range(24), CAMS):
                sil = normalise(silhouette([c @ ROT[ri].T for c in clouds], *cam, SIZE), SIZE)
                v = max(iou(sil, t) for t in targets)
                if v > best[0]:
                    best = (v, (ri, cam))
            ri, (y0, p0) = best[1]
            exact = max(max(iou(normalise(exact_silhouette(lib, visible[gi], ROT[ri], y0 + dy, p0 + dp, SIZE), SIZE), t) for t in targets)
                        for dy in (-5, 0, 5) for dp in (-5, 0, 5))
            rows.append((best[0], exact))
            print(f"{setno} step {step['number']:3} parts {len(visible[gi]):3} | hull {best[0]:.2f} -> exact {exact:.2f}   (orientation {ri}, camera {y0}/{p0})", flush=True)
        if rows:
            print(f"== {setno}: median hull {statistics.median(r[0] for r in rows):.2f} -> exact {statistics.median(r[1] for r in rows):.2f}\n", flush=True)


if __name__ == "__main__":
    main()
