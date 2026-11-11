"""Grade every audited set's answer key (A/B/C) and write .cache/booklet-mpd/grades.json.

cd python && .venv/bin/python ../scripts/grade_sets.py
Inputs: audit.json, part-identity-api.json (cached Rebrickable results), the booklets and OMRs.
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
from booklet_mpd.consistency import visible_iou
from booklet_mpd.grading import grade_set
from booklet_mpd.pairing import find_pairs
from booklet_mpd.rawimages import main_model_image
from booklet_mpd.truth import build_scoped_steps

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"
SAMPLE_STEPS, MAX_PARTS = 8, 150


def identity_of(row):
    if not row:
        return None
    b = row["booklet_vs_omr"]
    return {"booklet_total": b["total_a"], "omr_total": b["total_b"], "official_total": row["official_total"],
            "booklet_residual": sum(n for _k, n in row["reconcile"]["residual_booklet"]),
            "omr_residual": sum(n for _k, n in row["reconcile"]["residual_omr"])}


def sampled_iou(lib, pair, audit_row):
    pdf = pymupdf.open(pair.pdf)
    steps = json.loads((OUT / "extract" / f"{pair.set_number}-{pair.booklet}" / "extract.json").read_text())["steps"]
    scoped = build_scoped_steps(str(pair.omr), expand_submodels=audit_row["truth_mode"] == "expand", warnings=[])
    visible = group_visible(scoped, audit_row["groups"])
    eligible = [(i, g[0][0]) for i, g in enumerate(audit_row["groups"])
                if len(g[0]) == 1 and steps[g[0][0]].get("pictureBox") and 0 < len(visible[i]) <= MAX_PARTS]
    chosen = eligible[:: max(1, len(eligible) // SAMPLE_STEPS)][:SAMPLE_STEPS]
    values = []
    for gi, bi in chosen:
        step = steps[bi]
        image = main_model_image(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
        if image is not None:
            values.append(visible_iou(lib, visible[gi], image))
    return (statistics.median(values) if values else None), len(values)


def main():
    audit = {r["set"]: r for r in json.loads((OUT / "audit.json").read_text())["pairs"]}
    identity = {r["set"]: r for r in json.loads((OUT / "part-identity-api.json").read_text())}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    rows = []
    for pair in pairs:
        a = audit[pair.set_number]
        if not a["alignment_ok"]:
            iou, n = None, 0
        else:
            iou, n = sampled_iou(lib, pair, a)
        graded = grade_set(alignment_ok=a["alignment_ok"], evidence=a["evidence"], identity=identity_of(identity.get(pair.set_number)),
                           median_iou=iou, iou_steps=n)
        rows.append({"set": pair.set_number, "split": pair.split, "family": "studded" if pair.set_number.startswith("40") else "technic/other",
                     "median_iou": iou, "iou_steps": n, **graded})
        print(f"{pair.set_number} {pair.split:11} {graded['grade']}  iou {('%.2f' % iou) if iou is not None else ' n/a'} ({n} steps)  {'; '.join(graded['reasons'])}", flush=True)
    (OUT / "grades.json").write_text(json.dumps(rows, indent=1))
    for g in "ABC":
        print(g, [r["set"] for r in rows if r["grade"] == g])


if __name__ == "__main__":
    main()
