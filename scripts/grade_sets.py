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
from booklet_mpd.baseline import group_context, group_visible
from booklet_mpd.grading import grade_set
from booklet_mpd.pairing import find_pairs
from booklet_mpd.rawimages import main_model_image_info
from booklet_mpd.scale import scale_ratio
from booklet_mpd.stepfit import fit_step
from booklet_mpd.viewfit import BOOKLET_SCALE
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
    visible, context = group_visible(scoped, audit_row["groups"]), group_context(scoped, audit_row["groups"])
    added = [[p for o in omr for p in scoped[o]["added"]] for _b, omr in audit_row["groups"]]
    eligible = [(i, g[0][0]) for i, g in enumerate(audit_row["groups"])
                if len(g[0]) == 1 and steps[g[0][0]].get("pictureBox") and 0 < len(visible[i]) + len(context[i]) <= MAX_PARTS]
    chosen = eligible[:: max(1, len(eligible) // SAMPLE_STEPS)][:SAMPLE_STEPS]
    values, feasible, ratios = [], [], []
    for gi, bi in chosen:
        step = steps[bi]
        image, pts_per_px = main_model_image_info(pdf[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
        if image is not None:
            fit = fit_step(lib, visible[gi], context[gi], added[gi], image, pts_per_px=pts_per_px, scale_prior=BOOKLET_SCALE)
            values.append(fit["iou"])            # 0.0 when no view reproduces the booklet's scale
            feasible.append(fit["feasible"])
            ratios.append(scale_ratio(fit, pts_per_px))
    stats = {"feasible": (sum(feasible) / len(feasible)) if feasible else None, "n": len(feasible),
             "median": statistics.median([r for r in ratios if r]) if any(ratios) else None}
    return (statistics.median(values) if values else None), len(values), stats


def main():
    audit = {r["set"]: r for r in json.loads((OUT / "audit.json").read_text())["pairs"]}
    identity = {r["set"]: r for r in json.loads((OUT / "part-identity-api.json").read_text())}
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    rows = []
    for pair in pairs:
        a = audit[pair.set_number]
        if not a["alignment_ok"]:
            iou, n, scale = None, 0, {"median": None, "feasible": None, "n": 0}
        else:
            iou, n, scale = sampled_iou(lib, pair, a)
        graded = grade_set(alignment_ok=a["alignment_ok"], evidence=a["evidence"], identity=identity_of(identity.get(pair.set_number)),
                           median_iou=iou, iou_steps=n, scale_feasible=scale["feasible"], scale_steps=scale["n"])
        rows.append({"set": pair.set_number, "split": pair.split, "family": "studded" if pair.set_number.startswith("40") else "technic/other",
                     "median_iou": iou, "iou_steps": n, "scale_median": scale["median"], "scale_feasible": scale["feasible"],
                     "scale_steps": scale["n"], **graded})
        print(f"{pair.set_number} {pair.split:11} {graded['grade']}  iou {('%.2f' % iou) if iou is not None else ' n/a'} scale {('%.3f' % scale['median']) if scale['median'] else ' n/a'} feasible {('%.0f%%' % (100 * scale['feasible'])) if scale['feasible'] is not None else 'n/a'} ({n} steps)  {'; '.join(graded['reasons'])}", flush=True)
    (OUT / "grades.json").write_text(json.dumps(rows, indent=1))
    for g in "ABC":
        print(g, [r["set"] for r in rows if r["grade"] == g])


if __name__ == "__main__":
    main()
