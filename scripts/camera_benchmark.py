"""Teacher-forced camera benchmark on real booklet steps.

For sampled steps of audited sets, the TRUE model so far (from the OMR) is rendered over a
grid of viewing angles and compared with the step picture's model mask. Reports how well
a camera can be fitted at all, before any placement logic is attempted.

cd python && .venv/bin/python ../scripts/camera_benchmark.py [--sets 8] [--steps 6]
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.audit import TRUTH_LOADERS
from booklet_mpd.baseline import group_truth
from booklet_mpd.camera_fit import fit_camera_to_mask
from booklet_mpd.pairing import find_pairs
from booklet_mpd.stepimage import largest_component, model_mask

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sets", type=int, default=8)
    ap.add_argument("--steps", type=int, default=6)
    ap.add_argument("--max-parts", type=int, default=120)
    ap.add_argument("--mode", choices=("with-new", "before"), default="with-new",
                    help="before: model before the step vs the picture's largest component (floating new part excluded)")
    args = ap.parse_args()
    audit = [r for r in json.loads((OUT / "audit.json").read_text())["pairs"] if r["alignment_ok"] and r["evidence"] == "strong" and r["set"].startswith("40")]
    wanted = {r["set"]: r for r in audit[: args.sets]}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    rows = []
    for pair in pairs:
        row = wanted.get(pair.set_number)
        if not row:
            continue
        folder = OUT / "extract" / f"{pair.set_number}-{pair.booklet}"
        steps = json.loads((folder / "extract.json").read_text())["steps"]
        truth, _ = group_truth(TRUTH_LOADERS[row["truth_mode"]](str(pair.omr), warnings=[]), [None] * len(steps), row["groups"])
        pictures = {g[0][0]: steps[g[0][0]].get("picture") for g in row["groups"] if len(g[0]) == 1}
        usable = [(i, g[0][0]) for i, g in enumerate(row["groups"]) if len(g[0]) == 1 and pictures.get(g[0][0])]
        usable = [u for u in usable if sum(len(st) for st in truth[: u[0] + 1]) <= args.max_parts]
        chosen = usable[:: max(1, len(usable) // args.steps)][: args.steps]
        for group_index, booklet_index in chosen:
            built = [p for step in truth[: group_index + (1 if args.mode == "with-new" else 0)] for p in step]
            if not built:
                continue
            rgb = cv2.imread(str(folder / pictures[booklet_index]))[..., ::-1].copy()
            mask = model_mask(rgb)
            if args.mode == "before":
                mask = largest_component(mask)
            fit = fit_camera_to_mask(lib, built, mask, yaws=range(-180, 180, 20), pitches=range(-60, 61, 15), size=80)
            rows.append({"set": pair.set_number, "step": steps[booklet_index]["number"], "parts": len(built), **fit})
            print(pair.set_number, "step", steps[booklet_index]["number"], "parts", len(built), f"IoU {fit['iou']:.2f} yaw {fit['yaw']:.0f} pitch {fit['pitch']:.0f}", flush=True)
    (OUT / f"camera-benchmark-{args.mode}.json").write_text(json.dumps(rows, indent=1))
    ious = [r["iou"] for r in rows]
    if ious:
        print(f"steps {len(ious)}: median IoU {statistics.median(ious):.2f}, share >= 0.8: {sum(i >= .8 for i in ious) / len(ious):.0%}, share < 0.5: {sum(i < .5 for i in ious) / len(ious):.0%}")


if __name__ == "__main__":
    main()
