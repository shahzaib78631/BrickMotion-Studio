"""Booklet renders share one scale (page points per LDraw unit), so size is evidence.

Measured on three booklets: matched steps give 0.80-0.88 pt/LDU (CV 1.6-6.9% within a booklet);
parts from a different step imply a scale off by a median of about 35%. A set whose visible-part
model is right therefore shows a near-constant ratio across its steps.
"""
from __future__ import annotations

import statistics


def scale_ratio(fit: dict, pts_per_px: float | None) -> float | None:
    """Page points per LDraw unit implied by a view fit: picture extent over model extent."""
    px, ldu = fit.get("picture_extent_px"), fit.get("model_extent_ldu")
    if not px or not ldu or not pts_per_px:
        return None
    return px * pts_per_px / ldu


def scale_consistency(ratios) -> dict:
    values = [r for r in ratios if r is not None]
    if not values:
        return {"median": None, "cv": None, "n": 0}
    median = statistics.median(values)
    cv = statistics.pstdev(values) / median if len(values) >= 3 and median else None
    return {"median": median, "cv": cv, "n": len(values)}
