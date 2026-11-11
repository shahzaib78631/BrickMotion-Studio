"""Run the mask quality gate on every step picture of every graded set.

cd python && .venv/bin/python ../scripts/mask_gate.py
Writes .cache/booklet-mpd/mask-gate.json. Thresholds are the fixed rules in booklet_mpd/maskgate.py.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from booklet_mpd.maskgate import mask_quality
from booklet_mpd.pairing import find_pairs
from booklet_mpd.rawimages import main_model_image

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def main():
    grades = {r["set"]: r for r in json.loads((OUT / "grades.json").read_text())}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    results, totals = [], defaultdict(lambda: [0, 0])
    for pair in pairs:
        pdf = pymupdf.open(pair.pdf)
        steps = json.loads((OUT / "extract" / f"{pair.set_number}-{pair.booklet}" / "extract.json").read_text())["steps"]
        for step in steps:
            if not step.get("pictureBox"):
                continue
            q = mask_quality(main_model_image(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"])))
            results.append({"set": pair.set_number, "split": pair.split, "grade": grades[pair.set_number]["grade"], "step": step["number"],
                            "passed": q["passed"], "reasons": q["reasons"]})
            totals[pair.split][0] += q["passed"]
            totals[pair.split][1] += 1
    (OUT / "mask-gate.json").write_text(json.dumps(results, indent=1))
    for split in ("train", "validation", "test"):
        p, n = totals[split]
        print(f"{split:11} {p}/{n} step pictures pass ({p / n:.1%})")
    failures = defaultdict(list)
    for r in results:
        if not r["passed"]:
            failures[r["reasons"][0].split(" (")[0].split(" ")[0] + " " + " ".join(r["reasons"][0].split(" ")[1:3])].append((r["set"], r["step"]))
    for reason, items in sorted(failures.items(), key=lambda kv: -len(kv[1])):
        print(f"  {reason}: {len(items)}  e.g. {items[:4]}")


if __name__ == "__main__":
    main()
