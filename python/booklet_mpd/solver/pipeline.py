"""Free-run reconstruction: booklet PDF -> MPD, from the PDF alone (no answer key, no OMR).

1. Extract the booklet (steps, callouts, parts list) with `instructions_pdf.extract`.
2. Read each step's new parts (`parts.read_parts`: callout pictures matched to the printed parts
   list, element ids to LDraw parts through the cached Rebrickable inventories). A booklet without a
   parts list falls back to the set's Rebrickable inventory (set number read off the cover), its
   pictures rendered from the LDraw parts.
3. Walk the steps in order, keeping one model in one frame: each step re-registers the model so far
   to its picture and places the new parts (`step.solve`). Substep panels have no pictures of their
   own in the extract, so their callout parts are placed against the main picture. "Nx" repeats are
   recorded in the report (one copy is placed: compound placement of repeated sub-assemblies is not
   implemented).
4. Score each part with the confidence combiner and write an MPD with real STEPs, flags on parts
   below the threshold and an INCOMPLETE marker from the first step the solver gave up on.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .confidence import part_confidence

# A step "gave up" when its registration is this poor or nothing could be placed; the model after
# it is still built (later steps may recover) but is marked INCOMPLETE from there.
GIVE_UP_IOU = 0.35


@dataclass
class FreeRun:
    groups: list = field(default_factory=list)        # per extracted step: [(part, colour, matrix)]
    confidences: list = field(default_factory=list)   # per extracted step: [float]
    rows: list = field(default_factory=list)          # per extracted step: diagnostics
    failed_from: int | None = None                    # 1-based step index of the first give-up
    parts_report: dict = field(default_factory=dict)

    @property
    def model(self) -> list:
        return [p for g in self.groups for p in g]


def extract(pdf: Path, out_dir: Path) -> tuple[dict, Path]:
    folder = Path(out_dir)
    path = folder / "extract.json"
    if path.exists():
        return json.loads(path.read_text()), folder
    from instructions_pdf.extract import extract_booklet
    folder.mkdir(parents=True, exist_ok=True)
    data = extract_booklet(str(pdf), str(folder))
    path.write_text(json.dumps(data))
    return data, folder


def run(lib, pdf: Path, extract_data: dict, folder: Path, index: dict, collider=None, client=None,
        combiner: dict | None = None, max_steps: int | None = None, log=None) -> FreeRun:
    import pymupdf

    from ..rawimages import main_model_image_info
    from .parts import read_parts
    from .step import solve

    doc = pymupdf.open(str(pdf))
    steps_parts, report = read_parts(lib, extract_data, folder, index, client,
                                     fallback=inventory_fallback(lib, doc, extract_data, index, client))
    out = FreeRun(parts_report=report)
    model: list = []
    steps = extract_data["steps"][:max_steps] if max_steps else extract_data["steps"]
    for si, step in enumerate(steps):
        read = steps_parts[si]
        row = {"index": si, "number": step["number"], "page": step["page"], "read": len(read.parts),
               "unresolved": read.unresolved, "repeat": step.get("repeat", 1), "substeps": len(step.get("substeps", []))}
        placed, confs = [], []
        if read.parts:
            rgb = pts = None
            if step.get("pictureBox"):
                rgb, pts = main_model_image_info(doc[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            try:
                result = solve(lib, model, list(read.parts), rgb, pts, collider=collider)
                status = result.status
            except Exception as error:   # one bad step must not stop the booklet
                result, status = None, f"error: {type(error).__name__}: {error}"[:200]
            if result is not None:
                placed = list(result.placed)
                read_conf = list(read.confidence)
                for k, sc in enumerate(result.scores):
                    confs.append(part_confidence(sc, result, read_conf[k] if k < len(read_conf) else 0.0, combiner))
                row.update(registration=float(result.registration), fit_iou=float(result.fit_iou),
                           placed=len(placed))
            gave_up = result is None or status != "ok" or result.fit_iou < GIVE_UP_IOU or len(placed) < len(read.parts)
            row["status"] = status if status != "ok" or not gave_up else "low fit"
            if gave_up and out.failed_from is None:
                out.failed_from = si + 1
        else:
            row["status"] = "no parts read"
        model += placed
        out.groups.append(placed)
        out.confidences.append(confs)
        out.rows.append(row)
        if log:
            log(row)
    return out


def inventory_fallback(lib, doc, extract_data: dict, index: dict, client) -> list[dict] | None:
    """No printed parts list: the set's Rebrickable inventory, the set number read off the cover."""
    if any(e.get("element") for e in extract_data.get("inventory", [])):
        return None
    from .parts import fallback_inventory, set_number_from_pdf
    number = set_number_from_pdf(doc)
    return fallback_inventory(lib, number, client, index) if number else None


def write(run_result: FreeRun, path: Path, name: str, threshold: float) -> dict:
    from ..flagged_mpd import write_flagged_mpd
    return write_flagged_mpd(path, name, run_result.groups, run_result.confidences, threshold,
                             failed_from_step=run_result.failed_from)
