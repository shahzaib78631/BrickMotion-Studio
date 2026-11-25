"""Exact discrete + continuous placement optimizer driven directly by ModelScorer & native Collider.

Replaces greedy per-part gain ranking with:
  1. Calibrated sprite pre-scoring using ModelScorer's own Lab colour planes, dark+light ink
     precision map, and optional previous-step change mask.
  2. Beam search deduplicated by canonical geometric pose multiset (eliminating both symmetric
     turn duplicates and identical-part permutation duplicates), with EVERY layer ranked directly
     by exact incremental `ModelScorer.score(drawn_placed)`.
  3. Multi-start joint polish over the top beam states: single-part moves, blocking-pair moves,
     direct swaps between new parts, rigid host+children moves, and rigid sub-build unit moves.
  4. Native C++ multi-mate physical tie-breaking for visually occluded/tied parts.
  5. Fine continuous DoF refinement for hinges, clips, and sliding Technic connectors.
"""
from __future__ import annotations

import numpy as np

from .edges import DEPTH_TOL
from .place import (
    DELTAS,
    FLOAT_PENALTY,
    PUSH_STEPS,
    Scored,
    State,
    _boxes_overlap,
    _filled_stacks,
    _same_spot,
    _shape,
    _size,
    approach_axis,
    distinct,
    drawn_pose,
    part_sprite,
)
from .scorer import CHANGE_WEIGHT, EDGE_PREC_WEIGHT, ModelScorer, PAPER_PENALTY, UNEXPLAINED_PENALTY

MATE_TIE_WEIGHT = 6.0        # physical tie-breaker per mated connector (in pixel-score units)
HIDDEN_FRAC = 0.22           # smooth occlusion threshold: zero penalty at >=22% visible, ramps smoothly below
HIDDEN_PER_PX = 0.90         # penalty per pixel below `HIDDEN_FRAC * total_px` (prevents 12%-vis backside rim cheats)
HIDDEN_CAP = 300.0           # cap so a truly hidden inner brick always beats wrong colour / bare paper (-800..-3500)
SAME_STEP_TIE = 0.2          # tiny tie-breaker for snapping an occluded part onto a new part
ORTHO_PENALTY = 45.0         # prefer 90-deg grid over 45-deg single-stud spins unless picture clearly shows 45-deg
FLUSH_PENALTY = 100.0        # prefer physically connected poses over disconnected side-by-side flush poses
FLOAT_BASE = 700.0           # fixed activation cost for floating a part (delta > 0) vs seated (delta == 0) on main steps
CONTINUOUS_KINDS = ("clip", "hinge", "technic")


def _float_cost(delta: float, float_base: float | None = None) -> float:
    if delta <= 0.0:
        return 0.0
    fb = FLOAT_BASE if float_base is None else float(float_base)
    return fb + FLOAT_PENALTY * float(delta)


def _non_ortho_penalty(cand: dict | None, matrix: np.ndarray) -> float:
    pen = FLUSH_PENALTY if (cand is not None and cand.get("kind") == "flush") else 0.0
    if cand is not None and cand.get("kind") in ("hinge", "clip"):
        return pen
    r = np.abs(np.asarray(matrix, float)[:3, :3])
    # Orthogonal cube rotations have row/col max == 1.0 and sum == 1.0
    if r.max(axis=1).min() < 0.99:
        pen += ORTHO_PENALTY
    return pen


def _geom_key(lib, part: str, colour: int, matrix: np.ndarray) -> tuple:
    """Canonical geometric key invariant to exact part symmetries (e.g. 1x1 plate 4 turns)."""
    m = np.asarray(matrix, float)
    h, lo = _shape(lib, part, m[:3, :3])
    pos = tuple(np.round((m[:3, 3] + lo) * 2).astype(int))
    return (part, colour, h, pos)


def _state_geom_key(lib, placed: list) -> frozenset:
    return frozenset(_geom_key(lib, p, c, m) for p, c, m in placed)


def _sprite_delta_score(scorer: ModelScorer, sp, row0: int, col0: int, dd: float,
                        cidx: int, cur_depth: np.ndarray, cur_label: np.ndarray,
                        cur_col_map: np.ndarray, cur_edge_depth: np.ndarray) -> tuple[float, float, float, int]:
    """Fast calibrated incremental sprite gain against current scene using ModelScorer's planes."""
    h, w = sp.mask.shape
    H, W = scorer.shape
    r0, c0 = max(row0, 0), max(col0, 0)
    r1, c1 = min(row0 + h, H), min(col0 + w, W)
    total = int(sp.mask.sum())
    if r1 <= r0 or c1 <= c0:
        return -PAPER_PENALTY * total, -PAPER_PENALTY * total, 0.0, total

    m = sp.mask[r0 - row0:r1 - row0, c0 - col0:c1 - col0]
    outside = total - int(m.sum())
    d = sp.depth[r0 - row0:r1 - row0, c0 - col0:c1 - col0] + dd
    vis = m & (d < cur_depth[r0:r1, c0:c1])
    n_vis = int(vis.sum())
    if n_vis == 0:
        val = -PAPER_PENALTY * outside
        return val, val, 0.0, outside

    # 1. Colour + silhouette delta: new pixel score minus what was there before
    if 0 <= cidx < len(scorer.codes):
        new_col = scorer.col_planes[cidx, r0:r1, c0:c1][vis]
    else:
        new_col = np.zeros(n_vis, dtype=np.float32)

    old_cidx = cur_col_map[r0:r1, c0:c1][vis]
    old_fg = scorer.fg[r0:r1, c0:c1][vis]
    old_col = np.where(old_fg, -UNEXPLAINED_PENALTY, 0.0).astype(np.float32)
    had_old = old_cidx >= 0
    if had_old.any():
        vy, vx = np.nonzero(vis)
        hy, hx = vy[had_old] + r0, vx[had_old] + c0
        old_col[had_old] = scorer.col_planes[old_cidx[had_old], hy, hx]

    col_gain = float((new_col - old_col).sum()) - PAPER_PENALTY * outside

    # 2. Edge precision delta on visible pixels
    se = sp.edge_img[r0 - row0:r1 - row0, c0 - col0:c1 - col0][vis]
    ced_v = cur_edge_depth[r0:r1, c0:c1][vis]
    be = np.isfinite(ced_v) & (ced_v <= cur_depth[r0:r1, c0:c1][vis] + DEPTH_TOL)
    ep = scorer.edge_prec_map[r0:r1, c0:c1][vis]
    edge_gain = EDGE_PREC_WEIGHT * float(ep[se].sum() - ep[be].sum())

    # 3. Previous-step change mask bonus/penalty (matches C++ chg_plane: never heavily penalise unchanged
    # interior pixels since same-colour-on-same-colour parts leave interior RGB unchanged!)
    chg_gain = 0.0
    if getattr(scorer, "chg_plane", None) is not None:
        chg_gain = float(scorer.chg_plane[r0:r1, c0:c1][vis].sum())
    elif scorer.changed is not None:
        ch = scorer.changed[r0:r1, c0:c1][vis]
        arr = scorer.arrows[r0:r1, c0:c1][vis]
        on_ch = int(np.count_nonzero(ch))
        on_unch = int(np.count_nonzero(~ch & ~arr))
        chg_gain = CHANGE_WEIGHT * float(on_ch - 0.15 * on_unch)

    val = col_gain + edge_gain + chg_gain
    return val, col_gain, edge_gain, n_vis + outside


def _build_current_buffers(lib, scorer: ModelScorer, drawn_placed: list):
    """Composite `drawn_placed` onto `scorer`'s base buffers for fast sprite scoring."""
    if not drawn_placed:
        col_map = np.full(scorer.shape, -1, dtype=np.int32)
        if scorer.n_base:
            ok = scorer.base_label >= 0
            col_map[ok] = scorer.base_colour_idx[scorer.base_label[ok]]
        return scorer.base_depth, scorer.base_label, col_map, scorer.base_edge_depth

    from .render import render
    from .scorer import _edge_depth_map
    d_add, l_add = render(lib, drawn_placed, scorer.view, scorer.shape)
    nearer = d_add < scorer.base_depth
    depth = np.where(nearer, d_add, scorer.base_depth)
    label = np.where(nearer, l_add + scorer.n_base, scorer.base_label)
    add_cidx = np.array([scorer.code_idx.get(c, -1) for _p, c, _m in drawn_placed], dtype=np.int32)
    all_cidx = np.concatenate([scorer.base_colour_idx, add_cidx]) if scorer.n_base else add_cidx
    col_map = np.full(scorer.shape, -1, dtype=np.int32)
    ok = label >= 0
    if ok.any() and len(all_cidx):
        col_map[ok] = all_cidx[label[ok]]
    add_ed = _edge_depth_map(lib, drawn_placed, scorer.view, depth)
    base_vis_ed = np.where(np.isfinite(scorer.base_edge_depth) & (scorer.base_edge_depth <= depth + DEPTH_TOL),
                           scorer.base_edge_depth, np.inf)
    edge_depth = np.minimum(base_vis_ed, add_ed)
    return depth, label, col_map, edge_depth


def _scene_score_planes(scorer: ModelScorer, cur_depth: np.ndarray, cur_col_map: np.ndarray,
                        cur_edge_depth: np.ndarray):
    """Precompute dense float32/uint8 planes once per scene for C++ batch sprite scoring."""
    old_score = np.where(scorer.fg, -UNEXPLAINED_PENALTY, 0.0).astype(np.float32)
    had = cur_col_map >= 0
    if had.any():
        hy, hx = np.nonzero(had)
        old_score[hy, hx] = scorer.col_planes[cur_col_map[hy, hx], hy, hx]
    base_edge = (np.isfinite(cur_edge_depth) & (cur_edge_depth <= cur_depth + DEPTH_TOL)).astype(np.uint8)
    chg_plane = getattr(scorer, "chg_plane", None)
    return old_score, base_edge, chg_plane


def score_candidates_calibrated(lib, scorer: ModelScorer, drawn_placed: list, part: str, colour: int,
                                cands: list[dict], deltas=DELTAS, pushes=(),
                                float_base: float | None = None) -> list[Scored]:
    """Score candidates using ModelScorer's calibrated Lab planes, dark+light edges, and change mask.
    Batches all placements per unique part rotation through C++ `bm_score_sprites` (~500x faster)."""
    from . import native_bridge
    from .scorer import _is_printed
    if not cands:
        return []
    cur_depth, cur_label, cur_col_map, cur_edge_depth = _build_current_buffers(lib, scorer, drawn_placed)
    cidx = scorer.code_idx.get(colour, -1)
    col_plane = scorer.col_planes[cidx] if 0 <= cidx < len(scorer.codes) else None
    if col_plane is not None and _is_printed(part):
        # Match ModelScorer.score(): printed parts (eyes, belt tiles, faces) carry multi-colour artwork
        # on foreground, so never punish artwork pixels on foreground as wrong base colour during pre-scoring!
        col_plane = np.ascontiguousarray(np.where(scorer.fg, np.maximum(col_plane, -0.1), col_plane), dtype=np.float32)
    old_score, base_edge, chg_plane = _scene_score_planes(scorer, cur_depth, cur_col_map, cur_edge_depth)

    # Group candidates by rotation so each unique rotation sprite is rasterised once and batch-scored in C++
    groups: dict[bytes, list[tuple[int, dict, np.ndarray]]] = {}
    for idx, cand in enumerate(cands):
        m = np.asarray(cand["matrix"], float)
        rk = m[:3, :3].round(3).tobytes()
        groups.setdefault(rk, []).append((idx, cand, m))

    out: list[Scored | None] = [None] * len(cands)
    use_cpp = native_bridge.available()
    back = scorer.view.matrix.T if pushes else None

    for rk, items in groups.items():
        sp = part_sprite(lib, part, items[0][2][:3, :3], scorer.view)
        if not sp.mask.size:
            for idx, cand, _m in items:
                out[idx] = Scored(-np.inf, 0.0, 1.0, cand)
            continue
        sp_total = int(sp.mask.sum())
        trans_list, metas = [], []
        # Fast path when deltas == (0.0,) and no pushes: pure vectorized batch projection!
        if deltas == (0.0,) and not pushes:
            t_arr = np.array([m[:3, 3] for _idx, _cand, m in items], dtype=np.float64)
            q = t_arr @ scorer.view.matrix.T
            cols0_arr = np.rint(scorer.view.offset[0] + scorer.view.scale * q[:, 0]).astype(np.int32) + int(sp.corner[0])
            rows0_arr = np.rint(scorer.view.offset[1] + scorer.view.scale * q[:, 1]).astype(np.int32) + int(sp.corner[1])
            dds_arr = np.ascontiguousarray(q[:, 2], dtype=np.float64)
            metas = [(idx, 0.0, 1.0, None) for idx, _cand, _m in items]
        else:
            rows0, cols0, dds = [], [], []
            metas_tr, metas_push = [], []
            v_mat_T = scorer.view.matrix.T
            v_sc = float(scorer.view.scale)
            v_ox, v_oy = float(scorer.view.offset[0]), float(scorer.view.offset[1])
            cx0, cy0 = int(sp.corner[0]), int(sp.corner[1])
            for idx, cand, m in items:
                axis = approach_axis(cand)
                signs = (1.0, -1.0) if (deltas != (0.0,) or cand.get("axis") is None or cand.get("bidirectional")) else (1.0,)
                m_t = m[:3, 3]
                for sign in signs:
                    for delta in deltas:
                        if delta == 0.0 and sign < 0:
                            continue
                        trans_list.append(m_t + sign * delta * axis)
                        metas_tr.append((idx, float(delta), float(sign), None))
                if pushes:
                    q_b = m_t @ v_mat_T
                    c0_b = int(round(v_ox + v_sc * q_b[0])) + cx0
                    r0_b = int(round(v_oy + v_sc * q_b[1])) + cy0
                    dd_b = float(q_b[2])
                    for d_dir, length in pushes:
                        for k in PUSH_STEPS:
                            for sign in (1.0, -1.0):
                                du, dv = sign * k * length * d_dir[0], sign * k * length * d_dir[1]
                                ldu = k * length / max(v_sc, 1e-6)
                                move = back @ np.array([du / v_sc, dv / v_sc, 0.0])
                                rows0.append(r0_b + int(round(dv))); cols0.append(c0_b + int(round(du))); dds.append(dd_b)
                                metas_push.append((idx, float(ldu), 1.0, move))
            metas = metas_tr + metas_push
            if trans_list:
                t_arr = np.asarray(trans_list, dtype=np.float64)
                q = t_arr @ v_mat_T
                c_tr = np.rint(v_ox + v_sc * q[:, 0]).astype(np.int32) + cx0
                r_tr = np.rint(v_oy + v_sc * q[:, 1]).astype(np.int32) + cy0
                d_tr = np.ascontiguousarray(q[:, 2], dtype=np.float64)
                if rows0:
                    rows0_arr = np.concatenate([r_tr, np.array(rows0, dtype=np.int32)])
                    cols0_arr = np.concatenate([c_tr, np.array(cols0, dtype=np.int32)])
                    dds_arr = np.concatenate([d_tr, np.array(dds, dtype=np.float64)])
                else:
                    rows0_arr, cols0_arr, dds_arr = r_tr, c_tr, d_tr
            else:
                rows0_arr = np.array(rows0, dtype=np.int32)
                cols0_arr = np.array(cols0, dtype=np.int32)
                dds_arr = np.array(dds, dtype=np.float64)

        if use_cpp and len(rows0_arr):
            res = native_bridge.score_sprites(
                col_plane, old_score, cur_depth, base_edge, scorer.edge_prec_map, chg_plane,
                PAPER_PENALTY, EDGE_PREC_WEIGHT,
                sp.mask, sp.depth, sp.edge_img, sp_total,
                rows0_arr, cols0_arr, dds_arr,
            )
        else:
            res = None

        if res is not None:
            vals, cgs, egs, chgs = res
        else:
            vals = np.empty(len(rows0_arr), dtype=np.float64)
            cgs = np.empty(len(rows0_arr), dtype=np.float64)
            egs = np.empty(len(rows0_arr), dtype=np.float64)
            chgs = np.empty(len(rows0_arr), dtype=np.int32)
            for j, (r0, c0, dd) in enumerate(zip(rows0_arr, cols0_arr, dds_arr)):
                v, cg, eg, ch = _sprite_delta_score(scorer, sp, int(r0), int(c0), float(dd), cidx, cur_depth, cur_label, cur_col_map, cur_edge_depth)
                vals[j], cgs[j], egs[j], chgs[j] = v, cg, eg, ch

        best_by: dict[int, tuple] = {}
        seated_by: dict[int, float] = {}
        apply_hid = (deltas == (0.0,) and sp_total >= 80)
        hid_thr = HIDDEN_FRAC * float(sp_total)
        for j, (idx, delta, sign, move) in enumerate(metas):
            ch_j = int(chgs[j])
            v = float(vals[j]) - _float_cost(delta, float_base)
            if apply_hid and ch_j < hid_thr:
                v -= min(HIDDEN_CAP, HIDDEN_PER_PX * (hid_thr - float(ch_j)))
            if delta == 0.0 and move is None:
                seated_by[idx] = v
            prev = best_by.get(idx)
            if prev is None or v > prev[0]:
                best_by[idx] = (v, delta, sign, float(cgs[j]), float(egs[j]), ch_j, move)

        for idx, cand, m in items:
            b = best_by[idx]
            value = b[0] + float(cand.get("prior", 0.0)) * abs(b[0]) - _non_ortho_penalty(cand, m)
            out[idx] = Scored(value, b[1], b[2], cand, b[3], b[4], seated_by.get(idx, 0.0), b[5], move=b[6])

    return out


def _drawn_entries(placed: list, scores: list) -> list:
    return [(p, c, drawn_pose(sc) if sc is not None else m) for (p, c, m), sc in zip(placed, scores)]


def _hidden_backside_penalty(lib, scorer: ModelScorer, placed: list, vis_counts: list[int]) -> float:
    """Smooth zero-cliff penalty for hiding >78% of a newly placed part behind the existing model on
    an in-place step (0 at `HIDDEN_FRAC`, ramping linearly with occlusion depth so deeply hidden
    backside cheats like 40350 s27 3666:0 cannot ride a 2-px rim error while genuinely partially-
    occluded parts like 41605 s13 22885:71 at 23% visibility suffer zero discontinuity)."""
    if not placed or not vis_counts:
        return 0.0
    pen = 0.0
    for (p, _c, m), vis in zip(placed, vis_counts):
        sp = part_sprite(lib, p, np.asarray(m, float)[:3, :3], scorer.view)
        tot = int(sp.mask.sum())
        if tot < 80:
            continue
        thr = HIDDEN_FRAC * float(tot)
        if vis < thr:
            pen += min(HIDDEN_CAP, HIDDEN_PER_PX * (thr - float(vis)))
    return pen


def _physical_bonus(collider, base: list, placed: list) -> float:
    """Small tie-breaker favouring physically well-mated poses (only breaks visual ties)."""
    if collider is None or not placed or not getattr(collider, "native", None):
        return 0.0
    collider.set_model(base)
    _collides, _connected, mates, _grip = collider.layout_check(placed)
    return MATE_TIE_WEIGHT * float(mates)


def _model_key(model: list) -> tuple:
    return tuple((p, tuple(np.round(np.asarray(m, float).ravel(), 2))) for p, _c, m in model)


def _milp_tiling_seeds(lib, scorer: ModelScorer, base: list, parts: list[tuple[str, int]],
                       cached_cands, collider=None, max_sols: int = 4, time_limit: float = 0.8) -> list[State]:
    """Global exact-cover MILP proposal for multi-part steps (`2 <= len(parts) <= 12`).

    When several parts (especially `k >= 2` identical parts like a ring of SNOT bricks) attach
    to `base` simultaneously, sequential 1-by-1 beam search can get trapped by a single shifted
    part that greedily straddles pixels belonging to two true parts. This MILP selects a mutually
    non-colliding set of candidates matching exact part counts to maximise joint pixel coverage
    of unexplained/changed foreground minus paper/edge penalties, returning top distinct tilings
    scored by exact `ModelScorer.score`."""
    from scipy.optimize import Bounds, LinearConstraint, milp
    from scipy.sparse import csc_matrix

    if not (2 <= len(parts) <= 12) or not base:
        return []

    # Group part indices by (part, colour)
    by_type: dict[tuple[str, int], list[int]] = {}
    for idx, pc in enumerate(parts):
        by_type.setdefault(pc, []).append(idx)

    # Precompute valid base candidates per unique type
    cur_depth, cur_label, cur_col_map, cur_edge_depth = _build_current_buffers(lib, scorer, [])
    H, W = scorer.shape
    r0_roi, r1_roi, c0_roi, c1_roi = scorer.roi
    roi_area = max(1, (r1_roi - r0_roi) * (c1_roi - c0_roi))
    stride = max(2, int(round(np.sqrt(roi_area / 360.0))))

    type_pools: dict[tuple[str, int], list[tuple[Scored, np.ndarray]]] = {}
    for pc, idxs in by_type.items():
        p, c = pc
        cands = distinct(lib, p, cached_cands(p, base))
        if collider is not None and cands:
            cands = [q for q in cands if not collider.hits(p, q["matrix"])]
        if len(cands) < len(idxs):
            continue
        scored = score_candidates_calibrated(lib, scorer, [], p, c, cands, deltas=(0.0,))
        scored.sort(key=lambda s: -s.score)
        cap = min(len(scored), max(48, 14 * len(idxs)))
        pool = [(sc, np.asarray(sc.candidate["matrix"], float)) for sc in scored[:cap]]
        type_pools[pc] = pool

    if not type_pools:
        return []

    def _run_milp(subset_types: list[tuple[str, int]]) -> list[State]:
        # Build unified candidate list (up to 64 binary vars for single-type, 96 across multi-type
        # so HiGHS solves cleanly to global optimality well within time_limit)
        total_req = sum(len(by_type[pc]) for pc in subset_types)
        per_cap = 64 if len(subset_types) == 1 else max(20, min(48, 96 // max(1, len(subset_types))))
        cand_list = []   # (type_idx, part, colour, sc, mat)
        type_ranges = []
        for ti, pc in enumerate(subset_types):
            pool = type_pools[pc][:per_cap]
            if len(pool) < len(by_type[pc]):
                return []
            start = len(cand_list)
            for sc, mat in pool:
                cand_list.append((ti, pc[0], pc[1], sc, mat))
            type_ranges.append((start, len(cand_list), len(by_type[pc])))

        N = len(cand_list)
        if N < total_req:
            return []

        # Extract per-candidate positive pixel coverage on strided grid + non-positive / edge weights
        cand_cov: list[dict[int, float]] = []
        cand_base_w = np.zeros(N, dtype=np.float64)
        pix_best: dict[int, float] = {}
        sp_cache: dict = {}

        for ci, (_ti, p, c, sc, m) in enumerate(cand_list):
            rk = (p, m[:3, :3].round(3).tobytes())
            sp = sp_cache.get(rk)
            if sp is None:
                sp = part_sprite(lib, p, m[:3, :3], scorer.view)
                sp_cache[rk] = sp
            if not sp.mask.size:
                cand_cov.append({})
                cand_base_w[ci] = -1e6
                continue
            row0, col0, dd, _o = sp.place(scorer.view, m[:3, 3])
            h, w = sp.mask.shape
            r0, c0 = max(row0, 0), max(col0, 0)
            r1, c1 = min(row0 + h, H), min(col0 + w, W)
            total_px = int(sp.mask.sum())
            if r1 <= r0 or c1 <= c0:
                cand_cov.append({})
                cand_base_w[ci] = -PAPER_PENALTY * total_px
                continue
            msk = sp.mask[r0 - row0:r1 - row0, c0 - col0:c1 - col0]
            outside = total_px - int(msk.sum())
            d = sp.depth[r0 - row0:r1 - row0, c0 - col0:c1 - col0] + dd
            vis = msk & (d < cur_depth[r0:r1, c0:c1])
            cidx = scorer.code_idx.get(c, -1)
            vy, vx = np.nonzero(vis)
            if not len(vy):
                cand_cov.append({})
                cand_base_w[ci] = -PAPER_PENALTY * outside
                continue
            gy, gx = vy + r0, vx + c0
            new_col = scorer.col_planes[cidx, gy, gx] if 0 <= cidx < len(scorer.codes) else np.zeros(len(vy), np.float32)
            old_cidx = cur_col_map[gy, gx]
            old_fg = scorer.fg[gy, gx]
            old_col = np.where(old_fg, -UNEXPLAINED_PENALTY, 0.0).astype(np.float32)
            had = old_cidx >= 0
            if had.any():
                old_col[had] = scorer.col_planes[old_cidx[had], gy[had], gx[had]]
            delta = (new_col - old_col).astype(np.float64)
            if scorer.changed is not None:
                ch = scorer.changed[gy, gx]
                arr = scorer.arrows[gy, gx]
                delta += CHANGE_WEIGHT * (ch.astype(np.float64) - (~ch & ~arr).astype(np.float64))

            # Positive gain pixels go into shared pixel-cover objective; negative penalties + edge gain stay per-candidate
            neg_sum = float(delta[delta < 0.0].sum()) - PAPER_PENALTY * outside
            pos_sum = float(delta[delta > 0.0].sum())
            hid_pen = 0.0
            hid_thr = HIDDEN_FRAC * float(total_px)
            if total_px >= 80 and len(vy) < hid_thr:
                hid_pen = min(HIDDEN_CAP, HIDDEN_PER_PX * (hid_thr - float(len(vy))))
            cand_base_w[ci] = neg_sum + float(sc.edge) + 0.06 * pos_sum - hid_pen

            # Subsample positive-gain pixels on the fixed image stride grid
            on_grid = (delta > 0.25) & ((gy % stride) == 0) & ((gx % stride) == 0)
            cov = {}
            if on_grid.any():
                py, px, pv = gy[on_grid], gx[on_grid], delta[on_grid]
                for y_i, x_i, val in zip(py.tolist(), px.tolist(), pv.tolist()):
                    pid = y_i * W + x_i
                    cov[pid] = val
                    if val > pix_best.get(pid, 0.0):
                        pix_best[pid] = val
            cand_cov.append(cov)

        if not pix_best:
            return []
        # Cap pixel variables at 450 highest-value sample pixels
        pix_items = sorted(pix_best.items(), key=lambda kv: -kv[1])[:450]
        pix_ids = [pid for pid, _ in pix_items]
        pix_index = {pid: pi for pi, pid in enumerate(pix_ids)}
        M = len(pix_ids)
        pix_weight = np.array([val * (stride * stride) for _, val in pix_items], dtype=np.float64)

        # Pairwise collision exclusions (fast AABB prefilter + native exact check)
        has_native = collider is not None and getattr(collider, "native", None) is not None
        coll_pairs = []
        for a in range(N):
            ea = (cand_list[a][1], cand_list[a][2], cand_list[a][4])
            for b in range(a + 1, N):
                eb = (cand_list[b][1], cand_list[b][2], cand_list[b][4])
                if not _boxes_overlap(lib, ea, eb, shrink=0.5):
                    continue
                if has_native:
                    if collider.hits_extra(ea[0], ea[2], [eb]):
                        coll_pairs.append((a, b))
                else:
                    coll_pairs.append((a, b))

        # Assemble sparse MILP: vars = [x_0..x_{N-1}, y_0..y_{M-1}]
        n_vars = N + M
        c_obj = np.zeros(n_vars, dtype=np.float64)
        c_obj[:N] = -cand_base_w
        c_obj[N:] = -pix_weight
        integrality = np.zeros(n_vars, dtype=np.int8)
        integrality[:N] = 1
        bounds = Bounds(np.zeros(n_vars), np.ones(n_vars))

        rows_i, cols_j, vals_v = [], [], []
        lb_list, ub_list = [], []
        r_idx = 0

        # 1. Exact count per part type
        for start, end, need in type_ranges:
            for ci in range(start, end):
                rows_i.append(r_idx); cols_j.append(ci); vals_v.append(1.0)
            lb_list.append(float(need)); ub_list.append(float(need))
            r_idx += 1

        # 2. Pairwise non-collision
        for a, b in coll_pairs:
            rows_i.append(r_idx); cols_j.append(a); vals_v.append(1.0)
            rows_i.append(r_idx); cols_j.append(b); vals_v.append(1.0)
            lb_list.append(-np.inf); ub_list.append(1.0)
            r_idx += 1

        # 3. Pixel coverage: y_p - sum_{a covering p} x_a <= 0
        pix_coverers: list[list[int]] = [[] for _ in range(M)]
        for ci, cov in enumerate(cand_cov):
            for pid, val in cov.items():
                pi = pix_index.get(pid)
                if pi is not None and val >= 0.4 * pix_best[pid]:
                    pix_coverers[pi].append(ci)
        for pi in range(M):
            rows_i.append(r_idx); cols_j.append(N + pi); vals_v.append(1.0)
            for ci in pix_coverers[pi]:
                rows_i.append(r_idx); cols_j.append(ci); vals_v.append(-1.0)
            lb_list.append(-np.inf); ub_list.append(0.0)
            r_idx += 1

        out_states: list[State] = []
        done_indices = frozenset(i for pc in subset_types for i in by_type[pc])
        for _sol_k in range(max_sols):
            A = csc_matrix((vals_v, (rows_i, cols_j)), shape=(r_idx, n_vars))
            res = milp(c_obj, integrality=integrality, bounds=bounds,
                       constraints=LinearConstraint(A, lb_list, ub_list),
                       options={"time_limit": time_limit})
            if res.x is None:
                break
            chosen = [ci for ci in range(N) if res.x[ci] > 0.5]
            if len(chosen) != total_req:
                break
            placed = [(cand_list[ci][1], cand_list[ci][2], cand_list[ci][4]) for ci in chosen]
            scores = [cand_list[ci][3] for ci in chosen]
            sc_m, vis_m = scorer.score_and_vis(placed)
            exact_val = sc_m - _hidden_backside_penalty(lib, scorer, placed, vis_m) + _physical_bonus(collider, base, placed)
            out_states.append(State(placed, scores, exact_val, done_indices))
            # Add no-good cut to discover diverse alternative tilings
            for ci in chosen:
                rows_i.append(r_idx); cols_j.append(ci); vals_v.append(1.0)
            lb_list.append(-np.inf); ub_list.append(float(total_req - 1))
            r_idx += 1
        return out_states

    seeds: list[State] = []
    # 1. Full-step MILP when every part type has enough candidates directly on base
    if len(type_pools) == len(by_type):
        seeds.extend(_run_milp(list(by_type.keys())))
    # 2. Also run per-type MILP for any identical-part block of size >= 2 in mixed/stacked steps
    if len(by_type) > 1:
        for pc, idxs in by_type.items():
            if len(idxs) >= 2 and pc in type_pools:
                seeds.extend(_run_milp([pc]))
    return seeds


def solve_step_exact(lib, scene_for, scorer: ModelScorer, base: list, parts: list[tuple[str, int]],
                     candidate_fn, collider=None, beam: int = 10, per_part: int = 12,
                     deltas=DELTAS, pushes=(), fill: bool = True,
                     next_scorer: ModelScorer | None = None, polish_starts: int = 3,
                     use_milp: bool = True, milp_time_limit: float = 0.8, milp_max_sols: int = 4,
                     polish_top_k: int = 40, polish_rounds: int = 4,
                     fill_depth: int | None = None, fill_budget: int | None = None,
                     time_budget: float = 18.0, float_base: float | None = None) -> list[State]:
    """Exact ModelScorer-guided beam search + global MILP tiling seeds + multi-start joint polish.
    When `next_scorer` is supplied on an exploded step (`deltas != (0.0,)`), candidate pruning also
    keeps the highest-scoring SEATED poses on `next_scorer` so arrows never discard the true seat."""
    import time as _time
    if not parts:
        return [State()]
    _t_deadline = _time.monotonic() + time_budget

    # Cache candidates per (part, model) for this step
    cand_cache: dict = {}
    def cached_cands(part: str, model: list) -> list[dict]:
        k = (part, _model_key(model))
        res = cand_cache.get(k)
        if res is None:
            res = candidate_fn(part, model)
            cand_cache[k] = res
        return res

    if collider is not None:
        collider.set_model(base)

    # 1. Order part types by strongest root-state visual evidence (clear parts first!).
    # On exploded steps (`deltas != (0.0,)`), place SEATED parts (`delta == 0`) BEFORE FLOATING parts
    # (`delta > 0`) so floating parts (e.g. flame above candle, clip above blaster) have their seated host!
    unique_types = list(dict.fromkeys(parts))
    if len(unique_types) > 1:
        best_root = {}
        best_is_seated = {}
        for p, c in unique_types:
            cands = distinct(lib, p, cached_cands(p, base))
            if collider is not None and cands:
                cands = [q for q in cands if not collider.hits(p, q["matrix"])]
            scored = score_candidates_calibrated(lib, scorer, [], p, c, cands, deltas=deltas, pushes=pushes, float_base=float_base) if cands else []
            scored.sort(key=lambda s: -s.score)
            best_root[(p, c)] = scored[0].score if scored else -1e9
            best_is_seated[(p, c)] = bool(scored and scored[0].delta == 0.0 and scored[0].move is None)
        if deltas != (0.0,):
            order = sorted(range(len(parts)), key=lambda i: (0 if best_is_seated[parts[i]] else 1, -max(0.0, best_root[parts[i]]), -_size(lib, parts[i][0])))
        else:
            order = sorted(range(len(parts)), key=lambda i: (-max(0.0, best_root[parts[i]]), -_size(lib, parts[i][0])))
    else:
        order = list(range(len(parts)))

    # 2. Seed states (empty + filled hole stacks + global MILP exact-cover tiling seeds)
    states = [State(total=scorer.base_score)]
    milp_complete: list[State] = []
    if use_milp and deltas == (0.0,) and 2 <= len(parts) <= 12:
        for mst in _milp_tiling_seeds(lib, scorer, base, parts, cached_cands, collider=collider, max_sols=milp_max_sols,
                                      time_limit=milp_time_limit):
            if len(mst.done) == len(parts):
                milp_complete.append(mst)
            else:
                states.append(mst)
    if fill and len(parts) > 1:
        hits_fn = None
        if collider is not None:
            def hits_fn(part, matrix, model):
                if len(model) == len(base):
                    return collider.hits(part, matrix)
                return collider.hits_extra(part, matrix, model[len(base):])
        def cal_score(part, colour, cands_list, d_grid):
            return score_candidates_calibrated(lib, scorer, [], part, colour, cands_list, deltas=d_grid)
        fill_kw = {}
        if fill_depth is not None:
            fill_kw["max_depth"] = fill_depth
        if fill_budget is not None:
            fill_kw["max_budget"] = fill_budget
        stacks = _filled_stacks(lib, scene_for(base), base, parts, cached_cands, hits_fn, order,
                                score_fn=cal_score, **fill_kw)
        for st in stacks:
            st.total = scorer.score(_drawn_entries(st.placed, st.scores))
            states.append(st)

    # 3. Beam search: every layer scored directly by exact incremental ModelScorer!
    # For large identical-part steps already covered by global MILP seeds, use a tighter beam so
    # we don't waste 45s on redundant identical-part permutations.
    fast_ident = bool(milp_complete and len(unique_types) == 1 and len(parts) >= 4)
    eff_beam = min(beam, 4) if fast_ident else beam
    eff_per_part = min(per_part, 8) if fast_ident else per_part
    while any(len(st.done) < len(parts) for st in states):
        # If wall-clock budget is nearly exhausted on a huge-branching step (e.g. 6x6 baseplate on 100-part model),
        # smoothly narrow beam to finish remaining parts greedily rather than stalling for minutes!
        if _time.monotonic() > _t_deadline:
            eff_beam = min(eff_beam, 2)
            eff_per_part = min(eff_per_part, 3)
            states = states[:eff_beam]
        expanded: list[State] = [st for st in states if len(st.done) == len(parts)]
        advanced = False
        for st in states:
            if len(st.done) == len(parts):
                continue
            i = next(k for k in order if k not in st.done)
            part, colour = parts[i]
            model = base + st.placed
            drawn = _drawn_entries(st.placed, st.scores)
            cands = distinct(lib, part, cached_cands(part, model))
            if not cands:
                continue
            scored = score_candidates_calibrated(lib, scorer, drawn, part, colour, cands, deltas=deltas, pushes=pushes, float_base=float_base)
            fresh = len(base)
            scored.sort(key=lambda s: (-s.score, 0 if (s.candidate.get("host") or -1) >= fresh else 1))

            kept: list[Scored] = []
            kept_keys: set = set()

            def _accept(sc_item: Scored) -> bool:
                m = np.asarray(sc_item.candidate["matrix"], float)
                k = (_geom_key(lib, part, colour, m), bool(sc_item.delta > 0.0)) if deltas != (0.0,) else _geom_key(lib, part, colour, m)
                if k in kept_keys:
                    return False
                if collider is not None:
                    if collider.hits_extra(part, m, st.placed):
                        return False
                elif any(_boxes_overlap(lib, (part, colour, m), o) for o in st.placed):
                    return False
                kept_keys.add(k)
                kept.append(sc_item)
                return True

            if next_scorer is not None and deltas != (0.0,):
                # Score SEATED candidates against step N+1 (where exploded parts are shown attached!)
                scored_next = score_candidates_calibrated(lib, next_scorer, st.placed, part, colour, cands, deltas=(0.0,))
                scored_next.sort(key=lambda s: -s.score)
                # Map cand id -> current-step Scored so drawn_pose stays consistent for step N
                by_id = {id(sc.candidate): sc for sc in scored}
                next_score_by_id = {id(nsc.candidate): float(nsc.score) for nsc in scored_next}
                n_added = 0
                for nsc in scored_next:
                    if n_added >= per_part:
                        break
                    cur_sc = by_id.get(id(nsc.candidate), nsc)
                    if _accept(cur_sc):
                        n_added += 1
            else:
                next_score_by_id = {}

            cur_limit = eff_per_part if next_scorer is None else max(4, eff_per_part // 2)
            # Cap zero-pixel hidden poses (`changed == 0`) to at most 2 slots so dozens of underneath
            # hidden poses (`score == 0.0`) can NEVER evict visible high-edge-precision poses (whose
            # edge-recall gain is only seen by exact ModelScorer, e.g. 41488 s2 `2420`)!
            c_added = 0
            hidden_added = 0
            for sc in scored:
                if c_added >= cur_limit:
                    break
                if sc.changed == 0:
                    if hidden_added >= 2:
                        continue
                    if _accept(sc):
                        c_added += 1
                        hidden_added += 1
                elif _accept(sc):
                    c_added += 1
            # Also reserve up to 3 slots for top visible edge-precision candidates (covers EDGE_REC delta)
            # and up to 3 slots for top visible colour-gain candidates (covers dense-edge black-on-black parts!)
            edge_added = 0
            for sc in sorted((s for s in scored if s.changed > 0 and s.edge > 20.0),
                             key=lambda s: -(s.score + 1.5 * s.edge)):
                if edge_added >= 3:
                    break
                if _accept(sc):
                    edge_added += 1
            col_added = 0
            for sc in sorted((s for s in scored if s.changed >= 200 and s.colour > 50.0),
                             key=lambda s: -s.colour):
                if col_added >= 3:
                    break
                if _accept(sc):
                    col_added += 1
            # On exploded steps (`deltas != (0.0,)`), MOST parts are still drawn SEATED (`d = 0`), while
            # only 1-2 parts float along arrows! Always reserve up to 4 slots for top SEATED (`d = 0`)
            # poses so high-delta floating candidates can never evict true seated poses from the beam!
            if deltas != (0.0,):
                seat_added = 0
                for sc in sorted(scored, key=lambda s: -s.seated):
                    if seat_added >= 4:
                        break
                    sc0 = sc if (sc.delta == 0.0 and sc.move is None) else Scored(
                        sc.seated, 0.0, 1.0, sc.candidate, sc.colour, sc.edge, sc.seated, sc.changed
                    )
                    if _accept(sc0):
                        seat_added += 1

            for j, sc in enumerate(kept):
                nxt = kept[j + 1].score if j + 1 < len(kept) else (kept[j - 1].score if j else sc.score - 100.0)
                sc.margin = sc.score - nxt if j == 0 else sc.score - kept[0].score
                entry = (part, colour, np.asarray(sc.candidate["matrix"], float))
                new_placed = st.placed + [entry]
                new_scores = st.scores + [sc]
                # Exact ModelScorer evaluation on step N's picture (using drawn poses for exploded parts).
                # Subtract FLOAT_PENALTY * delta so a buried part floating up to the exact same 2D pixels
                # can never tie or beat a genuinely seated part!
                # On exploded steps with a verified same-camera step N+1, ADD precision-focused seated
                # consistency in step N+1 (clamped so occlusion in step N+1 never overwrites step N!).
                drawn_np = _drawn_entries(new_placed, new_scores)
                cur_ex, vis_np = scorer.score_and_vis(drawn_np)
                if deltas == (0.0,):
                    cur_ex -= _hidden_backside_penalty(lib, scorer, new_placed, vis_np)
                else:
                    # On mixed exploded steps, penalise hiding SEATED parts (`delta == 0`) behind the model too!
                    seated_p = [e for e, s in zip(new_placed, new_scores) if s is None or (s.delta == 0.0 and s.move is None)]
                    seated_v = [v for v, s in zip(vis_np, new_scores) if s is None or (s.delta == 0.0 and s.move is None)]
                    if seated_p:
                        cur_ex -= _hidden_backside_penalty(lib, scorer, seated_p, seated_v)
                    cur_ex -= sum(_float_cost(float(s.delta), float_base) for s in new_scores if s is not None)
                exact_val = cur_ex
                if next_scorer is not None and deltas != (0.0,):
                    nv_ex = float(next_scorer.score_seated_in_next(new_placed))
                    cur_delta = cur_ex - float(scorer.base_score)
                    exact_val += 1.0 * max(nv_ex, -0.35 * max(0.0, cur_delta))
                exact_val -= sum(_non_ortho_penalty(s.candidate if s else None, m_i) for (_p, _c, m_i), s in zip(new_placed, new_scores))
                if collider is not None and getattr(collider, "native", None) is not None:
                    exact_val += _physical_bonus(collider, base, new_placed)
                if (sc.candidate.get("host") or -1) >= fresh and sc.changed < 40:
                    exact_val += SAME_STEP_TIE
                expanded.append(State(new_placed, new_scores, exact_val, st.done | {i}, st.groups))
                advanced = True

        if not advanced:
            break
        expanded.sort(key=lambda s: -s.total)
        unique, seen = [], set()
        for st in expanded:
            key = _state_geom_key(lib, st.placed)
            if key in seen:
                continue
            seen.add(key)
            unique.append(st)
            if len(unique) >= eff_beam:
                break
        states = unique

    # Merge MILP complete seeds with beam complete states (deduplicated, sorted by exact ModelScorer)
    if milp_complete:
        merged, seen_m = [], set()
        for st in sorted(states + milp_complete, key=lambda s: -s.total):
            k = _state_geom_key(lib, st.placed)
            if k in seen_m:
                continue
            seen_m.add(k)
            merged.append(st)
        states = merged

    # 4. Multi-start joint polish directly on ModelScorer (in-place steps, AND seated subset on mixed exploded steps!)
    complete = [st for st in states if len(st.placed) == len(parts)]
    if complete and deltas == (0.0,) and polish_starts > 0 and _time.monotonic() < _t_deadline + 6.0:
        polished = []
        seen_keys = set()
        n_pol = min(polish_starts, len(complete))
        for st in complete[:n_pol]:
            rem = max(2.0, (_t_deadline + 12.0) - _time.monotonic())
            pst = exact_polish(lib, scorer, base, st, cached_cands, collider=collider,
                               top_k=polish_top_k, rounds=polish_rounds, time_budget=min(12.0, rem))
            k = _state_geom_key(lib, pst.placed)
            if k not in seen_keys:
                seen_keys.add(k)
                polished.append(pst)
        # Keep remaining beam states as alternatives for lookahead
        for st in complete[n_pol:]:
            k = _state_geom_key(lib, st.placed)
            if k not in seen_keys:
                seen_keys.add(k)
                polished.append(st)
        polished.sort(key=lambda s: -s.total)
        return polished

    # 4b. On mixed exploded steps (e.g. 41620 s8: 1 floating printed tile + 4 seated black corner plates!),
    # polish ONLY the seated parts (`delta == 0.0`) while holding floating parts fixed at their drawn poses!
    if complete and deltas != (0.0,) and polish_starts > 0 and _time.monotonic() < _t_deadline + 4.0:
        polished_exp = []
        seen_ek = set()
        n_ep = min(2, polish_starts, len(complete))
        for st in complete[:n_ep]:
            seat_idxs = [idx_p for idx_p, s in enumerate(st.scores) if s is None or (s.delta == 0.0 and s.move is None)]
            float_idxs = [idx_p for idx_p in range(len(st.placed)) if idx_p not in set(seat_idxs)]
            if len(seat_idxs) >= 2:
                float_drawn = [
                    (st.placed[k][0], st.placed[k][1], drawn_pose(st.scores[k]) if st.scores[k] is not None else st.placed[k][2])
                    for k in float_idxs
                ]
                float_seated = [st.placed[k] for k in float_idxs]
                # Score seated parts with floating parts rendered at their drawn poses in `sub_sc`
                sub_sc = ModelScorer(lib, base + float_drawn, scorer.picture, scorer.view, scorer.codes)
                if getattr(scorer, "changed", None) is not None:
                    sub_sc.changed = scorer.changed
                    sub_sc.chg_plane = scorer.chg_plane
                sub_base_col = base + float_seated
                seat_st = State([st.placed[k] for k in seat_idxs], [st.scores[k] for k in seat_idxs], 0.0)
                if collider is not None:
                    collider.set_model(sub_base_col)
                pst_s = exact_polish(lib, sub_sc, sub_base_col, seat_st, cached_cands, collider=collider,
                                     top_k=min(polish_top_k, 24), rounds=2, time_budget=4.0)
                if collider is not None:
                    collider.set_model(base)
                # Reassemble full state and re-score with exact full exploded objective!
                comb_p = list(st.placed)
                comb_s = list(st.scores)
                for loc_i, orig_i in enumerate(seat_idxs):
                    comb_p[orig_i] = pst_s.placed[loc_i]
                    comb_s[orig_i] = pst_s.scores[loc_i]
                drawn_c = _drawn_entries(comb_p, comb_s)
                c_ex, v_ex = scorer.score_and_vis(drawn_c)
                c_ex -= _hidden_backside_penalty(lib, scorer, [comb_p[k] for k in seat_idxs], [v_ex[k] for k in seat_idxs])
                c_ex -= sum(_float_cost(float(s.delta), float_base) for s in comb_s if s is not None)
                c_tot = c_ex
                if next_scorer is not None:
                    nv_c = float(next_scorer.score_seated_in_next(comb_p))
                    c_tot += 1.0 * max(nv_c, -0.35 * max(0.0, c_ex - float(scorer.base_score)))
                c_tot -= sum(_non_ortho_penalty(s.candidate if s else None, m_i) for (_p, _c, m_i), s in zip(comb_p, comb_s))
                if collider is not None and getattr(collider, "native", None) is not None:
                    c_tot += _physical_bonus(collider, base, comb_p)
                chosen = State(comb_p, comb_s, c_tot, st.done, st.groups) if c_tot > st.total + 1e-4 else st
            else:
                chosen = st
            k = _state_geom_key(lib, chosen.placed)
            if k not in seen_ek:
                seen_ek.add(k)
                polished_exp.append(chosen)
        for st in complete[n_ep:]:
            k = _state_geom_key(lib, st.placed)
            if k not in seen_ek:
                seen_ek.add(k)
                polished_exp.append(st)
        polished_exp.sort(key=lambda s: -s.total)
        return polished_exp

    states.sort(key=lambda s: -s.total)
    return states


def _rotate_about_axis(axis: np.ndarray, deg: float) -> np.ndarray:
    a = np.asarray(axis, float)
    a = a / (np.linalg.norm(a) or 1.0)
    t = np.radians(deg)
    c, s = float(np.cos(t)), float(np.sin(t))
    k = np.array([[0.0, -a[2], a[1]], [a[2], 0.0, -a[0]], [-a[1], a[0], 0.0]])
    return np.eye(3) + s * k + (1.0 - c) * (k @ k)


def _refine_continuous_part(lib, scorer: ModelScorer, base: list, placed: list, scores: list,
                            idx: int, collider, cur_val: float) -> tuple[list, list, float]:
    """Fine 1D search over roll angle & slide for clip/hinge/technic parts."""
    sc = scores[idx]
    if sc is None or not isinstance(sc.candidate, dict):
        return placed, scores, cur_val
    kind = sc.candidate.get("kind")
    axis = sc.candidate.get("axis")
    if kind not in CONTINUOUS_KINDS or axis is None:
        return placed, scores, cur_val
    axis = np.asarray(axis, float)
    n = np.linalg.norm(axis)
    if n < 1e-6:
        return placed, scores, cur_val
    axis = axis / n

    part, colour, m0 = placed[idx]
    m0 = np.asarray(m0, float)
    others = [o for k, o in enumerate(placed) if k != idx]
    if collider is not None:
        collider.set_model(base)

    best_m = m0
    best_val = cur_val
    # 1. Refine slide along axis (especially for clips / sliding Technic parts)
    for step in (2.0, 0.5):
        improved = True
        while improved:
            improved = False
            for ds in (-step, step):
                m = best_m.copy()
                m[:3, 3] = m[:3, 3] + ds * axis
                if collider is not None and collider.hits_extra(part, m, others):
                    continue
                trial = list(placed)
                trial[idx] = (part, colour, m)
                v = scorer.score(trial)
                if v > best_val + 0.5:
                    best_val, best_m, improved = v, m, True
                    break
    # 2. Refine roll angle about axis (pivot = part origin or connector point)
    if kind in ("clip", "hinge"):
        pivot = best_m[:3, 3].copy()
        for step in (5.0, 2.0):
            for da in (-step, step):
                R = _rotate_about_axis(axis, da)
                m = np.eye(4)
                m[:3, :3] = R @ best_m[:3, :3]
                m[:3, 3] = pivot
                if collider is not None and collider.hits_extra(part, m, others):
                    continue
                trial = list(placed)
                trial[idx] = (part, colour, m)
                v = scorer.score(trial)
                if v > best_val + 0.5:
                    best_val, best_m = v, m
    if best_val > cur_val + 0.5:
        out_p = list(placed)
        out_s = list(scores)
        out_p[idx] = (part, colour, best_m)
        out_s[idx] = Scored(sc.score, 0.0, 1.0, {**sc.candidate, "matrix": best_m},
                            sc.colour, sc.edge, sc.seated, sc.changed)
        return out_p, out_s, best_val
    return placed, scores, cur_val


def exact_polish(lib, scorer: ModelScorer, base: list, state: State, candidate_fn,
                 collider=None, top_k: int = 40, rounds: int = 4, time_budget: float = 12.0) -> State:
    """Coordinate ascent + swaps + blocking-pair moves + host-with-children + unit moves on ModelScorer.
    Enforces collision-freedom AND structural connectivity to `base` on every move (never pulls a support
    brick out from under a stack and leaves upper parts floating in midair)."""
    import time as _time
    _t_deadline = _time.monotonic() + time_budget
    placed = [(p, c, np.asarray(m, float)) for p, c, m in state.placed]
    scores = list(state.scores)
    groups = state.groups or [[i] for i in range(len(placed))]
    has_native = collider is not None and getattr(collider, "native", None) is not None
    if collider is not None:
        collider.set_model(base)

    # Track minimum required connected-to-base count (never break connectivity!)
    min_connected = 0
    if has_native and placed:
        _c0, conn0, _m0, _g0 = collider.layout_check(placed)
        min_connected = conn0

    def _breaks_support(old_placed: list, new_placed: list, moved_idxs: set[int]) -> bool:
        """When native connectivity check is unavailable (collider=None), prevent pulling a support
        brick out from underneath another newly placed part that rests directly on it."""
        if has_native or len(old_placed) <= 1:
            return False
        from .place import _world_aabb
        def _xz_supported(upper, lower) -> bool:
            ulo, uhi = _world_aabb(lib, upper[0], upper[2])
            llo, lhi = _world_aabb(lib, lower[0], lower[2])
            # Upper sits directly on top of lower: bottom of upper (uhi[1]) sits at lower's top
            # surface (`llo[1] + 4` for a studded part, `llo[1]` for a flush tile), never floating
            # 1 plate above (`uhi[1] - llo[1] == -4`)!
            if not (-1.0 <= uhi[1] - llo[1] <= 5.5):
                return False
            ox = min(uhi[0], lhi[0]) - max(ulo[0], llo[0])
            oz = min(uhi[2], lhi[2]) - max(ulo[2], llo[2])
            return ox > 2.0 and oz > 2.0

        n_b = len(base)
        for j in range(len(old_placed)):
            if j in moved_idxs:
                continue
            sc_j = scores[j] if j < len(scores) else None
            host_j = sc_j.candidate.get("host") if (sc_j is not None and isinstance(sc_j.candidate, dict)) else None
            if isinstance(host_j, int) and (host_j - n_b) in moved_idxs:
                return True
            for m_idx in moved_idxs:
                if _xz_supported(old_placed[j], old_placed[m_idx]):
                    # Check if j still has another direct support underneath it in base or unmoved placed parts
                    still_supported = any(_xz_supported(old_placed[j], b) for b in base) or any(
                        _xz_supported(old_placed[j], old_placed[k]) for k in range(len(old_placed)) if k != j and k not in moved_idxs
                    )
                    if not still_supported:
                        return True
        return False

    def eval_layout(lay: list, check_valid: bool = True, moved_idxs: set[int] | None = None) -> float:
        if has_native:
            collides, connected, mates, _grip = collider.layout_check(lay)
            if check_valid and (collides or connected < min_connected):
                return -1e18
            sc_v, vis_v = scorer.score_and_vis(lay)
            return sc_v - _hidden_backside_penalty(lib, scorer, lay, vis_v) + MATE_TIE_WEIGHT * float(mates)
        if check_valid and moved_idxs and _breaks_support(placed, lay, moved_idxs):
            return -1e18
        sc_v, vis_v = scorer.score_and_vis(lay)
        return sc_v - _hidden_backside_penalty(lib, scorer, lay, vis_v)

    best_val = eval_layout(placed, check_valid=False)

    def rest_of(skip: set[int]) -> list:
        return [o for k, o in enumerate(placed) if k not in skip]

    def shortlist_part(part: str, colour: int, model: list, drawn_others: list) -> list[Scored]:
        cands = distinct(lib, part, candidate_fn(part, model))
        if not cands:
            return []
        sc = score_candidates_calibrated(lib, scorer, drawn_others, part, colour, cands, deltas=(0.0,))
        sc.sort(key=lambda s: -s.score)
        # Cap completely hidden (`changed == 0`) poses to at most 2 slots so they never crowd out
        # visible poses with strong edge precision (whose edge recall raises exact ModelScorer!).
        out_p: list[Scored] = []
        seen_id: set[int] = set()
        hidden_n = 0
        for s in sc:
            if len(out_p) >= top_k:
                break
            if s.changed == 0:
                if hidden_n >= 2:
                    continue
                hidden_n += 1
            out_p.append(s)
            seen_id.add(id(s))
        # Ensure top edge-matching visible poses always enter the polish shortlist
        for s in sorted((x for x in sc if x.changed > 0 and x.edge > 20.0),
                        key=lambda x: -(x.score + 1.5 * x.edge))[:6]:
            if id(s) not in seen_id:
                out_p.append(s)
                seen_id.add(id(s))
        return out_p

    def shortlist_group(group: list[int], skip: set[int]) -> list[tuple[list, list]]:
        rest = rest_of(skip)
        model = base + rest
        if len(group) == 1:
            p, c, _m = placed[group[0]]
            return [([(p, c, np.asarray(s.candidate["matrix"], float))], [s])
                    for s in shortlist_part(p, c, model, rest)]
        # Rigid multi-part unit copy (expand self-symmetric turns dropped by `distinct()`)
        from .subbuild import _self_symmetries
        entries = [placed[k] for k in group]
        m0inv = np.linalg.inv(entries[0][2])
        config = [(q, c, m0inv @ m) for q, c, m in entries]
        options: dict = {}
        for q, _c, rel in config:
            inv = np.linalg.inv(rel)
            syms = _self_symmetries(lib, q)
            for cand in candidate_fn(q, model):
                cm = np.asarray(cand["matrix"], float)
                for sym in syms:
                    t = (cm @ sym) @ inv
                    key = tuple(np.round(t[:3, :4], 1).ravel())
                    if key not in options:
                        options[key] = [(qq, cc, t @ r) for qq, cc, r in config]
        if not options:
            return []
        # Batch-score rigid unit poses through C++ `bm_score_sprites` (~300x faster than Python loop!)
        from .subbuild import _batch_score_unit_options
        cur_bufs = _build_current_buffers(lib, scorer, rest)
        opt_list = [(world, None, True, False) for world in options.values()]
        scored_u = _batch_score_unit_options(lib, scorer, cur_bufs, opt_list, (0.0,))
        pre_ranked = [(tot, world) for tot, world, _ss, _up in scored_u]
        pre_ranked.sort(key=lambda x: -x[0])
        # Exact ModelScorer evaluation only on top collision-free shortlist
        ranked = []
        for _sv, world in pre_ranked[:max(top_k * 3, 48)]:
            if collider is not None and any(collider.hits_extra(qq, m, rest) for qq, _cc, m in world):
                continue
            trial = list(placed)
            for k, e in zip(group, world):
                trial[k] = e
            ranked.append((scorer.score(trial), world))
            if len(ranked) >= top_k:
                break
        ranked.sort(key=lambda x: -x[0])
        return [(world, [None] * len(world)) for _v, world in ranked[:top_k]]

    for _round in range(rounds):
        if _time.monotonic() > _t_deadline:
            break
        improved = False

        # A. Single-group moves + blocking-pair moves
        for g, group in enumerate(groups):
            if _time.monotonic() > _t_deadline:
                break
            gset = set(group)
            for entries, scs in shortlist_group(group, gset):
                if all(_same_spot(e[2], placed[k][2]) and np.allclose(e[2][:3, :3], placed[k][2][:3, :3], atol=1e-3)
                       for e, k in zip(entries, group)):
                    continue
                # Fast collision check against base (base is already loaded in collider!)
                if collider is not None:
                    if any(collider.hits(q, m) for q, _c, m in entries):
                        continue
                # Find which other new groups collide with `entries` (no BVH rebuild!)
                blocking = []
                for h, other in enumerate(groups):
                    if h == g:
                        continue
                    other_entries = [placed[k] for k in other]
                    if any(_boxes_overlap(lib, e, o, shrink=0.5) for e in entries for o in other_entries):
                        if has_native:
                            if any(collider.hits_extra(q, m, other_entries) for q, _c, m in entries):
                                blocking.append(h)
                        else:
                            blocking.append(h)

                if not blocking:
                    trial = list(placed)
                    for k, e in zip(group, entries):
                        trial[k] = e
                    v = eval_layout(trial, moved_idxs=gset)
                    if v > best_val + 1e-4:
                        best_val = v
                        placed = trial
                        if has_native:
                            _, min_connected, _, _ = collider.layout_check(placed)
                        for k, sc in zip(group, scs):
                            if sc is not None:
                                scores[k] = sc
                        improved = True
                        break
                elif len(blocking) == 1 and len(groups[blocking[0]]) == 1:
                    # Try moving the single blocking part out of the way to its best free candidate
                    h = blocking[0]
                    hk = groups[h][0]
                    hp, hc, _hm = placed[hk]
                    skip_both = gset | {hk}
                    rest_both = rest_of(skip_both) + list(entries)
                    model_both = base + rest_both
                    for sc2 in shortlist_part(hp, hc, model_both, rest_both)[:8]:
                        m2 = np.asarray(sc2.candidate["matrix"], float)
                        if collider is not None and collider.hits_extra(hp, m2, rest_both):
                            continue
                        trial = list(placed)
                        for k, e in zip(group, entries):
                            trial[k] = e
                        trial[hk] = (hp, hc, m2)
                        v = eval_layout(trial)
                        if v > best_val + 1e-4:
                            best_val = v
                            placed = trial
                            if has_native:
                                _, min_connected, _, _ = collider.layout_check(placed)
                            for k, sc in zip(group, scs):
                                if sc is not None:
                                    scores[k] = sc
                            scores[hk] = sc2
                            improved = True
                            break
                    if improved:
                        break

                elif len(blocking) == 2 and len(groups[blocking[0]]) == 1 and len(groups[blocking[1]]) == 1:
                    # Try moving BOTH blocking single parts out of the way (fixes 2-for-2 shifted rings!)
                    hk1, hk2 = groups[blocking[0]][0], groups[blocking[1]][0]
                    p1, c1, _m1 = placed[hk1]
                    p2, c2, _m2 = placed[hk2]
                    skip_all = gset | {hk1, hk2}
                    rest_1 = rest_of(skip_all) + list(entries)
                    model_1 = base + rest_1
                    for sc1 in shortlist_part(p1, c1, model_1, rest_1)[:4]:
                        m1 = np.asarray(sc1.candidate["matrix"], float)
                        if collider is not None and collider.hits_extra(p1, m1, rest_1):
                            continue
                        rest_2 = rest_1 + [(p1, c1, m1)]
                        model_2 = base + rest_2
                        for sc2 in shortlist_part(p2, c2, model_2, rest_2)[:4]:
                            m2 = np.asarray(sc2.candidate["matrix"], float)
                            if collider is not None and collider.hits_extra(p2, m2, rest_2):
                                continue
                            trial = list(placed)
                            for k, e in zip(group, entries):
                                trial[k] = e
                            trial[hk1] = (p1, c1, m1)
                            trial[hk2] = (p2, c2, m2)
                            v = eval_layout(trial)
                            if v > best_val + 1e-4:
                                best_val = v
                                placed = trial
                                if has_native:
                                    _, min_connected, _, _ = collider.layout_check(placed)
                                for k, sc in zip(group, scs):
                                    if sc is not None:
                                        scores[k] = sc
                                scores[hk1] = sc1
                                scores[hk2] = sc2
                                improved = True
                                break
                        if improved:
                            break
                    if improved:
                        break

        # B. Direct pairwise swaps between distinct single-part groups (e.g. black & gold 1x1 plates, tan tile & slope)
        singles = [g[0] for g in groups if len(g) == 1]
        for a_i in range(len(singles)):
            for b_i in range(a_i + 1, len(singles)):
                i, j = singles[a_i], singles[b_i]
                pi, ci, mi = placed[i]
                pj, cj, mj = placed[j]
                if (pi, ci) == (pj, cj):
                    continue
                if abs(_size(lib, pi) - _size(lib, pj)) > 0.35 * max(_size(lib, pi), _size(lib, pj), 1.0):
                    continue
                trial = list(placed)
                trial[i] = (pi, ci, mj)
                trial[j] = (pj, cj, mi)
                v = eval_layout(trial)
                if v > best_val + 1e-4:
                    best_val = v
                    placed = trial
                    if has_native:
                        _, min_connected, _, _ = collider.layout_check(placed)
                    improved = True

        # C. Rigid host + child cluster moves (when a new part sits on another new part)
        if len(singles) >= 2 and has_native:
            for host_idx in singles:
                hp, hc, hm = placed[host_idx]
                children = []
                for ch_idx in singles:
                    if ch_idx == host_idx:
                        continue
                    cp, cc, cm = placed[ch_idx]
                    m_base, _ = collider.mates(cp, cm)
                    if m_base == 0:
                        # Check if ch_idx mates with host_idx (only 1-part check, fast box prefilter)
                        if _boxes_overlap(lib, placed[host_idx], placed[ch_idx], shrink=-6.0):
                            children.append(ch_idx)
                if not children:
                    continue
                cluster = [host_idx] + children
                cset = set(cluster)
                rest_c = rest_of(cset)
                model_c = base + rest_c
                h_inv = np.linalg.inv(hm)
                rels = [(placed[k][0], placed[k][1], h_inv @ placed[k][2]) for k in cluster]
                for sc_h in shortlist_part(hp, hc, model_c, rest_c)[:10]:
                    new_hm = np.asarray(sc_h.candidate["matrix"], float)
                    if _same_spot(new_hm, hm) and np.allclose(new_hm[:3, :3], hm[:3, :3], atol=1e-3):
                        continue
                    moved_c = [(q, col, new_hm @ rel) for q, col, rel in rels]
                    trial = list(placed)
                    for k, e in zip(cluster, moved_c):
                        trial[k] = e
                    v = eval_layout(trial)
                    if v > best_val + 1e-4:
                        best_val = v
                        placed = trial
                        _, min_connected, _, _ = collider.layout_check(placed)
                        scores[host_idx] = sc_h
                        improved = True
                        break
                if improved:
                    break

        if not improved:
            break

    # D. Continuous DoF refinement for any clips/hinges/technic parts
    for idx in range(len(placed)):
        placed, scores, best_val = _refine_continuous_part(lib, scorer, base, placed, scores, idx, collider, best_val)

    return State(placed, scores, best_val, state.done, state.groups)
