"""Does one camera per booklet explain its steps? Fit on half the steps, score the rest.

cd python && .venv/bin/python ../scripts/consensus_benchmark.py [--sets 8] [--steps 12]
Teacher-forced: the true model before each step (from the OMR) vs the picture's largest component.
"""
import argparse
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
from booklet_mpd.camera_fit import _clouds
from booklet_mpd.consensus import apply_consensus, consensus_camera, iou_surface
from booklet_mpd.pairing import find_pairs
from booklet_mpd.stepimage import largest_component, model_mask

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"
YAWS, PITCHES = list(range(0, 360, 5)), list(range(10, 71, 5))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sets", type=int, default=8)
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--max-parts", type=int, default=120)
    args = ap.parse_args()
    audit = [r for r in json.loads((OUT / "audit.json").read_text())["pairs"]
             if r["alignment_ok"] and r["evidence"] == "strong" and r["set"].startswith("40")]
    wanted = {r["set"]: r for r in audit[: args.sets]}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    summary = []
    for pair in pairs:
        row = wanted.get(pair.set_number)
        if not row:
            continue
        folder = OUT / "extract" / f"{pair.set_number}-{pair.booklet}"
        steps = json.loads((folder / "extract.json").read_text())["steps"]
        truth, _ = group_truth(TRUTH_LOADERS[row["truth_mode"]](str(pair.omr), warnings=[]), [None] * len(steps), row["groups"])
        usable = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and steps[g[0][0]].get("picture") and i > 0
                  and sum(len(st) for st in truth[:i]) <= args.max_parts]
        chosen = usable[:: max(1, len(usable) // args.steps)][: args.steps]
        surfaces = []
        for gi, bi in chosen:
            built = [p for st in truth[:gi] for p in st]
            rgb = cv2.imread(str(folder / steps[bi]["picture"]))[..., ::-1].copy()
            surfaces.append(iou_surface(_clouds(lib, built), largest_component(model_mask(rgb)), YAWS, PITCHES))
        if len(surfaces) < 4:
            continue
        fit, held = surfaces[0::2], surfaces[1::2]
        camera = consensus_camera(fit, YAWS, PITCHES)
        held_consensus = [apply_consensus(s, YAWS, PITCHES, camera)["iou"] for s in held]
        held_free = [float(s.max()) for s in held]
        held_fixed = [apply_consensus(s, YAWS, PITCHES, {"yaw": 35, "pitch": 35})["iou"] for s in held]
        item = {"set": pair.set_number, "yaw": camera["yaw"], "pitch": camera["pitch"], "fit_steps": len(fit), "held_steps": len(held),
                "held_consensus_mean": statistics.mean(held_consensus), "held_free_mean": statistics.mean(held_free), "held_fixed_35_mean": statistics.mean(held_fixed),
                "held_fixed_35_ge_0.8": sum(v >= .8 for v in held_fixed) / len(held),
                "held_consensus_ge_0.8": sum(v >= .8 for v in held_consensus) / len(held)}
        summary.append(item)
        print(f"{pair.set_number}: camera yaw {camera['yaw']} pitch {camera['pitch']} | held-out mean IoU consensus {item['held_consensus_mean']:.2f} "
              f"vs free per-step {item['held_free_mean']:.2f} | fixed 35/35 {item['held_fixed_35_mean']:.2f} | held-out >=0.8: {item['held_consensus_ge_0.8']:.0%}", flush=True)
    (OUT / "consensus-benchmark.json").write_text(json.dumps(summary, indent=1))
    if summary:
        print(f"overall: consensus {statistics.mean(s['held_consensus_mean'] for s in summary):.2f} | fixed 35/35 {statistics.mean(s['held_fixed_35_mean'] for s in summary):.2f} | free {statistics.mean(s['held_free_mean'] for s in summary):.2f}")


if __name__ == "__main__":
    main()
