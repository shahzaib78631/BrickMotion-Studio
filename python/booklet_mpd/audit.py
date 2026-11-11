"""Audit a booklet/OMR pair: does extraction work and do the steps line up?

Alignment here is count-only (callout quantity total vs OMR piece count); callout
crops are not yet resolved to LDraw ids, so this is the first, weaker filter.
"""
from __future__ import annotations

import json
from pathlib import Path

from brickheadz.reconstruct import steps_from_omr
from instructions_pdf.extract import extract_booklet

from .align import align_steps, count_similarity
from .pairing import Pair


def _extraction(pair: Pair, folder: Path) -> dict:
    cache = folder / "extract.json"
    if cache.is_file():
        return json.loads(cache.read_text())
    folder.mkdir(parents=True, exist_ok=True)
    booklet = extract_booklet(str(pair.pdf), str(folder))
    cache.write_text(json.dumps(booklet))
    return booklet


def audit_pair(pair: Pair, work_dir: Path) -> dict:
    result = {"set": pair.set_number, "split": pair.split, "booklet_steps": 0, "omr_steps": 0,
              "alignment_ok": False, "alignment_reason": "", "mean_similarity": 0.0,
              "steps_with_picture": 0, "extraction_error": None, "aligned": []}
    try:
        truth = steps_from_omr(str(pair.omr))
        result["omr_steps"] = len(truth)
        booklet = _extraction(pair, Path(work_dir) / f"{pair.set_number}-{pair.booklet}")
    except Exception as error:  # audit must survive one bad pair
        result["extraction_error"] = f"{type(error).__name__}: {error}"
        result["alignment_reason"] = "extraction failed"
        return result
    steps = booklet["steps"]
    result["booklet_steps"] = len(steps)
    result["steps_with_picture"] = sum(1 for s in steps if s.get("picture"))
    totals = [sum(c["count"] for c in s["callout"]) for s in steps]
    alignment = align_steps(totals, [len(s) for s in truth], count_similarity)
    result.update(alignment_ok=alignment.ok, alignment_reason=alignment.reason,
                  mean_similarity=alignment.mean_similarity,
                  aligned=[[a, b] for a, b in alignment.pairs if a is not None and b is not None])
    return result
