"""Audit a booklet/OMR pair: does extraction work and do the steps line up?

Alignment matches callout quantity totals to OMR piece counts and, given an LDraw library, also how the
parts-list pictures look against the OMR steps' parts (shape and colour of each part drawn in four turns):
counts alone pair any two runs of steps with the same totals.
"""
from __future__ import annotations

import json
from pathlib import Path

from functools import partial

from .truth import build_steps
from instructions_pdf.extract import extract_booklet

from .align import align_groups
from .pairing import Pair


def _extraction(pair: Pair, folder: Path) -> dict:
    cache = folder / "extract.json"
    if cache.is_file():
        return json.loads(cache.read_text())
    folder.mkdir(parents=True, exist_ok=True)
    booklet = extract_booklet(str(pair.pdf), str(folder))
    cache.write_text(json.dumps(booklet))
    return booklet


TRUTH_LOADERS = {"lump": partial(build_steps, expand_submodels=False), "expand": build_steps}


def omr_blocks(groups) -> int:
    """Number of contiguous runs of OMR steps the booklet's steps matched; a real match
    is a few long blocks (one per model), a chance match is scattered."""
    indices = sorted({o for _b, steps in groups for o in steps})
    return sum(1 for pos, o in enumerate(indices) if pos == 0 or o != indices[pos - 1] + 1)


_LOOKS: dict = {}


def part_look(lib, folder: Path, steps: list, omr_steps: list):
    """part_sim for align_groups: per booklet step, the count-weighted mean over its callout pictures of
    the best similarity to any part the OMR steps add (each part drawn in four upright turns)."""
    import cv2
    from .solver.parts import describe, rendered_descriptors, similarity
    callouts = []
    for st in steps:
        row = []
        for e in st.get("callout", []):
            img = cv2.imread(str(folder / e["crop"])) if e.get("crop") else None
            d = describe(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)) if img is not None else None
            if d is not None:
                row.append((d, e.get("count", 1) or 1))
        callouts.append(row)
    keys = [sorted({(p, c) for p, c, *_ in step}) for step in omr_steps]
    best: dict = {}

    def one(bi, ci, key):
        k = (bi, ci, key)
        if k not in best:
            if key not in _LOOKS:
                _LOOKS[key] = rendered_descriptors(lib, *key) or []
            best[k] = max((similarity(callouts[bi][ci][0], r) for r in _LOOKS[key]), default=0.0)
        return best[k]

    def sim(brange, orange):
        parts = {k for j in orange for k in keys[j]}
        tot = w = 0.0
        for bi in brange:
            for ci, (_d, n) in enumerate(callouts[bi]):
                tot += n * max((one(bi, ci, key) for key in parts), default=0.0)
                w += n
        return tot / w if w else None
    return sim


def audit_pair(pair: Pair, work_dir: Path, lib=None) -> dict:
    """Pick, per set, the OMR step granularity (root-file steps with submodels lumped, or
    submodel steps expanded) that best aligns with the booklet's callout totals."""
    result = {"set": pair.set_number, "split": pair.split, "booklet_steps": 0, "omr_steps": 0,
              "alignment_ok": False, "alignment_reason": "", "mean_similarity": 0.0, "truth_mode": None,
              "booklet_coverage": 0.0, "omr_coverage": 0.0, "omr_blocks": 0, "steps_with_picture": 0,
              "extraction_error": None, "aligned": [], "groups": [], "omr_warnings": [], "evidence": None}
    try:
        booklet = _extraction(pair, Path(work_dir) / f"{pair.set_number}-{pair.booklet}")
    except Exception as error:  # audit must survive one bad pair
        result["extraction_error"] = f"{type(error).__name__}: {error}"
        result["alignment_reason"] = "extraction failed"
        return result
    steps = booklet["steps"]
    result["booklet_steps"] = len(steps)
    result["steps_with_picture"] = sum(1 for s in steps if s.get("picture"))
    totals = [sum(c["count"] for c in s["callout"]) for s in steps]
    best, errors = None, []
    for mode, loader in TRUTH_LOADERS.items():
        try:
            found: list[str] = []
            omr_steps = loader(str(pair.omr), warnings=found)
            sizes = [len(s) for s in omr_steps]
        except Exception as error:
            errors.append(f"{mode}: {type(error).__name__}: {error}")
            continue
        look = part_look(lib, Path(work_dir) / f"{pair.set_number}-{pair.booklet}", steps, omr_steps) if lib is not None else None
        alignment = align_groups(totals, sizes, part_sim=look)
        one_to_one = sum(1 for b, o in alignment.groups if len(b) == 1 and len(o) == 1)
        key = (alignment.ok, round(min(alignment.booklet_coverage, alignment.omr_coverage), 2), one_to_one, alignment.mean_similarity)
        if best is None or key > best[0]:
            best = (key, mode, sizes, alignment, found)
    if best is None:
        result["extraction_error"] = "; ".join(errors)
        result["alignment_reason"] = "OMR unreadable"
        return result
    _key, mode, sizes, alignment, warnings = best
    result.update(omr_steps=len(sizes), truth_mode=mode, alignment_ok=alignment.ok, alignment_reason=alignment.reason,
                  mean_similarity=alignment.mean_similarity, booklet_coverage=alignment.booklet_coverage,
                  omr_coverage=alignment.omr_coverage, omr_blocks=omr_blocks(alignment.groups), omr_warnings=warnings,
                  evidence="strong" if omr_blocks(alignment.groups) <= 4 else "weak", groups=[[b, o] for b, o in alignment.groups],
                  aligned=[[b[0], o[0]] for b, o in alignment.groups if len(b) == 1 and len(o) == 1])
    return result
