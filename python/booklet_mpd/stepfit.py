"""Fit one booklet step: does its picture show the model before or after the step?

Booklets mix conventions: some steps draw the new part floating (the picture shows the model
before the step), others draw it seated (after). Both hypotheses are fitted with the scale-
constrained view fit and the better one wins. A submodel with nothing built yet is drawn inside
the model it will attach to, so the surrounding context stands in for the empty visible set.
"""
from __future__ import annotations

import numpy as np

from .viewfit import fit_view


def hypotheses(visible, context, added) -> dict:
    base = list(visible) if visible else list(context)
    return {"before": base, "after": base + list(added)}


def fit_step(lib, visible, context, added, rgb: np.ndarray, pts_per_px: float | None = None,
             scale_prior: float | None = None) -> dict:
    best = {"iou": 0.0, "hypothesis": None, "feasible": True}
    seen = set()
    for name, parts in hypotheses(visible, context, added).items():
        if not parts:
            continue
        key = tuple((p, c, tuple(np.round(m, 3).ravel())) for p, c, m in parts)
        if key in seen:      # identical part sets (nothing added): one fit is enough
            continue
        seen.add(key)
        fit = fit_view(lib, parts, rgb, pts_per_px=pts_per_px, scale_prior=scale_prior)
        if fit["iou"] > best["iou"] or best["hypothesis"] is None:
            best = {**fit, "hypothesis": name}
    return best
