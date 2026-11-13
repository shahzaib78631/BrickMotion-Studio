"""Solve one booklet step: register the model so far to the picture, then place the new parts.

Inference only (no answer key): inputs are the model so far, the identities of the new parts and
the step picture. Used by the free-run pipeline and, with the true model so far, by the
teacher-forced benchmark.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import os

import numpy as np

from ..viewfit import BOOKLET_SCALE, ORIENTATIONS
from .edges import NEAR_INK, ink_distance
from .candidates import candidates
from .picture import Picture
from .place import DELTAS, Scene, State, solve_step
from .subbuild import FACING, SUBBUILDS, place_units, solve_unit, unit_parts
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
    orientation_index: int | None = None               # cube orientation of `view` (for SectionCamera)
    look: list = field(default_factory=list)           # lookahead: next-step completed score per top state


VIEWS = 8
MIN_ARROW_PIXELS = 25     # working-resolution red stroke pixels before floating parts are considered
RANKED = 4
EDGE_REG_WEIGHT = 1.0
UPRIGHT_BONUS = 0.0
REREGISTER = True
PUSH = os.environ.get("BOOKLET_SOLVER_PUSH", "0") != "0"   # parts drawn displaced along their arrows (A/B: no gain, off)
RERANK = int(os.environ.get("BOOKLET_SOLVER_RERANK", "3"))  # beam states re-scored as completed models
ROUNDS = 1                # placement / completed re-registration alternations per hypothesis
# booklet pages sit within a few percent of the scale prior; the registered base alone cannot tell scale
# from the parts about to be added (they hide part of the silhouette), so the prior is held tightly
# BOOKLET_SOLVER_SCALE_SPAN holds the scale prior to +-3% (A/B: tight beat the old wide +-10% on 4 sets)
SCALE_RANGE = tuple(np.linspace(1 - float(os.environ.get("BOOKLET_SOLVER_SCALE_SPAN", "0.03")),
                                1 + float(os.environ.get("BOOKLET_SOLVER_SCALE_SPAN", "0.03")), 7))
VIEW_SEPARATION = 0.0     # >0: hypotheses are distinct camera peaks (degrees apart), not one per orientation
HYPOTHESES = int(os.environ.get("BOOKLET_SOLVER_HYPOTHESES", "4"))  # camera orientations carried through placement and compared once completed
UPRIGHT = [i for i, R in enumerate(ORIENTATIONS) if np.allclose(R @ np.array([0.0, -1.0, 0.0]), [0.0, -1.0, 0.0])]


CAMERA_HOLD = os.environ.get("BOOKLET_SOLVER_CAMERA_HOLD", "1") != "0"
HOLD_DROP = float(os.environ.get("BOOKLET_SOLVER_HOLD_DROP", "0.15"))   # completed-score slack before the held camera is doubted
HOLD_AGREE = 6.0          # degrees: chosen cameras this close are one section camera
HOLD_RECENT = 5           # steps looked back over
HOLD_MIN = 2              # steps that must agree before a camera is held


class SectionCamera:
    """The camera a booklet section is drawn from. A booklet keeps one camera until it turns the model (a
    rotate icon); re-estimating it every step lets the scale wander a few percent and a symmetric base
    flip 180 degrees. Fed the camera each solved step chose (after placement, from its completed model),
    it holds the one most recent steps agree on. Keyed by model file: a submodel has its own frame."""

    def __init__(self):
        self.seen: dict = {}       # key -> [(view, orientation index, completed score, weight)]

    def add(self, key, result: "StepResult", weight: float) -> None:
        """`weight`: parts in the model so far (a larger model fixes its camera better)."""
        if result.view is not None and result.completed and result.placed:
            self.seen.setdefault(key, []).append((result.view, result.orientation_index, float(result.completed), weight))

    def prior(self, key):
        """(view, orientation index, expected completed score) or None."""
        recent = self.seen.get(key, [])[-HOLD_RECENT:]
        best = None
        for j, (v, _oi, _s, _w) in enumerate(recent):
            members = [x for x in recent if _angle(x[0], v) < HOLD_AGREE]
            weight = sum(x[3] for x in members)
            if len(members) >= HOLD_MIN and (best is None or (weight, j) > best[0]):
                best = ((weight, j), members, v)
        if best is None:
            return None
        _k, members, v = best
        same = [x for x in members if np.allclose(x[0].orientation, v.orientation)]
        view = v.replace(yaw=float(np.median([x[0].yaw for x in same])),
                         pitch=float(np.median([x[0].pitch for x in same])),
                         scale=float(np.median([x[0].scale for x in same])))
        return view, same[-1][1], float(np.median([x[2] for x in same]))


def _angle(a, b) -> float:
    r = np.asarray(a.matrix, float)[:3, :3] @ np.asarray(b.matrix, float)[:3, :3].T
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1))))


UNIT_BEAM = 2             # unit placements carried into the rest of the step


def _units(lib, parts: list, subbuilds: list[dict]) -> tuple[list, list]:
    """Which parts each sub-build panel holds. Returns ([spec], parts left for the main picture); a spec
    is solved per camera hypothesis (solve_unit), its parts falling back to the main picture if it fails."""
    left = list(parts)
    specs = []
    for sub in subbuilds:
        pts = sub["pts_per_px"]
        pic = Picture.from_rgb(sub["rgb"], pts, BOOKLET_SCALE / pts if pts else None)
        n = max(1, int(sub.get("count", 1) or 1))
        per_copy = unit_parts(left, pic, n)
        if not per_copy:
            continue
        trial = list(left)
        for x in per_copy * n:
            trial.remove(x)
        left = trial
        codes = sorted({c for _p, c in per_copy})
        ink = ink_distance(pic.rgb)
        specs.append({"per_copy": per_copy, "count": n, "picture": pic, "codes": codes,
                      "classes": pic.classes(codes), "ink": ink, "on_ink": ink <= NEAR_INK, "cache": {}})
    return specs, left


def first_part_pose() -> np.ndarray:
    return np.eye(4)


def solve(lib, base: list, parts: list[tuple[str, int]], rgb: np.ndarray, pts_per_px: float | None,
          collider=None, beam: int = 6, extra_codes=(), orientations: list[int] | None = None,
          subbuilds: list[dict] | None = None, exploded: bool = False, camera=None) -> StepResult:
    """`base`: model so far [(id, colour, 4x4)] in the frame the step is built in; `parts`: new parts
    [(id, colour)]. When `base` is empty the largest new part is put at the origin (the frame is free).
    `orientations`: restrict the camera search to these cube orientations (a known, fixed camera).
    `subbuilds`: the step's sub-build panels (rawimages.subbuild_images): each is solved alone and its unit
    placed as a whole, N copies. `exploded`: the picture draws parts apart (a sub-build panel).
    `camera`: SectionCamera.prior(...) — the section's camera: tried first at its scale, and the free camera
    search runs only when its completed model scores more than HOLD_DROP under what the section expects."""
    if rgb is None:
        return StepResult([], [], None, 0.0, 0.0, status="no picture")
    parts = list(parts)
    units: list = []
    if subbuilds and SUBBUILDS and base:
        units, parts = _units(lib, parts, subbuilds)
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
    codes = sorted({c for _p, c, _m in model0} | {c for _p, c in parts} | {c for spec in units for _p, c in spec["per_copy"]} | set(extra_codes))
    classes = picture.classes(codes)
    ink_dist = ink_distance(picture.rgb)
    if orientations is None:
        orientations = list(dict.fromkeys([oi for _i, oi, _y, _p in views[:RANKED]] + UPRIGHT))
    scale = BOOKLET_SCALE / picture.pts_per_px if picture.pts_per_px else _scale_from_extent(lib, model0, views[0][1], views[0][2], views[0][3], picture)

    def free_hypotheses():
        regs = search(lib, model0, picture, codes, orientations, scale, classes=classes, on_ink=ink_dist <= NEAR_INK,
                      refine=HYPOTHESES, diverse=True, separation=VIEW_SEPARATION,
                      scale_range=SCALE_RANGE if pts_per_px else np.linspace(0.9, 1.1, 7))
        # diverse camera hypotheses: the best registration per cube orientation, best first
        out, seen = [], set()
        for reg in sorted(regs, key=lambda r: -(r.score + (UPRIGHT_BONUS if r.orientation_index in UPRIGHT else 0.0))):
            key = (reg.orientation_index, round(reg.view.yaw), round(reg.view.pitch)) if VIEW_SEPARATION else reg.orientation_index
            if key not in seen:
                seen.add(key)
                out.append(reg)
        return out[:HYPOTHESES]

    held = None
    if camera is not None and CAMERA_HOLD:
        cview, coi, expect = camera
        held = register(lib, model0, picture, codes, cview.orientation, cview.yaw, cview.pitch, cview.scale,
                        scale_range=(1.0,), angle_steps=((3.0, 0.0), (-3.0, 0.0), (0.0, 3.0), (0.0, -3.0)),
                        classes=classes, on_ink=ink_dist <= NEAR_INK)
        held.orientation_index = coi
    pre_iou = float(views[0][0])
    if not parts and not units:
        reg = held if held is not None else free_hypotheses()[0]
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, pre_iou, completed=reg.score)

    def candidate_fn(part, model):
        return candidates(lib, part, model)

    collides = None
    if collider is not None:
        collider.set_model(model0)
        collides = lambda part, matrix, _model: collider.hits(part, matrix)
    deltas = DELTAS if exploded or int(picture.arrows.sum()) >= MIN_ARROW_PIXELS else (0.0,)
    pushes = picture.arrow_axes() if PUSH and deltas != (0.0,) else []
    on_ink = ink_dist <= NEAR_INK

    def place_under(reg):
        def scene_for(model):
            scene = Scene.build(lib, model, reg.view, classes, codes, ink_dist)
            scene.picture = picture
            return scene
        solved, rest, facing = [], list(parts), {}
        for spec in units:
            key = (tuple(np.round(reg.view.orientation, 3).ravel()), round(reg.view.yaw), round(reg.view.pitch))
            if key not in spec["cache"]:
                spec["cache"][key] = solve_unit(lib, spec, reg.view, candidate_fn, DELTAS, collider)
                if collider is not None:
                    collider.set_model(model0)
            unit = spec["cache"][key]
            if unit is None:
                rest += spec["per_copy"] * spec["count"]
            elif len(unit["parts"]) == 1:
                # one part drawn large: it only tells which way that part faces
                p0, c0, m0 = unit["parts"][0]
                facing.setdefault((p0, c0), []).append(unit["facing"] @ m0)
                rest += spec["per_copy"] * spec["count"]
            else:
                left = list(spec["per_copy"])
                for q, c, _m in unit["parts"]:
                    left.remove((q, c))
                rest += left * spec["count"]
                solved.append((unit, spec["count"]))
        if facing:
            def cands(part, model, _raw=candidate_fn):
                out = _raw(part, model)
                rots = [r[:3, :3] for (q, _c), rs in facing.items() if q == part for r in rs]
                if not rots:
                    return out
                return [{**c, "prior": FACING} if any(np.allclose(np.asarray(c["matrix"])[:3, :3], r, atol=1e-3) for r in rots)
                        else c for c in out]
        else:
            cands = candidate_fn
        if not solved:
            return solve_step(lib, scene_for, model0, rest, cands, collides=collides, beam=beam, deltas=deltas, pushes=pushes)
        set_model = collider.set_model if collider is not None else None
        ustates = place_units(lib, scene_for, model0, solved, cands, collides=collides, set_model=set_model,
                              deltas=deltas)
        if not ustates:
            if set_model is not None:
                set_model(model0)
            loose = rest + [x for u, n in solved for x in [(q, c) for q, c, _m in u["parts"]] * n]
            return solve_step(lib, scene_for, model0, loose, cands, collides=collides, beam=beam, deltas=deltas, pushes=pushes)
        out = []
        for ust in ustates[:UNIT_BEAM]:
            if not rest:
                out.append(ust)
                continue
            if set_model is not None:
                set_model(model0 + ust.placed)
            for st in solve_step(lib, scene_for, model0 + ust.placed, rest, cands, collides=collides,
                                 beam=beam, deltas=deltas, pushes=pushes):
                out.append(State(ust.placed + st.placed, ust.scores + st.scores, ust.total + st.total))
        if set_model is not None:
            set_model(model0)
        out.sort(key=lambda st: -st.total)
        return out[:beam]

    def completed(reg, state, scales=(0.98, 1.0, 1.02)):
        """Re-register the completed hypothesis (parts drawn where the picture shows them)."""
        from .place import drawn_pose
        drawn = [(p, c, drawn_pose(sc) if sc is not None else m) for (p, c, m), sc in zip(state.placed, state.scores)]
        out = register(lib, model0 + drawn, picture, codes, reg.view.orientation, reg.view.yaw, reg.view.pitch,
                       reg.view.scale, scale_range=scales, classes=classes, on_ink=on_ink)
        out.orientation_index = reg.orientation_index
        return out

    def evaluate(reg, scales=(0.98, 1.0, 1.02)):
        """(completed score, completed registration, states) under one camera hypothesis, or None."""
        states = place_under(reg)
        if not states or not states[0].placed:
            return None
        reg2 = completed(reg, states[0], scales)
        # the picture shows the model AFTER the step: registering the model before it lets the new
        # parts' silhouette pull the camera off. Alternate placement and completed re-registration.
        for _round in range(ROUNDS if REREGISTER else 0):
            moved = np.hypot(reg2.view.offset[0] - reg.view.offset[0], reg2.view.offset[1] - reg.view.offset[1])
            if not (moved > 1.0 or abs(reg2.view.yaw - reg.view.yaw) > 1 or abs(reg2.view.pitch - reg.view.pitch) > 1):
                break
            states2 = place_under(reg2)
            if not states2 or not states2[0].placed:
                break
            reg3 = completed(reg2, states2[0], scales)
            if reg3.score < reg2.score - 1e-9:
                break
            reg, reg2, states = reg2, reg3, states2
        # the beam ranks states by summed per-part gains; the completed model is the better judge
        # (two same-colour parts swapped: each gain alike, the whole picture not)
        for k in range(1, min(RERANK, len(states))):
            alt = completed(reg, states[k], scales)
            if alt.score > reg2.score + 1e-9:
                reg2, states = alt, [states[k]] + states[:k] + states[k + 1:]
        return reg2.score, reg2, states

    results = []
    search_free = True
    if held is not None:
        r = evaluate(held, scales=(1.0,))
        if r is not None:
            search_free = r[0] < expect - HOLD_DROP
            # doubted (the model may have been turned): search afresh, but the held camera still wins
            # unless a free one beats it clearly
            results.append((r[0] + (HOLD_DROP if search_free else 0.0), r[1], r[2]))
    hypotheses = free_hypotheses() if search_free else []
    for reg in hypotheses:
        r = evaluate(reg)
        if r is not None:
            results.append(r)
    if not results:
        reg = held if held is not None else (hypotheses or free_hypotheses())[0]
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, pre_iou, status="no candidates")
    # pick the hypothesis whose completed model explains the picture best
    score, reg, states = max(results, key=lambda r: r[0])
    score = reg.score
    best: State = states[0]
    return StepResult(seeded + best.placed, [None] * len(seeded) + best.scores, reg.view, reg.score, pre_iou,
                      alternatives=states[1:], completed=float(score), hypotheses=[float(r[0]) for r in results],
                      orientation_index=reg.orientation_index)


ALONE = os.environ.get("BOOKLET_SOLVER_ALONE", "1") != "0"
LOOKAHEAD = os.environ.get("BOOKLET_SOLVER_LOOKAHEAD", "1") != "0"
LOOK_TOP = 3              # beam states tried under the next step
LOOK_GAP = float(os.environ.get("BOOKLET_SOLVER_LOOK_GAP", "0.05"))   # only when the runner-up is this close (share of the top total)
LOOK_WIN = float(os.environ.get("BOOKLET_SOLVER_LOOK_WIN", "0.0"))    # next-step completed score a switch must gain


def lookahead(lib, base: list, result: StepResult, next_parts: list[tuple[str, int]], next_rgb, next_pts,
              collider=None, subbuilds=None) -> StepResult:
    """Pick among a step's closest answers by the next step's picture. A side-stud brick facing the wrong
    way, or a part hidden in the wrong place, looks alike in its own picture; the next picture draws what
    attaches to it, and the next step solves only on the right answer. Each of the top states gets the
    next step solved on it (under this step's camera); the one whose completed next model explains the next
    picture best is kept. Run only when the runner-up is within LOOK_GAP of the top state."""
    if not LOOKAHEAD or next_rgb is None or not next_parts or not result.alternatives or result.view is None:
        return result
    if any(sc is None for sc in result.scores):        # a seeded (frame-free) first part
        return result
    top = State(list(result.placed), list(result.scores), sum(sc.score for sc in result.scores))
    states = [top] + [st for st in result.alternatives[:LOOK_TOP - 1]]
    if abs(top.total - states[1].total) > LOOK_GAP * max(1.0, abs(top.total)):
        return result
    camera = (result.view, result.orientation_index, result.completed)
    judged = []
    for st in states:
        r = solve(lib, base + st.placed, next_parts, next_rgb, next_pts, collider=collider, subbuilds=subbuilds,
                  camera=camera)
        judged.append(r.completed if r.placed else -np.inf)
    result.look = list(judged)
    k = int(np.argmax(judged))
    if k == 0 or judged[k] <= judged[0] + max(LOOK_WIN, 1e-6):
        return result
    best = states[k]
    rest = [st for j, st in enumerate(states) if j != k] + result.alternatives[LOOK_TOP - 1:]
    return StepResult(best.placed, best.scores, result.view, result.registration, result.fit_iou,
                      alternatives=rest, status=result.status, completed=result.completed,
                      hypotheses=result.hypotheses, orientation_index=result.orientation_index, look=list(judged))


def solve_start(lib, context: list, parts: list[tuple[str, int]], rgb, pts_per_px, **kw) -> tuple[StepResult, bool]:
    """A step that starts a sub-model. Booklets draw it either in place on the model so far, or alone
    (a new figure's first plate on an empty page). Fitting the whole model to a lone plate fails, and
    fitting a lone plate to the whole model leaves most of the picture unexplained, so both are solved and
    the completed model that explains the picture better is kept. Returns (result, alone); an alone result
    is in a frame of its own (largest part at the origin)."""
    shown = solve(lib, context, parts, rgb, pts_per_px, **kw) if context else None
    if not ALONE or rgb is None:
        return shown, False
    alone = solve(lib, [], parts, rgb, pts_per_px, **{k: v for k, v in kw.items() if k != "camera"})
    if shown is None or (alone.placed and alone.completed > shown.completed):
        return alone, True
    return shown, False


def _scale_from_extent(lib, parts, oi, yaw, pitch, picture) -> float:
    """Pixels per LDU from the largest foreground component when the page scale is unknown."""
    from ..viewfit import _ldu_extent
    from .render import world_triangles
    pts = np.concatenate([world_triangles(lib, p, m).reshape(-1, 3) for p, _c, m in parts]) @ ORIENTATIONS[oi].T
    ys, xs = np.where(picture.foreground)
    if not len(xs):
        return 1.0
    return float(max(np.ptp(xs), np.ptp(ys))) / max(1e-6, _ldu_extent(pts, yaw, pitch))
