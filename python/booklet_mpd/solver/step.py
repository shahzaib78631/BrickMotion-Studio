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
from .register import rank_views, register, search
from .render import View


@dataclass
class StepResult:
    placed: list                       # [(part, colour, matrix)] new parts, in the input order where possible
    scores: list                       # per placed part: place.Scored
    view: View | None
    registration: float
    fit_iou: float                     # PRE-placement hull IoU of the model so far (not evidence of correct placement)
    alternatives: list = field(default_factory=list)   # other final beam states (State)
    status: str = "ok"
    completed: float = 0.0             # registration score of the chosen completed hypothesis (model + new parts)
    hypotheses: list = field(default_factory=list)     # completed scores of every camera hypothesis tried


VIEWS = 8
MIN_ARROW_PIXELS = 25     # working-resolution red stroke pixels before floating parts are considered
RANKED = 4
EDGE_REG_WEIGHT = 1.0
UPRIGHT_BONUS = 0.0
REREGISTER = True
HYPOTHESES = 3            # camera orientations carried through placement and compared once completed
UPRIGHT = [i for i, R in enumerate(ORIENTATIONS) if np.allclose(R @ np.array([0.0, -1.0, 0.0]), [0.0, -1.0, 0.0])]


def first_part_pose() -> np.ndarray:
    return np.eye(4)


def solve(lib, base: list, parts: list[tuple[str, int]], rgb: np.ndarray, pts_per_px: float | None,
          collider=None, beam: int = 6, extra_codes=(), orientations: list[int] | None = None) -> StepResult:
    """`base`: model so far [(id, colour, 4x4)] in the frame the step is built in; `parts`: new parts
    [(id, colour)]. When `base` is empty the largest new part is put at the origin (the frame is free).
    `orientations`: restrict the camera search to these cube orientations (a known, fixed camera)."""
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
    if orientations is None:
        orientations = list(dict.fromkeys([oi for _i, oi, _y, _p in views[:RANKED]] + UPRIGHT))
    scale = BOOKLET_SCALE / picture.pts_per_px if picture.pts_per_px else _scale_from_extent(lib, model0, views[0][1], views[0][2], views[0][3], picture)
    regs = search(lib, model0, picture, codes, orientations, scale, classes=classes, on_ink=ink_dist <= NEAR_INK,
                  refine=2 * HYPOTHESES)
    # diverse camera hypotheses: the best registration per cube orientation, best first
    hypotheses, seen = [], set()
    for reg in sorted(regs, key=lambda r: -(r.score + (UPRIGHT_BONUS if r.orientation_index in UPRIGHT else 0.0))):
        if reg.orientation_index not in seen:
            seen.add(reg.orientation_index)
            hypotheses.append(reg)
    hypotheses = hypotheses[:HYPOTHESES]
    pre_iou = float(views[0][0])
    if not parts:
        reg = hypotheses[0]
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, pre_iou, completed=reg.score)

    def candidate_fn(part, model):
        return candidates(lib, part, model)

    collides = None
    if collider is not None:
        collider.set_model(model0)
        collides = lambda part, matrix, _model: collider.hits(part, matrix)
    deltas = DELTAS if int(picture.arrows.sum()) >= MIN_ARROW_PIXELS else (0.0,)
    on_ink = ink_dist <= NEAR_INK

    def place_under(reg):
        def scene_for(model):
            return Scene.build(lib, model, reg.view, classes, codes, ink_dist)
        return solve_step(lib, scene_for, model0, parts, candidate_fn, collides=collides, beam=beam, deltas=deltas)

    def completed(reg, state):
        """Re-register the completed hypothesis (parts drawn where the picture shows them)."""
        from .place import drawn_pose
        drawn = [(p, c, drawn_pose(sc) if sc is not None else m) for (p, c, m), sc in zip(state.placed, state.scores)]
        out = register(lib, model0 + drawn, picture, codes, reg.view.orientation, reg.view.yaw, reg.view.pitch,
                       reg.view.scale, scale_range=(0.98, 1.0, 1.02), classes=classes, on_ink=on_ink)
        out.orientation_index = reg.orientation_index
        return out

    results = []
    for reg in hypotheses:
        states = place_under(reg)
        if not states or not states[0].placed:
            continue
        reg2 = completed(reg, states[0])
        if REREGISTER:
            # the picture shows the model AFTER the step: registering the model before it lets the new
            # parts' silhouette pull the camera off; place again under the completed registration
            moved = np.hypot(reg2.view.offset[0] - reg.view.offset[0], reg2.view.offset[1] - reg.view.offset[1])
            if moved > 1.0 or abs(reg2.view.yaw - reg.view.yaw) > 1 or abs(reg2.view.pitch - reg.view.pitch) > 1:
                states2 = place_under(reg2)
                if states2 and states2[0].placed:
                    states = states2
                    reg2 = completed(reg2, states[0])
        results.append((reg2.score, reg2, states))
    if not results:
        reg = hypotheses[0]
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, pre_iou, status="no candidates")
    # pick the hypothesis whose completed model explains the picture best
    score, reg, states = max(results, key=lambda r: r[0])
    best: State = states[0]
    return StepResult(seeded + best.placed, [None] * len(seeded) + best.scores, reg.view, reg.score, pre_iou,
                      alternatives=states[1:], completed=float(score), hypotheses=[float(r[0]) for r in results])


def _scale_from_extent(lib, parts, oi, yaw, pitch, picture) -> float:
    """Pixels per LDU from the largest foreground component when the page scale is unknown."""
    from ..viewfit import _ldu_extent
    from .render import world_triangles
    pts = np.concatenate([world_triangles(lib, p, m).reshape(-1, 3) for p, _c, m in parts]) @ ORIENTATIONS[oi].T
    ys, xs = np.where(picture.foreground)
    if not len(xs):
        return 1.0
    return float(max(np.ptp(xs), np.ptp(ys))) / max(1e-6, _ldu_extent(pts, yaw, pitch))
