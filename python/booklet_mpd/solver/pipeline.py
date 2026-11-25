"""Free-run reconstruction: booklet PDF -> MPD, from the PDF alone (no answer key, no OMR).

1. Extract the booklet (steps, callouts, parts list) with `instructions_pdf.extract`.
2. Read each step's new parts (`parts.read_parts`: callout pictures matched to the printed parts
   list, element ids to LDraw parts through the cached Rebrickable inventories). A booklet without a
   parts list falls back to the set's Rebrickable inventory (set number read off the cover), its
   pictures rendered from the LDraw parts.
3. Walk the steps in order, keeping one model in one frame: each step re-registers the model so far
   to its picture and places the new parts (`step.solve`). Substep panels have no pictures of their
   own in the extract, so their callout parts are placed against the main picture. "Nx" repeats are
   recorded in the report (one copy is placed: compound placement of repeated sub-assemblies is not
   implemented).
4. Score each part with the confidence combiner and write an MPD with real STEPs, flags on parts
   below the threshold and an INCOMPLETE marker from the first step that is either an operational
   give-up or an unsupported construction (repeats). Review-required uncertainty (unresolved or
   unread parts) is listed separately. A run without these markers is NOT verified correct.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .confidence import part_confidence

# A step "gave up" when its post-placement fit is this poor or nothing could be placed; the model
# after it is still built (later steps may recover) but is marked INCOMPLETE from there.
GIVE_UP_IOU = 0.35
SWITCH_IOU_THRESH = 0.62       # below this post-placement IoU (or on an area drop), check standalone start / assembly switch
SWITCH_IOU_GAIN = 0.14         # another assembly (or standalone start) must beat current IoU by at least this
AREA_DROP_RATIO = 0.68         # foreground LDU^2 shrinking below this ratio always checks standalone start / switch
BACKTRACK_IOU_THRESH = 0.76    # below this post-placement IoU, check 1-step backtracking on previous beam alternatives
BACKTRACK_IOU_GAIN = 0.05      # backtracking switch must gain at least this much IoU


def _fg_area_ldu2(rgb: np.ndarray | None, pts: float | None) -> float:
    """Scale-normalised foreground area (in LDU^2, arrows excluded) of a step picture."""
    if rgb is None:
        return 0.0
    from ..viewfit import BOOKLET_SCALE
    from .picture import Picture
    sc = BOOKLET_SCALE / pts if pts else 1.0
    pic = Picture.from_rgb(rgb, pts, sc if pts else None)
    return float(np.count_nonzero(pic.foreground & ~pic.arrows)) / max(sc * sc, 1e-6)


def _post_fit_iou(lib, model_parts: list, rgb: np.ndarray | None, pts: float | None, view,
                  placed: list | None = None, scores: list | None = None) -> float:
    """Bidirectional silhouette IoU of the completed assembly (using DRAWN poses for exploded parts!)
    against the step picture."""
    if rgb is None or view is None:
        return 0.0
    from ..viewfit import BOOKLET_SCALE
    from .exact_place import _drawn_entries
    from .picture import Picture
    from .register import view_fit_metrics
    drawn = list(model_parts) + (_drawn_entries(placed, scores) if (placed and scores is not None) else list(placed or []))
    if not drawn:
        return 0.0
    pic = Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None)
    iou, _md, _p90 = view_fit_metrics(lib, drawn, pic, view)
    return float(iou)


def _attach_assembly(lib, host_parts: list, sub_parts: list, rgb: np.ndarray, pts: float | None,
                     collider=None, camera_prior=None):
    """Rigidly attach a completed standalone `sub_parts` assembly onto `host_parts` using connector
    candidates (including self-symmetries of symmetric connector parts!) + exact collision + `ModelScorer`,
    returning `(T_4x4, view, iou, host_alone_iou, completed)` or None.
    Works for e.g. placing a BrickHeadz figure or side props onto a display stand."""
    if not host_parts or not sub_parts or rgb is None:
        return None
    from ..viewfit import BOOKLET_SCALE
    from .candidates import candidates
    from .exact_place import _build_current_buffers
    from .picture import Picture
    from .register import refine_view, view_fit_metrics
    from .scorer import ModelScorer
    from .step import solve
    from .subbuild import _batch_score_unit_options, _self_symmetries

    # 1. Register host_parts to the step picture to get the camera view
    reg_res = solve(lib, host_parts, [], rgb, pts, collider=collider, camera=camera_prior)
    if reg_res.view is None:
        return None
    view = reg_res.view
    pic = Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None)
    host_alone_iou = float(view_fit_metrics(lib, host_parts, pic, view)[0])
    codes = sorted({c for _p, c, _m in host_parts} | {c for _p, c, _m in sub_parts})
    scorer = ModelScorer(lib, host_parts, pic, view, codes)

    # 2. Generate rigid transforms T that mate any boundary part of sub_parts onto host_parts
    # Expand `_self_symmetries` so symmetric bottom/top plates (3022/3031/24866/4032a) try all 4 yaw turns!
    m0_inv = np.linalg.inv(np.asarray(sub_parts[0][2], float))
    config = [(p, c, m0_inv @ np.asarray(m, float)) for p, c, m in sub_parts]
    options: dict = {}
    ys_sub = [float(np.asarray(m, float)[1, 3]) for _p, _c, m in sub_parts]
    y_min, y_max = min(ys_sub), max(ys_sub)
    # Bottom-most layers first (covers feet/base AND jumper plates on display stands like 92593 at y_max-32!),
    # then top-most layer for assemblies that hang from above.
    anchors = [i for i, y in enumerate(ys_sub) if y >= y_max - 40.0]
    anchors += [i for i, y in enumerate(ys_sub) if i not in anchors and y <= y_min + 8.5]
    if not anchors:
        anchors = list(range(min(12, len(sub_parts))))
    for ai in anchors[:32]:
        p, _c, rel = config[ai]
        rel_inv = np.linalg.inv(rel)
        syms = _self_symmetries(lib, p)
        cands_a = [c for c in candidates(lib, p, host_parts) if c.get("kind") != "flush"]
        ortho_a = [
            c for c in cands_a
            if np.all((np.abs(np.asarray(c["matrix"], float)[:3, :3]) < 0.05) | (np.abs(np.asarray(c["matrix"], float)[:3, :3]) > 0.95))
        ]
        if ortho_a:
            cands_a = ortho_a
        for cand in cands_a:
            cm = np.asarray(cand["matrix"], float)
            for sym in syms:
                T = (cm @ sym) @ rel_inv
                key = tuple(np.round(T[:3, :4], 1).ravel())
                if key not in options:
                    options[key] = T @ m0_inv
    if not options:
        return None

    # 3. Fast C++ batch sprite pre-score of candidate rigid attachments (~300x faster than Python loop)
    cur_bufs = _build_current_buffers(lib, scorer, [])
    T_list = list(options.values())
    opt_list = [([(p, c, T_w @ np.asarray(m, float)) for p, c, m in sub_parts], None, True, False) for T_w in T_list]
    scored_u = _batch_score_unit_options(lib, scorer, cur_bufs, opt_list, (0.0,))
    pre = [(scored_u[i][0], T_list[i]) for i in range(len(T_list))]
    pre.sort(key=lambda x: -x[0])

    # 4. Exact collision check + exact ModelScorer ranking on top non-colliding attachments
    if collider is not None:
        collider.set_model(host_parts)
    best = None
    checked = 0
    for _sv, T_world in pre[:96]:
        moved = [(p, c, T_world @ np.asarray(m, float)) for p, c, m in sub_parts]
        if collider is not None and any(collider.hits(p, m) for p, _c, m in moved):
            continue
        sc = scorer.score(moved)
        checked += 1
        if best is None or sc > best[0]:
            best = (sc, T_world, moved)
        if checked >= 16:
            break
    if best is None:
        return None
    sc, T_world, moved = best
    merged_parts = host_parts + moved
    iou0 = float(view_fit_metrics(lib, merged_parts, pic, view)[0])
    rv = refine_view(lib, merged_parts, pic, view, scale_tol=0.06, outer=2)
    iou1 = float(view_fit_metrics(lib, merged_parts, pic, rv)[0])
    if iou1 >= iou0:
        view, iou = rv, iou1
    else:
        iou = iou0
    norm = max(1.0, float(scorer.fg.sum() + scorer.ink_fg.sum()))
    return T_world, view, float(iou), host_alone_iou, float(sc / norm + 1.0)


@dataclass
class FreeRun:
    groups: list = field(default_factory=list)        # per extracted step: [(part, colour, matrix)]
    confidences: list = field(default_factory=list)   # per extracted step: [float]
    rows: list = field(default_factory=list)          # per extracted step: diagnostics
    failed_from: int | None = None                    # 1-based step of the first operational give-up
    unsupported_from: int | None = None               # 1-based step of the first unsupported construction (repeats)
    review: list = field(default_factory=list)        # [(step, reason)] steps needing human review
    parts_report: dict = field(default_factory=dict)
    assemblies: int = 1                               # number of distinct assemblies built

    @property
    def model(self) -> list:
        return [p for g in self.groups for p in g]


def extract(pdf: Path, out_dir: Path) -> tuple[dict, Path]:
    folder = Path(out_dir)
    path = folder / "extract.json"
    if path.exists():
        return json.loads(path.read_text()), folder
    from instructions_pdf.extract import extract_booklet
    folder.mkdir(parents=True, exist_ok=True)
    data = extract_booklet(str(pdf), str(folder))
    path.write_text(json.dumps(data))
    return data, folder


def run(lib, pdf: Path, extract_data: dict, folder: Path, index: dict, collider=None, client=None,
        combiner: dict | None = None, max_steps: int | None = None, log=None) -> FreeRun:
    import pymupdf

    from ..rawimages import main_model_image_info, subbuild_images
    from .parts import read_parts
    from .step import SectionCamera, lookahead, solve

    doc = pymupdf.open(str(pdf))
    steps_parts, report = read_parts(lib, extract_data, folder, index, client,
                                     fallback=inventory_fallback(lib, doc, extract_data, index, client))
    out = FreeRun(parts_report=report)
    assemblies: list[dict] = [{"id": 0, "parts": [], "step_indices": [], "fg_area": 0.0}]
    active_idx = 0
    section = SectionCamera()       # one camera per assembly section
    steps = extract_data["steps"][:max_steps] if max_steps else extract_data["steps"]
    # Pre-read step pictures so each step can use prev_rgb and next_rgb from the same booklet
    step_pics = []
    for step in steps:
        if step.get("pictureBox"):
            page = doc[step["page"] - 1]
            rect = pymupdf.Rect(step["pictureBox"])
            step_pics.append((*main_model_image_info(page, rect), subbuild_images(page, rect)))
        else:
            step_pics.append((None, None, []))

    prev_step_num: int | None = None
    prev_step_info: dict | None = None   # for 1-step backtracking: {si, asm_idx, base_parts, alts}
    early_beams: list[dict] | None = None  # multi-step trajectory beam across first 8 steps of each assembly
    step_views: dict[int, object] = {}     # si -> final View chosen for step si (used by global_opt)
    step_alts: dict[int, list] = {}        # si -> runner-up beam States (used by global_opt hindsight)
    merge_records: list[dict] = []         # standalone sub-assembly snapshots before merging into a host

    def _transform_assembly(asm_idx: int, T: np.ndarray) -> None:
        """Transform every part already recorded in `asm_idx` into a new coordinate frame by T,
        and invalidate stale pre-merge `step_views`/`step_alts` recorded in the old coordinate frame."""
        from .candidates import clean_matrix
        asm = assemblies[asm_idx]
        asm["parts"] = [(p, c, clean_matrix(T @ np.asarray(m, float))) for p, c, m in asm["parts"]]
        for s_i in asm["step_indices"]:
            out.groups[s_i] = [(p, c, clean_matrix(T @ np.asarray(m, float))) for p, c, m in out.groups[s_i]]
            step_views.pop(s_i, None)
            step_alts.pop(s_i, None)

    for si, step in enumerate(steps):
        read = steps_parts[si]
        step_num = int(step.get("number", si + 1) or (si + 1))
        # Step number reset (e.g. 40353 second figure starting back at step 1) -> start a new assembly
        step_reset = prev_step_num is not None and step_num <= prev_step_num and bool(assemblies[active_idx]["parts"])
        if step_reset:
            active_idx = len(assemblies)
            assemblies.append({"id": active_idx, "parts": [], "step_indices": [], "fg_area": 0.0})
            prev_step_info = None
            early_beams = None

        row = {"index": si, "number": step["number"], "page": step["page"], "read": len(read.parts),
               "unresolved": read.unresolved, "repeat": step.get("repeat", 1), "substeps": len(step.get("substeps", [])),
               "assembly": active_idx}
        rgb, pts, subs = step_pics[si]
        placed, confs = [], []
        post_iou = 0.0
        cur_fg_area = _fg_area_ldu2(rgb, pts) if rgb is not None else 0.0

        # Check next step info (within same booklet sequence, not crossing a step reset)
        has_next = (si + 1 < len(steps)) and (int(steps[si + 1].get("number", si + 2) or (si + 2)) > step_num)
        next_rgb, next_pts, next_subs = step_pics[si + 1] if has_next else (None, None, [])
        next_parts = list(steps_parts[si + 1].parts) if has_next else []

        if read.parts:
            cur_parts = assemblies[active_idx]["parts"]
            prev_fg_area = float(assemblies[active_idx].get("fg_area", 0.0))
            area_dropped = bool(cur_parts and prev_fg_area > 0.0 and cur_fg_area > 0.0 and cur_fg_area < AREA_DROP_RATIO * prev_fg_area)
            same_prev = (not step_reset) and prev_step_info is not None and prev_step_info["asm_idx"] == active_idx
            prev_rgb, prev_pts = (step_pics[si - 1][0], step_pics[si - 1][1]) if (same_prev and si > 0) else (None, None)

            result, status = None, "ok"
            switched_early = False

            # Fast path for dramatic silhouette-area drop on large models (e.g. 78-part chick -> 1-part stand):
            # test standalone start FIRST to avoid wasting 10+ seconds fitting a giant model onto a lone plate!
            if area_dropped and cur_fg_area < 0.50 * prev_fg_area and len(cur_parts) >= 12 and rgb is not None:
                try:
                    alone_fast = solve(lib, [], list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                       next_rgb=next_rgb, next_pts=next_pts)
                    alone_fast_iou = _post_fit_iou(lib, [], rgb, pts, alone_fast.view,
                                                   placed=alone_fast.placed, scores=alone_fast.scores)
                    if alone_fast.placed and len(alone_fast.placed) == len(read.parts) and alone_fast_iou >= 0.80:
                        target_idx = len(assemblies)
                        assemblies.append({"id": target_idx, "parts": [], "step_indices": [], "fg_area": 0.0})
                        active_idx = target_idx
                        cur_parts = assemblies[active_idx]["parts"]
                        result, status, post_iou = alone_fast, alone_fast.status, alone_fast_iou
                        row["assembly"] = active_idx
                        row["assembly_event"] = f"new_submodel_{active_idx}"
                        early_beams = None
                        switched_early = True
                except Exception:
                    pass

            # Early-step multi-step trajectory beam (K=4 across first 4 steps of each assembly)
            # Resolves symmetric step-1/2 flips (e.g. 41488 4x4 plate, 41605 2x2 pair) using step 2-4 + DINOv2 evidence!
            if (not switched_early and early_beams and len(early_beams) >= 1 and not area_dropped
                    and len(read.parts) <= 5 and not subs and rgb is not None
                    and len(assemblies[active_idx]["step_indices"]) < 4):
                new_beams = []
                seen_b = set()
                n_prev_steps = len(assemblies[active_idx]["step_indices"])
                for b in early_beams:
                    try:
                        b_res = solve(lib, b["asm_parts"], list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                      beam=5, prev_rgb=prev_rgb, prev_pts=prev_pts, next_rgb=next_rgb, next_pts=next_pts)
                    except Exception:
                        continue
                    # Branch into orientation-diverse hypotheses ONLY on step 2 (n_prev_steps == 1);
                    # afterwards extend each distinct trajectory with its best continuation (n_exp = 1)
                    # so one hypothesis's runner-up cannot duplicate and evict a competing orientation!
                    n_exp = 4 if n_prev_steps == 1 else 1
                    cands_b = b_res.early_branches[:n_exp] if (n_exp > 1 and b_res.early_branches) else [
                        (list(b_res.placed), list(b_res.scores), b_res.view, b_res.orientation_index, float(b_res.completed))
                    ]
                    for b_pl, b_sc, b_v, b_oi, b_comp in cands_b:
                        if not b_pl:
                            continue
                        b_iou = _post_fit_iou(lib, b["asm_parts"], rgb, pts, b_v, placed=b_pl, scores=b_sc)
                        new_parts = b["asm_parts"] + list(b_pl)
                        bkey = (b_oi, frozenset(
                            (p, c, tuple(np.round(np.asarray(m, float)[:3, 3], 1)),
                             tuple(np.round(np.asarray(m, float)[:3, :3].ravel(), 1)))
                            for p, c, m in new_parts
                        ))
                        if bkey in seen_b:
                            continue
                        seen_b.add(bkey)
                        cam_cont = 0.02 if (b.get("last_oi") is not None and b_oi == b.get("last_oi")) else 0.0
                        nb = {
                            "asm_parts": new_parts,
                            "step_groups": {**b["step_groups"], si: list(b_pl)},
                            "step_scores": {**b["step_scores"], si: (list(b_sc), b_v, b_oi, b_comp, b_iou, b_res)},
                            "cum_placed": b["cum_placed"] + len(b_pl),
                            "cum_iou": b["cum_iou"] + b_iou + cam_cont,
                            "cum_comp": b["cum_comp"] + b_comp,
                            "cum_dino": b.get("cum_dino", 0.0),
                            "last_oi": b_oi,
                        }
                        new_beams.append(nb)
                if new_beams:
                    # Score surviving early trajectories with zero-shot DINOv2 so printed/asymmetric bricks break
                    # 90/180-deg silhouette ties before committing the assembly frame!
                    if len(new_beams) >= 2 and rgb is not None:
                        from . import vision_prior
                        perc_eb = vision_prior.perceptor()
                        if perc_eb is not None:
                            from ..viewfit import BOOKLET_SCALE
                            from .picture import Picture
                            pic_eb = Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None)
                            bg_eb = tuple(int(round(v)) for v in pic_eb.background)
                            fg_eb = pic_eb.foreground & ~pic_eb.arrows
                            ren_eb = []
                            valid_eb = []
                            for idx_eb, nb in enumerate(new_beams):
                                b_v = nb["step_scores"][si][1]
                                if b_v is not None:
                                    ren_eb.append(vision_prior.render_npr_rgb(lib, nb["asm_parts"], b_v, pic_eb.rgb.shape[:2], bg=bg_eb)[0])
                                    valid_eb.append(idx_eb)
                            if len(ren_eb) >= 2:
                                d_eb = perc_eb.score_renders(pic_eb.rgb, fg_eb, bg_eb, ren_eb)
                                for pos_eb, idx_eb in enumerate(valid_eb):
                                    new_beams[idx_eb]["cum_dino"] += float(d_eb[pos_eb])

                    def _beam_val(nb):
                        return nb["cum_placed"] * 10.0 + nb["cum_iou"] + 0.35 * nb["cum_comp"] + 0.65 * nb.get("cum_dino", 0.0)
                    new_beams.sort(key=lambda nb: -_beam_val(nb))
                    best_bv = _beam_val(new_beams[0])
                    # Keep up to 4 surviving trajectories (dropping clearly beaten ones after step 5 to stay fast)
                    keep_n = 4 if n_prev_steps <= 3 else (3 if n_prev_steps <= 5 else 2)
                    early_beams = [nb for nb in new_beams[:keep_n]
                                   if n_prev_steps <= 4 or _beam_val(nb) >= best_bv - 0.16]
                    win = early_beams[0]
                    # Retroactively sync previous early steps, views & SectionCamera to the winning trajectory
                    for prev_si, prev_pl in win["step_groups"].items():
                        if prev_si != si:
                            out.groups[prev_si] = list(prev_pl)
                    section.seen.pop(active_idx, None)
                    for prev_si in sorted(win["step_scores"]):
                        if prev_si != si:
                            _psc, pv, poi, pcomp, _piou, _pres = win["step_scores"][prev_si]
                            if pv is not None:
                                step_views[prev_si] = pv
                            if pv is not None and pcomp:
                                section.seen.setdefault(active_idx, []).append((pv, poi, float(pcomp), 1.0))
                    assemblies[active_idx]["parts"] = list(win["asm_parts"][:-len(win["step_groups"][si])])
                    cur_parts = assemblies[active_idx]["parts"]
                    w_sc, w_v, w_oi, w_comp, w_iou, w_res = win["step_scores"][si]
                    from .step import StepResult
                    result = StepResult(list(win["step_groups"][si]), list(w_sc), w_v, w_comp, w_res.fit_iou,
                                        alternatives=w_res.alternatives, status=w_res.status, completed=w_comp,
                                        hypotheses=w_res.hypotheses, orientation_index=w_oi, state_total=w_res.state_total)
                    status, post_iou = result.status, w_iou
                    switched_early = True
                    # Commit & release beam once 4 early steps are done (or only 1 trajectory survives, or >= 14 parts)
                    if n_prev_steps >= 3 or len(win["asm_parts"]) >= 14 or (n_prev_steps >= 2 and len(early_beams) <= 1):
                        early_beams = None
                else:
                    early_beams = None

            if not switched_early:
                try:
                    result = solve(lib, cur_parts, list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                   camera=section.prior(active_idx) if cur_parts else None,
                                   prev_rgb=prev_rgb, prev_pts=prev_pts, next_rgb=next_rgb, next_pts=next_pts)
                    status = result.status
                except Exception as error:   # one bad step must not stop the booklet
                    result, status = None, f"error: {type(error).__name__}: {error}"[:200]

                post_iou = _post_fit_iou(lib, cur_parts, rgb, pts,
                                         result.view if result else None,
                                         placed=result.placed if result else None,
                                         scores=result.scores if result else None)

                # Late display-stand / large-baseplate sub-assembly hypothesis: when a late step adds >=4
                # parts including a large flat plate onto a large existing model (>=20 parts) without a
                # subbuild panel (e.g. placing a figure onto a 6x6 display stand), also solve baseplate-first!
                if (len(cur_parts) >= 20 and len(read.parts) >= 4 and not subs and rgb is not None):
                    from .global_opt import has_large_baseplate, solve_base_subassembly, _eval_multiview_score
                    if has_large_baseplate(lib, list(read.parts)) is not None:
                        stand_out = solve_base_subassembly(
                            lib, cur_parts, list(read.parts), rgb, pts, collider=collider,
                            camera_prior=section.prior(active_idx), prev_rgb=prev_rgb, prev_pts=prev_pts,
                            init_view=result.view if result is not None else None,
                            init_orientation_index=result.orientation_index if result is not None else 0,
                            init_fit_iou=result.fit_iou if result is not None else 0.0,
                        )
                        if stand_out is not None:
                            res_st, st_iou = stand_out
                            take_stand = (result is None or status != "ok" or len(result.placed) < len(read.parts))
                            if not take_stand and res_st.view is not None:
                                sc_cmp = _eval_multiview_score(
                                    lib, [(cur_parts, [], rgb, pts, res_st.view)],
                                    [[result.placed], [res_st.placed]], use_dino=True,
                                )
                                take_stand = (sc_cmp[1][0] > sc_cmp[0][0] + 0.015) or (st_iou > post_iou + 0.03)
                            if take_stand:
                                result, status, post_iou = res_st, res_st.status, st_iou
                                row["stand_subassembly"] = True

                # 1-step backtracking: if this step struggled on step (si-1)'s top state, try its runner-up beam states!
                # Keep bounded (<= 6 parts, local camera lock) so large sub-build steps never multiply runtime by 8x!
                if (same_prev and prev_step_info is not None and prev_step_info["alts"]
                        and len(read.parts) <= 6
                        and rgb is not None and (result is None or len(result.placed) < len(read.parts) or post_iou < BACKTRACK_IOU_THRESH)):
                    base_before_prev = prev_step_info["base_parts"]
                    best_bt = None
                    bt_pr = section.prior(active_idx)
                    bt_cam = bt_pr if bt_pr is not None else None
                    for alt_st in prev_step_info["alts"][:2]:
                        alt_model = base_before_prev + list(alt_st.placed)
                        try:
                            alt_res = solve(lib, alt_model, list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                            beam=4, camera=bt_cam,
                                            prev_rgb=prev_rgb, prev_pts=prev_pts, next_rgb=next_rgb, next_pts=next_pts)
                            alt_iou = _post_fit_iou(lib, alt_model, rgb, pts, alt_res.view,
                                                    placed=alt_res.placed, scores=alt_res.scores)
                        except Exception:
                            continue
                        better_count = len(alt_res.placed) > (len(result.placed) if result else 0)
                        better_iou = len(alt_res.placed) >= (len(result.placed) if result else 0) and alt_iou >= post_iou + BACKTRACK_IOU_GAIN
                        if (better_count or better_iou) and (best_bt is None or (len(alt_res.placed), alt_iou) > (len(best_bt[0].placed), best_bt[1])):
                            best_bt = (alt_res, alt_iou, alt_st, alt_model)
                    if best_bt is not None:
                        alt_res, alt_iou, alt_st, alt_model = best_bt
                        # Retroactively commit the better previous-step layout
                        psi = prev_step_info["si"]
                        out.groups[psi] = list(alt_st.placed)
                        assemblies[active_idx]["parts"] = list(alt_model)
                        cur_parts = assemblies[active_idx]["parts"]
                        result, status, post_iou = alt_res, alt_res.status, alt_iou
                        row["backtracked"] = True

                # Multi-submodel detection: if step picture clearly doesn't show `cur_parts` (low IoU or big area drop),
                # test starting a standalone sub-assembly OR switching back to / attaching onto an earlier assembly!
                if cur_parts and rgb is not None and (result is None or status != "ok" or len(result.placed) < len(read.parts) or post_iou < SWITCH_IOU_THRESH or area_dropped):
                    best_switch = None   # (iou, kind, target_idx, new_res, attach_T)
                    alone_min = 0.72 if (area_dropped and cur_fg_area < 0.55 * prev_fg_area) else 0.74
                    alone_gain = 0.05 if (area_dropped and cur_fg_area < 0.55 * prev_fg_area) else SWITCH_IOU_GAIN
                    # Option A: Start a brand-new standalone assembly (drawn alone on empty canvas)
                    try:
                        alone_res = solve(lib, [], list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                          next_rgb=next_rgb, next_pts=next_pts)
                        alone_iou = _post_fit_iou(lib, [], rgb, pts, alone_res.view,
                                                  placed=alone_res.placed, scores=alone_res.scores)
                        if alone_res.placed and alone_iou >= max(alone_min, post_iou + alone_gain):
                            best_switch = (alone_iou, "alone", len(assemblies), alone_res, None)
                    except Exception:
                        pass
                    # Option B: Switch back to an earlier assembly (or attach current sub-assembly onto it!)
                    for oi, other in enumerate(assemblies):
                        if oi == active_idx or not other["parts"]:
                            continue
                        try:
                            sw_res = solve(lib, other["parts"], list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                           camera=section.prior(oi), next_rgb=next_rgb, next_pts=next_pts)
                            sw_iou = _post_fit_iou(lib, other["parts"], rgb, pts, sw_res.view,
                                                   placed=sw_res.placed, scores=sw_res.scores)
                            if sw_res.placed and sw_iou >= max(0.72, post_iou + SWITCH_IOU_GAIN):
                                if best_switch is None or sw_iou > best_switch[0]:
                                    best_switch = (sw_iou, "switch", oi, sw_res, None)
                        except Exception:
                            pass
                        # Also try rigidly attaching `cur_parts` onto `other` if `cur_parts` is a sub-assembly
                        if len(cur_parts) <= 40 and (best_switch is None or best_switch[0] < 0.85):
                            att = _attach_assembly(lib, other["parts"], cur_parts, rgb, pts, collider=collider,
                                                   camera_prior=section.prior(oi))
                            if att is not None:
                                T_att, _v_att, att_iou, _host_iou, _sc_att = att
                                moved_cur = [(p, c, T_att @ np.asarray(m, float)) for p, c, m in cur_parts]
                                merged = other["parts"] + moved_cur
                                try:
                                    m_res = solve(lib, merged, list(read.parts), rgb, pts, collider=collider, subbuilds=subs,
                                                  camera=section.prior(oi), next_rgb=next_rgb, next_pts=next_pts)
                                    m_iou = _post_fit_iou(lib, merged, rgb, pts, m_res.view,
                                                          placed=m_res.placed, scores=m_res.scores)
                                    if m_res.placed and m_iou >= max(0.72, post_iou + SWITCH_IOU_GAIN):
                                        if best_switch is None or m_iou > best_switch[0]:
                                            best_switch = (m_iou, "attach", oi, m_res, T_att)
                                except Exception:
                                    pass
                    if best_switch is not None:
                        sw_iou, sw_kind, target_idx, sw_res, T_att = best_switch
                        if sw_kind == "alone":
                            assemblies.append({"id": target_idx, "parts": [], "step_indices": [], "fg_area": 0.0})
                            active_idx = target_idx
                            row["assembly_event"] = f"new_submodel_{active_idx}"
                        elif sw_kind == "switch":
                            active_idx = target_idx
                            row["assembly_event"] = f"switch_to_{active_idx}"
                        elif sw_kind == "attach":
                            _transform_assembly(active_idx, T_att)
                            assemblies[target_idx]["parts"].extend(assemblies[active_idx]["parts"])
                            assemblies[target_idx]["step_indices"].extend(assemblies[active_idx]["step_indices"])
                            assemblies[active_idx]["parts"] = []
                            assemblies[active_idx]["step_indices"] = []
                            active_idx = target_idx
                            row["assembly_event"] = f"attached_to_{active_idx}"
                        cur_parts = assemblies[active_idx]["parts"]
                        result, status, post_iou = sw_res, sw_res.status, sw_iou
                        row["assembly"] = active_idx
                        early_beams = None

            # Seed early-step trajectory beam on step 0 of any new assembly.
            # Deduplicate by 3D rigid shape (up to 90-deg Y-rotations of the frame-free step 0 model!)
            # so identical 90-deg-rotated copies don't duplicate and evict true step-2 orientations!
            if (not cur_parts and result is not None and status == "ok" and result.placed
                    and 2 <= len(read.parts) <= 4 and not subs and result.early_branches):
                from .subbuild import _turn
                early_beams = []
                seen_rigid = set()
                for b_pl, b_sc, b_v, b_oi, b_comp in result.early_branches[:6]:
                    # Canonicalise rigid geometry up to the 4 quarter turns around Y
                    canon_r = None
                    for k_r in range(4):
                        tk = _turn(k_r)
                        pts_k = sorted(
                            (p, c, tuple(np.round((tk @ np.asarray(m, float))[:3, 3], 1)))
                            for p, c, m in b_pl
                        )
                        key_k = tuple(pts_k)
                        if canon_r is None or key_k < canon_r:
                            canon_r = key_k
                    if canon_r in seen_rigid:
                        continue
                    seen_rigid.add(canon_r)
                    b_iou = _post_fit_iou(lib, [], rgb, pts, b_v, placed=b_pl, scores=b_sc)
                    early_beams.append({
                        "asm_parts": list(b_pl),
                        "step_groups": {si: list(b_pl)},
                        "step_scores": {si: (list(b_sc), b_v, b_oi, b_comp, b_iou, result)},
                        "cum_placed": len(b_pl),
                        "cum_iou": b_iou,
                        "cum_comp": b_comp,
                        "last_oi": b_oi,
                    })
                    if len(early_beams) >= 2:
                        break
                # Even if step 0 has only 1 unique rigid geometry (e.g. 41488 3031+3020), keep
                # early_beams active with length 1 so step 1 expands all 4 orientation hypotheses!
                if not early_beams:
                    early_beams = None

            # Active multi-step lookahead for ambiguous / occluded placements
            if result is not None and status == "ok" and result.alternatives and next_rgb is not None and next_parts and not early_beams:
                try:
                    result = lookahead(lib, cur_parts, result, next_parts, next_rgb, next_pts,
                                       collider=collider, subbuilds=next_subs)
                except Exception:
                    pass

            if result is not None:
                section.add(active_idx, result, len(cur_parts))
                if result.view is not None:
                    step_views[si] = result.view
                if result.alternatives:
                    step_alts[si] = list(result.alternatives[:4])
                placed = list(result.placed)
                read_conf = list(read.confidence)
                for k, sc in enumerate(result.scores):
                    confs.append(part_confidence(sc, result, read_conf[k] if k < len(read_conf) else 0.0, combiner))
                row.update(registration=float(result.registration), pre_fit_iou=float(result.fit_iou),
                           post_fit_iou=float(post_iou), completed=float(result.completed),
                           hypotheses=result.hypotheses, placed=len(placed))
                prev_step_info = {
                    "si": si,
                    "asm_idx": active_idx,
                    "base_parts": list(cur_parts),
                    "alts": list(result.alternatives),
                }
            else:
                prev_step_info = None
                early_beams = None

            # Operational failure: could not place all read parts, or post-placement fit is very low
            eff_iou = post_iou if post_iou > 0.0 else (result.fit_iou if result is not None else 0.0)
            gave_up = result is None or status != "ok" or eff_iou < GIVE_UP_IOU or len(placed) < len(read.parts)
            row["status"] = status if status != "ok" or not gave_up else "low post-placement fit"
            if gave_up and out.failed_from is None:
                out.failed_from = si + 1
        else:
            # No new parts read: check if this is a pure sub-assembly merge step (e.g. props/figure onto baseplate!).
            # Test ALL live assembly pairs (prioritising pairs involving `active_idx`, then all other pairs such as
            # merging the completed main figure onto the completed stand on the final booklet page!).
            live_ids = [i for i, a in enumerate(assemblies) if a["parts"]]
            if rgb is not None and len(live_ids) >= 2:
                pair_order = []
                for a_i in live_ids:
                    for b_i in live_ids:
                        if a_i < b_i:
                            involves_active = (a_i == active_idx or b_i == active_idx)
                            pair_order.append((0 if involves_active else 1, a_i, b_i))
                pair_order.sort()
                best_merge = None   # (att_iou, sc, host_i, sub_i, T_att, v_att)
                for _prio, a_i, b_i in pair_order:
                    # Register the larger assembly as host first; also try reversed when sizes are comparable
                    if len(assemblies[a_i]["parts"]) >= len(assemblies[b_i]["parts"]):
                        order_hs = [(a_i, b_i), (b_i, a_i)]
                    else:
                        order_hs = [(b_i, a_i), (a_i, b_i)]
                    for host_i, sub_i in order_hs:
                        try:
                            att = _attach_assembly(lib, assemblies[host_i]["parts"], assemblies[sub_i]["parts"],
                                                   rgb, pts, collider=collider, camera_prior=section.prior(host_i))
                        except Exception:
                            att = None
                        if att is None:
                            continue
                        T_att, v_att, att_iou, host_iou, sc_att = att
                        # Require strong post-merge silhouette match AND genuine improvement over host alone
                        if att_iou >= 0.72 and att_iou >= host_iou + 0.04:
                            if best_merge is None or (att_iou, sc_att) > (best_merge[0], best_merge[1]):
                                best_merge = (att_iou, sc_att, host_i, sub_i, T_att, v_att)
                            if att_iou >= 0.86:
                                break
                    if best_merge is not None and best_merge[0] >= 0.86:
                        break
                if best_merge is not None:
                    att_iou, _sc_m, host_i, sub_i, T_att, v_att = best_merge
                    sub_sis_snap = [s2 for s2 in assemblies[sub_i]["step_indices"] if out.groups[s2]]
                    sub_ious = [float(out.rows[s2].get("post_fit_iou") or 0.0) for s2 in sub_sis_snap if s2 < len(out.rows)]
                    merge_records.append({
                        "id": sub_i,
                        "step_indices": list(sub_sis_snap),
                        "local_parts": list(assemblies[sub_i]["parts"]),
                        "mean_iou": float(np.mean(sub_ious)) if sub_ious else 0.0,
                        "merge_si": si,
                        "host_steps_before": [s2 for s2 in assemblies[host_i]["step_indices"] if out.groups[s2]],
                    })
                    if v_att is not None:
                        step_views[si] = v_att
                    _transform_assembly(sub_i, T_att)
                    assemblies[host_i]["parts"].extend(assemblies[sub_i]["parts"])
                    assemblies[host_i]["step_indices"].extend(assemblies[sub_i]["step_indices"])
                    assemblies[sub_i]["parts"] = []
                    assemblies[sub_i]["step_indices"] = []
                    active_idx = host_i
                    row["assembly"] = active_idx
                    row["assembly_event"] = f"merged_{sub_i}_into_{host_i}"
                    row["post_fit_iou"] = float(att_iou)
            row["status"] = "no parts read"
            prev_step_info = None
            early_beams = None

        # Only flag repeat as unsupported when copies are actually missing (not when all N copies were read & placed!)
        rep = int(step.get("repeat", 1) or 1)
        if rep > 1 and (len(placed) < len(read.parts) or (not subs and post_iou < 0.65)):
            row["unsupported"] = f"repeat x{rep} incomplete"
            if out.unsupported_from is None:
                out.unsupported_from = si + 1
        # review-required uncertainty (not a failure by itself)
        if read.unresolved:
            out.review.append((si + 1, f"{read.unresolved} unresolved part(s)"))
        if not read.parts and "assembly_event" not in row:
            out.review.append((si + 1, "no parts read"))
        assemblies[active_idx]["parts"].extend(placed)
        assemblies[active_idx]["step_indices"].append(si)
        if cur_fg_area > 0.0:
            assemblies[active_idx]["fg_area"] = cur_fg_area
        out.groups.append(placed)
        out.confidences.append(confs)
        out.rows.append(row)
        prev_step_num = step_num
        if log:
            log(row)

    # Whole-booklet post-forward global multi-view optimization (isomorphic sub-assembly clone transfer,
    # multi-view merge optimization, articulation-bridge twist unwinding, and hindsight hinge/alt repair).
    # Run each pass independently so an error in one pass never suppresses downstream passes!
    import os
    if os.environ.get("BOOKLET_SOLVER_GLOBAL_OPT", "1") != "0" and len(out.groups) >= 4:
        from .global_opt import (
            polish_bilateral_symmetry_multiview,
            refine_multiview_hindsight,
            refine_subassembly_merges,
            unwind_articulation_twists,
        )
        go_passes = [
            ("merges", lambda: refine_subassembly_merges(lib, merge_records, assemblies, out, step_pics, step_views, collider=collider, log=log)),
            ("twists", lambda: unwind_articulation_twists(lib, assemblies, out, step_pics, steps_parts, step_views, collider=collider, log=log)),
            ("hindsight", lambda: refine_multiview_hindsight(lib, assemblies, out, step_pics, step_views, step_alts, collider=collider, log=log)),
        ]
        if os.environ.get("BOOKLET_SOLVER_SYM_POLISH", "0") == "1":
            go_passes.append(("symmetry", lambda: polish_bilateral_symmetry_multiview(lib, assemblies, out, step_pics, step_views, collider=collider, log=log)))
        for pass_name, pass_fn in go_passes:
            try:
                pass_fn()
            except Exception as err:
                out.review.append((0, f"global_opt:{pass_name}: {type(err).__name__}: {err}"[:120]))

    out.assemblies = sum(1 for a in assemblies if a["parts"])
    return out


def inventory_fallback(lib, doc, extract_data: dict, index: dict, client) -> list[dict] | None:
    """Rebrickable inventory fallback/supplement (read-only public parts list, set number from cover):
    - When the booklet prints no parts list: returns the full set inventory.
    - When the booklet prints a partial parts list (e.g. elements missed at bottom of page): returns ONLY
      the missing `(ldraw_part, colour)` entries so `read_parts` can supplement without hurting healthy PDF crops."""
    from .parts import fallback_inventory, ldraw_part, resolve_element, set_number_from_pdf
    number = set_number_from_pdf(doc)
    if not number:
        return None
    pdf_inv = [e for e in extract_data.get("inventory", []) if e.get("element")]
    if not pdf_inv:
        return fallback_inventory(lib, number, client, index)
    have: set[tuple[str, int]] = set()
    for e in pdf_inv:
        rec = resolve_element(str(e["element"]), index, client)
        if rec is not None:
            p, _notes = ldraw_part(lib, rec)
            if p is not None:
                have.add((p, int(rec["color"])))
    missing = fallback_inventory(lib, number, client, index, exclude=have)
    return missing or None


def write(run_result: FreeRun, path: Path, name: str, threshold: float) -> dict:
    from ..flagged_mpd import write_flagged_mpd
    marks = [s for s in (run_result.failed_from, run_result.unsupported_from) if s is not None]
    return write_flagged_mpd(path, name, run_result.groups, run_result.confidences, threshold,
                             failed_from_step=min(marks) if marks else None)
