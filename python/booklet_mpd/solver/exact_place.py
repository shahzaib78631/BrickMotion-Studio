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

MATE_TIE_WEIGHT = 0.5        # tiny tie-breaker per mated connector (in pixel-score units)
SAME_STEP_TIE = 0.2          # tiny tie-breaker for snapping an occluded part onto a new part
CONTINUOUS_KINDS = ("clip", "hinge", "technic")


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
    be = cur_edge_depth[r0:r1, c0:c1][vis] <= cur_depth[r0:r1, c0:c1][vis] + DEPTH_TOL
    ep = scorer.edge_prec_map[r0:r1, c0:c1][vis]
    edge_gain = EDGE_PREC_WEIGHT * float(ep[se].sum() - ep[be].sum())

    # 3. Previous-step change mask bonus/penalty
    chg_gain = 0.0
    if scorer.changed is not None:
        ch = scorer.changed[r0:r1, c0:c1][vis]
        arr = scorer.arrows[r0:r1, c0:c1][vis]
        on_ch = int(np.count_nonzero(ch))
        on_unch = int(np.count_nonzero(~ch & ~arr))
        chg_gain = CHANGE_WEIGHT * float(on_ch - on_unch)

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
    base_vis_ed = np.where(scorer.base_edge_depth <= depth + DEPTH_TOL, scorer.base_edge_depth, np.inf)
    edge_depth = np.minimum(base_vis_ed, add_ed)
    return depth, label, col_map, edge_depth


def score_candidates_calibrated(lib, scorer: ModelScorer, drawn_placed: list, part: str, colour: int,
                                cands: list[dict], deltas=DELTAS, pushes=()) -> list[Scored]:
    """Score candidates using ModelScorer's calibrated Lab planes, dark+light edges, and change mask."""
    cur_depth, cur_label, cur_col_map, cur_edge_depth = _build_current_buffers(lib, scorer, drawn_placed)
    cidx = scorer.code_idx.get(colour, -1)
    out: list[Scored] = []
    for cand in cands:
        m = np.asarray(cand["matrix"], float)
        sp = part_sprite(lib, part, m[:3, :3], scorer.view)
        if not sp.mask.size:
            out.append(Scored(-np.inf, 0.0, 1.0, cand))
            continue
        axis = approach_axis(cand)
        best = None
        seated = 0.0
        signs = (1.0, -1.0) if cand.get("axis") is None or cand.get("bidirectional") else (1.0,)
        for sign in signs:
            for delta in deltas:
                if delta == 0.0 and sign < 0:
                    continue
                row0, col0, dd, _origin = sp.place(scorer.view, m[:3, 3] + sign * delta * axis)
                val, cg, eg, changed = _sprite_delta_score(
                    scorer, sp, row0, col0, dd, cidx, cur_depth, cur_label, cur_col_map, cur_edge_depth
                )
                val -= FLOAT_PENALTY * delta
                if delta == 0.0:
                    seated = val
                if best is None or val > best[0]:
                    best = (val, delta, sign, cg, eg, changed, None)
        if pushes:
            row0, col0, dd, _origin = sp.place(scorer.view, m[:3, 3])
            back = scorer.view.matrix.T
            for d_dir, length in pushes:
                for k in PUSH_STEPS:
                    for sign in (1.0, -1.0):
                        du, dv = sign * k * length * d_dir[0], sign * k * length * d_dir[1]
                        val, cg, eg, changed = _sprite_delta_score(
                            scorer, sp, row0 + int(round(dv)), col0 + int(round(du)), dd,
                            cidx, cur_depth, cur_label, cur_col_map, cur_edge_depth,
                        )
                        ldu = k * length / max(scorer.view.scale, 1e-6)
                        val -= FLOAT_PENALTY * ldu
                        if val > best[0]:
                            move = back @ np.array([du / scorer.view.scale, dv / scorer.view.scale, 0.0])
                            best = (val, ldu, 1.0, cg, eg, changed, move)
        value = best[0] + float(cand.get("prior", 0.0)) * abs(best[0])
        out.append(Scored(value, best[1], best[2], cand, best[3], best[4], seated, best[5], move=best[6]))
    return out


def _drawn_entries(placed: list, scores: list) -> list:
    return [(p, c, drawn_pose(sc) if sc is not None else m) for (p, c, m), sc in zip(placed, scores)]


def _physical_bonus(collider, base: list, placed: list) -> float:
    """Small tie-breaker favouring physically well-mated poses (only breaks visual ties)."""
    if collider is None or not placed or not getattr(collider, "native", None):
        return 0.0
    total = 0.0
    cur = list(base)
    for p, c, m in placed:
        collider.set_model(cur)
        mates, _grip = collider.mates(p, m)
        total += min(mates, 6)
        cur.append((p, c, m))
    return MATE_TIE_WEIGHT * total


def _collides_with(collider, lib, part: str, matrix: np.ndarray, model: list, placed_others: list) -> bool:
    if any(_boxes_overlap(lib, (part, 0, matrix), o) for o in placed_others):
        # Verify with exact collider when available (e.g. plate on headlight brick's recessed side stud)
        if collider is None or not collider.exact:
            return True
    if collider is not None:
        collider.set_model(model)
        return collider.hits(part, matrix)
    return False


def solve_step_exact(lib, scene_for, scorer: ModelScorer, base: list, parts: list[tuple[str, int]],
                     candidate_fn, collider=None, beam: int = 10, per_part: int = 12,
                     deltas=DELTAS, pushes=(), fill: bool = True) -> list[State]:
    """Exact ModelScorer-guided beam search + multi-start joint polish."""
    if not parts:
        return [State()]

    # 1. Order part types by strongest root-state visual evidence (clear parts first!)
    unique_types = list(dict.fromkeys(parts))
    if len(unique_types) > 1:
        best_root = {}
        for p, c in unique_types:
            cands = distinct(lib, p, candidate_fn(p, base))
            if collider is not None and cands:
                collider.set_model(base)
                cands = [q for q in cands if not collider.hits(p, q["matrix"])]
            scored = score_candidates_calibrated(lib, scorer, [], p, c, cands, deltas=deltas, pushes=pushes) if cands else []
            scored.sort(key=lambda s: -s.score)
            best_root[(p, c)] = scored[0].score if scored else -1e9
        order = sorted(range(len(parts)), key=lambda i: (-best_root[parts[i]], -_size(lib, parts[i][0])))
    else:
        order = list(range(len(parts)))

    # 2. Seed states (empty + any filled hole stacks)
    states = [State(total=scorer.base_score)]
    if fill and len(parts) > 1:
        hits_fn = None
        if collider is not None:
            def hits_fn(part, matrix, model):
                collider.set_model(model)
                return collider.hits(part, matrix)
        stacks = _filled_stacks(lib, scene_for(base), base, parts, candidate_fn, hits_fn, order)
        for st in stacks:
            st.total = scorer.score(_drawn_entries(st.placed, st.scores))
            states.append(st)

    # 3. Beam search: every layer scored directly by exact incremental ModelScorer!
    while any(len(st.done) < len(parts) for st in states):
        expanded: list[State] = [st for st in states if len(st.done) == len(parts)]
        advanced = False
        for st in states:
            if len(st.done) == len(parts):
                continue
            i = next(k for k in order if k not in st.done)
            part, colour = parts[i]
            model = base + st.placed
            drawn = _drawn_entries(st.placed, st.scores)
            cands = distinct(lib, part, candidate_fn(part, model))
            if not cands:
                continue
            scored = score_candidates_calibrated(lib, scorer, drawn, part, colour, cands, deltas=deltas, pushes=pushes)
            fresh = len(base)
            scored.sort(key=lambda s: (-s.score, 0 if (s.candidate.get("host") or -1) >= fresh else 1))

            kept: list[Scored] = []
            if collider is not None:
                collider.set_model(model)
            for sc in scored:
                if len(kept) >= per_part:
                    break
                m = np.asarray(sc.candidate["matrix"], float)
                if collider is not None:
                    if collider.hits(part, m):
                        continue
                elif any(_boxes_overlap(lib, (part, colour, m), o) for o in st.placed):
                    continue
                kept.append(sc)

            for j, sc in enumerate(kept):
                nxt = kept[j + 1].score if j + 1 < len(kept) else (kept[j - 1].score if j else sc.score - 100.0)
                sc.margin = sc.score - nxt if j == 0 else sc.score - kept[0].score
                entry = (part, colour, np.asarray(sc.candidate["matrix"], float))
                new_placed = st.placed + [entry]
                new_scores = st.scores + [sc]
                # Exact ModelScorer evaluation of the partial state!
                exact_val = scorer.score(_drawn_entries(new_placed, new_scores))
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
            if len(unique) >= beam:
                break
        states = unique

    # 4. Multi-start joint polish directly on ModelScorer (only for in-place steps)
    complete = [st for st in states if len(st.placed) == len(parts)]
    if complete and deltas == (0.0,):
        polished = []
        seen_keys = set()
        for st in complete[:min(4, len(complete))]:
            pst = exact_polish(lib, scorer, base, st, candidate_fn, collider=collider)
            k = _state_geom_key(lib, pst.placed)
            if k not in seen_keys:
                seen_keys.add(k)
                polished.append(pst)
        # Keep remaining beam states as alternatives for lookahead
        for st in complete[4:]:
            k = _state_geom_key(lib, st.placed)
            if k not in seen_keys:
                seen_keys.add(k)
                polished.append(st)
        polished.sort(key=lambda s: -s.total)
        return polished

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
    others = base + [o for k, o in enumerate(placed) if k != idx]
    if collider is not None:
        collider.set_model(others)

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
                if collider is not None and collider.hits(part, m):
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
                if collider is not None and collider.hits(part, m):
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
                 collider=None, top_k: int = 24, rounds: int = 4) -> State:
    """Coordinate ascent + swaps + blocking-pair moves + host-with-children + unit moves on ModelScorer."""
    placed = [(p, c, np.asarray(m, float)) for p, c, m in state.placed]
    scores = list(state.scores)
    groups = state.groups or [[i] for i in range(len(placed))]

    def eval_layout(lay: list) -> float:
        return scorer.score(lay) + _physical_bonus(collider, base, lay)

    best_val = eval_layout(placed)

    def rest_of(skip: set[int]) -> list:
        return [o for k, o in enumerate(placed) if k not in skip]

    def shortlist_part(part: str, colour: int, model: list, drawn_others: list) -> list[Scored]:
        cands = distinct(lib, part, candidate_fn(part, model))
        if not cands:
            return []
        sc = score_candidates_calibrated(lib, scorer, drawn_others, part, colour, cands, deltas=(0.0,))
        sc.sort(key=lambda s: -s.score)
        return sc[:top_k]

    def shortlist_group(group: list[int], skip: set[int]) -> list[tuple[list, list]]:
        rest = rest_of(skip)
        model = base + rest
        if len(group) == 1:
            p, c, _m = placed[group[0]]
            return [([(p, c, np.asarray(s.candidate["matrix"], float))], [s])
                    for s in shortlist_part(p, c, model, rest)]
        # Rigid multi-part unit copy
        entries = [placed[k] for k in group]
        m0inv = np.linalg.inv(entries[0][2])
        config = [(q, c, m0inv @ m) for q, c, m in entries]
        options: dict = {}
        for q, _c, rel in config:
            inv = np.linalg.inv(rel)
            for cand in candidate_fn(q, model):
                t = np.asarray(cand["matrix"], float) @ inv
                key = tuple(np.round(t[:3, :4], 1).ravel())
                if key not in options:
                    options[key] = [(qq, cc, t @ r) for qq, cc, r in config]
        if not options:
            return []
        # Rank options quickly by exact ModelScorer
        ranked = []
        for world in options.values():
            trial = list(placed)
            for k, e in zip(group, world):
                trial[k] = e
            ranked.append((scorer.score(trial), world))
        ranked.sort(key=lambda x: -x[0])
        return [(world, [None] * len(world)) for _v, world in ranked[:top_k]]

    for _round in range(rounds):
        improved = False

        # A. Single-group moves + blocking-pair moves
        for g, group in enumerate(groups):
            gset = set(group)
            rest_no_g = rest_of(gset)
            # Also try moving a single part together with any new parts stacked ONLY on it
            for entries, scs in shortlist_group(group, gset):
                if all(_same_spot(e[2], placed[k][2]) and np.allclose(e[2][:3, :3], placed[k][2][:3, :3], atol=1e-3)
                       for e, k in zip(entries, group)):
                    continue
                # Check collision against base first
                if collider is not None:
                    collider.set_model(base)
                    if any(collider.hits(q, m) for q, _c, m in entries):
                        continue
                # Find which other new groups collide with `entries`
                blocking = []
                for h, other in enumerate(groups):
                    if h == g:
                        continue
                    other_entries = [placed[k] for k in other]
                    if collider is not None:
                        collider.set_model(other_entries)
                        if any(collider.hits(q, m) for q, _c, m in entries):
                            blocking.append(h)
                    elif any(_boxes_overlap(lib, e, o) for e in entries for o in other_entries):
                        blocking.append(h)

                if not blocking:
                    trial = list(placed)
                    for k, e in zip(group, entries):
                        trial[k] = e
                    v = eval_layout(trial)
                    if v > best_val + 1e-4:
                        best_val = v
                        placed = trial
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
                    if collider is not None:
                        collider.set_model(model_both)
                    for sc2 in shortlist_part(hp, hc, model_both, rest_both)[:8]:
                        m2 = np.asarray(sc2.candidate["matrix"], float)
                        if collider is not None and collider.hits(hp, m2):
                            continue
                        trial = list(placed)
                        for k, e in zip(group, entries):
                            trial[k] = e
                        trial[hk] = (hp, hc, m2)
                        v = eval_layout(trial)
                        if v > best_val + 1e-4:
                            best_val = v
                            placed = trial
                            for k, sc in zip(group, scs):
                                if sc is not None:
                                    scores[k] = sc
                            scores[hk] = sc2
                            improved = True
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
                # Only swap if they have similar bounding-box extents (same footprint)
                if abs(_size(lib, pi) - _size(lib, pj)) > 0.35 * max(_size(lib, pi), _size(lib, pj), 1.0):
                    continue
                trial = list(placed)
                trial[i] = (pi, ci, mj)
                trial[j] = (pj, cj, mi)
                # Collision check both swapped parts
                if collider is not None:
                    others = base + [o for k, o in enumerate(trial) if k not in (i, j)]
                    collider.set_model(others)
                    if collider.hits(pi, mj) or collider.hits(pj, mi):
                        continue
                    collider.set_model(others + [trial[i]])
                    if collider.hits(pj, mi):
                        continue
                v = eval_layout(trial)
                if v > best_val + 1e-4:
                    best_val = v
                    placed = trial
                    improved = True

        # C. Rigid host + child cluster moves (when a new part sits on another new part)
        if len(singles) >= 2 and collider is not None:
            for host_idx in singles:
                # Find any other single new parts that mate ONLY with host_idx (and not base)
                hp, hc, hm = placed[host_idx]
                children = []
                for ch_idx in singles:
                    if ch_idx == host_idx:
                        continue
                    cp, cc, cm = placed[ch_idx]
                    collider.set_model(base)
                    m_base, _ = collider.mates(cp, cm)
                    if m_base == 0:
                        collider.set_model([placed[host_idx]])
                        m_host, _ = collider.mates(cp, cm)
                        if m_host > 0:
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
                    collider.set_model(model_c)
                    if any(collider.hits(q, m) for q, _col, m in moved_c):
                        continue
                    trial = list(placed)
                    for k, e in zip(cluster, moved_c):
                        trial[k] = e
                    v = eval_layout(trial)
                    if v > best_val + 1e-4:
                        best_val = v
                        placed = trial
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
