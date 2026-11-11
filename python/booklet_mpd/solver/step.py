"""Solve one booklet step: register the model so far to the picture, then place the new parts.

Inference only (no answer key): inputs are the model so far, the identities of the new parts and
the step picture. Used by the free-run pipeline and, with the true model so far, by the
teacher-forced benchmark.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..viewfit import BOOKLET_SCALE, ORIENTATIONS
from .edges import NEAR_INK, ink_distance
from .candidates import candidates
from .picture import Picture
from .place import DELTAS, Scene, State, solve_step
from .register import rank_views, search
from .render import View


@dataclass
class StepResult:
    placed: list                       # [(part, colour, matrix)] new parts, in the input order where possible
    scores: list                       # per placed part: place.Scored
    view: View | None
    registration: float
    fit_iou: float
    alternatives: list = field(default_factory=list)   # other final beam states (State)
    status: str = "ok"


VIEWS = 8
MIN_ARROW_PIXELS = 25     # working-resolution red stroke pixels before floating parts are considered
RANKED = 4
EDGE_REG_WEIGHT = 1.0
UPRIGHT_BONUS = 0.0
UPRIGHT = [i for i, R in enumerate(ORIENTATIONS) if np.allclose(R @ np.array([0.0, -1.0, 0.0]), [0.0, -1.0, 0.0])]


def first_part_pose() -> np.ndarray:
    return np.eye(4)


def solve(lib, base: list, parts: list[tuple[str, int]], rgb: np.ndarray, pts_per_px: float | None,
          collider=None, beam: int = 6, extra_codes=()) -> StepResult:
    """`base`: model so far [(id, colour, 4x4)] in the frame the step is built in; `parts`: new parts
    [(id, colour)]. When `base` is empty the largest new part is put at the origin (the frame is free)."""
    if rgb is None:
        return StepResult([], [], None, 0.0, 0.0, status="no picture")
    parts = list(parts)
    seeded: list = []
    if not base:
        if not parts:
            return StepResult([], [], None, 0.0, 0.0, status="nothing to place")
        from .place import _size
        k = max(range(len(parts)), key=lambda i: _size(lib, parts[i][0]))
        seeded = [(parts[k][0], parts[k][1], first_part_pose())]
        parts = parts[:k] + parts[k + 1:]
    model0 = base + seeded
    px_per_ldu = BOOKLET_SCALE / pts_per_px if pts_per_px else None
    views = rank_views(lib, model0, rgb, pts_per_px, BOOKLET_SCALE if pts_per_px else None, top=VIEWS)
    if not views:
        views = rank_views(lib, model0, rgb, None, None, top=VIEWS)
    if not views:
        return StepResult(seeded, [None] * len(seeded), None, 0.0, 0.0, status="no view fit")
    picture = Picture.from_rgb(rgb, pts_per_px, px_per_ldu)
    codes = sorted({c for _p, c, _m in model0} | {c for _p, c in parts} | set(extra_codes))
    classes = picture.classes(codes)
    ink_dist = ink_distance(picture.rgb)
    orientations = list(dict.fromkeys([oi for _i, oi, _y, _p in views[:RANKED]] + UPRIGHT))
    scale = BOOKLET_SCALE / picture.pts_per_px if picture.pts_per_px else _scale_from_extent(lib, model0, views[0][1], views[0][2], views[0][3], picture)
    best = None
    for reg in search(lib, model0, picture, codes, orientations, scale, classes=classes, on_ink=ink_dist <= NEAR_INK):
        value = reg.score + (UPRIGHT_BONUS if reg.orientation_index in UPRIGHT else 0.0)
        if best is None or value > best[0]:
            best = (value, reg)
    _value, reg = best
    fit = {"iou": views[0][0]}
    if not parts:
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, fit["iou"])

    def scene_for(model):
        return Scene.build(lib, model, reg.view, classes, codes, ink_dist)

    def candidate_fn(part, model):
        return candidates(lib, part, model)

    collides = None
    if collider is not None:
        collider.set_model(model0)
        collides = lambda part, matrix, _model: collider.hits(part, matrix)
    deltas = DELTAS if int(picture.arrows.sum()) >= MIN_ARROW_PIXELS else (0.0,)
    states = solve_step(lib, scene_for, model0, parts, candidate_fn, collides=collides, beam=beam, deltas=deltas)
    if not states or not states[0].placed:
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, fit["iou"], status="no candidates")
    best: State = states[0]
    return StepResult(seeded + best.placed, [None] * len(seeded) + best.scores, reg.view, reg.score, fit["iou"],
                      alternatives=states[1:])


def _scale_from_extent(lib, parts, oi, yaw, pitch, picture) -> float:
    """Pixels per LDU from the largest foreground component when the page scale is unknown."""
    from ..viewfit import _ldu_extent
    from .render import world_triangles
    pts = np.concatenate([world_triangles(lib, p, m).reshape(-1, 3) for p, _c, m in parts]) @ ORIENTATIONS[oi].T
    ys, xs = np.where(picture.foreground)
    if not len(xs):
        return 1.0
    return float(max(np.ptp(xs), np.ptp(ys))) / max(1e-6, _ldu_extent(pts, yaw, pitch))
