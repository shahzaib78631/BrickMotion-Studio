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

import numpy as np
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


def _key(part) -> tuple:
    p, c, m = part
    return (p, c, tuple(np.round(np.asarray(m, float)[:3], 2).ravel().tolist()))


def _links(parts: list, tol: float = 0.5) -> list[set[int]]:
    """Which parts touch which: a stud/clip connection (BrickNet catalogue) or world boxes overlapping within `tol`
    LDU (the catalogue has no Technic pins and misses some parts; boxes err towards touching)."""
    from brickheadz.connectors import build_graph, catalog
    from coordnet.labels import pose_centre_extent

    cat = catalog()
    names = [p for p, _c, _m in parts]
    g = build_graph(names, [c for _p, c, _m in parts], [np.asarray(m, float) for *_x, m in parts], cat)
    nb: list[set[int]] = [set() for _ in parts]
    for e in g.edges:
        nb[e.a].add(e.b)
        nb[e.b].add(e.a)
    if parts:
        ce = [pose_centre_extent(p, m) for p, _c, m in parts]
        lo = np.array([c - e / 2 for c, e in ce]) - tol
        hi = np.array([c + e / 2 for c, e in ce]) + tol
        ov = (lo[:, None] <= hi[None]).all(2) & (lo[None] <= hi[:, None]).all(2)
        for i, j in zip(*np.nonzero(ov)):
            if i != j:
                nb[int(i)].add(int(j))
    return nb


def picture_scope(steps: list[tuple[list, list]]) -> list[list]:
    """The parts each step's picture shows, from (parts built so far, parts the step adds) in build order.

    A flat answer key (truth_mode "lump") holds every assembly in one model, but a booklet builds a separate
    assembly (40348's display base) on its own and draws it alone, even where the final model has it mating with
    the main one. So: a step whose new parts connect to nothing built so far starts a sub-build, drawn alone;
    steps whose parts connect to the sub-build stay in it; a step whose parts connect only to the rest goes back
    to the whole model."""
    out, current = [], None
    for built, added in steps:
        parts = list(built) + list(added)
        nb = _links(parts)
        nv = len(built)
        touched = {j for i in range(nv, len(parts)) for j in nb[i] if j < nv}
        keys = [_key(p) for p in parts]
        if built and not touched:
            current = {keys[i] for i in range(nv, len(parts))}
            out.append([])
            continue
        if current is not None:
            if any(keys[j] in current for j in touched):
                out.append([p for p, k in zip(built, keys) if k in current])
                current |= {keys[i] for i in range(nv, len(parts))}
                continue
            current = None
        out.append(list(built))
    return out


def cases(set_number: str, with_images: bool = True, max_parts: int = 400) -> list[Case]:
    """One case per booklet step that maps to whole answer-key steps (groups with one booklet step). `visible` is
    what the step's picture shows (flat answer keys: `picture_scope`, a separately built assembly is drawn
    alone)."""
    row = audit_rows()[set_number]
    pair = pairs()[set_number]
    extract, _folder = extract_of(set_number)
    steps = extract["steps"]
    scoped = build_scoped_steps(row.get("omr_file") or str(pair.omr), expand_submodels=row["truth_mode"] == "expand", warnings=[])
    groups = row["groups"]
    visible, context = group_visible(scoped, groups), group_context(scoped, groups)
    if row["truth_mode"] == "lump":         # one flat model: separately built assemblies must be found
        shown = picture_scope([(visible[gi], [p for o in oidx for p in scoped[o]["added"]])
                               for gi, (_b, oidx) in enumerate(groups)])
    else:                                   # expanded submodels are already scoped by the answer key
        shown = visible
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
        case = Case(set_number, bidx[0], step["number"], step["page"], shown[gi], context[gi], added, files.pop())
        if with_images and step.get("pictureBox"):
            case.rgb, case.pts_per_px = main_model_image_info(doc[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
            case.subbuilds = subbuild_images(doc[step["page"] - 1], pymupdf.Rect(step["pictureBox"]))
        out.append(case)
    return out
