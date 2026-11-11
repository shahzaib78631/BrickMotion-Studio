"""How much of the IoU gap is model orientation? Fixed camera (35, 35): vertical quarter turns vs all 24 cube rotations.

cd python && .venv/bin/python ../scripts/rotation_experiment.py
"""
import json
import statistics
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.audit import TRUTH_LOADERS
from booklet_mpd.baseline import group_truth
from booklet_mpd.camera_fit import _clouds, normalise, silhouette
from booklet_mpd.pairing import find_pairs
from booklet_mpd.stepimage import model_components
from brickheadz.instruction_place import _rotations24, iou

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"
SIZE = 80


def vertical_turn(k):
    c, s = [(1, 0), (0, 1), (-1, 0), (0, -1)][k]
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], float)


def main():
    audit = [r for r in json.loads((OUT / "audit.json").read_text())["pairs"]
             if r["alignment_ok"] and r["evidence"] == "strong" and r["set"].startswith("40")][:8]
    wanted = {r["set"]: r for r in audit}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    rot24 = [np.asarray(r, float)[:3, :3] for r in _rotations24()]
    rows = []
    for pair in pairs:
        row = wanted.get(pair.set_number)
        if not row:
            continue
        folder = OUT / "extract" / f"{pair.set_number}-{pair.booklet}"
        steps = json.loads((folder / "extract.json").read_text())["steps"]
        truth, _ = group_truth(TRUTH_LOADERS[row["truth_mode"]](str(pair.omr), warnings=[]), [None] * len(steps), row["groups"])
        usable = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and steps[g[0][0]].get("picture") and i > 0
                  and sum(len(st) for st in truth[:i]) <= 120]
        for gi, bi in usable[:: max(1, len(usable) // 12)][:12]:
            clouds = _clouds(lib, [p for st in truth[:gi] for p in st])
            rgb = cv2.imread(str(folder / steps[bi]["picture"]))[..., ::-1].copy()
            targets = [normalise(c, SIZE) for c in model_components(rgb)]
            score = lambda R: max((iou(normalise(silhouette([c @ R.T for c in clouds], 35, 35, SIZE), SIZE), t) for t in targets), default=0.0)
            v = max(score(vertical_turn(k)) for k in range(4))
            a = max(score(R) for R in rot24)
            rows.append((pair.set_number, v, a))
        sel = [r for r in rows if r[0] == pair.set_number]
        print(pair.set_number, f"vertical turns {statistics.mean(r[1] for r in sel):.2f} | all 24 rotations {statistics.mean(r[2] for r in sel):.2f}", flush=True)
    print(f"overall vertical {statistics.mean(r[1] for r in rows):.2f} | 24 rotations {statistics.mean(r[2] for r in rows):.2f} | share >=0.8: "
          f"{sum(r[1] >= .8 for r in rows) / len(rows):.0%} -> {sum(r[2] >= .8 for r in rows) / len(rows):.0%}")


if __name__ == "__main__":
    main()
