"""Per-step view fit: which camera and model orientation make these parts look like the picture?

The instruction team picks the viewing angle for each step, so one fixed camera is only a prior.
Scale is a hard constraint when `pts_per_px` and `scale_prior` are given: a candidate (view, picture
component) is feasible only if the implied page scale is within `scale_tol` of the prior. Without it a
tiny blob shaped like the model scores well (bounding-box normalisation) and odd views win on near-ties.
Search: 24 cube orientations x a plausible camera grid with fast convex-hull silhouettes, then
refine the best candidate with exact polygon silhouettes (concave parts keep their notches).
Yaw is searched over [5, 80]: quarter turns about the vertical axis are already in the orientations.
"""
from __future__ import annotations

import numpy as np

from brickheadz.instruction_place import _rotations24, iou, rotation

from .camera_fit import _clouds, exact_silhouette, normalise, silhouette
from .stepimage import model_components

YAWS = (5, 20, 35, 50, 65, 80)
PITCHES = (20, 35, 50, 65)
ORIENTATIONS = [np.asarray(r, float)[:3, :3] for r in _rotations24()]
REFINE_STEP = 5.0
BOOKLET_SCALE = 0.815   # page points per LDraw unit; steps of 3 booklets sit at 0.807-0.839 (train sets), medians of others agree
SCALE_TOLERANCE = 0.10


def _ldu_extent(points: np.ndarray, yaw: float, pitch: float) -> float:
    return float(np.ptp((points @ rotation(yaw, pitch).T)[:, :2], axis=0).max())


def fit_view(lib, parts, rgb: np.ndarray, size: int = 80, pts_per_px: float | None = None,
             scale_prior: float | None = None, scale_tol: float = SCALE_TOLERANCE) -> dict:
    empty = {"iou": 0.0, "hull_iou": 0.0, "exact_iou": 0.0, "yaw": None, "pitch": None, "orientation": None,
             "picture_extent_px": None, "model_extent_ldu": None, "feasible": True, "unconstrained_iou": 0.0}
    clouds = _clouds(lib, parts)
    components = model_components(rgb)
    targets = [normalise(c, size) for c in components]
    if not clouds or not targets:
        return empty
    extents_px = []
    for c in components:
        ys, xs = np.where(c)
        extents_px.append(float(max(np.ptp(xs), np.ptp(ys))))
    constrained = bool(pts_per_px and scale_prior)

    def score(mask, ldu):
        """(best feasible IoU, its component, best IoU ignoring scale)."""
        values = [iou(normalise(mask, size), t) for t in targets]
        best_any = max(values)
        best, best_k = -1.0, -1
        for k, value in enumerate(values):
            ok = (not constrained) or abs(extents_px[k] * pts_per_px / ldu - scale_prior) <= scale_tol * scale_prior
            if ok and value > best:
                best, best_k = value, k
        return best, best_k, best_any

    best = (-1.0, 0, 0, 0, -1)
    unconstrained = 0.0
    for oi, R in enumerate(ORIENTATIONS):
        rotated = [c @ R.T for c in clouds]
        allp = np.concatenate(rotated)
        for yaw in YAWS:
            for pitch in PITCHES:
                value, k, any_value = score(silhouette(rotated, yaw, pitch, size), _ldu_extent(allp, yaw, pitch))
                unconstrained = max(unconstrained, any_value)
                if value > best[0]:
                    best = (value, oi, yaw, pitch, k)
    if best[4] < 0:   # no view and component reproduce the expected page scale
        return {**empty, "feasible": False, "unconstrained_iou": unconstrained}
    hull, oi, yaw, pitch, comp = best
    allp = np.concatenate(clouds) @ ORIENTATIONS[oi].T
    exact, ey, ep, ek = -1.0, yaw, pitch, comp
    for dy, dp in ((0, 0), (REFINE_STEP, 0), (-REFINE_STEP, 0), (0, REFINE_STEP), (0, -REFINE_STEP)):
        value, k, _ = score(exact_silhouette(lib, parts, ORIENTATIONS[oi], yaw + dy, pitch + dp, size), _ldu_extent(allp, yaw + dy, pitch + dp))
        if value > exact:
            exact, ey, ep, ek = value, yaw + dy, pitch + dp, k
    final_yaw, final_pitch, final_comp = (ey, ep, ek) if exact >= hull else (yaw, pitch, comp)
    return {"iou": max(hull, exact), "hull_iou": hull, "exact_iou": exact, "yaw": float(final_yaw),
            "pitch": float(final_pitch), "orientation": oi, "picture_extent_px": extents_px[final_comp],
            "model_extent_ldu": _ldu_extent(allp, final_yaw, final_pitch), "feasible": True,
            "unconstrained_iou": max(unconstrained, hull, exact)}
