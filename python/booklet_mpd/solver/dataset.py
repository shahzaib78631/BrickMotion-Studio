"""Evaluation data: booklet steps paired with answer-key steps (SCORING AND TRAINING ONLY).

Nothing here may be imported by the inference path (`solver.pipeline`, `solve`). A teacher-forced
case gives the parts visible before a booklet step and the parts the step adds, both in the answer
key's frame, together with the step picture read straight from the PDF.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import pymupdf

from ..baseline import group_context, group_visible
from ..pairing import find_pairs
from ..rawimages import main_model_image_info, subbuild_images
from ..truth import build_scoped_steps

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / ".cache/booklet-mpd"
OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/booklet-mpd/sources.json"


@dataclass
class Case:
    set_number: str
    booklet_step: int          # index into extract steps
    step_number: int           # printed step number
    page: int
    visible: list
    context: list
    added: list
    file: str                  # submodel file the step builds into
    rgb: object = None
    pts_per_px: float | None = None
    subbuilds: list | None = None     # sub-build panels (rawimages.subbuild_images)


@lru_cache(maxsize=1)
def audit_rows() -> dict:
    return {r["set"]: r for r in json.loads((CACHE / "audit.json").read_text())["pairs"]}


@lru_cache(maxsize=1)
def grades() -> list[dict]:
    return json.loads((CACHE / "grades.json").read_text())


@lru_cache(maxsize=1)
def pairs() -> dict:
    return {p.set_number: p for p in find_pairs(SOURCES, OMR, ROOT)[0]}


def extract_of(set_number: str) -> tuple[dict, Path]:
    pair = pairs()[set_number]
    folder = CACHE / "extract" / f"{set_number}-{pair.booklet}"
    return json.loads((folder / "extract.json").read_text()), folder


def cases(set_number: str, with_images: bool = True, max_parts: int = 400) -> list[Case]:
    """One case per booklet step that maps to whole answer-key steps (groups with one booklet step)."""
    row = audit_rows()[set_number]
    pair = pairs()[set_number]
    extract, _folder = extract_of(set_number)
    steps = extract["steps"]
    scoped = build_scoped_steps(str(pair.omr), expand_submodels=row["truth_mode"] == "expand", warnings=[])
    groups = row["groups"]
    visible, context = group_visible(scoped, groups), group_context(scoped, groups)
    doc = pymupdf.open(pair.pdf) if with_images else None
    out = []
    for gi, (bidx, oidx) in enumerate(groups):
        if len(bidx) != 1:
            continue
        files = {scoped[o]["file"] for o in oidx}
        if len(files) != 1:
            continue
        step = steps[bidx[0]]
        added = [p for o in oidx for p in scoped[o]["added"]]
        if len(visible[gi]) + len(added) > max_parts:
            continue
        case = Case(set_number, bidx[0], step["number"], step["page"], visible[gi], context[gi], added, files.pop())
        if with_images and step.get("pictureBox"):
            case.rgb, case.pts_per_px = main_model_image_info(doc[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            case.subbuilds = subbuild_images(doc[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
        out.append(case)
    return out
