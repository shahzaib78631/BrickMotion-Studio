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
from .exact_place import _drawn_entries, exact_polish, solve_step_exact
from .candidates import candidates
from .picture import Picture
from .place import DELTAS, Scene, State, _boxes_overlap, distinct, polish, score_candidates, solve_step
from .scorer import EDGE_PREC_WEIGHT, ModelScorer
from .subbuild import FACING, SUBBUILDS, place_units, solve_unit, unit_parts
from .register import Aligner, Registration, rank_views, refine_view, register, search, view_fit_metrics
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
    state_total: float = 0.0                           # exact raw ModelScorer total of the chosen State
    early_branches: list = field(default_factory=list) # top distinct (placed, scores, view, oi, completed) across hypotheses for early-step beam


VIEWS = 8
MIN_ARROW_PIXELS = 25     # working-resolution red stroke pixels before floating parts are considered
RANKED = 4
EDGE_REG_WEIGHT = 1.0
UPRIGHT_BONUS = 0.0
REREGISTER = True
PUSH = os.environ.get("BOOKLET_SOLVER_PUSH", "0") != "0"   # parts drawn displaced along their arrows (A/B: no gain, off)
RERANK = int(os.environ.get("BOOKLET_SOLVER_RERANK", "3"))  # beam states re-scored as completed models
# after the beam: move one part at a time to the alternative the completed model scores higher (gate 4b: the
# beam lost a better-scoring layout in 63 of 101 wrong parts with a good camera; a wider beam got 8 of them)
POLISH = os.environ.get("BOOKLET_SOLVER_POLISH", "0") != "0"   # off: gate 4b 372/578 vs 370, 13 steps up 12 down, +24% time
POLISH_K = int(os.environ.get("BOOKLET_SOLVER_POLISH_K", "32"))   # alternatives tried per part
EXACT_PLACE = os.environ.get("BOOKLET_SOLVER_EXACT", "1") != "0"  # ModelScorer + exact discrete/continuous optimizer
ROUNDS = 1                # placement / completed re-registration alternations per hypothesis
# booklet pages sit within a few percent of the scale prior; the registered base alone cannot tell scale
# from the parts about to be added (they hide part of the silhouette), so the prior is held tightly
# BOOKLET_SOLVER_SCALE_SPAN holds the scale prior to +-3% (A/B: tight beat the old wide +-10% on 4 sets)
SCALE_RANGE = tuple(np.linspace(1 - float(os.environ.get("BOOKLET_SOLVER_SCALE_SPAN", "0.03")),
                                1 + float(os.environ.get("BOOKLET_SOLVER_SCALE_SPAN", "0.03")), 7))
VIEW_SEPARATION = 0.0     # >0: hypotheses are distinct camera peaks (degrees apart), not one per orientation
HYPOTHESES = int(os.environ.get("BOOKLET_SOLVER_HYPOTHESES", "4"))  # camera orientations carried through placement and compared once completed
UPRIGHT = [i for i, R in enumerate(ORIENTATIONS) if np.allclose(R @ np.array([0.0, -1.0, 0.0]), [0.0, -1.0, 0.0])]
UPSIDE_DOWN = [i for i, R in enumerate(ORIENTATIONS) if np.allclose(R @ np.array([0.0, -1.0, 0.0]), [0.0, 1.0, 0.0])]


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
                         scale=float(np.median([x[0].scale for x in same])),
                         roll=float(np.median([x[0].roll for x in same])))
        return view, same[-1][1], float(np.median([x[2] for x in same]))


def _angle(a, b) -> float:
    r = np.asarray(a.matrix, float)[:3, :3] @ np.asarray(b.matrix, float)[:3, :3].T
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1))))


UNIT_BEAM = 2             # unit placements carried into the rest of the step


def _units(lib, parts: list, subbuilds: list[dict]) -> tuple[list, list]:
    """Which parts each sub-build panel holds. Returns ([spec], parts left for the main picture); a spec
    is solved per camera hypothesis (solve_unit), its parts falling back to the main picture if it fails.
    Handles multiple sub-build panels sharing the same colours (e.g. mirror-image left & right sub-builds
    in 41620 s27) by dividing shared parts evenly across the claiming panels instead of dumping all parts
    into the first panel!"""
    from collections import Counter
    from .subbuild import panel_colours

    if not subbuilds:
        return [], list(parts)
    all_codes = sorted({c for _p, c in parts})
    panel_meta = []
    for sub in subbuilds:
        pts = sub["pts_per_px"]
        pic = Picture.from_rgb(sub["rgb"], pts, BOOKLET_SCALE / pts if pts else None)
        n = max(1, int(sub.get("count", 1) or 1))
        present = panel_colours(all_codes, pic)
        panel_meta.append((pic, n, present, sub.get("stages") or []))

    # Count total copies claimed per colour across all panels, and rank panels by clean colour pixels
    # so when a unique colour (e.g. 6141:85 in 40348 s4) gets a stray outline hit in another panel,
    # it goes to the panel that actually draws it instead of being dropped by `tot // denom == 0`!
    claim_by_col: dict[int, list[tuple[int, int, int]]] = {}   # colour -> [(px_score, panel_idx, n)]
    for pi, (pic, n, present, _raw_stages) in enumerate(panel_meta):
        cls_all = pic.classes(all_codes)
        for c in present:
            k_c = all_codes.index(c)
            px_c = int(np.count_nonzero((cls_all == k_c) & ~pic.arrows))
            claim_by_col.setdefault(c, []).append((px_c, pi, n))

    # Decide which panels actually own each colour
    owner_share: dict[tuple[int, int], int] = {}   # (panel_idx, colour) -> copies_per_panel_unit
    total_counts = Counter(parts)
    by_colour_parts: dict[int, list[tuple[str, int]]] = {}
    for (p, c), tot in total_counts.items():
        by_colour_parts.setdefault(c, []).append((p, tot))
    for c, claimers in claim_by_col.items():
        tot_c = sum(t for _p, t in by_colour_parts.get(c, []))
        denom = sum(n for _px, _pi, n in claimers)
        if tot_c >= denom:
            for _px, pi, _n in claimers:
                owner_share[(pi, c)] = denom
        else:
            # Fewer total parts of colour `c` than total panel copies claiming it: assign ONLY to the
            # strongest panel(s) by pixel count (whose copy count fits `tot_c`)!
            ranked = sorted(claimers, key=lambda x: -x[0])
            used_n = 0
            chosen = []
            for _px, pi, n in ranked:
                if used_n + n <= tot_c:
                    chosen.append(pi)
                    used_n += n
            for pi in chosen:
                owner_share[(pi, c)] = used_n

    left = list(parts)
    specs = []
    for pi, (pic, n, present, raw_stages) in enumerate(panel_meta):
        per_copy = []
        for (p, c), tot in total_counts.items():
            denom = owner_share.get((pi, c), 0)
            if denom <= 0:
                continue
            each = tot // denom if tot >= denom else 0
            if each > 0:
                per_copy.extend([(p, c)] * each)
        if not per_copy:
            continue
        # Verify remaining `left` actually holds `per_copy * n`
        trial = list(left)
        ok = True
        for x in per_copy * n:
            if x in trial:
                trial.remove(x)
            else:
                ok = False
                break
        if not ok:
            continue
        left = trial
        codes = sorted({c for _p, c in per_copy})
        ink = ink_distance(pic.rgb)
        stages = []
        for st in raw_stages:
            st_pts = st["pts_per_px"]
            st_pic = Picture.from_rgb(st["rgb"], st_pts, BOOKLET_SCALE / st_pts if st_pts else None)
            st_ink = ink_distance(st_pic.rgb)
            stages.append({
                "step": st["step"], "picture": st_pic, "codes": codes,
                "classes": st_pic.classes(codes), "ink": st_ink, "on_ink": st_ink <= NEAR_INK,
            })
        specs.append({"per_copy": per_copy, "count": n, "picture": pic, "codes": codes,
                      "classes": pic.classes(codes), "ink": ink, "on_ink": ink <= NEAR_INK,
                      "stages": stages, "cache": {}})
    return specs, left


def first_part_pose() -> np.ndarray:
    return np.eye(4)


def _make_next_scorer(lib, model0: list, reg_view: View, next_rgb: np.ndarray, next_pts: float | None,
                      codes: list[int]) -> ModelScorer | None:
    """Build a ModelScorer for the NEXT step's picture aligned to `model0` under the same camera section.
    Returns None if the next step turned the camera (poor base registration, poor edge alignment, or any
    90/180/270-degree rotated orientation of `model0` explains `next_pic` comparably or better!)."""
    from .render import render
    from .subbuild import _turn
    next_px = BOOKLET_SCALE / next_pts if next_pts else None
    next_pic = Picture.from_rgb(next_rgb, next_pts, next_px)
    next_classes = next_pic.classes(codes)
    next_ink = ink_distance(next_pic.rgb) <= NEAR_INK
    nreg = register(lib, model0, next_pic, codes, reg_view.orientation, reg_view.yaw, reg_view.pitch,
                    reg_view.scale, scale_range=(0.98, 1.0, 1.02),
                    angle_steps=((2.0, 0.0), (-2.0, 0.0), (0.0, 2.0), (0.0, -2.0)),
                    classes=next_classes, on_ink=next_ink, roll=reg_view.roll)
    # Strict camera-consistency gate: reject rotated/turned next steps (symmetric BrickHeadz silhouettes
    # still overlap >75% when rotated 90/180 deg, so require BOTH strong colour/edge reg score AND tight edges!)
    if nreg.score < 0.85:
        return None
    _d, lab = render(lib, model0, nreg.view, next_pic.rgb.shape[:2])
    base_mask = lab >= 0
    if not base_mask.any():
        return None
    fg = next_pic.foreground & ~next_pic.arrows
    base_in_fg = float(np.count_nonzero(base_mask & fg)) / float(np.count_nonzero(base_mask))
    if base_in_fg < 0.82:
        return None
    _iou, mdist, _p90 = view_fit_metrics(lib, model0, next_pic, nreg.view)
    if mdist > 1.6:
        return None
    ns = ModelScorer(lib, model0, next_pic, nreg.view, codes)
    same_base = float(ns.base_score)
    # Verify `reg_view.orientation` decisively beats every 90/180/270-deg rotated view of `model0` on `next_pic`:
    # catches booklet rotation steps on boxy silhouettes (e.g. 41605 s20->s21 rotating Thanos 90 deg!)
    base_orient = np.asarray(reg_view.orientation, float)
    for k in (1, 2, 3):
        rot_orient = base_orient @ _turn(k)[:3, :3]
        r_rot = register(lib, model0, next_pic, codes, rot_orient, nreg.view.yaw, nreg.view.pitch,
                         nreg.view.scale, scale_range=(1.0,), angle_steps=(),
                         classes=next_classes, on_ink=next_ink, roll=reg_view.roll)
        other_base = float(ModelScorer(lib, model0, next_pic, r_rot.view, codes).base_score)
        if other_base > same_base - 150.0:
            return None
    return ns


def _next_step_seat_score(lib, model0: list, seated_placed: list, reg_view: View,
                          next_pic: Picture, codes: list[int], next_view: View | None = None,
                          next_scorer: ModelScorer | None = None) -> tuple[float, View]:
    """Precision-focused score of a candidate's SEATED poses against step N+1's picture."""
    if next_scorer is not None:
        ns = next_scorer
        next_view = ns.view
    else:
        if next_view is None:
            next_classes = next_pic.classes(codes)
            next_ink = ink_distance(next_pic.rgb) <= NEAR_INK
            nreg = register(lib, model0, next_pic, codes, reg_view.orientation, reg_view.yaw, reg_view.pitch,
                            reg_view.scale, scale_range=(0.98, 1.0, 1.02),
                            angle_steps=((2.0, 0.0), (-2.0, 0.0), (0.0, 2.0), (0.0, -2.0)),
                            classes=next_classes, on_ink=next_ink, roll=reg_view.roll)
            next_view = nreg.view
        ns = ModelScorer(lib, model0, next_pic, next_view, codes)
    if not seated_placed:
        return 0.0, next_view
    return float(ns.score_seated_in_next(seated_placed)), next_view


def solve(lib, base: list, parts: list[tuple[str, int]], rgb: np.ndarray, pts_per_px: float | None,
          collider=None, beam: int = 6, extra_codes=(), orientations: list[int] | None = None,
          subbuilds: list[dict] | None = None, exploded: bool = False, camera=None,
          prev_rgb: np.ndarray | None = None, prev_pts: float | None = None,
          next_rgb: np.ndarray | None = None, next_pts: float | None = None) -> StepResult:
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
        # Early steps of a new model/stand (`len(base) <= 2`) are always drawn upright; never flip
        # a 1-2 plate starting base upside-down (e.g. 40350 s24-s26 black stand plates)!
        orientations = list(UPRIGHT) if len(base) <= 2 else list(dict.fromkeys([oi for _i, oi, _y, _p in views[:RANKED]] + UPRIGHT))
    scale = BOOKLET_SCALE / picture.pts_per_px if picture.pts_per_px else _scale_from_extent(lib, model0, views[0][1], views[0][2], views[0][3], picture)

    def free_hypotheses():
        regs = search(lib, model0, picture, codes, orientations, scale, classes=classes, on_ink=ink_dist <= NEAR_INK,
                      refine=HYPOTHESES, diverse=True, separation=VIEW_SEPARATION,
                      scale_range=SCALE_RANGE if pts_per_px else np.linspace(0.9, 1.1, 7), subpixel=True)
        # If the booklet page is flipped upside down (e.g. building underside/feet) or zoomed relative
        # to BOOKLET_SCALE, Aligner can score high on a wrong upright view while leaving low IoU.
        best_iou = view_fit_metrics(lib, model0, picture, regs[0].view)[0] if regs else 0.0
        iou_thresh = 0.90 if (not parts and not units) else (0.78 if len(base) >= 3 else 0.65)
        if not regs or regs[0].score < 1.0 or best_iou < iou_thresh:
            # Early steps of a new model/stand (`len(base) <= 2`) are never drawn upside-down; only add
            # UPSIDE_DOWN once a multi-part model (`len(base) >= 3`) exists whose underside may be flipped up!
            missing_dn = [oi for oi in UPSIDE_DOWN if oi not in orientations] if len(base) >= 3 else []
            if missing_dn:
                regs_dn = search(lib, model0, picture, codes, missing_dn, scale, classes=classes,
                                 on_ink=ink_dist <= NEAR_INK, refine=HYPOTHESES, diverse=True,
                                 separation=VIEW_SEPARATION,
                                 scale_range=SCALE_RANGE if pts_per_px else np.linspace(0.9, 1.1, 7), subpixel=True)
                regs = regs + regs_dn
                if regs_dn:
                    best_iou = max(best_iou, max(view_fit_metrics(lib, model0, picture, r.view)[0] for r in regs_dn))
            # Only scan extent-based scales when scale is unknown, model0 IS the full picture (no new parts),
            # native scale failed badly (best_iou < 0.45), or SectionCamera already established a zoomed scale!
            cam_scale_diff = (camera is not None and abs(float(camera[0].scale) - scale) > 0.12 * scale)
            ext_iou_lim = 0.90 if (not parts and not units) else (0.72 if len(base) <= 1 else 0.45)
            if not regs or regs[0].score < 1.0 or best_iou < ext_iou_lim or not pts_per_px or cam_scale_diff:
                all_orients = orientations + missing_dn
                ext_scales = []
                if cam_scale_diff:
                    ext_scales.append(float(camera[0].scale))
                for _vi, voi, vy, vp in list(views[:2]) + [(0.0, UPRIGHT[0], 45.0, 35.0)]:
                    es = _scale_from_extent(lib, model0, voi, vy, vp, picture)
                    if es > 0.05 and abs(es - scale) > 0.06 * scale and all(abs(es - prev) > 0.08 * prev for prev in ext_scales):
                        ext_scales.append(es)
                for ext_scale in ext_scales:
                    regs_ext = search(lib, model0, picture, codes, all_orients, ext_scale, classes=classes,
                                      on_ink=ink_dist <= NEAR_INK, refine=HYPOTHESES, diverse=True,
                                      separation=VIEW_SEPARATION, scale_range=np.linspace(0.82, 1.18, 9), subpixel=True)
                    regs = regs + regs_ext
            else:
                ext_scales = []
            # On standalone single-part / flat-plate pages (e.g. 40350 s24 6x6 black plate), Aligner can prefer
            # a shrunken low-pitch patch (IoU=0.47) over the true upright studio angle (yaw=35..55, pitch=35,
            # IoU=0.85+). Always inject canonical upright studio registrations at both native and extent scales!
            if not parts and not units and best_iou < 0.85:
                canon_ois = list(UPRIGHT) + (list(UPSIDE_DOWN) if len(base) >= 3 else [])
                for sc_u in [scale] + ext_scales:
                    for voi_u in canon_ois:
                        for vy_u in (35.0, 45.0, 55.0):
                            ru = register(lib, model0, picture, codes, ORIENTATIONS[voi_u], vy_u, 35.0, sc_u,
                                          scale_range=(0.94, 1.0, 1.06), angle_steps=(), classes=classes,
                                          on_ink=ink_dist <= NEAR_INK, subpixel=True)
                            ru.orientation_index = voi_u
                            regs.append(ru)
        # diverse camera hypotheses: the best registration per cube orientation, best first
        def _rank_key(reg):
            iou, mdist, _p90 = view_fit_metrics(lib, model0, picture, reg.view)
            # Combine template agreement with silhouette IoU and edge tightness so shrunken fits never win
            iou_w = 1.6 if (not parts and not units) else 0.6
            edge_w = 0.35 if (not parts and not units) else 0.12
            return reg.score + iou_w * iou - edge_w * min(mdist, 4.0) + (UPRIGHT_BONUS if reg.orientation_index in UPRIGHT else 0.0)
        out, seen = [], set()
        for reg in sorted(regs, key=lambda r: -_rank_key(r)):
            key = (reg.orientation_index, round(reg.view.yaw), round(reg.view.pitch)) if VIEW_SEPARATION else reg.orientation_index
            if key not in seen:
                seen.add(key)
                out.append(reg)
        # Never let upside-down hypotheses evict ALL upright hypotheses on a symmetric flat plate
        # (e.g. 40350 s25 black 6x6 plate): reserve all 4 distinct UPRIGHT orientations when len(base) <= 1,
        # and at least half the slots otherwise!
        top_out = out[:HYPOTHESES]
        if any(oi in UPRIGHT for oi in orientations):
            up_avail, seen_uoi = [], set()
            for r in out:
                if r.orientation_index in UPRIGHT and r.orientation_index not in seen_uoi:
                    seen_uoi.add(r.orientation_index)
                    up_avail.append(r)
            min_up = min(len(up_avail), 4 if len(base) <= 1 else max(1, HYPOTHESES // 2))
            cur_up = [r for r in top_out if r.orientation_index in UPRIGHT]
            if len(cur_up) < min_up:
                kept_up = up_avail[:min_up]
                kept_ids = {id(r) for r in kept_up}
                rest_out = [r for r in out if id(r) not in kept_ids]
                top_out = (kept_up + rest_out)[:max(HYPOTHESES, min_up)]
        return top_out

    held = None
    if camera is not None and CAMERA_HOLD:
        cview, coi, expect = camera
        if expect <= -1e8:
            # Fixed oracle camera (e.g. Gate 4b): keep exact view without drifting it
            held = Registration(cview, 0.0, classes.shape, coi)
        else:
            held = register(lib, model0, picture, codes, cview.orientation, cview.yaw, cview.pitch, cview.scale,
                            scale_range=(1.0,), angle_steps=((3.0, 0.0), (-3.0, 0.0), (0.0, 3.0), (0.0, -3.0)),
                            classes=classes, on_ink=ink_dist <= NEAR_INK, subpixel=True, roll=cview.roll,
                            init_offset=cview.offset if cview.offset != (0.0, 0.0) else None)
            held.orientation_index = coi
    pre_iou = float(views[0][0])
    if not parts and not units:
        cands_reg = [held] if held is not None else free_hypotheses()
        best_reg, best_view, best_q = cands_reg[0], cands_reg[0].view, -1e9
        for reg in cands_reg:
            iou0, md0, p90_0 = view_fit_metrics(lib, model0, picture, reg.view)
            rv = refine_view(lib, model0, picture, reg.view, scale_tol=0.08, outer=3)
            iou, mdist, p90 = view_fit_metrics(lib, model0, picture, rv)
            if iou < iou0 - 0.08:   # never let edge refinement collapse a good silhouette onto an interior patch
                rv, iou, mdist, p90 = reg.view, iou0, md0, p90_0
            q = 4.5 * iou - 0.6 * min(mdist, 4.0) - 0.15 * min(p90, 6.0) + 0.25 * reg.score
            if len(cands_reg) > 1:
                # Break symmetric-silhouette orientation ties (e.g. black 6x6 baseplate with coloured jumpers!)
                sc_v = ModelScorer(lib, model0, picture, rv, codes)
                norm_v = max(1.0, float(sc_v.fg.sum() + sc_v.ink_fg.sum()))
                q += 1.2 * float(sc_v.base_score / norm_v)
            if q > best_q:
                best_q, best_reg, best_view = q, reg, rv
        return StepResult(seeded, [None] * len(seeded), best_view, best_reg.score, pre_iou, completed=best_reg.score,
                          orientation_index=best_reg.orientation_index,
                          early_branches=[(seeded, [None] * len(seeded), best_view, best_reg.orientation_index, float(best_reg.score))])

    # Additive step-wide candidate cache: candidates(part, model0) is computed ONCE per part for
    # the entire step (shared across all camera hypotheses, rounds, beam nodes, and polish moves!),
    # and for `model = model0 + extra`, only `candidates(part, extra)` (tiny!) is added on the fly.
    base_cand_cache: dict[str, list[dict]] = {}
    extra_cand_cache: dict = {}
    n_model0 = len(model0)

    deltas = DELTAS if exploded or int(picture.arrows.sum()) >= MIN_ARROW_PIXELS else (0.0,)
    pushes = picture.arrow_axes() if PUSH and deltas != (0.0,) else []
    on_ink = ink_dist <= NEAR_INK
    # On in-place steps building onto an existing model (`base` non-empty and no arrows), physically
    # connected candidates always govern: strip disconnected side-by-side `flush` poses unless none exist!
    allow_flush = (not base) or (deltas != (0.0,))

    def _filter_flush(cands_in: list[dict]) -> list[dict]:
        if allow_flush:
            return cands_in
        non_fl = [c for c in cands_in if c.get("kind") != "flush"]
        return non_fl if non_fl else cands_in

    def candidate_fn(part, model):
        if collider is not None and n_model0 > 0 and len(model) >= n_model0 and (
                model is model0 or all(a is b for a, b in zip(model, model0))):
            bc = base_cand_cache.get(part)
            if bc is None:
                collider.set_model(model0)
                raw_b = distinct(lib, part, _filter_flush(candidates(lib, part, model0)))
                # Pre-filter base-colliding poses ONCE so scoring/polish never wastes work on impossible poses!
                bc = [c for c in raw_b if not collider.hits(part, c["matrix"])]
                base_cand_cache[part] = bc
            if len(model) == n_model0:
                return bc
            extra = model[n_model0:]
            ek = (part, tuple((p, tuple(np.round(np.asarray(m, float).ravel(), 2))) for p, _c, m in extra))
            ec = extra_cand_cache.get(ek)
            if ec is None:
                raw_e = distinct(lib, part, _filter_flush(candidates(lib, part, extra)))
                collider.set_model(model0)
                ec = [{**c, "host": c["host"] + n_model0} if isinstance(c.get("host"), int) else c
                      for c in raw_e if not collider.hits(part, c["matrix"])]
                extra_cand_cache[ek] = ec
            return bc + ec if ec else bc
        return _filter_flush(candidates(lib, part, model))

    collides = None
    if collider is not None:
        collider.set_model(model0)
        collides = lambda part, matrix, _model: collider.hits(part, matrix)

    def place_under(reg, polish_starts: int = 3, step_budget: float = 18.0):
        def scene_for(model):
            scene = Scene.build(lib, model, reg.view, classes, codes, ink_dist)
            scene.picture = picture
            return scene
        scorer = ModelScorer(lib, model0, picture, reg.view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts) if EXACT_PLACE else None
        next_scorer = None
        if next_rgb is not None and (deltas != (0.0,) or units) and model0 and EXACT_PLACE:
            next_scorer = _make_next_scorer(lib, model0, reg.view, next_rgb, next_pts, codes)
        solved, rest, facing = [], list(parts), {}
        for spec in units:
            # Solve each sub-build panel ONCE per step (canonical upright studio angles, scale-invariant 3D unit!)
            from .subbuild import upright as _upright_view
            uv = _upright_view(reg.view)
            o_up = np.asarray(uv.orientation, float)
            key = "canon"
            if key not in spec["cache"]:
                ubudget = 14.0 if len(spec.get("stages") or []) >= 3 else 10.0
                spec["cache"][key] = solve_unit(lib, spec, uv, candidate_fn, DELTAS, collider, time_budget=ubudget)
                if collider is not None:
                    collider.set_model(model0)
            unit_cached = spec["cache"][key]
            if unit_cached is None:
                unit = None
            else:
                R_rel = np.eye(4)
                R_rel[:3, :3] = o_up.T
                unit = {"parts": unit_cached["parts"], "facing": R_rel @ unit_cached["facing"]}
                if unit_cached.get("alternatives"):
                    unit["alternatives"] = [
                        {"parts": au["parts"], "facing": R_rel @ au["facing"]}
                        for au in unit_cached["alternatives"]
                    ]
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
            if EXACT_PLACE and scorer is not None:
                step_fp = 0.0 if (not base and deltas != (0.0,)) else None
                ptop = 20 if polish_starts <= 1 else 40
                prnd = 2 if polish_starts <= 1 else 4
                states = solve_step_exact(lib, scene_for, scorer, model0, rest, cands, collider=collider,
                                          beam=max(beam, 10), deltas=deltas, pushes=pushes,
                                          next_scorer=next_scorer if deltas != (0.0,) else None,
                                          polish_starts=polish_starts, polish_top_k=ptop, polish_rounds=prnd,
                                          time_budget=step_budget, flush_penalty=step_fp)
            else:
                states = solve_step(lib, scene_for, model0, rest, cands, collides=collides, beam=beam, deltas=deltas, pushes=pushes)
        else:
            set_model = collider.set_model if collider is not None else None
            unit_pushes = picture.arrow_axes() if deltas != (0.0,) else []
            ustates = place_units(lib, scene_for, model0, solved, cands, collides=collides, set_model=set_model,
                                  deltas=deltas, pushes=unit_pushes, collider=collider, scorer=scorer,
                                  next_scorer=next_scorer if deltas != (0.0,) else None)
            # Multi-hypothesis sub-build disambiguation: when solve_unit returned distinct close alternative
            # assemblies (e.g. ambiguous stack order in 2D panel), place each alternative on the main picture
            # and let exact ModelScorer + physical collisions/mates on model0 choose the winning assembly!
            if len(solved) == 1 and solved[0][0].get("alternatives") and EXACT_PLACE and scorer is not None:
                from .exact_place import _state_geom_key
                u_cnt = solved[0][1]
                # On multi-copy (2x+) repeat steps where the primary unit already locks >= 0.90 IoU, skip
                # redundant alternative-unit re-placement (saves 2x-3x runtime on repeat steps like 41620 s10!).
                skip_alts = (
                    u_cnt >= 2 and bool(ustates)
                    and float(view_fit_metrics(lib, model0 + _drawn_entries(ustates[0].placed, ustates[0].scores), picture, reg.view)[0]) >= 0.90
                )
                all_u = list(ustates)
                for alt_u in ([] if skip_alts else solved[0][0]["alternatives"][:2]):
                    alt_st = place_units(lib, scene_for, model0, [(alt_u, u_cnt)], cands, collides=collides,
                                         set_model=set_model, deltas=deltas, pushes=unit_pushes, collider=collider,
                                         scorer=scorer, next_scorer=next_scorer if deltas != (0.0,) else None)
                    all_u.extend(alt_st)
                if len(all_u) > len(ustates):
                    all_u.sort(key=lambda s: -s.total)
                    ded_u, seen_uk = [], set()
                    for s_u in all_u:
                        uk = _state_geom_key(lib, s_u.placed)
                        if uk not in seen_uk:
                            seen_uk.add(uk)
                            ded_u.append(s_u)
                    ustates = ded_u[:max(6, UNIT_BEAM * 2)]
            all_loose = rest + [x for u, n in solved for x in [(q, c) for q, c, _m in u["parts"]] * n]
            if not ustates:
                if set_model is not None:
                    set_model(model0)
                if EXACT_PLACE and scorer is not None:
                    states = solve_step_exact(lib, scene_for, scorer, model0, all_loose, cands, collider=collider,
                                              beam=max(beam, 10), deltas=deltas, pushes=pushes,
                                              next_scorer=next_scorer if deltas != (0.0,) else None,
                                              polish_starts=polish_starts)
                else:
                    states = solve_step(lib, scene_for, model0, all_loose, cands, collides=collides, beam=beam, deltas=deltas, pushes=pushes)
            else:
                sizes = [len(unit["parts"]) for unit, n in solved for _ in range(n)]
                unit_groups, at = [], 0
                for size in sizes:                  # each unit copy's parts sit together, in copy order
                    unit_groups.append(list(range(at, at + size)))
                    at += size
                out = []
                for ust in ustates[:max(UNIT_BEAM, 4 if (next_rgb is not None and deltas != (0.0,)) else UNIT_BEAM)]:
                    if not rest:
                        st_combined = State(ust.placed, ust.scores, ust.total, ust.done, unit_groups)
                        if EXACT_PLACE and scorer is not None:
                            from .exact_place import _float_cost
                            st_combined.total = float(scorer.score(_drawn_entries(st_combined.placed, st_combined.scores)))
                            if deltas != (0.0,):
                                # Penalise floating rigid unit once per floating copy (consistent with loose states)
                                for grp_u in unit_groups:
                                    d_u = max((float(st_combined.scores[k].delta) for k in grp_u if st_combined.scores[k] is not None), default=0.0)
                                    if d_u > 0.0:
                                        st_combined.total -= _float_cost(d_u)
                        out.append(st_combined)
                        continue
                    if set_model is not None:
                        set_model(model0 + ust.placed)
                    if EXACT_PLACE and scorer is not None:
                        sub_scorer = ModelScorer(lib, model0 + ust.placed, picture, reg.view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts)
                        rstates = solve_step_exact(lib, scene_for, sub_scorer, model0 + ust.placed, rest, cands,
                                                   collider=collider, beam=max(beam, 8), deltas=deltas, pushes=pushes,
                                                   polish_starts=min(polish_starts, 2))
                    else:
                        rstates = solve_step(lib, scene_for, model0 + ust.placed, rest, cands, collides=collides,
                                             beam=beam, deltas=deltas, pushes=pushes)
                    for st in rstates:
                        n0 = len(ust.placed)
                        comb_placed = ust.placed + st.placed
                        comb_scores = ust.scores + st.scores
                        comb_total = scorer.score(_drawn_entries(comb_placed, comb_scores)) if (EXACT_PLACE and scorer is not None) else (ust.total + st.total)
                        out.append(State(comb_placed, comb_scores, comb_total,
                                         groups=unit_groups + [[n0 + k] for k in range(len(st.placed))]))
                if set_model is not None:
                    set_model(model0)
                all_multistage = bool(units) and all(len(sp.get("stages") or []) >= 2 for sp in units)
                if EXACT_PLACE and scorer is not None and deltas == (0.0,) and polish_starts > 0:
                    out.sort(key=lambda st: -st.total)
                    n_p = min(polish_starts, len(out))
                    polished = []
                    for st in out[:n_p]:
                        # 1. Rigid unit-group polish (moves whole sub-build units cleanly!)
                        p1 = exact_polish(lib, scorer, model0, st, cands, collider=collider)
                        # 2. Per-part polish ONLY when rigid unit fit is imperfect (p1_iou < 0.92),
                        # requiring a strong ModelScorer gain (+400 px for multi-stage verified units,
                        # +150 px otherwise) so noise never tears apart a verified multi-stage unit!
                        p1_iou = view_fit_metrics(lib, model0 + p1.placed, picture, reg.view)[0]
                        if p1_iou < 0.92 and not all_multistage:
                            p2 = exact_polish(lib, scorer, model0, State(p1.placed, p1.scores, p1.total, p1.done, groups=None),
                                              cands, collider=collider, rounds=2)
                            polished.append(p2 if p2.total > p1.total + 150.0 else p1)
                        else:
                            polished.append(p1)
                    out = polished + out[n_p:]
                # Guard against a mis-assembled sub-build panel (or turn-over/preview inset box): compare against
                # loose exact placement whenever step is small (<= 5 parts on in-place steps) OR best unit fit
                # leaves low silhouette IoU! For multi-stage verified units, require loose placement to beat unit
                # by > +400 px so loose scrambling never overwrites a cleanly solved multi-stage sub-build!
                if EXACT_PLACE and scorer is not None:
                    out.sort(key=lambda st: -st.total)
                    best_unit_tot = out[0].total if out else -1e9
                    unit_iou = view_fit_metrics(lib, model0 + _drawn_entries(out[0].placed, out[0].scores), picture, reg.view)[0] if out else 0.0
                    want_loose = (len(all_loose) <= 5 or unit_iou < 0.90) if deltas == (0.0,) else (not all_multistage and (len(all_loose) <= 6 or unit_iou < 0.88))
                    if want_loose:
                        loose_states = solve_step_exact(lib, scene_for, scorer, model0, all_loose, cands, collider=collider,
                                                        beam=max(beam, 8), deltas=deltas, pushes=pushes,
                                                        next_scorer=next_scorer if deltas != (0.0,) else None,
                                                        polish_starts=min(polish_starts, 2))
                        if all_multistage:
                            out.extend(st for st in loose_states[:3] if st.total > best_unit_tot + 400.0)
                        else:
                            out.extend(loose_states[:3])
                out.sort(key=lambda st: -st.total)
                states = out[:max(beam, 8)]
        # Next-step verification ONLY for exploded steps (deltas != (0.0,)): COMBINE step N's drawn score
        # with precision-focused step N+1 seated consistency (never overwrite step N's evidence completely,
        # and skip if NO candidate achieves positive confirmation in step N+1 — e.g. occluded/rotated away!).
        if next_scorer is not None and deltas != (0.0,) and len(states) >= 2 and model0 and scorer is not None:
            raw_eval = []
            for st in states[:6]:
                cur_s = scorer.score(_drawn_entries(st.placed, st.scores))
                nv_score, _nv = _next_step_seat_score(lib, model0, st.placed, reg.view, next_scorer.picture, codes,
                                                      next_scorer=next_scorer)
                raw_eval.append((cur_s, nv_score, st))
            if raw_eval and max(nv for _, nv, _ in raw_eval) > 0.0:
                rescored = []
                for cur_s, nv_score, st in raw_eval:
                    cur_d = cur_s - float(scorer.base_score)
                    nv_eff = max(nv_score, -0.35 * max(0.0, cur_d))
                    comb = cur_s + 1.0 * nv_eff
                    st.total = comb
                    rescored.append((comb, st))
                rescored.sort(key=lambda x: -x[0])
                states = [st for _, st in rescored] + states[6:]
        # V2 NPR layout reranker on in-place close calls (zero-op unless layout-comparator.pt & weight > 0)
        if deltas == (0.0,) and len(states) >= 2 and model0 and EXACT_PLACE:
            from .comparator import layout_patches, layout_weight, loaded_layout
            comp_v2 = loaded_layout()
            if comp_v2 is not None and layout_weight() > 0.0:
                top_k = min(8, len(states))
                top_sts = states[:top_k]
                drawn_list = [_drawn_entries(st.placed, st.scores) for st in top_sts]
                pats = layout_patches(lib, picture.rgb, picture.background, reg.view, model0, drawn_list)
                if pats is not None and len(pats) == top_k:
                    base_arr = np.array([float(st.total) for st in top_sts], dtype=float)
                    blended = comp_v2.blend(base_arr, comp_v2.logits(pats))
                    order_v2 = np.argsort(-blended)
                    reranked = []
                    for idx_r in order_v2:
                        st_r = top_sts[int(idx_r)]
                        st_r.total = float(blended[int(idx_r)])
                        reranked.append(st_r)
                    states = reranked + states[top_k:]
        return states

    def completed(reg, state, scales=(0.98, 1.0, 1.02), subpixel: bool = False):
        """Re-register the completed hypothesis (parts drawn where the picture shows them)."""
        from .place import drawn_pose
        drawn = [(p, c, drawn_pose(sc) if sc is not None else m) for (p, c, m), sc in zip(state.placed, state.scores)]
        full_d = model0 + drawn
        out = register(lib, full_d, picture, codes, reg.view.orientation, reg.view.yaw, reg.view.pitch,
                       reg.view.scale, scale_range=scales, classes=classes, on_ink=on_ink, roll=reg.view.roll,
                       init_offset=reg.view.offset if reg.view.offset != (0.0, 0.0) else None)
        if subpixel and on_ink is not None and full_d:
            iou0, md0, _p0 = view_fit_metrics(lib, full_d, picture, out.view)
            rv = refine_view(lib, full_d, picture, out.view, scale_tol=0.06, outer=2)
            iou1, md1, _p1 = view_fit_metrics(lib, full_d, picture, rv)
            if iou1 >= iou0 - 0.03 and md1 <= md0 + 0.15:
                out = Registration(rv, out.score, out.shape, reg.orientation_index)
        out.orientation_index = reg.orientation_index
        return out

    def evaluate(reg, scales=(0.98, 1.0, 1.02), fixed_camera: bool = False, polish_starts: int = 3,
                 step_budget: float = 18.0, best_so_far: float = -1e9):
        """(completed score, completed registration, states) under one camera hypothesis, or None."""
        states = place_under(reg, polish_starts=polish_starts, step_budget=step_budget)
        if not states or not states[0].placed:
            return None
        if fixed_camera and EXACT_PLACE:
            # Oracle / locked camera: keep exact view; optionally break close beam ties with zero-shot DINOv2!
            norm = max(1.0, float((picture.foreground & ~picture.arrows).sum()))
            if len(states) >= 2:
                dino_w = float(os.environ.get("BOOKLET_SOLVER_DINO_W", "0.65"))
                if dino_w > 0.0:
                    from . import vision_prior
                    if vision_prior.enabled():
                        top_k_f = min(6, len(states))
                        top_sts = states[:top_k_f]
                        top_r = max(float(s.total) for s in top_sts)
                        sec_r = sorted(float(s.total) for s in top_sts)[-2]
                        if (top_r - sec_r) <= 0.18 * norm:
                            drawn_f = [_drawn_entries(s.placed, s.scores) for s in top_sts]
                            d_cur = vision_prior.score_candidate_layouts(lib, model0, drawn_f, picture, reg.view)
                            if d_cur is not None and len(d_cur) == top_k_f:
                                d_adj = d_cur - float(np.mean(d_cur))
                                order_f = sorted(range(top_k_f), key=lambda i: -(float(top_sts[i].total) + dino_w * norm * float(d_adj[i])))
                                states = [top_sts[i] for i in order_f] + states[top_k_f:]
            sc_norm = float(states[0].total) / norm
            return sc_norm, Registration(reg.view, sc_norm, classes.shape, reg.orientation_index), states
        reg2 = completed(reg, states[0], scales, subpixel=bool(deltas == (0.0,) and len(base) >= 3))
        # the picture shows the model AFTER the step: registering the model before it lets the new
        # parts' silhouette pull the camera off. Alternate placement and completed re-registration.
        for _round in range(ROUNDS if REREGISTER else 0):
            # Only compare Aligner score against Aligner best (never against ModelScorer final_score!)
            moved = np.hypot(reg2.view.offset[0] - reg.view.offset[0], reg2.view.offset[1] - reg.view.offset[1])
            scale_d = abs(reg2.view.scale - reg.view.scale) / max(reg.view.scale, 1e-6)
            if not (moved > 1.0 or scale_d > 0.008 or abs(reg2.view.yaw - reg.view.yaw) > 1 or abs(reg2.view.pitch - reg.view.pitch) > 1):
                break
            states2 = place_under(reg2, polish_starts=(0 if polish_starts <= 1 else min(polish_starts, 2)), step_budget=step_budget * 0.6)
            if not states2 or not states2[0].placed:
                break
            reg3 = completed(reg2, states2[0], scales, subpixel=bool(deltas == (0.0,) and len(base) >= 3))
            if reg3.score < reg2.score - 0.03:
                break
            reg, reg2, states = reg2, reg3, states2
        if EXACT_PLACE:
            # On small early bases (0, 1, or 2 parts: e.g. frame-free step 1, 40350 s25 lone 6x6 plate,
            # 41488 s2 2-plate base), registering `model0` alone shifts the offset toward the combined
            # silhouette! Re-center top candidate states via `completed()` so physically connected true
            # layouts are aligned accurately instead of losing to shifted/flush poses!
            if len(base) <= 2 and len(states) >= 2:
                from .exact_place import _non_ortho_penalty
                from .place import drawn_pose
                recentered = []
                n_rc = 10 if len(base) <= 1 else 6
                # Allow a wider scale search on 1-2 part bases (e.g. zoomed baseplate step 40350 s25!);
                # Aligner can still prefer a slightly shrunken scale, so also test 1.08x directly on ModelScorer!
                rc_scales = (0.96, 1.0, 1.04, 1.08, 1.12) if (1 <= len(base) <= 2) else scales
                exploded_s1 = (not base) and (deltas != (0.0,))
                step_arrow_axes = picture.arrow_axes() if exploded_s1 else []
                rc_fp = 0.0 if exploded_s1 else None
                for st in states[:n_rc]:
                    rc = completed(reg, st, rc_scales)
                    best_rc_item = None
                    try_views = [rc]
                    if len(base) == 1 and rc.view.scale < scale * 1.04:
                        rc_hi = completed(reg, st, (1.06, 1.10, 1.14))
                        try_views.append(rc_hi)
                    # Physical multi-stud seating tie-breaker for tiny 1-2 part SEATED bases (prevents an
                    # overhanging corner plate like 40350 s25 4477 mating 3 studs from beating a 6-stud seat).
                    # On exploded Step-1 diagrams, skip mates bonus for pure floated/flush pairs, while
                    # penalising incoherent mixed states that combine a mated stud part with a disconnected
                    # flush part (e.g. 41620 s1 placing one 3623 on studs and the twin 3623 disconnected!).
                    has_float = any(s is not None and (s.delta > 0.0 or s.move is not None) for s in st.scores)
                    n_fl_st = sum(1 for s in st.scores if s is not None and isinstance(s.candidate, dict) and s.candidate.get("kind") == "flush")
                    mixed_flush_pen = 0.25 if (0 < n_fl_st < len(st.scores)) else 0.0
                    rc_mates_bonus = 0.0
                    if (not (exploded_s1 and has_float)
                            and collider is not None and getattr(collider, "native", None) is not None and model0 and st.placed):
                        collider.set_model(model0)
                        _mc, _mconn, m_cnt, _mg = collider.layout_check(st.placed)
                        rc_mates_bonus = 0.015 * min(int(m_cnt), 8)
                    for rc_v in try_views:
                        sc_rc = ModelScorer(lib, model0, picture, rc_v.view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts)
                        drawn_rc = _drawn_entries(st.placed, st.scores)
                        val_rc = float(sc_rc.score(drawn_rc))
                        val_rc -= sum(_non_ortho_penalty(s.candidate if s else None, m_i, flush_penalty=rc_fp)
                                      for (_p, _c, m_i), s in zip(st.placed, st.scores))
                        norm_rc = max(1.0, float(sc_rc.fg.sum() + sc_rc.ink_fg.sum()))
                        rc_iou = float(view_fit_metrics(lib, model0 + drawn_rc, picture, rc_v.view)[0])
                        # On exploded Step-1 diagrams with red arrows, reward floating displacements whose
                        # 2D image vector aligns with an actual red arrow direction (separates horizontal flush
                        # push along Z from vertical 1-stud lift along Y that projects to the same 2D silhouette!).
                        arrow_bonus = 0.0
                        if step_arrow_axes and has_float:
                            als = []
                            for (_p, _c, m_i), s in zip(st.placed, st.scores):
                                if s is not None and (s.delta > 0.0 or s.move is not None):
                                    dm = drawn_pose(s)
                                    pts2 = rc_v.view.project(np.stack([np.asarray(dm, float)[:3, 3], np.asarray(m_i, float)[:3, 3]]))
                                    v2 = pts2[0, :2] - pts2[1, :2]
                                    vn = float(np.linalg.norm(v2))
                                    if vn > 4.0:
                                        u2 = v2 / vn
                                        als.append(max(abs(float(np.dot(u2, ax))) for ax, _ln in step_arrow_axes))
                            if als:
                                arrow_bonus = 0.08 * float(np.mean(als))
                        # Combine ModelScorer with silhouette IoU on tiny 1-2 part bases for ranking
                        # (so a true high-IoU upright layout beats a mismatched overdraw), while keeping
                        # unbiased `val_rc / norm_rc + 1.0` in `reg2.score` for SectionCamera continuity!
                        unbiased_rc = val_rc / norm_rc + 1.0
                        comb_rc = unbiased_rc + 0.50 * rc_iou + rc_mates_bonus + arrow_bonus - mixed_flush_pen
                        item_rc = (comb_rc, unbiased_rc, rc_v, st)
                        if best_rc_item is None or item_rc[0] > best_rc_item[0]:
                            best_rc_item = item_rc
                    recentered.append(best_rc_item)
                recentered.sort(key=lambda x: -x[0])
                # Apples-to-apples guard: noisy Aligner scale/offset jumps on individual `completed(st)`
                # calls can penalise the true layout (e.g. 40271 s2 jumping 1.00->1.04 and losing 0.04 IoU!).
                # Also score every candidate state on the single best recentered view `best_rcv` and keep
                # whichever view explains that state better!
                best_rcv = recentered[0][2]
                sc_shared = ModelScorer(lib, model0, picture, best_rcv.view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts)
                norm_sh = max(1.0, float(sc_shared.fg.sum() + sc_shared.ink_fg.sum()))
                for idx_rc in range(1, len(recentered)):
                    cr_i, ur_i, rcv_i, st_i = recentered[idx_rc]
                    drawn_sh = _drawn_entries(st_i.placed, st_i.scores)
                    val_sh = float(sc_shared.score(drawn_sh))
                    val_sh -= sum(_non_ortho_penalty(s.candidate if s else None, m_i, flush_penalty=rc_fp)
                                  for (_p, _c, m_i), s in zip(st_i.placed, st_i.scores))
                    iou_sh = float(view_fit_metrics(lib, model0 + drawn_sh, picture, best_rcv.view)[0])
                    has_fl_i = any(s is not None and (s.delta > 0.0 or s.move is not None) for s in st_i.scores)
                    n_fl_i = sum(1 for s in st_i.scores if s is not None and isinstance(s.candidate, dict) and s.candidate.get("kind") == "flush")
                    m_pen_i = 0.25 if (0 < n_fl_i < len(st_i.scores)) else 0.0
                    mb_i = 0.0
                    if (not (exploded_s1 and has_fl_i)
                            and collider is not None and getattr(collider, "native", None) is not None and model0 and st_i.placed):
                        collider.set_model(model0)
                        mb_i = 0.015 * min(int(collider.layout_check(st_i.placed)[2]), 8)
                    unb_sh = val_sh / norm_sh + 1.0
                    comb_sh = unb_sh + 0.50 * iou_sh + mb_i - m_pen_i
                    if comb_sh > cr_i:
                        recentered[idx_rc] = (comb_sh, unb_sh, best_rcv, st_i)
                recentered.sort(key=lambda x: -x[0])
                # On 1-2 part bases (including arrowed step-2 pages like 40271 s2!), break close
                # recentering ties with FoundPose DINOv2 (on drawn renders) + BrickPriorNet v3 (on seated poses)!
                if len(base) >= 1 and len(recentered) >= 2 and (recentered[0][0] - recentered[1][0]) < 0.16:
                    top_k_rc = min(6, len(recentered))
                    top_rc = recentered[:top_k_rc]
                    bonus_rc = np.zeros(top_k_rc, dtype=np.float64)
                    from . import brick_prior, vision_prior
                    bp_rc = brick_prior.prior()
                    if bp_rc is not None:
                        try:
                            bp_v = bp_rc.score_layouts_batch(model0, [x[3].placed for x in top_rc], max_neighbors=4, radius=95.0)
                            n_p_rc = max(1, len(top_rc[0][3].placed))
                            bonus_rc += np.clip(0.020 * (bp_v - float(np.mean(bp_v))) / n_p_rc, -0.04, 0.04)
                        except Exception:
                            pass
                    if vision_prior.enabled():
                        perc_rc = vision_prior.perceptor()
                        if perc_rc is not None:
                            try:
                                bg_rc = tuple(int(round(v)) for v in picture.background)
                                fg_rc = picture.foreground & ~picture.arrows
                                ren_rc = []
                                focus_rc = np.zeros(picture.rgb.shape[:2], dtype=bool)
                                for _cr, _ur, rcv_i, st_i in top_rc:
                                    full_i = list(model0) + _drawn_entries(st_i.placed, st_i.scores)
                                    rgb_i, _d_i, lab_i = vision_prior.render_npr_rgb(lib, full_i, rcv_i.view, picture.rgb.shape[:2], bg=bg_rc)
                                    ren_rc.append(rgb_i)
                                    focus_rc |= (lab_i >= len(model0))
                                d_rc = perc_rc.score_renders(picture.rgb, fg_rc, bg_rc, ren_rc,
                                                             focus_mask=focus_rc if focus_rc.any() else None)
                                if len(d_rc) == top_k_rc:
                                    bonus_rc += 0.55 * (d_rc - float(np.mean(d_rc)))
                            except Exception:
                                pass
                    ord_rc = sorted(range(top_k_rc), key=lambda i: -(top_rc[i][0] + float(bonus_rc[i])))
                    recentered = [top_rc[i] for i in ord_rc] + recentered[top_k_rc:]
                final_rank, unbiased_score, reg2, _best_st = recentered[0]
                # Tag each recentered state with its own aligned view so Step-1 early_branches keep exact views
                for _cr, _ur, rcv_i, st_i in recentered:
                    st_i._rc_view = rcv_i.view
                    st_i._rc_score = float(_ur)
                states = [x[3] for x in recentered] + states[n_rc:]
                reg2 = Registration(reg2.view, unbiased_score, reg2.shape, reg2.orientation_index)
                return final_rank, reg2, states
            # Rank all top candidate states under reg2.view using our unbiased fixed-camera ModelScorer,
            # preserving FLOAT_PENALTY, non-ortho penalty, AND verified next-step seated consistency on
            # exploded steps (so evaluate() never erases next_scorer from place_under()!)
            from .exact_place import _float_cost, _hidden_backside_penalty, _non_ortho_penalty, _physical_bonus
            scorer2 = ModelScorer(lib, model0, picture, reg2.view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts)
            ns2 = (_make_next_scorer(lib, model0, reg2.view, next_rgb, next_pts, codes)
                   if (next_rgb is not None and deltas != (0.0,) and len(states) >= 2 and model0) else None)
            raw_s2 = []
            for st in states[:max(RERANK, 6)]:
                drawn = _drawn_entries(st.placed, st.scores)
                if deltas == (0.0,):
                    cur_s2, vis_s2 = scorer2.score_and_vis(drawn)
                    hid_s2 = _hidden_backside_penalty(lib, scorer2, st.placed, vis_s2)
                    mat_s2 = _physical_bonus(collider, model0, st.placed)
                else:
                    cur_s2 = float(scorer2.score(drawn))
                    hid_s2, mat_s2 = 0.0, 0.0
                pen_s2 = hid_s2 - mat_s2 + sum(
                    (_float_cost(float(s.delta)) if s is not None else 0.0)
                    + _non_ortho_penalty(s.candidate if s else None, m_i)
                    for (_p, _c, m_i), s in zip(st.placed, st.scores)
                )
                nv_s2 = float(ns2.score_seated_in_next(st.placed)) if ns2 is not None else 0.0
                raw_s2.append((cur_s2, cur_s2 - pen_s2, nv_s2, st))
            use_nv2 = ns2 is not None and any(nv > 0.0 for _, _, nv, _ in raw_s2)
            scored_states = []
            for cur_s2, adj_s2, nv_s2, st in raw_s2:
                cur_d2 = cur_s2 - float(scorer2.base_score)
                rank_s2 = adj_s2 + (1.0 * max(nv_s2, -0.35 * max(0.0, cur_d2)) if use_nv2 else 0.0)
                st.total = rank_s2
                scored_states.append((rank_s2, cur_s2, st, adj_s2))
            if len(scored_states) >= 2:
                dino_w = float(os.environ.get("BOOKLET_SOLVER_DINO_W", "0.65"))
                if dino_w > 0.0:
                    from . import vision_prior
                    if vision_prior.enabled():
                        norm_d = max(1.0, float(scorer2.fg.sum() + scorer2.ink_fg.sum()))
                        top_r = max(x[0] for x in scored_states)
                        close_r = sorted(x[0] for x in scored_states)[-2]
                        if (top_r - close_r) <= 0.18 * norm_d:
                            drawn_list = [_drawn_entries(st.placed, st.scores) for _, _, st, _ in scored_states]
                            d_cur = vision_prior.score_candidate_layouts(lib, model0, drawn_list, picture, reg2.view)
                            if d_cur is not None and len(d_cur) == len(scored_states):
                                d_adj = d_cur - float(np.mean(d_cur))
                                # On exploded steps with verified next-step view, also check SEATED DINOv2 in step N+1!
                                if use_nv2 and ns2 is not None:
                                    d_nxt = vision_prior.score_candidate_layouts(
                                        lib, model0, [st.placed for _, _, st, _ in scored_states], ns2.picture, ns2.view
                                    )
                                    if d_nxt is not None and len(d_nxt) == len(scored_states):
                                        d_adj = 0.65 * d_adj + 0.35 * (d_nxt - float(np.mean(d_nxt)))
                                scored_states = [
                                    (float(scored_states[i][0] + dino_w * norm_d * float(d_adj[i])),
                                     scored_states[i][1], scored_states[i][2], scored_states[i][3])
                                    for i in range(len(scored_states))
                                ]
                                for rank_s2, _cur, st, _adj in scored_states:
                                    st.total = rank_s2
            if deltas == (0.0,) and len(scored_states) >= 2:
                from .comparator import layout_patches, layout_weight, loaded_layout
                comp_v2 = loaded_layout()
                if comp_v2 is not None and layout_weight() > 0.0:
                    drawn_list = [_drawn_entries(st.placed, st.scores) for _, _, st, _ in scored_states]
                    pats = layout_patches(lib, picture.rgb, picture.background, reg2.view, model0, drawn_list)
                    if pats is not None and len(pats) == len(scored_states):
                        base_arr = np.array([x[0] for x in scored_states], dtype=float)
                        blended = comp_v2.blend(base_arr, comp_v2.logits(pats))
                        scored_states = [(float(blended[i]), scored_states[i][1], scored_states[i][2], scored_states[i][3])
                                         for i in range(len(scored_states))]
                        for rank_s2, _cur, st, _adj in scored_states:
                            st.total = rank_s2
            scored_states.sort(key=lambda x: -x[0])
            states = [st for _, _, st, _ in scored_states] + states[max(RERANK, 6):]
            norm = max(1.0, float(scorer2.fg.sum() + scorer2.ink_fg.sum()))
            # Cross-hypothesis ranking includes float/hidden/non-ortho penalties (`adj_s2`) so a bogus
            # rotated camera cheating by floating 5 parts 120 LDU across the page can NEVER beat the true
            # seated camera (e.g. 40348 s37!), while `reg2.score` keeps unbiased `cur_s2` for SectionCamera!
            final_unbiased = float(scored_states[0][1]) / norm + 1.0
            final_rank = float(scored_states[0][3]) / norm + 1.0
            reg2 = Registration(reg2.view, final_unbiased, reg2.shape, reg2.orientation_index)
            return final_rank, reg2, states
        # Legacy Aligner re-rank path (when BOOKLET_SOLVER_EXACT=0)
        for k in range(1, min(RERANK, len(states))):
            alt = completed(reg, states[k], scales)
            if alt.score > reg2.score + 1e-9:
                reg2, states = alt, [states[k]] + states[:k] + states[k + 1:]
        if POLISH and deltas == (0.0,):
            better = polish_state(reg2.view, states[0])
            if better is not states[0]:
                reg3 = completed(reg, better, scales)
                if reg3.score >= reg2.score - 1e-9:
                    reg2, states = reg3, [better] + states
        return reg2.score, reg2, states

    def polish_state(view, state):
        aligner_codes = codes

        def score(model):
            return float(Aligner(lib, model, classes, aligner_codes, on_ink=on_ink).evaluate(view)[0])

        def scene_of(model):
            scene = Scene.build(lib, model, view, classes, codes, ink_dist)
            scene.picture = picture
            return scene

        def shortlist(entries, model):
            if len(entries) == 1:
                part, colour, _m = entries[0]
                cands = distinct(lib, part, candidates(lib, part, model))
                if not cands:
                    return []
                scored = score_candidates(lib, scene_of(model), part, colour, cands, deltas=(0.0,))
                scored.sort(key=lambda sc: -sc.score)
                return [([(part, colour, sc.candidate["matrix"])], [sc]) for sc in scored[:POLISH_K]]
            # a unit copy: every placement that seats one of its parts on a candidate, the rest rigidly with it
            m0inv = np.linalg.inv(entries[0][2])
            config = [(q, c, m0inv @ m) for q, c, m in entries]
            options = {}
            for q, _c, rel in config:
                inv = np.linalg.inv(rel)
                for cand in candidates(lib, q, model):
                    t = np.asarray(cand["matrix"], float) @ inv
                    key = tuple(np.round(t[:3, :4], 1).ravel())
                    if key not in options:
                        options[key] = [(qq, cc, t @ r) for qq, cc, r in config]
            if not options:
                return []
            scene = scene_of(model)
            ranked = []
            for world in options.values():
                ss = [score_candidates(lib, scene, qq, cc, [{"matrix": m}], deltas=(0.0,))[0] for qq, cc, m in world]
                ranked.append((sum(x.score for x in ss), world, ss))
            ranked.sort(key=lambda r: -r[0])
            return [(world, ss) for _t, world, ss in ranked[:POLISH_K]]

        hits = (lambda part, matrix, _model: collider.hits(part, matrix)) if collider is not None else None
        out = polish(model0, state, shortlist, score, collides=hits,
                     overlaps=lambda a, b: _boxes_overlap(lib, a, b))
        return out

    results = []
    search_free = True
    n_expected_parts = len(parts) + sum(len(sp["per_copy"]) * sp["count"] for sp in units)
    if held is not None:
        is_fixed = camera is not None and camera[2] <= -1e8
        is_lookahead = camera is not None and (-1e8 < camera[2] <= -1e5)
        r = evaluate(
            held, scales=(1.0,), fixed_camera=is_fixed,
            polish_starts=(0 if is_lookahead else 3),
            step_budget=(4.0 if is_lookahead else 18.0),
        )
        if r is not None:
            held_ok_iou = 0.0
            if not is_fixed and not is_lookahead and len(r[2][0].placed) == n_expected_parts and r[1].view is not None:
                held_ok_iou = float(view_fit_metrics(
                    lib, model0 + _drawn_entries(r[2][0].placed, r[2][0].scores), picture, r[1].view
                )[0])
            # Lock onto held section camera when model0's pre-placement Aligner fit is strong (held.score >= 1.10;
            # empirically 15/15 true booklet turns across EVAL6 have held.score <= 1.012!) AND completed fit is
            # tight (IoU >= 0.93, all parts placed, no severe score collapse). Prevents both false 5x free-search
            # slowdowns and false 90/180-deg boxy orientation flips when black/arrowed steps dip completed score!
            held_locked = (
                (not is_fixed)
                and (not is_lookahead)
                and len(base) >= 6
                and len(r[2][0].placed) == n_expected_parts
                and float(held.score) >= 1.10
                and held_ok_iou >= 0.93
                and r[0] >= expect - 0.20
                and r[0] >= 1.25
            )
            search_free = (not is_fixed) and (not is_lookahead) and (not held_locked) and (r[0] < expect - HOLD_DROP)
            # Only grant full HOLD_DROP inertia when model0's pre-placement Aligner score still matches
            # the page (`held.score >= 1.05`); when `held.score < 1.05`, the booklet almost certainly
            # turned the model (15/15 true turns across EVAL6 had held.score <= 1.012!), so apply only
            # tiny +0.02 tie-break slack instead of blocking the true 90/180-deg turn!
            hold_slack = HOLD_DROP if float(held.score) >= 1.05 else 0.02
            results.append((r[0] + (hold_slack if search_free else 0.0), r[1], r[2]))
    hypotheses = free_hypotheses() if search_free else []
    free_polish = 1 if len(hypotheses) > 1 else 3
    free_budget = 6.5 if len(hypotheses) > 1 else 18.0
    orig_beam = beam
    if len(hypotheses) > 1:
        beam = min(beam, 5)
    best_hyp_sc = results[0][0] if results else -1e9
    for hi_idx, reg in enumerate(hypotheses):
        # Safe fast exit ONLY after all 4 upright hypotheses have been tested (hi_idx >= 4), skipping
        # upside-down orientations when an upright hypothesis already locked >= 0.96 IoU and >= 1.65 score!
        if hi_idx >= 4 and len(base) >= 12 and reg.orientation_index not in UPRIGHT and results:
            top_r0 = max(results, key=lambda x: x[0])
            if len(top_r0[2][0].placed) == n_expected_parts and top_r0[0] >= 1.65:
                top_iou0 = float(view_fit_metrics(
                    lib, model0 + _drawn_entries(top_r0[2][0].placed, top_r0[2][0].scores), picture, top_r0[1].view
                )[0])
                if top_iou0 >= 0.96:
                    break
        r = evaluate(reg, polish_starts=free_polish, step_budget=free_budget, best_so_far=best_hyp_sc)
        if r is not None:
            results.append(r)
            if r[0] > best_hyp_sc:
                best_hyp_sc = r[0]
    beam = orig_beam
    if not results:
        reg = held if held is not None else (hypotheses or free_hypotheses())[0]
        return StepResult(seeded, [None] * len(seeded), reg.view, reg.score, pre_iou, status="no candidates")
    # pick the hypothesis whose completed model explains the picture best (strong upright bonus ONLY for
    # tiny 1-2 part symmetric flat baseplates like 40350 s25; gentle tie-breaker once len(base) >= 3 so
    # genuine upside-down steps like 40350 s27 aren't blocked by stacked HOLD_DROP + up_bonus!)
    up_bonus = 0.20 if len(base) <= 2 else 0.02
    ranked_res = sorted(results, key=lambda r: -(r[0] + (up_bonus if r[1].orientation_index in UPRIGHT else 0.0)))
    # DINOv2 cross-hypothesis camera orientation tie-breaker when top-2 orientations are close!
    if len(ranked_res) >= 2 and len(base) >= 3:
        top_h = ranked_res[0][0] + (up_bonus if ranked_res[0][1].orientation_index in UPRIGHT else 0.0)
        sec_h = ranked_res[1][0] + (up_bonus if ranked_res[1][1].orientation_index in UPRIGHT else 0.0)
        dino_hw = float(os.environ.get("BOOKLET_SOLVER_DINO_HYP_W", "0.35"))
        if dino_hw > 0.0 and (top_h - sec_h) < 0.14:
            from . import vision_prior
            perc = vision_prior.perceptor()
            if perc is not None:
                top_k_h = ranked_res[:min(4, len(ranked_res))]
                bg = tuple(int(round(v)) for v in picture.background)
                fg = picture.foreground & ~picture.arrows
                ren_h = [
                    vision_prior.render_npr_rgb(
                        lib, model0 + _drawn_entries(r[2][0].placed, r[2][0].scores), r[1].view, picture.rgb.shape[:2], bg=bg
                    )[0]
                    for r in top_k_h
                ]
                d_h = perc.score_renders(picture.rgb, fg, bg, ren_h)
                if len(d_h) == len(top_k_h):
                    d_adj_h = d_h - float(np.mean(d_h))
                    reranked_h = sorted(
                        range(len(top_k_h)),
                        key=lambda idx_h: -(
                            top_k_h[idx_h][0]
                            + (up_bonus if top_k_h[idx_h][1].orientation_index in UPRIGHT else 0.0)
                            + dino_hw * float(d_adj_h[idx_h])
                        ),
                    )
                    ranked_res = [top_k_h[i] for i in reranked_h] + ranked_res[len(top_k_h):]
    score, reg, states = ranked_res[0]
    score = reg.score
    best: State = states[0]
    # Collect top distinct early branches: FIRST take the best state from each distinct camera
    # orientation (reserving at least 2 slots for UPRIGHT orientations when upright was searched,
    # plus top overall orientations — resolves 90/180-deg and upright/inverted early base flips!).
    early_branches = []
    if len(model0) <= 10:
        seen_eb = set()
        if not base:
            # Frame-free Step 1: 4 quarter-turns of the single seeded part are rigidly equivalent.
            # Instead of repeating rank_idx 0..1 across 4 orientations, collect distinct rigid seated
            # shapes from the winning hypothesis's top states — explicitly preserving BOTH top `flush`
            # (side-by-side) AND top non-`flush` (stacked/mated) geometries so Step 2 resolves any
            # 2D arrow-ray ambiguity cleanly!
            from .subbuild import _turn
            def _rigid_sig(pl_entries: list):
                best_k = None
                for k_r in range(4):
                    tk = _turn(k_r)
                    pts_k = tuple(sorted(
                        (p, c, tuple(np.round((tk @ np.asarray(m, float))[:3, 3], 1)),
                         tuple(np.round((tk @ np.asarray(m, float))[:3, :3].ravel(), 1)))
                        for p, c, m in pl_entries
                    ))
                    if best_k is None or pts_k < best_k:
                        best_k = pts_k
                return best_k
            def _is_flush_st(st_f: State) -> bool:
                return any(s is not None and isinstance(s.candidate, dict) and s.candidate.get("kind") == "flush" for s in st_f.scores)
            win_reg, win_states = ranked_res[0][1], ranked_res[0][2]
            top_pool = win_states[:10]
            ordered_s1 = []
            if top_pool:
                ordered_s1.append(top_pool[0])
                fl_pool = [st_i for st_i in top_pool if _is_flush_st(st_i)]
                non_fl_pool = [st_i for st_i in top_pool if not _is_flush_st(st_i)]
                ordered_s1.extend(fl_pool[:2])
                ordered_s1.extend(non_fl_pool[:2])
                ordered_s1.extend(top_pool)
            for st_i in ordered_s1:
                pl_i = seeded + list(st_i.placed)
                eb_key = _rigid_sig(pl_i)
                if eb_key in seen_eb:
                    continue
                seen_eb.add(eb_key)
                v_i = getattr(st_i, "_rc_view", win_reg.view)
                sc_i = float(getattr(st_i, "_rc_score", win_reg.score))
                early_branches.append((pl_i, [None] * len(seeded) + list(st_i.scores), v_i, win_reg.orientation_index, sc_i))
                if len(early_branches) >= 6:
                    break
        elif len(base) == 1:
            # On 1-part symmetric bases (e.g. 6x6 display stand plate 3958 on step 2), 90-deg rotated
            # views of the same placement are rigidly identical; deduplicate by rigid 3D shape of
            # `base + pl_i` up to 90-deg Y-turns so genuinely distinct placements (`rank_idx = 0..3`)
            # enter `early_branches` for step 3 disambiguation instead of 4 copies of `state[0]`!
            from .subbuild import _turn
            def _rigid_sig1(full_entries: list):
                best_k = None
                for k_r in range(4):
                    tk = _turn(k_r)
                    pts_k = tuple(sorted(
                        (p, c, tuple(np.round((tk @ np.asarray(m, float))[:3, 3], 1)),
                         tuple(np.round((tk @ np.asarray(m, float))[:3, :3].ravel(), 1)))
                        for p, c, m in full_entries
                    ))
                    if best_k is None or pts_k < best_k:
                        best_k = pts_k
                return best_k
            up_res = [r for r in ranked_res if r[1].orientation_index in UPRIGHT]
            eb_hyps = up_res[:4] if up_res else list(ranked_res[:4])
            for rank_idx in (0, 1, 2, 3):
                for _rsc, r_reg, r_states in eb_hyps:
                    if rank_idx >= len(r_states):
                        continue
                    st_i = r_states[rank_idx]
                    pl_i = seeded + list(st_i.placed)
                    eb_key = _rigid_sig1(list(base) + pl_i)
                    if eb_key in seen_eb:
                        continue
                    seen_eb.add(eb_key)
                    v_i = getattr(st_i, "_rc_view", r_reg.view)
                    sc_i = float(getattr(st_i, "_rc_score", r_reg.score))
                    early_branches.append((pl_i, [None] * len(seeded) + list(st_i.scores), v_i, r_reg.orientation_index, sc_i))
                    if len(early_branches) >= 6:
                        break
                if len(early_branches) >= 6:
                    break
        else:
            up_res = [r for r in ranked_res if r[1].orientation_index in UPRIGHT]
            eb_hyps = list(ranked_res[:4])
            if up_res and sum(1 for r in eb_hyps if r[1].orientation_index in UPRIGHT) < 2:
                eb_hyps = up_res[:2] + [r for r in ranked_res if r not in up_res[:2]][:2]
            for rank_idx in (0, 1):
                for r_sc, r_reg, r_states in eb_hyps:
                    if rank_idx >= len(r_states):
                        continue
                    st_i = r_states[rank_idx]
                    pl_i = seeded + list(st_i.placed)
                    eb_key = (r_reg.orientation_index, frozenset(
                        (p, c, tuple(np.round(np.asarray(m, float)[:3, 3], 1)),
                         tuple(np.round(np.asarray(m, float)[:3, :3].ravel(), 1)))
                        for p, c, m in pl_i
                    ))
                    if eb_key in seen_eb:
                        continue
                    seen_eb.add(eb_key)
                    early_branches.append((pl_i, [None] * len(seeded) + list(st_i.scores), r_reg.view, r_reg.orientation_index, float(r_reg.score)))
                    if len(early_branches) >= 6:
                        break
                if len(early_branches) >= 6:
                    break
    from .candidates import clean_matrix
    placed_clean = [(p, c, clean_matrix(m)) for p, c, m in (seeded + best.placed)]
    return StepResult(placed_clean, [None] * len(seeded) + best.scores, reg.view, reg.score, pre_iou,
                      alternatives=states[1:], completed=float(score), hypotheses=[float(r[0]) for r in results],
                      orientation_index=reg.orientation_index, state_total=float(best.total),
                      early_branches=early_branches)


ALONE = os.environ.get("BOOKLET_SOLVER_ALONE", "1") != "0"
LOOKAHEAD = os.environ.get("BOOKLET_SOLVER_LOOKAHEAD", "1") != "0"
LOOK_TOP = 3              # beam states tried under the next step
LOOK_GAP = float(os.environ.get("BOOKLET_SOLVER_LOOK_GAP", "0.05"))   # only when the runner-up is this close (share of the top total)
LOOK_WIN = float(os.environ.get("BOOKLET_SOLVER_LOOK_WIN", "0.02"))   # next-step completed score a switch must gain


def lookahead(lib, base: list, result: StepResult, next_parts: list[tuple[str, int]], next_rgb, next_pts,
              collider=None, subbuilds=None) -> StepResult:
    """Pick among a step's closest answers by the next step's picture. A side-stud brick facing the wrong
    way, or a part hidden in the wrong place, looks alike in its own picture; the next picture draws what
    attaches to it, and the next step solves only on the right answer. Each of the top states gets the
    next step solved on it (under this step's camera); the one whose completed next model explains the next
    picture best is kept. Run when the runner-up is within LOOK_GAP of the top state OR a part is heavily occluded."""
    if not LOOKAHEAD or next_rgb is None or not next_parts or len(next_parts) > 6 or subbuilds or not result.alternatives or result.view is None:
        return result
    if any(sc is None for sc in result.scores):        # a seeded (frame-free) first part
        return result
    top_total = float(result.state_total) if result.state_total else sum(sc.score for sc in result.scores)
    top = State(list(result.placed), list(result.scores), top_total)
    states = [top] + [st for st in result.alternatives[:LOOK_TOP - 1]]
    occluded = any(sc is not None and sc.changed < 35 for sc in result.scores)
    close = abs(top.total - states[1].total) <= LOOK_GAP * max(1.0, abs(top.total))
    if not (close or occluded):
        return result
    # Register next_rgb locally around this step's camera without triggering a full 4-hypothesis camera search
    camera = (result.view, result.orientation_index, -1e6)
    judged = []
    for st in states:
        r = solve(lib, base + st.placed, next_parts, next_rgb, next_pts, collider=collider,
                  beam=4, camera=camera)
        judged.append(r.completed if r.placed and len(r.placed) == len(next_parts) else -np.inf)
    result.look = list(judged)
    k = int(np.argmax(judged))
    if k == 0 or judged[k] <= judged[0] + max(LOOK_WIN, 1e-6):
        return result
    best = states[k]
    rest = [st for j, st in enumerate(states) if j != k] + result.alternatives[LOOK_TOP - 1:]
    return StepResult(best.placed, best.scores, result.view, result.registration, result.fit_iou,
                      alternatives=rest, status=result.status, completed=result.completed,
                      hypotheses=result.hypotheses, orientation_index=result.orientation_index,
                      look=list(judged), state_total=float(best.total))


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
