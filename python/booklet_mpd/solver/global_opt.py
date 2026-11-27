"""Whole-booklet multi-view global optimizer: breaks the single-step greedy ceiling.

Combines five general, set-agnostic global inverse-graphics passes backed by exact `libbmcore`
connector/collision physics and frozen `DINOv2` foundation perception (`vision_prior.py`):

  1. `solve_base_subassembly`: handles late steps where a multi-part display stand / baseplate is
     introduced underneath an already-built figure/model in one step without a sub-build panel.
  2. `unwind_articulation_twists`: detects 90/180/270-deg frame twists across symmetric early-to-mid
     articulation bridges (e.g. a square neck/waist plate) by scoring all 4 quarter-turns of the
     prefix jointly across future suffix pages with ModelScorer + DINOv2, then selectively re-solving
     downstream conflicted / low-fit suffix steps on the untwisted base!
  3. `transfer_isomorphic_subassemblies`: when a booklet builds two standalone sub-assemblies with
     identical base-part multisets (ignoring colour, e.g. paired flowers/wings/pods), transfers the
     higher-confidence 3D geometry onto the noisier twin and re-optimises its merge jointly against
     both the merge page and the final assembled page!
  4. `refine_multiview_merges`: re-ranks top-K collision-free sub-assembly merge transforms jointly
     across the merge page and final assembled page with ModelScorer + DINOv2.
  5. `refine_multiview_hindsight`: re-evaluates saved step alternatives, continuous hinge-angle sweeps
     for hinged sub-assemblies, and bilateral-symmetry mirror proposals jointly across step `t` and
     future visible booklet pages `t+1 .. T` (checking zero collision against all later steps!).
"""
from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re

import numpy as np

from ..inventory_check import base_number
from ..viewfit import BOOKLET_SCALE
from .candidates import candidates, clean_matrix
from .exact_place import _build_current_buffers, _drawn_entries, score_candidates_calibrated, solve_step_exact
from .picture import Picture
from .place import State, _boxes_overlap, _size
from .register import refine_view, register, view_fit_metrics
from .render import View, render, world_triangles
from .scorer import ModelScorer
from .subbuild import _batch_score_unit_options, _self_symmetries, _turn
from .vision_prior import perceptor, render_npr_rgb, score_candidate_layouts

_CHIRAL_CACHE: dict[str, str] | None = None


def _chiral_mirror_map() -> dict[str, str]:
    """L/R chiral LEGO part swap table (base part id -> mirrored base part id)."""
    global _CHIRAL_CACHE
    if _CHIRAL_CACHE is not None:
        return _CHIRAL_CACHE
    out: dict[str, str] = {}
    for a, b in [
        ("24299", "24307"), ("43723", "43722"), ("41770", "41769"), ("54384", "54383"),
        ("48208", "48205"), ("47397", "47398"), ("5091", "5092"), ("30355", "30356"),
        ("43710", "43711"), ("41748", "41747"), ("41764", "41765"), ("6564", "6565"),
        ("29119", "29120"), ("41769", "41770"), ("50955", "50956"), ("65734", "65735"),
        ("3544", "3545"), ("48183", "48184"), ("47757", "47758"),
    ]:
        out[a] = b
        out[b] = a
    cat_path = Path(__file__).resolve().parents[3] / "public/data/catalog.json"
    if cat_path.exists():
        try:
            cat = json.loads(cat_path.read_text())
            by_norm: dict[str, dict[str, str]] = {}
            for item in cat:
                nl = str(item.get("name", "")).lower()
                if " left" not in nl and " right" not in nl:
                    continue
                pid = base_number(str(item.get("id", "")))
                key = re.sub(r"\b(left|right)\b", "<S>", nl)
                by_norm.setdefault(key, {})["L" if " left" in nl else "R"] = pid
            for pair in by_norm.values():
                if "L" in pair and "R" in pair:
                    out.setdefault(pair["L"], pair["R"])
                    out.setdefault(pair["R"], pair["L"])
        except Exception:
            pass
    _CHIRAL_CACHE = out
    return out


def _part_xz_span(lib, part: str) -> tuple[float, float, float]:
    """Axis-aligned local (sx, sy, sz) dimensions of `part` in LDU."""
    t = world_triangles(lib, part, np.eye(4)).reshape(-1, 3)
    if not len(t):
        return (0.0, 0.0, 0.0)
    span = t.max(0) - t.min(0)
    return (float(span[0]), float(span[1]), float(span[2]))


def _model_y_bounds(lib, parts: list) -> tuple[float, float]:
    """World (y_min, y_max) across all triangles in `parts` (LDraw Y points DOWN: y_max is bottom)."""
    ys_lo, ys_hi = [], []
    for p, _c, m in parts:
        t = world_triangles(lib, p, np.asarray(m, float)).reshape(-1, 3)
        if len(t):
            ys_lo.append(float(t[:, 1].min()))
            ys_hi.append(float(t[:, 1].max()))
    if not ys_lo:
        return (0.0, 0.0)
    return (min(ys_lo), max(ys_hi))


def _eval_multiview_score(lib, pages: list[tuple[list, list, np.ndarray, float | None, View]],
                          cand_parts_per_page: list[list[list]], use_dino: bool = True) -> list[tuple[float, float, float]]:
    """Evaluate `K` candidate hypotheses jointly across `M` booklet pages.

    `pages`: list of `(base_m, extra_static_m, rgb_m, pts_m, view_m)`.
    `cand_parts_per_page`: length-`K` list where item `k` is a length-`M` list of parts added on page `m`.
    Returns length-`K` list of `(combined_score, mean_model_scorer_norm, mean_dino)`.
    """
    K = len(cand_parts_per_page)
    M = len(pages)
    if K == 0 or M == 0:
        return []
    ms_sum = np.zeros(K, dtype=np.float64)
    dino_sum = np.zeros(K, dtype=np.float64)
    dino_cnt = 0
    perc = perceptor() if use_dino else None

    for m_idx, (base_m, static_m, rgb_m, pts_m, view_m) in enumerate(pages):
        if rgb_m is None or view_m is None:
            continue
        pic = Picture.from_rgb(rgb_m, pts_m, BOOKLET_SCALE / pts_m if pts_m else None)
        fixed = list(base_m) + list(static_m)
        codes = sorted(
            {int(c) for _p, c, _m in fixed}
            | {int(c) for k in range(K) for _p, c, _m in cand_parts_per_page[k][m_idx]}
        )
        scorer = ModelScorer(lib, fixed, pic, view_m, codes)
        norm = max(1.0, float(scorer.fg.sum() + scorer.ink_fg.sum()))
        for k in range(K):
            sc = float(scorer.score(cand_parts_per_page[k][m_idx]))
            ms_sum[k] += sc / norm
        if perc is not None:
            cand_added = [cand_parts_per_page[k][m_idx] for k in range(K)]
            d_sc = score_candidate_layouts(lib, fixed, cand_added, pic, view_m)
            if d_sc is not None and len(d_sc) == K:
                dino_sum += d_sc
                dino_cnt += 1

    ms_mean = ms_sum / max(1, M)
    dino_mean = dino_sum / max(1, dino_cnt) if dino_cnt > 0 else np.zeros(K, dtype=np.float64)
    # Combined objective balances normalized pixel/colour/edge fidelity with zero-shot DINOv2 perception
    comb = ms_mean + (1.20 * dino_mean if dino_cnt > 0 else 0.0)
    return [(float(comb[k]), float(ms_mean[k]), float(dino_mean[k])) for k in range(K)]


# ------------------------------------------------------------------ 1. Late Display-Stand / Baseplate Sub-Assembly Solver

def has_large_baseplate(lib, parts: list[tuple[str, int]]) -> int | None:
    """Return index of the largest flat plate/baseplate (>= 3x3 studs, height <= 24 LDU) in `parts`, or None."""
    best_i, best_area = None, 0.0
    for i, (p, _c) in enumerate(parts):
        sx, sy, sz = _part_xz_span(lib, p)
        if sx >= 58.0 and sz >= 58.0 and sy <= 26.0:
            area = sx * sz
            if area > best_area:
                best_area, best_i = area, i
    return best_i


def solve_base_subassembly(lib, base: list, parts: list[tuple[str, int]], rgb: np.ndarray,
                           pts: float | None, collider=None, camera_prior=None,
                           prev_rgb: np.ndarray | None = None, prev_pts: float | None = None,
                           init_view=None, init_orientation_index: int = 0, init_fit_iou: float = 0.0):
    """Alternative hypothesis for late steps adding a display stand / baseplate underneath `base`.

    Anchors the largest flat baseplate (`P0`) onto the bottom-most layer of `base` first (testing
    all legal connector mates + self-symmetries), then solves the remaining step parts onto
    `base + [P0]` so stand tiles/jumpers snap naturally onto `P0` instead of scattering over `base`.
    Returns `(StepResult, post_iou)` or None.
    """
    if len(base) < 20 or len(parts) < 4 or rgb is None:
        return None
    bp_idx = has_large_baseplate(lib, parts)
    if bp_idx is None:
        return None

    from .step import StepResult, solve
    # 1. Reuse already-registered view when available (avoids 50s redundant registration!), else register `base`
    if init_view is not None:
        view = init_view
        orient_idx = int(init_orientation_index)
        base_fit_iou = float(init_fit_iou)
    else:
        reg_res = solve(lib, base, [], rgb, pts, collider=collider, camera=camera_prior)
        if reg_res.view is None:
            return None
        view = reg_res.view
        orient_idx = int(reg_res.orientation_index)
        base_fit_iou = float(reg_res.fit_iou)
    pic = Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None)
    codes = sorted({int(c) for _p, c, _m in base} | {int(c) for _p, c in parts})
    scorer = ModelScorer(lib, base, pic, view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts)

    # 2. Candidate anchor plans for P0 underneath `bottom_base`:
    #    (A) Direct anchors: P0 mates directly underneath `bottom_base`.
    #    (B) Bridge anchors: a flat plate/jumper in `rest` (e.g. 92593) bridges underneath `bottom_base`
    #        (preferring multi-stud mates centered under both feet!), and P0 mates directly underneath it!
    from .place import distinct
    p0, c0 = parts[bp_idx]
    rest = parts[:bp_idx] + parts[bp_idx + 1:]
    _ylo, y_bot = _model_y_bounds(lib, base)
    bottom_base = [e for e in base if _model_y_bounds(lib, [e])[1] >= y_bot - 16.0]
    if len(bottom_base) < 2:
        bottom_base = [e for e in base if _model_y_bounds(lib, [e])[1] >= y_bot - 34.0]
    if not bottom_base:
        bottom_base = list(base)
    foot_pts = [np.asarray(m, float)[:3, 3] for _p, _c, m in bottom_base]
    foot_cx = float(np.mean([pt[0] for pt in foot_pts]))
    foot_cz = float(np.mean([pt[2] for pt in foot_pts]))

    syms = _self_symmetries(lib, p0)
    p0_y_lo_loc, p0_y_hi_loc = _model_y_bounds(lib, [(p0, c0, np.eye(4))])
    if collider is not None:
        collider.set_model(base)

    def _expand_under_p0(hosts: list, min_y_top: float) -> list[dict]:
        raw = [c for c in candidates(lib, p0, hosts) if c.get("kind") != "flush"]
        out_c, seen_k = [], set()
        for c in raw:
            cm = np.asarray(c["matrix"], float)
            if abs(float(cm[1, 1])) < 0.95:
                continue
            for sym in syms:
                m = clean_matrix(cm @ sym)
                if float(m[1, 1]) >= 0.0:
                    py_lo, py_hi = float(m[1, 3]) + p0_y_lo_loc, float(m[1, 3]) + p0_y_hi_loc
                else:
                    py_lo, py_hi = float(m[1, 3]) - p0_y_hi_loc, float(m[1, 3]) - p0_y_lo_loc
                if not (py_lo >= min_y_top - 5.0 and py_hi >= min_y_top + 4.0):
                    continue
                key = tuple(np.round(m[:3, :4], 1).ravel())
                if key in seen_k:
                    continue
                seen_k.add(key)
                c2 = dict(c)
                c2["matrix"] = m
                out_c.append(c2)
        return out_c

    def _rank_p0_cands(cands_in: list[dict], extra_pre: list, limit: int = 2) -> list[tuple[float, object, np.ndarray]]:
        if not cands_in:
            return []
        sc_list = score_candidates_calibrated(lib, scorer, extra_pre, p0, c0, cands_in, deltas=(0.0,))
        ranked = []
        for sc in sc_list:
            m = np.asarray(sc.candidate["matrix"], float)
            d_xz = float(np.hypot(m[0, 3] - foot_cx, m[2, 3] - foot_cz))
            ranked.append((float(sc.score) - 3.0 * d_xz, sc, m))
        ranked.sort(key=lambda x: -x[0])
        out_r = []
        for val, sc, m in ranked:
            if collider is not None and collider.hits(p0, m):
                continue
            out_r.append((val, sc, m))
            if len(out_r) >= limit:
                break
        return out_r

    # Plan list: [(seeded_entries, seeded_scores, remaining_parts)]
    anchor_plans: list[tuple[list, list, list]] = []

    # (B) Bridge anchors first (1-plate jumper/plate bridging feet to baseplate!)
    seen_bp_types: set[tuple[str, int]] = set()
    bridge_plans: list[tuple[float, list, list, list]] = []
    for ri, (bp, bc) in enumerate(rest):
        if (bp, bc) in seen_bp_types:
            continue
        bsx, bsy, bsz = _part_xz_span(lib, bp)
        if not (bsy <= 15.0 and max(bsx, bsz) >= 38.0):
            continue
        seen_bp_types.add((bp, bc))
        raw_bp = distinct(lib, bp, [c for c in candidates(lib, bp, bottom_base) if c.get("kind") != "flush"])
        bp_y_lo_loc, bp_y_hi_loc = _model_y_bounds(lib, [(bp, bc, np.eye(4))])
        good_bp = []
        for c_bp in raw_bp:
            m_bp = clean_matrix(np.asarray(c_bp["matrix"], float))
            if abs(float(m_bp[1, 1])) < 0.95:
                continue
            by_hi = float(m_bp[1, 3]) + (bp_y_hi_loc if float(m_bp[1, 1]) >= 0.0 else -bp_y_lo_loc)
            if by_hi < y_bot + 4.0:
                continue
            if collider is not None and collider.hits(bp, m_bp):
                continue
            dm = int(collider.mates(bp, m_bp)[0]) if (collider is not None and getattr(collider, "native", None) is not None) else 1
            d_xz = float(np.hypot(m_bp[0, 3] - foot_cx, m_bp[2, 3] - foot_cz))
            good_bp.append((dm, -d_xz, by_hi, m_bp))
        if not good_bp:
            continue
        good_bp.sort(key=lambda x: (-x[0], -x[1]))
        max_dm = good_bp[0][0]
        top_bp = [x for x in good_bp if x[0] >= max_dm][:2]
        rem_after_bp = rest[:ri] + rest[ri + 1:]
        for dm, neg_dxz, by_hi, m_bp in top_bp:
            bp_entry = (bp, bc, m_bp)
            p0_cands_b = _expand_under_p0([bp_entry], by_hi)
            for val_p0, sc_p0, m_p0 in _rank_p0_cands(p0_cands_b, [bp_entry], limit=2):
                bridge_plans.append((val_p0 + 50.0 * dm + 2.0 * neg_dxz,
                                     [bp_entry, (p0, c0, m_p0)], [None, sc_p0], rem_after_bp))
    bridge_plans.sort(key=lambda x: -x[0])
    for _sc_b, s_ent, s_scs, s_rem in bridge_plans[:3]:
        anchor_plans.append((s_ent, s_scs, s_rem))

    # (A) Direct anchors (P0 directly underneath `bottom_base`)
    p0_cands_d = _expand_under_p0(bottom_base, y_bot)
    for _val_p0, sc_p0, m_p0 in _rank_p0_cands(p0_cands_d, [], limit=2):
        anchor_plans.append(([(p0, c0, m_p0)], [sc_p0], rest))

    if not anchor_plans:
        return None

    # 3. For each top collision-free anchor plan, solve the remaining parts on `base + seeded`!
    bot_cand_cache: dict[str, list[dict]] = {}
    full_cand_cache: dict[str, list[dict]] = {}
    extra_cand_cache: dict = {}
    if collider is not None:
        collider.set_model(base)

    def _base_cands_for(part_name: str, extra: list) -> list[dict]:
        if part_name not in bot_cand_cache:
            raw_b = distinct(lib, part_name, [c for c in candidates(lib, part_name, bottom_base) if c.get("kind") != "flush"])
            bot_cand_cache[part_name] = [c for c in raw_b if collider is None or not collider.hits(part_name, c["matrix"])]
        ec: list[dict] = []
        if extra:
            ek = (part_name, tuple((p, tuple(np.round(np.asarray(m, float)[:3, :4], 1).ravel())) for p, _c, m in extra))
            ec = extra_cand_cache.get(ek)
            if ec is None:
                raw_e = distinct(lib, part_name, [c for c in candidates(lib, part_name, extra) if c.get("kind") != "flush"])
                ec = [c for c in raw_e if collider is None or not collider.hits(part_name, c["matrix"])]
                extra_cand_cache[ek] = ec
        out_c = bot_cand_cache[part_name] + ec
        if out_c:
            return out_c
        if part_name not in full_cand_cache:
            raw_f = distinct(lib, part_name, [c for c in candidates(lib, part_name, base) if c.get("kind") != "flush"])
            full_cand_cache[part_name] = [c for c in raw_f if collider is None or not collider.hits(part_name, c["matrix"])]
        return full_cand_cache[part_name]

    def cand_fn(part_name, model_cur):
        extra = model_cur[len(base):]
        return _base_cands_for(part_name, extra)

    all_states: list[State] = []
    for seeded_entries, seeded_scores, rem_parts in anchor_plans[:4]:
        base_plus = list(base) + list(seeded_entries)
        if not rem_parts:
            full_placed = list(seeded_entries)
            full_tot = float(scorer.score(full_placed))
            all_states.append(State(full_placed, list(seeded_scores), full_tot, done=True))
            continue
        scorer_p = ModelScorer(lib, base_plus, pic, view, codes, prev_rgb=prev_rgb, prev_pts=prev_pts)
        def scene_for(_m):
            return None
        try:
            sub_sts = solve_step_exact(lib, scene_for, scorer_p, base_plus, rem_parts, cand_fn,
                                       collider=collider, beam=3, per_part=8, deltas=(0.0,),
                                       fill=False, polish_starts=0, use_milp=False,
                                       time_budget=2.5)
        except Exception:
            continue
        for st in sub_sts[:3]:
            if len(st.placed) != len(rem_parts):
                continue
            full_placed = list(seeded_entries) + [(p, col, clean_matrix(m)) for p, col, m in st.placed]
            # Verify zero overlap and physical stand connectivity to `base` (allow <= 2 loose/misread parts)
            if collider is not None and getattr(collider, "native", None) is not None:
                collider.set_model(base)
                ov, conn_cnt, mates, _grip = collider.layout_check(full_placed)
                if ov or conn_cnt < max(2, len(full_placed) - 2) or mates < 2:
                    continue
            full_scores = list(seeded_scores) + list(st.scores)
            full_tot = float(scorer.score(full_placed))
            all_states.append(State(full_placed, full_scores, full_tot, done=True))

    if not all_states:
        return None

    # 4. Deduplicate and re-rank top completed states jointly with ModelScorer + DINOv2!
    all_states.sort(key=lambda st: -st.total)
    uniq: list[State] = []
    seen_st: set = set()
    for st in all_states:
        k = frozenset((p, c, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 1))) for p, c, m in st.placed)
        if k not in seen_st:
            seen_st.add(k)
            uniq.append(st)
        if len(uniq) >= 6:
            break

    norm = max(1.0, float(scorer.fg.sum() + scorer.ink_fg.sum()))
    dino_sc = score_candidate_layouts(lib, base, [st.placed for st in uniq], pic, view)
    ranked_final = []
    for i, st in enumerate(uniq):
        d_term = (1.1 * float(dino_sc[i])) if (dino_sc is not None and i < len(dino_sc)) else 0.0
        ranked_final.append((float(st.total) / norm + d_term, st))
    ranked_final.sort(key=lambda x: -x[0])
    best_st = ranked_final[0][1]

    # Refine view slightly on the completed model + stand
    full_m = list(base) + list(best_st.placed)
    iou0 = float(view_fit_metrics(lib, full_m, pic, view)[0])
    rv = refine_view(lib, full_m, pic, view, scale_tol=0.05, outer=2)
    iou1 = float(view_fit_metrics(lib, full_m, pic, rv)[0])
    best_v, best_iou = (rv, iou1) if iou1 >= iou0 else (view, iou0)
    sc_norm = float(best_st.total) / norm + 1.0
    res = StepResult(
        best_st.placed, best_st.scores, best_v, sc_norm, base_fit_iou,
        alternatives=[st for _, st in ranked_final[1:]], status="ok",
        completed=sc_norm, hypotheses=[sc_norm],
        orientation_index=orient_idx, state_total=float(best_st.total),
    )
    return res, best_iou


# ------------------------------------------------------------------ 2. Bilateral 3D Symmetry Plane Detection

def detect_symmetry_plane(lib, parts: list) -> tuple[int, float, float] | None:
    """Detect the dominant bilateral mirror plane (`axis in {0: X, 2: Z}`, `coord`, `sym_fraction`).

    Returns `(axis, coord, frac)` when `frac >= 0.55`, else None.
    """
    if len(parts) < 8:
        return None
    chiral = _chiral_mirror_map()
    # Extract centers + base part ids
    items = []
    for p, c, m in parts:
        t = world_triangles(lib, p, np.asarray(m, float)).reshape(-1, 3)
        if not len(t):
            continue
        ctr = 0.5 * (t.min(0) + t.max(0))
        items.append((base_number(p), int(c), ctr))
    if len(items) < 8:
        return None

    best = None  # (frac, axis, coord)
    for axis in (0, 2):
        other = 2 - axis
        votes: Counter[float] = Counter()
        for i in range(len(items)):
            bi, _ci, pi = items[i]
            # Self-centered vote
            votes[round(pi[axis] / 5.0) * 5.0] += 1
            for j in range(i + 1, len(items)):
                bj, _cj, pj = items[j]
                if (bi == bj or chiral.get(bi) == bj) and abs(pi[1] - pj[1]) < 3.0 and abs(pi[other] - pj[other]) < 3.0:
                    mid = round((pi[axis] + pj[axis]) * 0.5 / 5.0) * 5.0
                    votes[mid] += 2
        for coord, _cnt in votes.most_common(4):
            matched = 0
            for i, (bi, _ci, pi) in enumerate(items):
                target = pi.copy()
                target[axis] = 2.0 * coord - pi[axis]
                mb = chiral.get(bi, bi)
                if any((bj == bi or bj == mb) and float(np.linalg.norm(pj - target)) < 3.0 for bj, _cj, pj in items):
                    matched += 1
            frac = matched / len(items)
            if best is None or frac > best[0]:
                best = (frac, axis, float(coord))
    if best is None or best[0] < 0.55:
        return None
    return (best[1], best[2], best[0])


# ------------------------------------------------------------------ 3. Multi-View Top-K Sub-Assembly Attachment

def attach_assembly_top_k(lib, host_parts: list, sub_parts: list, rgb: np.ndarray, pts: float | None,
                          collider=None, camera_prior=None, top_k: int = 12):
    """Return `(view, host_alone_iou, [(sc_norm, iou, T_world, moved), ...])` for top-K legal mates."""
    if not host_parts or not sub_parts or rgb is None:
        return None
    from .step import solve
    reg_res = solve(lib, host_parts, [], rgb, pts, collider=collider, camera=camera_prior)
    if reg_res.view is None:
        return None
    view = reg_res.view
    pic = Picture.from_rgb(rgb, pts, BOOKLET_SCALE / pts if pts else None)
    host_alone_iou = float(view_fit_metrics(lib, host_parts, pic, view)[0])
    codes = sorted({int(c) for _p, c, _m in host_parts} | {int(c) for _p, c, _m in sub_parts})
    scorer = ModelScorer(lib, host_parts, pic, view, codes)

    m0_inv = np.linalg.inv(np.asarray(sub_parts[0][2], float))
    config = [(p, c, m0_inv @ np.asarray(m, float)) for p, c, m in sub_parts]
    options: dict = {}
    ys_sub = [float(np.asarray(m, float)[1, 3]) for _p, _c, m in sub_parts]
    y_min, y_max = min(ys_sub), max(ys_sub)
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
            if np.all((np.abs(np.asarray(c["matrix"], float)[:3, :3]) < 0.05)
                      | (np.abs(np.asarray(c["matrix"], float)[:3, :3]) > 0.95))
        ]
        if ortho_a:
            cands_a = ortho_a
        for cand in cands_a:
            cm = np.asarray(cand["matrix"], float)
            for sym in syms:
                T = clean_matrix((cm @ sym) @ rel_inv @ m0_inv)
                key = tuple(np.round(T[:3, :4], 1).ravel())
                if key not in options:
                    options[key] = T
    if not options:
        return None

    cur_bufs = _build_current_buffers(lib, scorer, [])
    T_list = list(options.values())
    opt_list = [([(p, c, clean_matrix(T_w @ np.asarray(m, float))) for p, c, m in sub_parts], None, True, False)
                for T_w in T_list]
    scored_u = _batch_score_unit_options(lib, scorer, cur_bufs, opt_list, (0.0,))
    pre = [(scored_u[i][0], T_list[i]) for i in range(len(T_list))]
    pre.sort(key=lambda x: -x[0])

    if collider is not None:
        collider.set_model(host_parts)
    norm = max(1.0, float(scorer.fg.sum() + scorer.ink_fg.sum()))
    results = []
    for _sv, T_world in pre[:96]:
        moved = [(p, c, clean_matrix(T_world @ np.asarray(m, float))) for p, c, m in sub_parts]
        if collider is not None and any(collider.hits(p, m) for p, _c, m in moved):
            continue
        sc = float(scorer.score(moved)) / norm
        iou = float(view_fit_metrics(lib, host_parts + moved, pic, view)[0])
        results.append((sc, iou, T_world, moved))
        if len(results) >= top_k:
            break
    if not results:
        return None
    results.sort(key=lambda x: -(x[0] + 0.5 * x[1]))
    return view, host_alone_iou, results


# ------------------------------------------------------------------ 4. Isomorphic Sub-Assembly Clone Transfer & Multi-View Merge Polish

def _map_subassembly_colours(donor_parts: list, target_step_groups: list[list]) -> list[list] | None:
    """Transfer `donor_parts`'s clean 3D rigid geometry onto `target_step_groups`'s (part, colour) entries."""
    # Match each target part to an unclaimed donor part with identical base_number(p)
    used = [False] * len(donor_parts)
    mapped_groups: list[list] = []
    for grp in target_step_groups:
        new_grp = []
        for tp, tc, _tm in grp:
            bt = base_number(tp)
            hit = None
            for di, (dp, _dc, dm) in enumerate(donor_parts):
                if not used[di] and base_number(dp) == bt:
                    hit = di
                    break
            if hit is None:
                return None
            used[hit] = True
            new_grp.append((tp, tc, clean_matrix(donor_parts[hit][2])))
        mapped_groups.append(new_grp)
    return mapped_groups


def refine_subassembly_merges(lib, merge_records: list[dict], assemblies: list[dict], out,
                              step_pics: list, step_views: dict[int, View], collider=None, log=None) -> int:
    """Pass B: Isomorphic sub-assembly clone transfer + multi-view merge optimization (merge page + final page)."""
    if not merge_records:
        return 0
    improvements = 0

    # Find final step page of the booklet (preferring the largest final assembly page!)
    final_si = None
    for si in range(len(step_pics) - 1, -1, -1):
        if step_pics[si][0] is not None:
            final_si = si
            break

    # 1. Check for isomorphic twin sub-assemblies (identical base-part multiset, one solved much cleaner!)
    for rec_a in merge_records:
        parts_a = rec_a["local_parts"]
        if len(parts_a) < 4:
            continue
        sig_a = Counter(base_number(p) for p, _c, _m in parts_a)
        best_donor = None
        for rec_b in merge_records:
            if rec_b is rec_a:
                continue
            parts_b = rec_b["local_parts"]
            if Counter(base_number(p) for p, _c, _m in parts_b) != sig_a:
                continue
            if rec_b["mean_iou"] > rec_a["mean_iou"] + 0.04:
                if best_donor is None or rec_b["mean_iou"] > best_donor["mean_iou"]:
                    best_donor = rec_b

        merge_si = rec_a["merge_si"]
        rgb_m, pts_m, _subs_m = step_pics[merge_si]
        if rgb_m is None:
            continue

        # Identify which parts currently in the final host assembly belong to rec_a vs everything else
        a_step_set = set(rec_a["step_indices"])
        cur_a_parts = [e for si in rec_a["step_indices"] for e in out.groups[si]]
        host_at_merge = [e for si in rec_a["host_steps_before"] for e in out.groups[si]]
        other_final = [e for si, grp in enumerate(out.groups) if si not in a_step_set for e in grp]
        if not host_at_merge or not cur_a_parts:
            continue

        # Build candidate geometries: (1) current A geometry re-mated, (2) donor-cloned A geometry if twin exists!
        geom_sources = [("self", [list(out.groups[si]) for si in rec_a["step_indices"]])]
        if best_donor is not None:
            cloned_groups = _map_subassembly_colours(
                best_donor["local_parts"],
                [list(out.groups[si]) for si in rec_a["step_indices"]],
            )
            if cloned_groups is not None:
                geom_sources.append(("clone", cloned_groups))

        # Collect candidate transforms for each geometry source
        candidates_eval: list[tuple[str, list[list], list]] = [("current", [list(out.groups[si]) for si in rec_a["step_indices"]], cur_a_parts)]
        merge_view = step_views.get(merge_si)
        cam_p_merge = (merge_view, None, -1e9) if merge_view is not None else None
        for tag, grp_list in geom_sources:
            flat_sub = [e for g in grp_list for e in g]
            att = attach_assembly_top_k(lib, host_at_merge, flat_sub, rgb_m, pts_m, collider=collider,
                                        camera_prior=cam_p_merge, top_k=10)
            if att is None:
                continue
            v_m, _h_iou, top_list = att
            if merge_view is None:
                merge_view = v_m
                cam_p_merge = (merge_view, None, -1e9)
            # Check collision against ALL other parts in the final model too!
            if collider is not None:
                collider.set_model(other_final)
            for _sc, _iou, T_w, moved_flat in top_list[:6]:
                if collider is not None and any(collider.hits(p, m) for p, _c, m in moved_flat):
                    continue
                moved_grps = [[(p, c, clean_matrix(T_w @ np.asarray(m, float))) for p, c, m in g] for g in grp_list]
                candidates_eval.append((tag, moved_grps, moved_flat))

        if len(candidates_eval) <= 1 or merge_view is None:
            continue

        # Evaluate ALL candidates jointly on BOTH `merge_si` AND `final_si` (if distinct & registered)!
        eval_pages = [(host_at_merge, [], rgb_m, pts_m, merge_view)]
        cand_per_page = [[c[2]] for c in candidates_eval]
        if final_si is not None and final_si != merge_si and step_pics[final_si][0] is not None:
            rgb_f, pts_f, _ = step_pics[final_si]
            v_f = step_views.get(final_si)
            if v_f is None:
                from .step import solve
                rf = solve(lib, other_final, [], rgb_f, pts_f, collider=collider)
                v_f = rf.view
            if v_f is not None:
                eval_pages.append((other_final, [], rgb_f, pts_f, v_f))
                for k in range(len(candidates_eval)):
                    cand_per_page[k].append(candidates_eval[k][2])

        scores = _eval_multiview_score(lib, eval_pages, cand_per_page, use_dino=True)
        base_comb, base_ms, base_dino = scores[0]
        best_k = int(np.argmax([s[0] for s in scores]))
        win_comb, win_ms, win_dino = scores[best_k]

        if best_k != 0 and win_comb > base_comb + 0.025:
            tag_w, moved_grps_w, moved_flat_w = candidates_eval[best_k]
            for si, new_g in zip(rec_a["step_indices"], moved_grps_w):
                out.groups[si] = new_g
            # Sync live assemblies list
            for asm in assemblies:
                if any(si in asm["step_indices"] for si in rec_a["step_indices"]):
                    asm["parts"] = [e for si in asm["step_indices"] for e in out.groups[si]]
            improvements += 1
            if log:
                log({"global_opt": "subassembly_merge_upgrade", "source": tag_w, "merge_step": merge_si + 1,
                     "delta_comb": round(win_comb - base_comb, 4), "delta_ms": round(win_ms - base_ms, 4),
                     "delta_dino": round(win_dino - base_dino, 4)})
    return improvements


# ------------------------------------------------------------------ 5. Articulation-Bridge Twist Unwinding + Downstream Re-Solve

def _rigid_rotate_around_y(parts: list, pivot_xz: tuple[float, float], k_turns: int,
                           shift_xz: tuple[float, float] = (0.0, 0.0)) -> tuple[np.ndarray, list]:
    """Rotate `parts` by `k_turns * 90 deg` around vertical axis `(pivot_x, y, pivot_z)` + `(dx, dz)` shift."""
    px, pz = pivot_xz
    dx, dz = shift_xz
    T_to = np.eye(4); T_to[0, 3] = -px; T_to[2, 3] = -pz
    T_rot = _turn(k_turns)
    T_bk = np.eye(4); T_bk[0, 3] = px + dx; T_bk[2, 3] = pz + dz
    T = clean_matrix(T_bk @ T_rot @ T_to)
    return T, [(p, c, clean_matrix(T @ np.asarray(m, float))) for p, c, m in parts]


def _bridge_touch_count(lib, prefix: list, suffix: list) -> tuple[int, list[np.ndarray]]:
    """Count prefix bricks whose 3D bounding box touches/overlaps suffix within 3 LDU; return their centers."""
    touch_centers = []
    for pe in prefix:
        if any(_boxes_overlap(lib, pe, se, shrink=-3.0) for se in suffix):
            t = world_triangles(lib, pe[0], np.asarray(pe[2], float)).reshape(-1, 3)
            if len(t):
                touch_centers.append(0.5 * (t.min(0) + t.max(0)))
    return len(touch_centers), touch_centers


def unwind_articulation_twists(lib, assemblies: list[dict], out, step_pics: list, steps_parts: list,
                               step_views: dict[int, View], collider=None, log=None) -> int:
    """Pass A: Detect and fix 90/180/270-deg frame twists across early-to-mid articulation bridges!

    Tests rotating `prefix = asm_steps[:pos]` around the bridge pivot relative to `suffix = asm_steps[pos:]`
    using multi-view ModelScorer + DINOv2 across 5-6 diverse suffix pages. When a non-zero turn wins
    decisively on BOTH ModelScorer and DINOv2 with zero collision, commits the untwisted prefix and
    selectively re-solves downstream collided / low-fit suffix steps on top of the true untwisted base!
    """
    from .step import SectionCamera, solve

    fixes = 0
    for asm in assemblies:
        s_indices = [si for si in asm["step_indices"] if out.groups[si]]
        if len(s_indices) < 8:
            continue

        # Score candidate split points `pos` (where prefix has 4..28 parts and suffix has >= 12 parts)
        split_cands = []
        for pos in range(2, min(14, len(s_indices) - 4)):
            pref_sis = s_indices[:pos]
            suff_sis = s_indices[pos:]
            pref = [e for si in pref_sis for e in out.groups[si]]
            suff = [e for si in suff_sis for e in out.groups[si]]
            if not (4 <= len(pref) <= 28 and len(suff) >= 12):
                continue
            # Count touches ONLY against immediate next 2 suffix steps (not late stands/arms!)
            near_suff = [e for si in suff_sis[:2] for e in out.groups[si]]
            n_touch, touch_ctrs = _bridge_touch_count(lib, pref, near_suff)
            if n_touch == 0:
                continue
            row_prev = out.rows[pref_sis[-1]] if pref_sis[-1] < len(out.rows) else {}
            row_cur = out.rows[suff_sis[0]] if suff_sis[0] < len(out.rows) else {}
            row_nxt = out.rows[suff_sis[1]] if len(suff_sis) > 1 and suff_sis[1] < len(out.rows) else {}
            # Detect IoU dip RIGHT AT `suff_sis[0]` (e.g. step 6 dropping to 0.816 -> split BEFORE step 6!)
            # or right after `suff_sis[0]` (e.g. step 8 dropping to pre_fit_iou 0.639!)
            dip_at_cur = float(row_cur.get("post_fit_iou") or 1.0) < 0.86 or float(row_cur.get("pre_fit_iou") or 1.0) < 0.82
            dip_at_nxt = float(row_nxt.get("pre_fit_iou") or 1.0) < 0.80 or float(row_prev.get("post_fit_iou") or 1.0) < 0.86
            narrow = n_touch <= 6
            small_bridge_step = len(out.groups[suff_sis[0]]) <= 3
            prio = (4 if dip_at_cur else 0) + (2 if dip_at_nxt else 0) + (2 if narrow else 0) + (1 if small_bridge_step else 0)
            if prio >= 2:
                split_cands.append((prio, -n_touch, pos, pref_sis, suff_sis, touch_ctrs))

        if not split_cands:
            continue
        split_cands.sort(key=lambda x: (-x[0], -x[1]))

        # Evaluate top-4 distinct candidate split positions
        for _prio, _nt, pos, pref_sis, suff_sis, touch_ctrs in split_cands[:4]:
            pref = [e for si in pref_sis for e in out.groups[si]]
            suff = [e for si in suff_sis for e in out.groups[si]]
            # Candidate pivots: (1) XZ center of `pref` bounding box, (2) XZ centroid of immediate bridge bricks
            pref_pts = np.concatenate([world_triangles(lib, p, np.asarray(m, float)).reshape(-1, 3) for p, _c, m in pref])
            p_mid = 0.5 * (pref_pts.min(0) + pref_pts.max(0))
            piv_pref = (round(float(p_mid[0]) / 10.0) * 10.0, round(float(p_mid[2]) / 10.0) * 10.0)
            ctr = np.mean(touch_ctrs, axis=0)
            piv_br = (round(float(ctr[0]) / 10.0) * 10.0, round(float(ctr[2]) / 10.0) * 10.0)
            pivots = [piv_pref] if piv_pref == piv_br else [piv_pref, piv_br]

            # Pick up to 5 diverse suffix pages spanning early, mid, and late suffix steps
            valid_suff = [si for si in suff_sis if step_pics[si][0] is not None and step_views.get(si) is not None]
            if len(valid_suff) < 3:
                continue
            pick_idxs = sorted(set([
                valid_suff[min(1, len(valid_suff) - 1)],
                valid_suff[min(2, len(valid_suff) - 1)],
                valid_suff[len(valid_suff) // 2],
                valid_suff[(3 * len(valid_suff)) // 4],
                valid_suff[-1],
            ]))[:5]

            # Check collision ONLY against suffix parts resting strictly ABOVE `pref`'s mid-height
            # (so corrupted arms/accessories hanging alongside a twisted torso never block unwinding!)
            pref_y_lo, pref_y_hi = _model_y_bounds(lib, pref)
            suff_above = [e for e in suff if _model_y_bounds(lib, [e])[1] <= pref_y_lo + 10.0]
            if collider is not None and suff_above:
                collider.set_model(suff_above)

            rot_hyps = [(0, np.eye(4), pref)]
            for k_turn in (1, 2, 3):
                best_shift = None  # (mates, -shift_dist, T, moved)
                for piv in pivots:
                    for dx in (0.0, 10.0, -10.0, 20.0, -20.0):
                        for dz in (0.0, 10.0, -10.0, 20.0, -20.0):
                            if abs(dx) + abs(dz) > 20.0:
                                continue
                            T_k, moved_k = _rigid_rotate_around_y(pref, piv, k_turn, (dx, dz))
                            if collider is not None and suff_above and any(collider.hits(p, m) for p, _c, m in moved_k):
                                continue
                            mates = 0
                            if collider is not None and suff_above and getattr(collider, "native", None) is not None:
                                for p, _c, m in moved_k:
                                    m_cnt, _ = collider.mates(p, m)
                                    mates += int(m_cnt)
                            else:
                                mates, _ = _bridge_touch_count(lib, moved_k, suff)
                            if mates <= 0 and suff_above:
                                # Allow vertical gap if a single noisy bridge step (e.g. s6) sits between pref & suff_above
                                mates, _ = _bridge_touch_count(lib, moved_k, suff[:min(12, len(suff))])
                            if mates <= 0:
                                continue
                            cand_rank = (mates, -(abs(dx) + abs(dz)))
                            if best_shift is None or cand_rank > best_shift[0]:
                                best_shift = (cand_rank, T_k, moved_k)
                        if best_shift is not None and best_shift[0][1] == 0.0 and best_shift[0][0] >= 2:
                            break
                    if best_shift is not None and best_shift[0][1] == 0.0 and best_shift[0][0] >= 2:
                        break
                if best_shift is not None:
                    rot_hyps.append((k_turn, best_shift[1], best_shift[2]))

            if len(rot_hyps) <= 1:
                continue

            # Score all surviving rotations jointly across `pick_idxs` (locking each page's camera to `suffix_up_to_si`!)
            eval_pages = []
            cand_per_page = [[] for _ in rot_hyps]
            for si in pick_idxs:
                suff_upto = [e for s2 in suff_sis if s2 <= si for e in out.groups[s2]]
                rgb_s, pts_s, _ = step_pics[si]
                v_s = step_views[si]
                eval_pages.append((suff_upto, [], rgb_s, pts_s, v_s))
                for h_i, (_kt, _Tk, moved_k) in enumerate(rot_hyps):
                    cand_per_page[h_i].append(moved_k)

            scores = _eval_multiview_score(lib, eval_pages, cand_per_page, use_dino=True)
            base_comb, base_ms, base_dino = scores[0]
            best_h = int(np.argmax([s[0] for s in scores]))
            win_comb, win_ms, win_dino = scores[best_h]

            # Strict dual-evidence gate: non-zero twist must beat 0-deg on BOTH ModelScorer AND DINOv2!
            if best_h != 0 and win_comb > base_comb + 0.035 and win_ms > base_ms + 0.015 and win_dino > base_dino + 0.004:
                k_win, T_win, _moved_win = rot_hyps[best_h]
                # 1. Commit the untwisted prefix and invalidate its stale pre-rotation views!
                for si in pref_sis:
                    out.groups[si] = [(p, c, clean_matrix(T_win @ np.asarray(m, float))) for p, c, m in out.groups[si]]
                    step_views.pop(si, None)
                if log:
                    log({"global_opt": "twist_unwound", "split_step": suff_sis[0] + 1, "turn_deg": k_win * 90,
                         "delta_comb": round(win_comb - base_comb, 4), "delta_ms": round(win_ms - base_ms, 4),
                         "delta_dino": round(win_dino - base_dino, 4)})

                # 2. Selectively re-solve downstream suffix steps that collided or struggled on the old twisted body!
                sec = SectionCamera()
                cur_parts = [e for si in pref_sis for e in out.groups[si]]
                for idx_s, si in enumerate(suff_sis):
                    cur_grp = out.groups[si]
                    rgb_s, pts_s, subs_s = step_pics[si]
                    read_s = steps_parts[si]
                    row_s = out.rows[si] if si < len(out.rows) else {}
                    old_pre = float(row_s.get("pre_fit_iou") or 1.0)
                    old_post = float(row_s.get("post_fit_iou") or 1.0)
                    # Check if existing suffix step now collides with updated `cur_parts`
                    has_col = False
                    if collider is not None and cur_grp:
                        collider.set_model(cur_parts)
                        has_col = any(collider.hits(p, m) for p, _c, m in cur_grp)
                    # Re-solve if collided, low pre/post IoU, large baseplate step, or subbuild step right after twist!
                    need_resolve = (
                        bool(read_s.parts) and rgb_s is not None and (
                            has_col
                            or old_pre < 0.80
                            or old_post < 0.91
                            or (idx_s <= 2 and subs_s)
                            or has_large_baseplate(lib, list(read_s.parts)) is not None
                        )
                    )
                    if need_resolve:
                        prev_si = s_indices[s_indices.index(si) - 1]
                        prev_rgb, prev_pts, _ = step_pics[prev_si] if prev_si >= 0 else (None, None, [])
                        nxt_si = suff_sis[idx_s + 1] if idx_s + 1 < len(suff_sis) else None
                        nxt_rgb, nxt_pts, _ = step_pics[nxt_si] if nxt_si is not None else (None, None, [])
                        cam_p = sec.prior(0)
                        try:
                            res_new = solve(lib, cur_parts, list(read_s.parts), rgb_s, pts_s, collider=collider,
                                            subbuilds=subs_s, camera=cam_p,
                                            prev_rgb=prev_rgb, prev_pts=prev_pts, next_rgb=nxt_rgb, next_pts=nxt_pts)
                        except Exception:
                            res_new = None
                        # Also test baseplate sub-assembly hypothesis if applicable!
                        if has_large_baseplate(lib, list(read_s.parts)) is not None and not subs_s:
                            stand_out = solve_base_subassembly(lib, cur_parts, list(read_s.parts), rgb_s, pts_s,
                                                               collider=collider, camera_prior=cam_p,
                                                               prev_rgb=prev_rgb, prev_pts=prev_pts,
                                                               init_view=res_new.view if res_new is not None else None)
                            if stand_out is not None:
                                res_st, _st_iou = stand_out
                                if res_new is None or not res_new.placed or res_st.completed > res_new.completed:
                                    res_new = res_st
                        if res_new is not None and res_new.placed and len(res_new.placed) == len(read_s.parts):
                            # Accept if old collided OR new beats old on ModelScorer + DINOv2!
                            accept = has_col or not cur_grp
                            if not accept and res_new.view is not None:
                                sc_cmp = _eval_multiview_score(
                                    lib, [(cur_parts, [], rgb_s, pts_s, res_new.view)],
                                    [[cur_grp], [res_new.placed]], use_dino=True,
                                )
                                accept = sc_cmp[1][0] > sc_cmp[0][0] + 0.015
                            if accept:
                                out.groups[si] = list(res_new.placed)
                                step_views[si] = res_new.view
                                sec.add(0, res_new, len(cur_parts))
                                cur_grp = out.groups[si]
                    else:
                        v_old = step_views.get(si)
                        if v_old is not None and cur_grp:
                            from .step import StepResult
                            sec.add(0, StepResult(cur_grp, [], v_old, 1.5, old_pre, completed=1.5), len(cur_parts))
                    cur_parts = cur_parts + list(cur_grp)

                asm["parts"] = cur_parts
                fixes += 1
                break  # one twist fix per assembly pass
    return fixes


# ------------------------------------------------------------------ 6. Multi-View Hindsight Alternative & Symmetry Polish

def _find_step_hinge_pin(before_parts: list, step_parts: list) -> tuple[np.ndarray, np.ndarray] | None:
    """If `step_parts` mates onto `before_parts` through a BrickNet hinge connector, return `(pivot, axis)`."""
    from brickheadz.connectors import catalog
    from .joints import _axial_connectors

    cat = catalog()
    step_hinges = []
    for p, _c, m in step_parts:
        m = np.asarray(m, float)
        for fam, sub, fm, _l in _axial_connectors(p, cat):
            if fam.startswith("hinge:"):
                step_hinges.append((fam, sub, m @ fm))
    if not step_hinges:
        return None
    for hp, _hc, hm in before_parts:
        hm = np.asarray(hm, float)
        for fam_h, sub_h, fh, _l in _axial_connectors(hp, cat):
            if not fam_h.startswith("hinge:"):
                continue
            wh = hm @ fh
            p_h = wh[:3, 3]
            ax_h = wh[:3, 1]
            ax_h = ax_h / max(float(np.linalg.norm(ax_h)), 1e-8)
            for fam_s, sub_s, ws in step_hinges:
                if fam_s == fam_h and sub_s != sub_h:
                    if float(np.linalg.norm(ws[:3, 3] - p_h)) < 2.5:
                        ax_s = ws[:3, 1]
                        ax_s = ax_s / max(float(np.linalg.norm(ax_s)), 1e-8)
                        if abs(float(np.dot(ax_h, ax_s))) > 0.96:
                            return p_h, ax_h
    return None


def _rotate_rigid_about_pin(parts: list, pivot: np.ndarray, axis: np.ndarray, deg: float) -> list:
    from .exact_place import _rotate_about_axis
    R = _rotate_about_axis(axis, deg)
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = pivot - R @ pivot
    return [(p, c, clean_matrix(T @ np.asarray(m, float))) for p, c, m in parts]


def refine_multiview_hindsight(lib, assemblies: list[dict], out, step_pics: list,
                               step_views: dict[int, View], step_alts: dict[int, list[State]],
                               collider=None, log=None) -> int:
    """Pass C: Re-rank saved step alternatives & sweep hinged sub-assembly angles using FUTURE booklet views + DINOv2!

    1. For any step `si` that recorded runner-up beam states `step_alts[si]`, checks whether a runner-up
       that fits all future pages (`si+1`, rotated views, final page) WITHOUT colliding with later steps
       beats the greedily chosen step-`si` placement jointly across `(si, future pages)`.
    2. For any step `si` attached to the model through a physical hinge pin (e.g. articulated arms/wings/
       doors whose step-`si` picture drew them exploded at 0 deg while later pages show them angled at 30 deg!),
       sweeps the entire rigid step sub-assembly around its hinge pin axis scored strictly on future seated pages!
    """
    changes = 0
    for asm in assemblies:
        s_indices = [si for si in asm["step_indices"] if out.groups[si]]
        if len(s_indices) < 3:
            continue
        for pos, si in enumerate(s_indices[:-1]):
            cur_grp = out.groups[si]
            if not cur_grp:
                continue
            # Pick up to 3 future views in the same assembly (next step, +2/+3, and final step)
            fut_sis = [s2 for s2 in s_indices[pos + 1:] if step_pics[s2][0] is not None and step_views.get(s2) is not None]
            if not fut_sis:
                continue
            pick_fut = [fut_sis[0]]
            if len(fut_sis) >= 3:
                pick_fut.append(fut_sis[len(fut_sis) // 2])
            if len(fut_sis) >= 2 and fut_sis[-1] not in pick_fut:
                pick_fut.append(fut_sis[-1])

            before_parts = [e for s2 in s_indices[:pos] for e in out.groups[s2]]
            after_parts = [e for s2 in s_indices[pos + 1:] for e in out.groups[s2]]
            other_all = before_parts + after_parts

            # C1: Continuous 1-DoF rigid hinge-angle optimization on FUTURE SEATED pages!
            pin = _find_step_hinge_pin(before_parts, cur_grp)
            if pin is not None:
                pivot, axis = pin
                if collider is not None:
                    collider.set_model(other_all)
                hinge_cands = [(0.0, cur_grp)]
                for deg in (-75.0, -60.0, -45.0, -30.0, -22.5, -15.0, 15.0, 22.5, 30.0, 45.0, 60.0, 75.0):
                    rot_grp = _rotate_rigid_about_pin(cur_grp, pivot, axis, deg)
                    if collider is not None and any(collider.hits(p, m) for p, _c, m in rot_grp):
                        continue
                    hinge_cands.append((deg, rot_grp))
                if len(hinge_cands) > 1:
                    eval_h = [
                        ([e for s2 in s_indices if s2 <= fsi and s2 != si for e in out.groups[s2]],
                         [], step_pics[fsi][0], step_pics[fsi][1], step_views[fsi])
                        for fsi in pick_fut
                    ]
                    cand_h = [[grp for _ in eval_h] for _deg, grp in hinge_cands]
                    h_scores = _eval_multiview_score(lib, eval_h, cand_h, use_dino=True)
                    best_hi = int(np.argmax([s[0] for s in h_scores]))
                    dual_agree = (h_scores[best_hi][1] > h_scores[0][1] + 0.001 and h_scores[best_hi][2] > h_scores[0][2] + 0.003)
                    min_h_gain = 0.008 if dual_agree else 0.015
                    if best_hi != 0 and h_scores[best_hi][0] > h_scores[0][0] + min_h_gain:
                        out.groups[si] = hinge_cands[best_hi][1]
                        cur_grp = out.groups[si]
                        asm["parts"] = [e for s2 in asm["step_indices"] for e in out.groups[s2]]
                        changes += 1
                        if log:
                            log({"global_opt": "multiview_hinge_angle", "step": si + 1,
                                 "delta_deg": hinge_cands[best_hi][0],
                                 "delta_comb": round(h_scores[best_hi][0] - h_scores[0][0], 4)})
                        # Never let C2's un-rotated 0-deg step_alts overwrite a freshly optimized hinge angle!
                        continue

            # C2: Multi-view alternative beam re-selection across (step si [drawn], future pages [seated])
            alts = step_alts.get(si)
            v_cur = step_views.get(si)
            rgb_cur, pts_cur, _ = step_pics[si]
            if not alts or v_cur is None or rgb_cur is None:
                continue
            # Safety guard: verify `v_cur` is still in the same coordinate frame as `before_parts + cur_grp`!
            pic_chk = Picture.from_rgb(rgb_cur, pts_cur, BOOKLET_SCALE / pts_cur if pts_cur else None)
            if float(view_fit_metrics(lib, before_parts + cur_grp, pic_chk, v_cur)[0]) < 0.72:
                continue
            if collider is not None:
                collider.set_model(other_all)

            valid_cands: list[tuple[list, list]] = [(cur_grp, cur_grp)]  # (seated, drawn)
            seen_k = {frozenset((p, c, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 1))) for p, c, m in cur_grp)}
            for st in alts[:4]:
                if len(st.placed) != len(cur_grp):
                    continue
                pl_clean = [(p, c, clean_matrix(m)) for p, c, m in st.placed]
                k = frozenset((p, c, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 1))) for p, c, m in pl_clean)
                if k in seen_k:
                    continue
                if collider is not None and any(collider.hits(p, m) for p, _c, m in pl_clean):
                    continue
                seen_k.add(k)
                dr_clean = [(p, c, clean_matrix(m)) for p, c, m in _drawn_entries(pl_clean, st.scores)]
                valid_cands.append((pl_clean, dr_clean))

            if len(valid_cands) <= 1:
                continue

            eval_pages = [(before_parts, [], rgb_cur, pts_cur, v_cur)]
            cand_per_page = [[dr] for _se, dr in valid_cands]
            for fsi in pick_fut[:2]:
                static_f = [e for s2 in s_indices if s2 <= fsi and s2 != si for e in out.groups[s2]]
                rgb_f, pts_f, _ = step_pics[fsi]
                eval_pages.append((static_f, [], rgb_f, pts_f, step_views[fsi]))
                for ci, (se, _dr) in enumerate(valid_cands):
                    cand_per_page[ci].append(se)

            scores = _eval_multiview_score(lib, eval_pages, cand_per_page, use_dino=True)
            best_ci = int(np.argmax([s[0] for s in scores]))
            # Require strict dual-signal agreement (ModelScorer AND DINOv2) to prevent noisy false switches!
            if (best_ci != 0 and scores[best_ci][0] > scores[0][0] + 0.035
                    and scores[best_ci][1] > scores[0][1] + 0.005
                    and scores[best_ci][2] > scores[0][2] + 0.003):
                out.groups[si] = valid_cands[best_ci][0]
                asm["parts"] = [e for s2 in asm["step_indices"] for e in out.groups[s2]]
                changes += 1
                if log:
                    log({"global_opt": "hindsight_alt_switch", "step": si + 1,
                         "delta_comb": round(scores[best_ci][0] - scores[0][0], 4)})
    return changes


# ------------------------------------------------------------------ 7. Global Bilateral Symmetry & Multi-View In-Place Polish

def _mirror_matrix(m: np.ndarray, axis: int, coord: float) -> np.ndarray:
    """Proper right-handed reflection of 4x4 LDraw pose `m` across `axis == coord` (0: X, 2: Z)."""
    S = np.diag([-1.0, 1.0, 1.0]) if axis == 0 else np.diag([1.0, 1.0, -1.0])
    out = np.array(m, dtype=float, copy=True)
    out[:3, :3] = S @ out[:3, :3] @ S
    out[axis, 3] = 2.0 * coord - out[axis, 3]
    return clean_matrix(out)


def polish_bilateral_symmetry_multiview(lib, assemblies: list[dict], out, step_pics: list,
                                        step_views: dict[int, View], collider=None, log=None) -> int:
    """Pass D: Global bilateral-symmetry & multi-view in-place brick polish.

    For assemblies with a clear detected bilateral symmetry plane (`frac >= 0.60`), checks bricks
    missing an exact mirror counterpart:
      1. Proposes exact collision-free, physically mated mirror poses reflected from opposite-side
         bricks of the same (or chiral L/R) part mould.
      2. Tests collision-free, physically mated 90/180/270-deg in-place yaw turns.
    Every move is accepted ONLY if it strictly improves multi-view ModelScorer + DINOv2 across
    (step si, final assembled page) with zero collisions!
    """
    chiral = _chiral_mirror_map()
    changes = 0
    for asm in assemblies:
        s_indices = [si for si in asm["step_indices"] if out.groups[si]]
        if len(s_indices) < 4:
            continue
        all_parts = [e for si in s_indices for e in out.groups[si]]
        sym = detect_symmetry_plane(lib, all_parts)
        if sym is None or sym[2] < 0.60:
            continue
        axis, coord, _frac = sym
        final_si = next((si for si in reversed(s_indices) if step_pics[si][0] is not None and step_views.get(si) is not None), None)

        # Build fast lookup of all placed bricks with centers
        def _center_of(e):
            t = world_triangles(lib, e[0], np.asarray(e[2], float)).reshape(-1, 3)
            return 0.5 * (t.min(0) + t.max(0)) if len(t) else np.asarray(e[2], float)[:3, 3]

        all_ctrs = [_center_of(e) for e in all_parts]
        all_bases = [base_number(e[0]) for e in all_parts]

        for pos, si in enumerate(s_indices):
            v_cur = step_views.get(si)
            rgb_cur, pts_cur, _ = step_pics[si]
            if v_cur is None or rgb_cur is None:
                continue
            grp = out.groups[si]
            if not grp:
                continue
            for bi, (p, c, m) in enumerate(grp):
                bp = base_number(p)
                mp_base = chiral.get(bp, bp)
                ctr = _center_of((p, c, m))
                mir_ctr = ctr.copy()
                mir_ctr[axis] = 2.0 * coord - ctr[axis]
                # Skip bricks that already have a tight mirror counterpart in the model!
                has_twin = any(
                    (all_bases[j] == bp or all_bases[j] == mp_base) and float(np.linalg.norm(all_ctrs[j] - mir_ctr)) < 2.5
                    for j in range(len(all_parts))
                )
                if has_twin:
                    continue

                # Build candidate replacement poses for this single brick:
                # (a) Reflected poses of any opposite-side brick of matching base/chiral mould that lacks a twin
                cand_mats: list[np.ndarray] = []
                seen_k = {tuple(np.round(np.asarray(m, float)[:3, :4], 1).ravel())}
                for j, (pj, cj, mj) in enumerate(all_parts):
                    if all_bases[j] not in (bp, mp_base):
                        continue
                    # Only reflect opposite-side bricks
                    if (all_ctrs[j][axis] - coord) * (ctr[axis] - coord) > 4.0:
                        continue
                    mm = _mirror_matrix(mj, axis, coord)
                    k = tuple(np.round(mm[:3, :4], 1).ravel())
                    if k not in seen_k:
                        seen_k.add(k)
                        cand_mats.append(mm)
                # (b) In-place 90/180/270 yaw turns around brick's own center
                for kt in (1, 2, 3):
                    _, moved_t = _rigid_rotate_around_y([(p, c, m)], (float(ctr[0]), float(ctr[2])), kt)
                    mt = moved_t[0][2]
                    k = tuple(np.round(mt[:3, :4], 1).ravel())
                    if k not in seen_k:
                        seen_k.add(k)
                        cand_mats.append(mt)

                if not cand_mats:
                    continue

                # Check collision & physical mating against the rest of the ENTIRE assembly
                other_all = [
                    e for s2 in s_indices for k2, e in enumerate(out.groups[s2])
                    if not (s2 == si and k2 == bi)
                ]
                if collider is not None:
                    collider.set_model(other_all)
                legal = [(p, c, clean_matrix(m))]
                for cm in cand_mats[:8]:
                    if collider is not None:
                        if collider.hits(p, cm):
                            continue
                        if getattr(collider, "native", None) is not None and collider.mates(p, cm)[0] <= 0:
                            continue
                    legal.append((p, c, cm))
                if len(legal) <= 1:
                    continue

                # Score jointly on step `si` + final page (when distinct) via ModelScorer + DINOv2!
                static_si = [e for s2 in s_indices[:pos] for e in out.groups[s2]] + [
                    e for k2, e in enumerate(grp) if k2 != bi
                ]
                eval_pages = [(static_si, [], rgb_cur, pts_cur, v_cur)]
                cand_per_page = [[[entry]] for entry in legal]
                if final_si is not None and final_si != si:
                    eval_pages.append((other_all, [], step_pics[final_si][0], step_pics[final_si][1], step_views[final_si]))
                    for ci_l, entry in enumerate(legal):
                        cand_per_page[ci_l].append([entry])

                scores = _eval_multiview_score(lib, eval_pages, cand_per_page, use_dino=True)
                best_l = int(np.argmax([s[0] for s in scores]))
                if best_l != 0 and scores[best_l][0] > scores[0][0] + 0.012:
                    new_grp = list(out.groups[si])
                    new_grp[bi] = legal[best_l]
                    out.groups[si] = new_grp
                    asm["parts"] = [e for s2 in s_indices for e in out.groups[s2]]
                    all_parts = asm["parts"]
                    all_ctrs = [_center_of(e) for e in all_parts]
                    all_bases = [base_number(e[0]) for e in all_parts]
                    changes += 1
                    if log:
                        log({"global_opt": "symmetry_multiview_polish", "step": si + 1, "part": p,
                             "delta_comb": round(scores[best_l][0] - scores[0][0], 4)})
    return changes


# ------------------------------------------------------------------ 8. SCANet Multi-View Retroactive Error Localization & Stereo Self-Correction

def _view_angle_deg(a: View, b: View) -> float:
    r = np.asarray(a.matrix, float)[:3, :3] @ np.asarray(b.matrix, float)[:3, :3].T
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1.0) * 0.5, -1.0, 1.0))))


def scanet_multiview_correct(lib, assemblies: list[dict], out, step_pics: list,
                             step_views: dict[int, View], step_alts: dict[int, list[State]],
                             collider=None, log=None) -> int:
    """Pass E (SCANet, IROS 2024): Multi-view retroactive error localization & stereo self-correction.

    When later booklet pages rotate the assembly by >= 60 deg (e.g. 90/180-deg back/side turns),
    earlier occluded or visually-tied bricks become directly visible! This pass:
      1. Pairs each earlier step `si` with up to 2 maximally separated future viewpoints (`angle >= 60 deg`).
      2. Re-evaluates saved `step_alts[si]` AND single-brick collision-free, physically mated candidate
         repairs (in-place 90/180/270 yaw flips + top rotated-view connector mates) jointly across
         `(step si view, rotated future views)` using ModelScorer + FoundPose DINOv2 + BrickPriorNet v3.
      3. Accepts strictly under dual visual agreement + zero collision against the ENTIRE assembly +
         no step-`si` regression!
    """
    from . import brick_prior
    from .place import distinct

    bp = brick_prior.prior()
    has_nat = collider is not None and getattr(collider, "native", None) is not None
    changes = 0

    for asm in assemblies:
        s_indices = [si for si in asm["step_indices"] if out.groups[si]]
        if len(s_indices) < 6:
            continue

        # Collect steps with valid registered views
        viewed = [(pos, si, step_views[si]) for pos, si in enumerate(s_indices)
                  if step_pics[si][0] is not None and step_views.get(si) is not None]
        if len(viewed) < 3:
            continue

        for pos, si, v_cur in viewed[:-1]:
            grp = out.groups[si]
            if not grp or len(grp) > 6:
                continue
            rgb_cur, pts_cur, _ = step_pics[si]
            # Find future views rotated >= 60 deg from `v_cur`!
            rot_futs = []
            for _p2, fsi, vf in viewed:
                if fsi <= si:
                    continue
                ang = _view_angle_deg(v_cur, vf)
                if ang >= 60.0:
                    rot_futs.append((ang, fsi, vf))
            if not rot_futs:
                continue
            # Pick up to 2 diverse rotated views (earliest strong turn + largest-angle/latest turn)
            rot_futs.sort(key=lambda x: (x[1]))
            pick_rot = [rot_futs[0][1]]
            widest = max(rot_futs, key=lambda x: (x[0], x[1]))[1]
            if widest not in pick_rot:
                pick_rot.append(widest)

            before_parts = [e for s2 in s_indices[:pos] for e in out.groups[s2]]
            after_parts = [e for s2 in s_indices[pos + 1:] for e in out.groups[s2]]
            other_all = before_parts + after_parts
            if not before_parts:
                continue

            # Guard: verify `v_cur` is still aligned to `before_parts + grp`
            pic_cur = Picture.from_rgb(rgb_cur, pts_cur, BOOKLET_SCALE / pts_cur if pts_cur else None)
            if float(view_fit_metrics(lib, before_parts + grp, pic_cur, v_cur)[0]) < 0.72:
                continue

            # --- E1: Re-rank saved step_alts[si] on (step si + rotated future views) ---
            alts = step_alts.get(si)
            if alts:
                if collider is not None:
                    collider.set_model(other_all)
                valid_cands = [(grp, grp)]
                seen_k = {frozenset((p, c, tuple(np.round(np.asarray(m, float)[:3, 3], 1)),
                                     tuple(np.round(np.asarray(m, float)[:3, :3].ravel(), 1))) for p, c, m in grp)}
                for st in alts[:4]:
                    if len(st.placed) != len(grp):
                        continue
                    pl_c = [(p, c, clean_matrix(m)) for p, c, m in st.placed]
                    k = frozenset((p, c, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 1))) for p, c, m in pl_c)
                    if k in seen_k:
                        continue
                    if collider is not None and any(collider.hits(p, m) for p, _c, m in pl_c):
                        continue
                    seen_k.add(k)
                    dr_c = [(p, c, clean_matrix(m)) for p, c, m in _drawn_entries(pl_c, st.scores)]
                    valid_cands.append((pl_c, dr_c))
                if len(valid_cands) > 1:
                    eval_pages = [(before_parts, [], rgb_cur, pts_cur, v_cur)]
                    cand_pp = [[dr] for _se, dr in valid_cands]
                    for fsi in pick_rot:
                        st_f = [e for s2 in s_indices if s2 <= fsi and s2 != si for e in out.groups[s2]]
                        eval_pages.append((st_f, [], step_pics[fsi][0], step_pics[fsi][1], step_views[fsi]))
                        for ci_v, (se, _dr) in enumerate(valid_cands):
                            cand_pp[ci_v].append(se)
                    sc_all = _eval_multiview_score(lib, eval_pages, cand_pp, use_dino=True)
                    bp_arr = np.zeros(len(valid_cands), dtype=np.float64)
                    if bp is not None:
                        try:
                            raw_bp = bp.score_layouts_batch(before_parts, [se for se, _dr in valid_cands], max_neighbors=4, radius=70.0)
                            bp_arr = np.clip(0.012 * (raw_bp - float(np.mean(raw_bp))) / max(1, len(grp)), -0.025, 0.025)
                        except Exception:
                            pass
                    tot_arr = [sc_all[i][0] + float(bp_arr[i]) for i in range(len(valid_cands))]
                    best_ci = int(np.argmax(tot_arr))
                    if (best_ci != 0 and tot_arr[best_ci] > tot_arr[0] + 0.022
                            and sc_all[best_ci][1] > sc_all[0][1] + 0.005
                            and sc_all[best_ci][2] >= sc_all[0][2] - 0.001):
                        out.groups[si] = valid_cands[best_ci][0]
                        grp = out.groups[si]
                        asm["parts"] = [e for s2 in asm["step_indices"] for e in out.groups[s2]]
                        changes += 1
                        if log:
                            log({"global_opt": "scanet_stereo_alt", "step": si + 1, "rot_steps": [f + 1 for f in pick_rot],
                                 "delta_comb": round(tot_arr[best_ci] - tot_arr[0], 4)})

            # --- E2: Localized single-brick stereo repair for bricks hidden at step `si` & visible in `pick_rot[0]`! ---
            fsi0 = pick_rot[0]
            vf0 = step_views[fsi0]
            rgb_f0, pts_f0, _ = step_pics[fsi0]
            pic_f0 = Picture.from_rgb(rgb_f0, pts_f0, BOOKLET_SCALE / pts_f0 if pts_f0 else None)
            # Check which bricks in `grp` were heavily occluded in `v_cur` (<30% visible) yet visible in `vf0`!
            cur_full = before_parts + grp
            _dc, lab_c = render(lib, cur_full, v_cur, pic_cur.rgb.shape[:2])
            f0_steps = [s2 for s2 in s_indices if s2 <= fsi0]
            f0_full = [e for s2 in f0_steps for e in out.groups[s2]]
            _df, lab_f = render(lib, f0_full, vf0, pic_f0.rgb.shape[:2])
            # Map each brick index `bi` in `grp` to its label in `cur_full` and `f0_full`
            f0_off = sum(len(out.groups[s2]) for s2 in f0_steps if s2 < si)
            n_before = len(before_parts)

            for bi, (p, c, m) in enumerate(list(grp)):
                vis_cur = int(np.count_nonzero(lab_c == (n_before + bi)))
                vis_fut = int(np.count_nonzero(lab_f == (f0_off + bi)))
                # Only trigger single-brick localization on bricks that were occluded/tiny at `si`
                # and became clearly exposed (`>= 45 px` and `>= 1.8x` more visible!) in the rotated view!
                if vis_fut < 45 or (vis_cur >= 80 and vis_fut < 1.8 * vis_cur):
                    continue
                m = np.asarray(m, float)
                other_no_bi = before_parts + [e for k2, e in enumerate(grp) if k2 != bi] + after_parts
                static_si = before_parts + [e for k2, e in enumerate(grp) if k2 != bi]
                static_f0 = [e for s2 in f0_steps for k2, e in enumerate(out.groups[s2]) if not (s2 == si and k2 == bi)]

                # Propose: (a) 90/180/270 in-place turns around brick center, (b) top-4 rotated-view mated candidates!
                t_pts = world_triangles(lib, p, m).reshape(-1, 3)
                ctr = 0.5 * (t_pts.min(0) + t_pts.max(0)) if len(t_pts) else m[:3, 3]
                cand_mats = []
                seen_mk = {tuple(np.round(m[:3, :4], 1).ravel())}
                for kt in (1, 2, 3):
                    _, rot_e = _rigid_rotate_around_y([(p, c, m)], (float(ctr[0]), float(ctr[2])), kt)
                    mt = rot_e[0][2]
                    mk = tuple(np.round(mt[:3, :4], 1).ravel())
                    if mk not in seen_mk:
                        seen_mk.add(mk)
                        cand_mats.append(mt)
                raw_c = distinct(lib, p, [q for q in candidates(lib, p, static_si) if q.get("kind") != "flush"])
                if collider is not None:
                    collider.set_model(other_no_bi)
                legal_extra = []
                for q in raw_c:
                    qm = clean_matrix(np.asarray(q["matrix"], float))
                    mk = tuple(np.round(qm[:3, :4], 1).ravel())
                    if mk in seen_mk:
                        continue
                    if collider is not None and collider.hits(p, qm):
                        continue
                    legal_extra.append(q)
                if legal_extra:
                    codes_f0 = sorted({int(cc) for _pp, cc, _mm in static_f0} | {int(c)})
                    sc_f0 = ModelScorer(lib, static_f0, pic_f0, vf0, codes_f0)
                    pre_f0 = score_candidates_calibrated(lib, sc_f0, [], p, c, legal_extra, deltas=(0.0,))
                    pre_f0.sort(key=lambda s: -s.score)
                    for sc_item in pre_f0[:4]:
                        qm = clean_matrix(np.asarray(sc_item.candidate["matrix"], float))
                        mk = tuple(np.round(qm[:3, :4], 1).ravel())
                        if mk not in seen_mk:
                            seen_mk.add(mk)
                            cand_mats.append(qm)

                legal = [(p, c, clean_matrix(m))]
                for cm in cand_mats:
                    if collider is not None:
                        if collider.hits(p, cm):
                            continue
                        if has_nat and collider.mates(p, cm)[0] <= 0:
                            continue
                    legal.append((p, c, cm))
                if len(legal) <= 1:
                    continue

                # Score jointly on (step si view + rotated future views)
                eval_pages = [(static_si, [], rgb_cur, pts_cur, v_cur)]
                cand_pp = [[[e]] for e in legal]
                for fsi in pick_rot:
                    st_f = [e for s2 in s_indices if s2 <= fsi for k2, e in enumerate(out.groups[s2]) if not (s2 == si and k2 == bi)]
                    eval_pages.append((st_f, [], step_pics[fsi][0], step_pics[fsi][1], step_views[fsi]))
                    for ci_l, entry in enumerate(legal):
                        cand_pp[ci_l].append([entry])
                sc_b = _eval_multiview_score(lib, eval_pages, cand_pp, use_dino=True)
                best_l = int(np.argmax([s[0] for s in sc_b]))
                if (best_l != 0 and sc_b[best_l][0] > sc_b[0][0] + 0.020
                        and sc_b[best_l][1] > sc_b[0][1] + 0.005
                        and sc_b[best_l][2] > sc_b[0][2] + 0.002):
                    # Verify step `si` itself did not regress noticeably!
                    sc_si_only = _eval_multiview_score(lib, [eval_pages[0]], [[[legal[0]]], [[legal[best_l]]]], use_dino=False)
                    if sc_si_only[1][1] >= sc_si_only[0][1] - 0.012:
                        new_g = list(out.groups[si])
                        new_g[bi] = legal[best_l]
                        out.groups[si] = new_g
                        grp = new_g
                        asm["parts"] = [e for s2 in asm["step_indices"] for e in out.groups[s2]]
                        changes += 1
                        if log:
                            log({"global_opt": "scanet_stereo_brick", "step": si + 1, "part": p,
                                 "rot_steps": [f + 1 for f in pick_rot],
                                 "delta_comb": round(sc_b[best_l][0] - sc_b[0][0], 4)})
    return changes
