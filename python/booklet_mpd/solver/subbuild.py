"""Sub-builds: a small assembly drawn in its own panel ("2x": build two), built apart and then attached.

Placing those parts one at a time against the main picture throws away what the panel shows. A headlight
brick with a white plate on its side stud: alone, the brick's turn rests on faint edge lines of a red
face; as a unit, the white plate has to show where the picture shows it, which fixes the turn. A panel
holding one part drawn large (a brick with side studs) still tells which way that part faces. So:

1. `unit_parts`: the step parts the panel may hold: colours drawn in it, arrows aside; "Nx" divides the
   counts. Colour alone over-selects (an arrow drawn in a part's colour), so solving decides.
2. `solve_unit`: the panel solved as a model of its own under the main picture's camera angles. Each
   candidate part is tried as the seated base (a pulled-apart panel may draw any part floating), at
   each quarter turn and scale; the others are attached to it, floating allowed. The unit kept is the one
   whose drawing matches the panel best, colour by colour; a part whose removal improves the match
   (one placed over an arrow) drops out. A panel holding one part gives that part's facing only.
3. `place_units`: every copy placed on the model so far: each unit part is tried at each pose it could
   connect in, the unit moving with it, scored against the main picture, collision-checked. Upright
   (as drawn in the panel) is preferred, not required: some units are built flat and attached on their
   side. Facing as drawn breaks ties.
"""
from __future__ import annotations

import os
from collections import Counter

import numpy as np

from .place import Scored, State, _boxes_overlap, score_candidates

SUBBUILDS = os.environ.get("BOOKLET_SOLVER_SUBBUILDS", "1") != "0"
MIN_COLOUR_PX = 12          # working pixels of a part colour (arrows aside) before the panel counts as drawing it
SUB_DELTAS = (0.0, 16.0, 32.0, 48.0, 64.0, 80.0, 96.0)  # explode offsets inside a sub-build panel (covers tall vertical stacks!)
UNIT_PUSH_STEPS = (0.6, 0.9, 1.2, 1.5, 2.0, 2.5)        # unit-level arrow-axis displacement multiples
MIN_SHOWN = 5.0             # a unit part scoring less than this in its own panel is not drawn there: dropped
MIN_EXPLAINED = 0.58        # share of the panel's drawn pixels the solved unit must cover ...
MIN_PRECISION = 0.68        # ... and share of the unit's pixels that must land on drawn pixels; otherwise the
                            # panel is not this unit (cover art, a finished-model preview, a zoomed detail)
TIPPED = 0.06               # a tipped placement gives up this share of its score to an upright one (gentle so sideways SNOT units still win easily!)
FACING = 0.03               # a placement facing as the panel draws it gains this share (a tie-breaker)


def panel_colours(codes: list[int], picture) -> set[int]:
    """Which LDraw colour codes from `codes` are genuinely drawn in `picture` (arrows aside).
    Uses both `picture.classes` and true-CIELAB nearest-colour matching on clean foreground so dark/black,
    purple, and metallic gold sub-builds are never dropped."""
    import cv2
    from .picture import colour_rgb
    from .scorer import _rgb_to_lab_single, combined_ink

    if not codes:
        return set()
    # Dilate arrows by 3 px so orange/red anti-aliasing fringes around red assembly arrows never
    # falsely activate orange/red/yellow parts (e.g. trans-orange flame in 40348 s40 st1)!
    k3 = np.ones((3, 3), np.uint8)
    arr_dil = (cv2.dilate(picture.arrows.astype(np.uint8), k3) > 0) if picture.arrows.any() else picture.arrows
    classes = picture.classes(codes)
    present = {c for k, c in enumerate(codes) if np.count_nonzero((classes == k) & ~arr_dil) >= MIN_COLOUR_PX}
    # Supplement with true-CIELAB matching for any colour not yet found (e.g. Pearl Gold, Dark Purple, Black)
    missing = [c for c in codes if c not in present]
    if missing:
        fg = picture.foreground & ~arr_dil
        ink = combined_ink(picture.rgb) & ~arr_dil
        clean = fg & ~(cv2.dilate(ink.astype(np.uint8), k3) > 0)
        if int(clean.sum()) >= MIN_COLOUR_PX:
            pic_lab = cv2.cvtColor(picture.rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
            pic_lab[..., 0] *= (100.0 / 255.0)
            cpx = pic_lab[clean]
            dists = np.empty((len(codes), len(cpx)), dtype=np.float32)
            for k, code in enumerate(codes):
                ref = _rgb_to_lab_single(colour_rgb(code))
                chroma = float(np.hypot(ref[1] - 128.0, ref[2] - 128.0))
                wL = 0.70 if chroma < 12.0 else 0.50
                dists[k] = np.sqrt((wL * (cpx[:, 0] - ref[0])) ** 2 + (cpx[:, 1] - ref[1]) ** 2 + (cpx[:, 2] - ref[2]) ** 2)
            nearest = np.argmin(dists, axis=0)
            for k, code in enumerate(codes):
                if code in present:
                    continue
                # Small 1x1 accents (e.g. 6141 round plate in a 41x38 panel) can have 6-11 clean pixels
                min_px = 6 if int(clean.sum()) < 900 else MIN_COLOUR_PX
                if int(np.count_nonzero((nearest == k) & (dists[k] < 48.0))) >= min_px:
                    present.add(code)
            # If the panel still matched NO colours (e.g. Pearl Gold or Dark Purple whose booklet render
            # differs >48 Lab from LDConfig), assign the closest colour(s) present in clean foreground
            if not present and len(cpx) >= MIN_COLOUR_PX:
                for k, code in enumerate(codes):
                    if int(np.count_nonzero((nearest == k) & (dists[k] < 75.0))) >= MIN_COLOUR_PX:
                        present.add(code)
                if not present and len(codes) == 1:
                    present.add(codes[0])
    return present


def unit_parts(parts: list[tuple[str, int]], picture, count: int) -> list[tuple[str, int]]:
    """The parts one copy of the panel's unit may hold: step parts whose colour the panel draws (arrow
    pixels aside), with at least `count` of them in the step (one copy gets count // N)."""
    codes = sorted({c for _p, c in parts})
    present = panel_colours(codes, picture)
    out = []
    for (p, c), n in Counter(parts).items():
        if c in present and n >= count:
            out += [(p, c)] * (n // count)
    return out


def _turn(k: int) -> np.ndarray:
    c, s = ((1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0))[int(k) % 4]
    m = np.eye(4)
    m[:3, :3] = [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
    return m


def upright(view):
    """The view a panel is drawn in: the main picture's camera angles, the right way up. Steps that build a
    model's underside show it upside down, but a panel draws its unit as it is built (green plate pressed
    onto white): from one picture, "green on white seen upside down" and "white on green seen upright" are
    alike, so the panel's way up has to be assumed, and it is up."""
    o = np.asarray(view.orientation, float)
    if np.allclose(o @ np.array([0.0, -1.0, 0.0]), [0.0, 1.0, 0.0], atol=1e-6):
        return view.replace(orientation=np.diag([-1.0, -1.0, 1.0]) @ o)
    return view


SAME_SCALES = (1.0, 0.94, 1.06)
ZOOM_SCALES = (1.25, 1.5, 0.8, 1.8, 2.2)
MIN_MATCH = 0.05
EARLY_MATCH = 0.25


def _distinct_turns(lib, part: str) -> list[int]:
    """Quarter turns (0..3) that produce geometrically distinct orientations of `part`."""
    from .place import _shape
    seen, out = set(), []
    for k in range(4):
        h, _lo = _shape(lib, part, _turn(k)[:3, :3])
        if h not in seen:
            seen.add(h)
            out.append(k)
    return out or [0]


def _unit_metrics(lib, drawn: list, view, pic, codes: list[int]) -> tuple[float, float, float]:
    """(normalised_ModelScorer_score, silhouette_explained, silhouette_precision) for a sub-build panel."""
    from .render import render
    from .scorer import ModelScorer
    if not drawn:
        return -10.0, 0.0, 0.0
    sc = ModelScorer(lib, [], pic, view, codes)
    raw = sc.score(drawn)
    norm = max(1.0, float(sc.fg.sum() + sc.ink_fg.sum()))
    ms_norm = float(raw / norm)
    _d, label = render(lib, drawn, view, pic.rgb.shape[:2])
    mask = label >= 0
    fg = pic.foreground & ~pic.arrows
    inter = int(np.count_nonzero(mask & fg))
    explained = inter / max(1, int(np.count_nonzero(fg)))
    precision = inter / max(1, int(np.count_nonzero(mask & ~pic.arrows)))
    return ms_norm, float(explained), float(precision)


def _base_priority(lib, pc: tuple[str, int]) -> tuple[int, float]:
    """Prioritise substantial flat multi-stud plates (area >= 1200 LDU^2, e.g. 3031/3020/3022/3710)
    as sub-build anchors, while letting larger unique hinge/structural bricks (e.g. 6134) outrank
    tiny 1x2 plates (3023, area=800)."""
    from .place import _size, _world_aabb
    lo, hi = _world_aabb(lib, pc[0], np.eye(4))
    dx, dy, dz = float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2])
    area = dx * dz
    from brickheadz.connectors import catalog
    conns = catalog().connectors(pc[0]) or []
    has_studs = any(c.family == "stud" and c.sub == "stud" for c in conns)
    is_base_plate = 1 if (dy <= 14.0 and area >= 1200.0 and has_studs) else 0
    return (is_base_plate, area if is_base_plate else _size(lib, pc[0]))


def _solve_unit_staged(lib, spec: dict, canon_views: list, scale: float, bases: list,
                       candidate_fn, collider=None, deadline: float = 0.0):
    """Progressive mini-step sub-build solver: uses every numbered mini-step image (1, 2, ..., K) inside
    a sub-build panel to reconstruct multi-layer & exploded assemblies (e.g. 41605 Infinity Gauntlet / arm,
    41620 mirror headlights / blaster, 40271 curved slope shells, 40348 Technic pins & candle cake) 1-3
    parts at a time instead of solving 5-11 parts simultaneously from one final silhouette! Returns
    `(score, unit, explained, precision, all_good)` or None."""
    import time as _time
    from .exact_place import _state_geom_key, exact_polish, score_candidates_calibrated, solve_step_exact
    from .place import Scene, State, _boxes_overlap, drawn_pose
    from .register import Aligner
    from .scorer import ModelScorer

    raw_stages = spec.get("stages") or []
    stages = [st for st in raw_stages
              if int(np.count_nonzero(st["picture"].foreground & ~st["picture"].arrows)) >= 40]
    per_copy = spec["per_copy"]
    if len(stages) < 2 or len(per_copy) < 3:
        return None
    all_codes = spec["codes"]
    # Per-stage colour presence with cross-stage relative-area noise filter:
    # A colour that only has tiny anti-aliasing/shadow hits in stage t (<20% of its peak pixel count
    # across stages AND <45 px, e.g. orange arrow-head fringe in 40348 s40 st1 or dark stud shadows
    # in 41605 s23 st1-2) is NOT actually introduced until the stage where its pixels jump!
    import cv2 as _cv2
    from .picture import colour_rgb as _col_rgb
    from .scorer import _rgb_to_lab_single as _lab1, combined_ink as _cink
    _k5 = np.ones((5, 5), np.uint8)
    stage_px: list[dict[int, int]] = []
    for st in stages:
        pic_s = st["picture"]
        arr_d = (_cv2.dilate(pic_s.arrows.astype(np.uint8), _k5) > 0) if pic_s.arrows.any() else pic_s.arrows
        fg_s = pic_s.foreground & ~arr_d
        ink_s = _cink(pic_s.rgb) & ~arr_d
        clean_s = fg_s & ~(_cv2.dilate(ink_s.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        cls_s = pic_s.classes(all_codes)
        cnts: dict[int, int] = {}
        if int(clean_s.sum()) >= MIN_COLOUR_PX:
            plab = _cv2.cvtColor(pic_s.rgb, _cv2.COLOR_RGB2LAB).astype(np.float32)
            plab[..., 0] *= (100.0 / 255.0)
            cpx = plab[clean_s]
            dists = np.empty((len(all_codes), len(cpx)), dtype=np.float32)
            for k, code in enumerate(all_codes):
                ref = _lab1(_col_rgb(code))
                ch = float(np.hypot(ref[1] - 128.0, ref[2] - 128.0))
                wL = 0.70 if ch < 12.0 else 0.50
                dists[k] = np.sqrt((wL * (cpx[:, 0] - ref[0])) ** 2 + (cpx[:, 1] - ref[1]) ** 2 + (cpx[:, 2] - ref[2]) ** 2)
            near = np.argmin(dists, axis=0)
            for k, code in enumerate(all_codes):
                n_cls = int(np.count_nonzero((cls_s == k) & ~arr_d))
                n_lab = int(np.count_nonzero((near == k) & (dists[k] < 48.0)))
                cnts[code] = max(n_cls, n_lab)
        else:
            for k, code in enumerate(all_codes):
                cnts[code] = int(np.count_nonzero((cls_s == k) & ~arr_d))
        stage_px.append(cnts)
    max_px = {c: max((d.get(c, 0) for d in stage_px), default=0) for c in all_codes}
    stage_cols = []
    for si_c, st in enumerate(stages):
        raw_c = panel_colours(all_codes, st["picture"])
        fg_tot = max(1, int(np.count_nonzero(st["picture"].foreground & ~st["picture"].arrows)))
        filt = set()
        for c in raw_c:
            px_c = stage_px[si_c].get(c, 0)
            mp_c = max_px.get(c, 0)
            # Drop tiny spurious hits when this colour appears much more strongly in a later stage
            if si_c < len(stages) - 1 and mp_c >= 40 and px_c < max(25, int(0.22 * mp_c)):
                continue
            if si_c < len(stages) - 1 and px_c < 20 and px_c < int(0.012 * fg_tot):
                continue
            filt.add(c)
        stage_cols.append(filt if filt else (raw_c if raw_c else set(all_codes)))

    cand_cache: dict = {}

    def cached_cand(part, model):
        key = (part, tuple((p, tuple(np.round(np.asarray(m, float).ravel(), 2))) for p, _c, m in model))
        res = cand_cache.get(key)
        if res is None:
            res = candidate_fn(part, model)
            # A rigid sub-build unit must be physically connected: strip disconnected side-by-side `flush` poses!
            non_flush = [c for c in res if c.get("kind") != "flush"]
            if non_flush:
                res = non_flush
            # Inside rigid sub-build panels, prefer orthogonal 90-deg alignments for clip/hinge/technic
            # connectors (eliminates bogus 22.5/45-deg blaster & cone twists like 59900/60849 in 41620 s29!),
            # while NEVER dropping a unique technic attachment position (e.g. 6141 on 4274 pin in 40348 s4)
            # that has no orthogonal counterpart at the same 3D position!
            if any(c.get("kind") in ("clip", "hinge", "technic") for c in res):
                ortho_pos = {
                    tuple(np.round(np.asarray(c["matrix"], float)[:3, 3], 1))
                    for c in res
                    if np.all((np.abs(np.asarray(c["matrix"], float)[:3, :3]) < 0.05)
                              | (np.abs(np.asarray(c["matrix"], float)[:3, :3]) > 0.95))
                }
                kept_r = []
                for c in res:
                    kd = c.get("kind")
                    if kd in ("clip", "hinge", "technic"):
                        r3 = np.abs(np.asarray(c["matrix"], float)[:3, :3])
                        if not np.all((r3 < 0.05) | (r3 > 0.95)):
                            if kd in ("clip", "hinge") or tuple(np.round(np.asarray(c["matrix"], float)[:3, 3], 1)) in ortho_pos:
                                continue
                    kept_r.append(c)
                if kept_r:
                    res = kept_r
            cand_cache[key] = res
        return res

    from ..viewfit import BOOKLET_SCALE

    def _stage_scale(st_obj) -> float:
        p = st_obj["picture"].pts_per_px
        return float(BOOKLET_SCALE / p) if p else float(scale)

    def _align_view(parts_now, st_obj, cv_view, prefer_bottom: bool = False):
        sc_s = _stage_scale(st_obj)
        v0 = cv_view.replace(scale=sc_s, offset=(0.0, 0.0))
        _av, v1 = Aligner(lib, parts_now, st_obj["classes"], all_codes, on_ink=st_obj["on_ink"]).evaluate(v0)
        if prefer_bottom and len(parts_now) == 1:
            vb = _bottom_anchor_view(lib, parts_now[0], st_obj["picture"], cv_view, sc_s)
            if vb is not None:
                m_a = _unit_metrics(lib, parts_now, v1, st_obj["picture"], all_codes)
                m_b = _unit_metrics(lib, parts_now, vb, st_obj["picture"], all_codes)
                if m_b[2] >= 0.78 and m_b[0] >= m_a[0] - 0.10:
                    return vb
        return v1

    has_native_col = collider is not None and getattr(collider, "native", None) is not None
    from brickheadz.connectors import catalog as _conn_cat
    _cat_s = _conn_cat()

    def _has_male_studs(part_name: str) -> bool:
        """True if `part_name` carries top/side studs (solid or open/hollow) or Technic connectors other
        parts can stack onto (False for finishing/decorative studless tiles, slopes, cheese slopes,
        grilles, and terminal pin/bar flames like 37775)."""
        conns = _cat_s.connectors(part_name) or []
        return any(c.family == "stud" and c.sub in ("stud", "open", "open_stud", "hollow_stud") for c in conns) or any(
            c.family in ("axle", "pin") for c in conns
        )

    def _mates_count(parts_list: list) -> int:
        """Total physically mated connectors inside `parts_list` (distinguishes flush 2-stud seating
        from isometric-ray 1-stud cantilevers that project to identical 2D pixels at 35 deg pitch!)."""
        if not has_native_col or len(parts_list) < 2:
            return 0
        collider.set_model(parts_list[:1])
        _c, _conn, mates, _g = collider.layout_check(parts_list[1:])
        return int(mates)

    def _grow_on_stage(parts_in, rem_in, st_obj, cv_view, allow_cols, new_cols,
                       max_add: int, min_rem: int, is_stage0: bool = False):
        """Local beam growth on one mini-step stage `st_obj` (handles 0-add single-part stage 1,
        multi-part symmetric layer additions where 1 part temporarily dips `ms`, newly appearing
        stage colours `new_cols`, physical multi-stud seating over isometric cantilevers, and exploded
        mini-steps with arrows!). Returns list of `(parts_seated, rem, ms, exp, prec)`."""
        pic_t = st_obj["picture"]
        is_exp = int(pic_t.arrows.sum()) >= 25
        st_deltas = SUB_DELTAS if is_exp else (0.0,)
        st_pushes = pic_t.arrow_axes() if is_exp else []
        v_cur = _align_view(parts_in, st_obj, cv_view, prefer_bottom=(is_exp and len(parts_in) == 1))
        m_cur = _unit_metrics(lib, parts_in, v_cur, pic_t, all_codes)

        def _best_one_step(p_seated, p_drawn, r_now, v_now, top_n: int = 3):
            sc_t = ModelScorer(lib, p_drawn, pic_t, v_now, all_codes)
            if collider is not None:
                collider.set_model(p_seated)
            uniq_pc = list(dict.fromkeys((p, c) for p, c in r_now if c in allow_cols))
            if not uniq_pc:
                return []
            # Structural-before-finishing law on intermediate stages (ti < K-1):
            # When stud-bearing structural plates/bricks remain for this stage's colours, don't let
            # studless finishing slopes/tiles/flames (e.g. 54200, 85984, 37775) claim studs early and
            # block structural layers! (Only allow a studless new-colour part on non-exploded stages
            # so arrow-fringe noise never activates orange flames on exploded stage 1!)
            placed_cols = {c for _p, c, _m in p_seated}
            need_new = {c for c in new_cols if c not in placed_cols and any(rc == c for _rp, rc in uniq_pc)}
            if any(_has_male_studs(p) for p, _c in uniq_pc):
                uniq_pc = [pc for pc in uniq_pc if _has_male_studs(pc[0]) or (
                    not is_exp and pc[1] in need_new and not any(_has_male_studs(p2) and c2 == pc[1] for p2, c2 in uniq_pc)
                )]
            uniq_pc.sort(key=lambda pc: (0 if pc[1] in need_new else 1))

            cand_results = []
            for p, c in uniq_pc:
                cands = cached_cand(p, p_seated)
                if not cands:
                    continue
                scored = score_candidates_calibrated(lib, sc_t, [], p, c, cands, deltas=st_deltas, pushes=st_pushes, float_base=0.0)
                scored.sort(key=lambda s: -s.score)
                # Filter colliding poses & geometric duplicates BEFORE shortlisting so colliding poses
                # (e.g. 256/280 candidates of 3023 on 6134!) NEVER crowd out flush multi-stud seats!
                if collider is not None:
                    collider.set_model(p_seated)
                valid_scored: list[tuple[object, int]] = []
                seen_vg: set = set()
                for s in scored:
                    m_c = np.asarray(s.candidate["matrix"], float)
                    gk_c = _state_geom_key(lib, [(p, c, m_c)])
                    if gk_c in seen_vg:
                        continue
                    if collider is not None:
                        if collider.hits(p, m_c):
                            continue
                        dm_c = int(collider.mates(p, m_c)[0]) if has_native_col else 0
                    else:
                        if any(_boxes_overlap(lib, (p, c, m_c), o) for o in p_seated):
                            continue
                        dm_c = 0
                    seen_vg.add(gk_c)
                    valid_scored.append((s, dm_c))
                    if is_exp and len(valid_scored) >= 32:
                        break
                if not valid_scored:
                    continue
                # On upright sub-build stages, never seat a part upside-down (y = [0, -1, 0]) underneath
                # the base when upright non-colliding poses exist (stops flames/pins poking out the bottom!).
                if float(np.asarray(cv_view.orientation, float)[1, 1]) > 0.5:
                    upright_vs = [item for item in valid_scored if float(np.asarray(item[0].candidate["matrix"], float)[1, 1]) > -0.5]
                    if upright_vs:
                        valid_scored = upright_vs
                # Always retain highest-mate-count (flush, zero-overhang) poses so isometric-ray cantilevers
                # (or oblique arrow pushes on exploded mini-steps like 40271 s5!) cannot hide flush multi-stud seats!
                if len(p_seated) <= 6:
                    max_dm_p = max((dm_c for _s, dm_c in valid_scored), default=0)
                    shortlist_v = [item for item in valid_scored if max_dm_p >= 2 and item[1] >= max_dm_p]
                    seen_id = {id(item[0]) for item in shortlist_v}
                    by_y: dict[int, int] = {}
                    for item in valid_scored:
                        if id(item[0]) in seen_id:
                            continue
                        yk = int(round(float(np.asarray(item[0].candidate["matrix"], float)[1, 3])))
                        cap_y = 4 if is_exp else 6
                        if by_y.get(yk, 0) < cap_y:
                            by_y[yk] = by_y.get(yk, 0) + 1
                            shortlist_v.append(item)
                            seen_id.add(id(item[0]))
                    shortlist_v = shortlist_v[:(16 if is_exp else 28)]
                else:
                    n_keep = 8 if (c in need_new or len(p_seated) <= 2) else 5
                    shortlist_v = valid_scored[:n_keep]
                part_res = []
                for s, dmates in shortlist_v:
                    m_c = np.asarray(s.candidate["matrix"], float)
                    m_d = drawn_pose(s) if is_exp else m_c
                    nxt_d = p_drawn + [(p, c, m_d)]
                    v_eval = _align_view(nxt_d, st_obj, cv_view) if (len(p_seated) <= 3 and not is_exp) else v_now
                    met = _unit_metrics(lib, nxt_d, v_eval, pic_t, all_codes)
                    part_res.append((met[0], met[1], met[2], p, c, m_c, m_d, v_eval, dmates, s.candidate.get("kind", "")))
                # If a multi-stud part has full-seated poses (`dm >= 2`) that fit cleanly inside the stage
                # silhouette (`prec >= 0.84`), drop 1-stud isometric-ray cantilevers (`dm <= 1`) for this part
                # unless an overhang beats the best full-seated pose by > 0.35 ms (a real huge overhang)!
                if not is_exp and part_res:
                    max_dm_res = max(x[8] for x in part_res)
                    if max_dm_res >= 2:
                        flush_res = [x for x in part_res if x[8] >= max_dm_res and x[2] >= 0.84]
                        if flush_res:
                            best_flush_ms = max(x[0] for x in flush_res)
                            part_res = [x for x in part_res if x[8] >= max_dm_res or x[0] > best_flush_ms + 0.35]
                            # Bottom-up layer completion: if a flush pose fits cleanly at a lower open layer
                            # (`low_y`, larger Y in LDraw), don't skip open studs to stack higher (`y <= low_y - 6`)
                            # unless the higher pose wins by a large visual margin (> 0.15 ms)!
                            low_y_p = max(float(x[5][1, 3]) for x in flush_res)
                            low_res = [x for x in flush_res if float(x[5][1, 3]) >= low_y_p - 2.0]
                            best_low_ms = max(x[0] for x in low_res)
                            part_res = [
                                x for x in part_res
                                if float(x[5][1, 3]) >= low_y_p - 2.0 or x[0] > best_low_ms + 0.15
                            ]
                cand_results.extend(part_res)
            # Rank by visual ModelScorer + STRONG physical full-stud seating preference!
            # In isometric projection (~35 deg pitch), a 1-stud cantilever overhanging along (+X,+Z)
            # projects onto the same 2D pixels as stacking vertically in -Y. When a multi-stud part
            # has full-seated candidates (`max_dm >= 2`), strongly favour full-seated poses (`dm >= 2`)
            # over 1-stud overhangs!
            max_dm_by_part: dict[tuple[str, int], int] = {}
            max_flush_y_by_part: dict[tuple[str, int], float] = {}
            for x in cand_results:
                pk = (x[3], x[4])
                if x[8] > max_dm_by_part.get(pk, 0):
                    max_dm_by_part[pk] = x[8]
            for x in cand_results:
                pk = (x[3], x[4])
                if x[8] >= max_dm_by_part.get(pk, 1) and x[2] >= 0.82:
                    yv = float(x[5][1, 3])
                    if pk not in max_flush_y_by_part or yv > max_flush_y_by_part[pk]:
                        max_flush_y_by_part[pk] = yv

            def _pick_key(x):
                mdm = max_dm_by_part.get((x[3], x[4]), 1)
                if is_exp:
                    # On exploded mini-steps, still strongly prefer full multi-stud seating (`dm == mdm`)
                    # over cantilevered overhangs (e.g. 2x2 plate sitting 4-stud flush vs 2-stud offset in 40271 s5)!
                    exp_mate = (0.28 * (float(x[8]) / float(mdm)) - (0.14 if x[8] < mdm else 0.0)) if mdm >= 2 else 0.0
                    return x[0] + exp_mate + (0.06 if x[4] in need_new else 0.0)
                if mdm >= 2:
                    # Strongly favour full multi-stud seating (+0.18) over 1-stud cantilevers (-0.16)
                    mate_bonus = 0.18 * (float(x[8]) / float(mdm)) - (0.16 if x[8] <= 1 else 0.0)
                else:
                    mate_bonus = 0.0
                # Bottom-up layer completion: when adding a part at height y_c while a full-seated
                # pose for the same part exists at a lower open layer (larger y in LDraw, +Y down),
                # gently prefer filling the lower layer first so plates cross-brace cleanly!
                y_c = float(x[5][1, 3])
                low_y = max_flush_y_by_part.get((x[3], x[4]), y_c)
                layer_pen = 0.10 if (low_y - y_c >= 6.0 and x[8] >= max(1, mdm)) else 0.0
                return x[0] + mate_bonus - layer_pen + (0.06 if x[4] in need_new else 0.0)
            cand_results.sort(key=lambda x: -_pick_key(x))
            out_s, seen_s = [], set()
            # Guarantee at least 1 slot per uncovered newly appearing stage colour in `need_new`
            # (so e.g. black bracket 99780:0 in 41605 s23 st3 isn't crowded out by gold plates!)
            if need_new:
                for nc in sorted(need_new):
                    for item in cand_results:
                        if item[4] != nc:
                            continue
                        gk = _state_geom_key(lib, [(item[3], item[4], item[5])])
                        if gk not in seen_s:
                            seen_s.add(gk)
                            out_s.append(item)
                        break
            for item in cand_results:
                if len(out_s) >= max(top_n, len(need_new) + 2):
                    break
                gk = _state_geom_key(lib, [(item[3], item[4], item[5])])
                if gk not in seen_s:
                    seen_s.add(gk)
                    out_s.append(item)
            return out_s

        # Local beam over 0 .. min(max_add, 4) additions on this stage
        step_cap = min(max_add, 4)
        # node = (p_seated, p_drawn, rem, v_now, ms, exp, prec, n_added)
        cur_layer = [(list(parts_in), list(parts_in), list(rem_in), v_cur, m_cur[0], m_cur[1], m_cur[2], 0)]
        candidates_out = []
        # Always keep 0-add when stage 0 already fits cleanly (e.g. mini-step 1 showing just the base brick!)
        # or on later stages when the current assembly already fits cleanly
        if (is_stage0 and m_cur[1] >= 0.72 and m_cur[2] >= 0.85) or (not is_stage0 and m_cur[1] >= 0.86 and m_cur[2] >= 0.88):
            candidates_out.append((list(parts_in), list(rem_in), m_cur[0], m_cur[1], m_cur[2]))

        for depth in range(step_cap):
            if deadline and _time.monotonic() > deadline:
                break
            nxt_layer = []
            seen_l = set()
            for p_s, p_d, r_n, v_n, ms_n0, exp_n0, prec_n0, n_add in cur_layer:
                if len(r_n) <= min_rem:
                    continue
                if exp_n0 >= 0.92 and prec_n0 >= 0.93:
                    placed_cols = {c for _p, c, _m in p_s}
                    if not any(c not in placed_cols and any(rc == c for _rp, rc in r_n) for c in new_cols):
                        continue
                picks = _best_one_step(p_s, p_d, r_n, v_n, top_n=4 if depth <= 1 else 2)
                placed_cols = {c for _p, c, _m in p_s}
                for ms_n, exp_n, prec_n, p, c, m_c, m_d, v_e, dm_n, _kd in picks:
                    is_new_col = (c in new_cols and c not in placed_cols)
                    # Allow: (1) direct ms improvement, (2) coverage growth even if 1 half of a symmetric
                    # pair temporarily dips ms, (3) newly appearing stage colour, OR (4) a full multi-stud
                    # seated structural part (`dm >= 2`) that fits strictly inside the stage silhouette
                    # (`prec >= 0.88`, e.g. back half of a 2x2 plate layer partially occluded behind front half!).
                    ok_step = (
                        ms_n > ms_n0 + 0.008
                        or (exp_n > exp_n0 + 0.025 and prec_n >= 0.75 and ms_n >= ms_n0 - 0.14)
                        or (is_new_col and (
                            (exp_n > exp_n0 + 0.015 and prec_n >= 0.78 and ms_n >= ms_n0 - 0.08)
                            if is_exp else (prec_n >= 0.70 and ms_n >= ms_n0 - 0.25)
                        ))
                        or (not is_exp and not is_stage0 and dm_n >= 2 and prec_n >= 0.88 and ms_n >= ms_n0 - 0.05)
                    )
                    if not ok_step:
                        continue
                    ns = p_s + [(p, c, m_c)]
                    nd = p_d + [(p, c, m_d)]
                    nr = list(r_n)
                    nr.remove((p, c))
                    v_next = _align_view(nd, st_obj, cv_view) if not is_exp else v_e
                    m_next = _unit_metrics(lib, nd, v_next, pic_t, all_codes)
                    gk = _state_geom_key(lib, ns)
                    if gk in seen_l:
                        continue
                    seen_l.add(gk)
                    nxt_layer.append((ns, nd, nr, v_next, m_next[0], m_next[1], m_next[2], n_add + 1))
                    candidates_out.append((ns, nr, m_next[0], m_next[1], m_next[2]))
            if not nxt_layer:
                break
            nxt_layer.sort(key=lambda x: -(x[4] + 0.15 * x[5] + 0.15 * x[6] + (0.20 * (_mates_count(x[0]) / max(1, len(x[0]))) if not is_exp else 0.0)))
            cur_layer = nxt_layer[:3]

        if not candidates_out:
            candidates_out.append((list(parts_in), list(rem_in), m_cur[0], m_cur[1], m_cur[2]))

        def _stage_rank(item):
            ps, rn, ms_v, ex_v, pr_v = item
            pcols = {c for _p, c, _m in ps}
            cov_new = sum(1 for c in new_cols if c in pcols)
            # Physical multi-stud seating density breaks isometric-ray ties among multi-part states
            # WITHOUT penalising 1-part stage-0 bases (`len(ps) == 1` has no mates yet, so never give
            # bogus extra additions on mini-step 1 a fake mate bonus over keeping the single base part!).
            mates_dens = (_mates_count(ps) / max(1, len(ps))) if len(ps) >= 2 else (1.35 if is_stage0 else 0.0)
            # Gentle layer-flatness bonus when multiple parts are added on a non-exploded stage:
            # discourages stacking 2-high on one half of a plate when a flush 1-plate layer fits!
            added_ys = [float(np.asarray(m, float)[1, 3]) for _p, _c, m in ps[len(parts_in):]]
            y_spread_pen = (0.14 if (not is_exp and len(added_ys) >= 2 and (max(added_ys) - min(added_ys)) >= 6.0) else 0.0)
            return ms_v + 0.22 * mates_dens - y_spread_pen + 0.12 * cov_new + (0.08 if (ex_v >= 0.85 and pr_v >= 0.88) else 0.0)

        candidates_out.sort(key=lambda x: -_stage_rank(x))
        dedup, seen_o = [], set()
        for item in candidates_out:
            gk = _state_geom_key(lib, item[0])
            if gk not in seen_o:
                seen_o.add(gk)
                dedup.append(item)
            if len(dedup) >= 3:
                break
        return dedup

    # --- Stage 0: rank candidate base parts by actual fit on mini-step 1 (not blindly largest in full unit!) ---
    st0 = stages[0]
    cols0 = stage_cols[0]
    is_exp0 = int(st0["picture"].arrows.sum()) >= 25
    cand_bases0 = [pc for pc in bases if pc[1] in cols0] or list(bases)
    if len(cand_bases0) > 2:
        scored_b0 = []
        cv0 = canon_views[0]
        for pc in cand_bases0[:5]:
            best_b0 = -1e9
            for k in _distinct_turns(lib, pc[0])[:2]:
                a = (pc[0], pc[1], _turn(k))
                v0 = _align_view([a], st0, cv0, prefer_bottom=is_exp0)
                ms0, e0, p0 = _unit_metrics(lib, [a], v0, st0["picture"], all_codes)
                # Parts that overflow st0 badly (e.g. big blaster on 2-plate st1!) get penalised via precision,
                # while tiny parts inside a larger base plate (e.g. 3023 inside 6134) get ranked below by coverage!
                val = ms0 + 0.35 * p0 + 0.45 * e0 - (0.5 if p0 < 0.72 else 0.0)
                if val > best_b0:
                    best_b0 = val
            scored_b0.append((best_b0, pc))
        scored_b0.sort(key=lambda x: -x[0])
        bases0 = [pc for _v, pc in scored_b0[:2]]
    else:
        bases0 = cand_bases0[:2]

    K = len(stages)
    beams = []  # (cum_ms, parts, rem, cv, min_exp, min_prec)
    for base in bases0:
        if deadline and _time.monotonic() > deadline:
            break
        rem0 = list(per_copy)
        rem0.remove(base)
        turns = _distinct_turns(lib, base[0])
        for cv in canon_views:
            for k in turns:
                if deadline and _time.monotonic() > deadline:
                    break
                a = (base[0], base[1], _turn(k))
                grown = _grow_on_stage([a], rem0, st0, cv, cols0, cols0,
                                       max_add=max(1, len(per_copy) - 1), min_rem=1, is_stage0=True)
                for p_g, r_g, ms_g, exp_g, prec_g in grown:
                    beams.append((ms_g, p_g, r_g, cv, exp_g, prec_g))
    if not beams:
        return None

    def _dedupe_beams(blist, limit: int = 6):
        """Keep top distinct beams while reserving slots across each studio yaw (35 & 55 deg)
        so one yaw's early ties on mini-step 1 never evict the true yaw before later stages!"""
        blist.sort(key=lambda x: -x[0])
        out_b, seen_b = [], set()
        yaws_present = list(dict.fromkeys(round(item[3].yaw, 1) for item in blist))
        per_yaw = max(2, limit // max(1, len(yaws_present)))
        for yw in yaws_present:
            cnt_y = 0
            for item in blist:
                if round(item[3].yaw, 1) != yw:
                    continue
                key = (yw, _state_geom_key(lib, item[1]))
                if key not in seen_b:
                    seen_b.add(key)
                    out_b.append(item)
                    cnt_y += 1
                if cnt_y >= per_yaw or len(out_b) >= limit:
                    break
        for item in blist:
            if len(out_b) >= limit:
                break
            key = (round(item[3].yaw, 1), _state_geom_key(lib, item[1]))
            if key not in seen_b:
                seen_b.add(key)
                out_b.append(item)
        out_b.sort(key=lambda x: -x[0])
        return out_b[:limit]

    beams = _dedupe_beams(beams, limit=8)

    # --- Intermediate stages 1 .. K-2 ---
    for ti in range(1, K - 1):
        if deadline and _time.monotonic() > deadline:
            break
        st_t = stages[ti]
        cols_t = stage_cols[ti]
        prev_cols = set().union(*stage_cols[:ti])
        new_cols_t = cols_t - prev_cols
        next_beams = []
        for cum_ms, p_b, r_b, cv_b, min_e, min_p in beams:
            if deadline and _time.monotonic() > deadline:
                break
            grown = _grow_on_stage(p_b, r_b, st_t, cv_b, cols_t, new_cols_t,
                                   max_add=max(1, len(r_b)), min_rem=0, is_stage0=False)
            for p_g, r_g, ms_g, exp_g, prec_g in grown:
                next_beams.append((cum_ms + ms_g, p_g, r_g, cv_b, min(min_e, exp_g), min(min_p, prec_g)))
        if next_beams:
            beams = _dedupe_beams(next_beams, limit=8)

    # --- Final stage K-1: solve ALL remaining parts with exact placement + joint polish ---
    st_f = stages[-1]
    pic_f = st_f["picture"]
    is_exp_f = int(pic_f.arrows.sum()) >= 25
    f_deltas = SUB_DELTAS if is_exp_f else (0.0,)
    f_pushes = pic_f.arrow_axes() if is_exp_f else []
    all_finals: list = []   # [(rank_sc, ms_f, unit_4, exp_f, prec_f, all_good)]

    def _eval_final_view(p_b, r_b, cv_use, cum_ms, min_e, min_p):
        v_f = _align_view(p_b, st_f, cv_use, prefer_bottom=(is_exp_f and len(p_b) <= 3))
        if r_b:
            sc_f = ModelScorer(lib, p_b, pic_f, v_f, all_codes)
            def scene_for_f(model, _v=v_f):
                s = Scene.build(lib, model, _v, st_f["classes"], all_codes, st_f["ink"])
                s.picture = pic_f
                return s
            # On non-exploded final stages, try full-stud seated candidates first (for multi-stud parts
            # where flush `dm >= 2` poses exist!) so `solve_step_exact` cannot cantilever plates/slopes
            # sideways to mimic height; fall back to unrestricted `cached_cand` if silhouette fit < 0.85!
            def _flush_cand(part, model):
                res = cached_cand(part, model)
                if not has_native_col or len(res) <= 4:
                    return res
                collider.set_model(model)
                dm_list = []
                for c_item in res:
                    m_i = np.asarray(c_item["matrix"], float)
                    if collider.hits(part, m_i):
                        continue
                    dm_list.append((int(collider.mates(part, m_i)[0]), c_item))
                if not dm_list:
                    return res
                max_dm_f = max(d for d, _c in dm_list)
                if max_dm_f >= 2:
                    fl = [c_item for d, c_item in dm_list if d >= max_dm_f]
                    if fl:
                        return fl
                return [c_item for _d, c_item in dm_list]

            # On upright exploded final stages, prefer upright + full multi-stud flush seating first
            # (stops 2x2 plates from cantilevering 1 stud sideways on exploded mini-steps like 40271 s5!),
            # falling back to unrestricted upright candidates if flush seating doesn't explain the panel!
            def _upright_cand(part, model):
                res = cached_cand(part, model)
                if float(np.asarray(cv_use.orientation, float)[1, 1]) > 0.5:
                    up_r = [c_item for c_item in res if float(np.asarray(c_item["matrix"], float)[1, 1]) > -0.5]
                    if up_r:
                        return up_r
                return res

            def _upright_flush_cand(part, model):
                res = _upright_cand(part, model)
                if not has_native_col or len(res) <= 4:
                    return res
                collider.set_model(model)
                dm_list = []
                for c_item in res:
                    m_i = np.asarray(c_item["matrix"], float)
                    if collider.hits(part, m_i):
                        continue
                    dm_list.append((int(collider.mates(part, m_i)[0]), c_item))
                if not dm_list:
                    return res
                max_dm_f = max(d for d, _c in dm_list)
                if max_dm_f >= 2:
                    fl = [c_item for d, c_item in dm_list if d >= max_dm_f]
                    if fl:
                        return fl
                return [c_item for _d, c_item in dm_list]

            cand_passes = [(_flush_cand, True)] if (not is_exp_f and has_native_col) else (
                [(_upright_flush_cand, True)] if has_native_col else [(_upright_cand, False)]
            )
            # Structural-before-finishing split on final stage too: if remaining `r_b` mixes structural
            # stud-bearing parts with studless finishing slopes/tiles, seat structural parts first so
            # finishing slopes cannot steal studs needed by structural plates (e.g. 41605 s20 st4)!
            r_struct = [pc for pc in r_b if _has_male_studs(pc[0])]
            r_finish = [pc for pc in r_b if not _has_male_studs(pc[0])]
            use_split = (not is_exp_f and bool(r_struct) and bool(r_finish))
            best_st_eval = None
            evals_st = []
            for cand_use, is_fl_pass in cand_passes:
                if use_split:
                    st_a = solve_step_exact(lib, scene_for_f, sc_f, p_b, r_struct, cand_use,
                                            collider=collider, beam=4, per_part=8, deltas=f_deltas, pushes=f_pushes,
                                            fill=False, polish_starts=0, use_milp=False, float_base=0.0)
                    states = []
                    for sa in (st_a or [])[:3]:
                        pb_a = list(p_b) + list(sa.placed)
                        sc_fa = ModelScorer(lib, pb_a, pic_f, v_f, all_codes)
                        st_b = solve_step_exact(lib, scene_for_f, sc_fa, pb_a, r_finish, cand_use,
                                                collider=collider, beam=3, per_part=8, deltas=f_deltas, pushes=f_pushes,
                                                fill=(len(r_finish) >= 2 and len(set(r_finish)) >= 2),
                                                polish_starts=1, use_milp=(2 <= len(r_finish) <= 6),
                                                milp_time_limit=0.15, milp_max_sols=2,
                                                polish_top_k=16, polish_rounds=2, fill_depth=1, fill_budget=16, float_base=0.0)
                        for sb in (st_b or [])[:2]:
                            states.append(State(list(sa.placed) + list(sb.placed),
                                                list(sa.scores) + list(sb.scores),
                                                float(sa.total + sb.total)))
                    states.sort(key=lambda s: -s.total)
                else:
                    states = solve_step_exact(lib, scene_for_f, sc_f, p_b, r_b, cand_use,
                                              collider=collider, beam=4, per_part=8, deltas=f_deltas, pushes=f_pushes,
                                              fill=(not is_exp_f and len(r_b) >= 2 and len(set(r_b)) >= 2),
                                              polish_starts=0 if is_exp_f else 1,
                                              use_milp=(not is_exp_f and 2 <= len(r_b) <= 6),
                                              milp_time_limit=0.15, milp_max_sols=2,
                                              polish_top_k=16, polish_rounds=2, fill_depth=1, fill_budget=16, float_base=0.0)
                for st_cand in (states or [])[:3]:
                    if not st_cand.placed:
                        continue
                    u4_c = [(p, c, m, m) for p, c, m in p_b] + [
                        (p, c, m, drawn_pose(sc) if sc is not None else m)
                        for (p, c, m), sc in zip(st_cand.placed, st_cand.scores)
                    ]
                    dr_c = [(p, c, d) for p, c, _m, d in u4_c]
                    v_c = v_f
                    v_f2 = _align_view(dr_c, st_f, cv_use)
                    shift = float(np.hypot(v_f2.offset[0] - v_f.offset[0], v_f2.offset[1] - v_f.offset[1]))
                    if shift > 1.5 and not is_exp_f:
                        sc_f2 = ModelScorer(lib, p_b, pic_f, v_f2, all_codes)
                        st_p = exact_polish(lib, sc_f2, p_b, st_cand, cand_use, collider=collider, top_k=16, rounds=2)
                        cand_3 = list(p_b) + list(st_p.placed)
                        m_old = _unit_metrics(lib, dr_c, v_f2, pic_f, all_codes)
                        m_new = _unit_metrics(lib, cand_3, v_f2, pic_f, all_codes)
                        if m_new[0] > m_old[0]:
                            u4_c = [(p, c, m, m) for p, c, m in cand_3]
                            dr_c = cand_3
                        v_c = v_f2
                    elif shift > 1.5:
                        m_old = _unit_metrics(lib, dr_c, v_f, pic_f, all_codes)
                        m_new = _unit_metrics(lib, dr_c, v_f2, pic_f, all_codes)
                        if m_new[0] > m_old[0]:
                            v_c = v_f2
                    ms_c, ex_c, pr_c = _unit_metrics(lib, dr_c, v_c, pic_f, all_codes)
                    mt_c = (_mates_count([(p, c, m) for p, c, m, _d in u4_c]) / max(1, len(u4_c))) if len(u4_c) >= 2 else 0.0
                    key_c = ms_c + (0.20 * mt_c if not is_exp_f else 0.14 * mt_c) + (0.25 if len(u4_c) == len(per_copy) else 0.0)
                    item_c = (key_c, u4_c, ms_c, ex_c, pr_c, mt_c)
                    evals_st.append(item_c)
                    if best_st_eval is None or key_c > best_st_eval[0]:
                        best_st_eval = item_c
                if is_fl_pass and (best_st_eval is None or best_st_eval[3] < 0.84 or best_st_eval[4] < 0.86 or len(best_st_eval[1]) < len(per_copy)):
                    cand_passes.append((_upright_cand if is_exp_f else cached_cand, False))
            if not evals_st:
                return []
            evals_st.sort(key=lambda x: -x[0])
            out_ev = []
            for _kc, unit_4, ms_f, exp_f, prec_f, mates_f in evals_st[:2]:
                complete_bonus = 0.25 if len(unit_4) == len(per_copy) else 0.0
                avg_prev = cum_ms / max(1, K - 1)
                rank_sc = 0.65 * ms_f + 0.35 * avg_prev + (0.18 * mates_f if not is_exp_f else 0.14 * mates_f) + complete_bonus
                all_good = (len(unit_4) == len(per_copy) and min(min_e, exp_f) >= 0.78 and min(min_p, prec_f) >= 0.85)
                out_ev.append((rank_sc, ms_f, unit_4, exp_f, prec_f, all_good))
            return out_ev
        else:
            unit_4 = [(p, c, m, m) for p, c, m in p_b]
            drawn_f = list(p_b)
            ms_f, exp_f, prec_f = _unit_metrics(lib, drawn_f, v_f, pic_f, all_codes)
            mates_f = (_mates_count([(p, c, m) for p, c, m, _d in unit_4]) / max(1, len(unit_4))) if len(unit_4) >= 2 else 0.0
            complete_bonus = 0.25 if len(unit_4) == len(per_copy) else 0.0
            avg_prev = cum_ms / max(1, K - 1)
            rank_sc = 0.65 * ms_f + 0.35 * avg_prev + (0.18 * mates_f if not is_exp_f else 0.14 * mates_f) + complete_bonus
            all_good = (len(unit_4) == len(per_copy) and min(min_e, exp_f) >= 0.78 and min(min_p, prec_f) >= 0.85)
            return [(rank_sc, ms_f, unit_4, exp_f, prec_f, all_good)]

    for cum_ms, p_b, r_b, cv_b, min_e, min_p in beams:
        if deadline and _time.monotonic() > deadline + 2.0:
            break
        all_finals.extend(_eval_final_view(p_b, r_b, cv_b, cum_ms, min_e, min_p))

    best_final = max(all_finals, key=lambda x: x[0]) if all_finals else None
    # Inter-stage 90-deg tip fallback: if the final mini-step tips the partial sub-assembly sideways
    # (e.g. vertical blaster barrel in 41620 s29 st1-st2 tipped horizontally onto the blaster in st3!),
    # test the 4 sideways 90-deg orientations on the top 2 beams!
    if beams and (best_final is None or best_final[1] < 0.0 or best_final[3] < 0.72):
        from ..viewfit import ORIENTATIONS
        for cum_ms, p_b, r_b, cv_b, min_e, min_p in beams[:2]:
            side_Rs = []
            seen_y = set()
            for R_o in ORIENTATIONS:
                uy = tuple(np.round(R_o @ np.array([0.0, -1.0, 0.0]), 1))
                if abs(uy[1]) < 0.5 and uy not in seen_y:
                    seen_y.add(uy)
                    side_Rs.append(R_o)
            sc_side = []
            for R_s in side_Rs:
                for y_s in (35.0, 55.0):
                    cv_s = cv_b.replace(orientation=R_s, yaw=y_s)
                    v_s = _align_view(p_b, st_f, cv_s)
                    m_s = _unit_metrics(lib, p_b, v_s, pic_f, all_codes)
                    sc_side.append((m_s[2] + 0.5 * m_s[0], cv_s))
            sc_side.sort(key=lambda x: -x[0])
            for _sv, cv_s in sc_side[:4]:
                if deadline and _time.monotonic() > deadline + 4.0:
                    break
                all_finals.extend(_eval_final_view(p_b, r_b, cv_s, cum_ms, min_e, min_p))
    if not all_finals:
        return None
    all_finals.sort(key=lambda x: -x[0])
    # Deduplicate distinct unit assemblies up to canonical facing frame (keep top-3 so main picture resolves
    # depth/stack-order ambiguities like 40271 s5 or 41620 s29!)
    def _u4_key(u4):
        u3 = [(p, c, np.asarray(m, float)) for p, c, m, _d in u4]
        fac = next((m for _p, _c, m in u3 if np.allclose(m[:3, 1], [0.0, 1.0, 0.0], atol=1e-2)), u3[0][2])
        inv = np.linalg.inv(fac)
        return _state_geom_key(lib, [(p, c, inv @ m) for p, c, m in u3])

    dedup_f, seen_f = [], set()
    for item in all_finals:
        k_u = _u4_key(item[2])
        if k_u not in seen_f:
            seen_f.add(k_u)
            dedup_f.append(item)
        if len(dedup_f) >= 4:
            break
    # Zero-shot DINOv2 + BrickPriorNet v3 disambiguation across close final sub-build unit candidates
    # (especially effective on black-on-black blasters, pearl-gold gauntlets, and multi-layer stacks!)
    if len(dedup_f) >= 2 and abs(dedup_f[0][0] - dedup_f[1][0]) < 0.28:
        bp_bonus = np.zeros(len(dedup_f), dtype=np.float64)
        try:
            from . import brick_prior
            bp = brick_prior.prior()
            if bp is not None:
                lays_u = [[(p, c, m) for p, c, m, _d in item[2]] for item in dedup_f]
                bp_raw = np.array([
                    float(bp.score_layouts_batch(lay[:1], [lay[1:]], max_neighbors=4, radius=70.0)[0]) / max(1, len(lay) - 1)
                    if len(lay) >= 2 else 0.0
                    for lay in lays_u
                ], dtype=np.float64)
                bp_bonus = np.clip(0.05 * (bp_raw - float(np.mean(bp_raw))), -0.10, 0.10)
        except Exception:
            pass
        d_bonus = np.zeros(len(dedup_f), dtype=np.float64)
        from . import vision_prior
        perc = vision_prior.perceptor()
        if perc is not None:
            try:
                bg_f = tuple(int(round(v)) for v in pic_f.background)
                fg_f = pic_f.foreground & ~pic_f.arrows
                ren_f = []
                for item in dedup_f:
                    dr_u = [(p, c, d) for p, c, _m, d in item[2]]
                    v_u = _align_view(dr_u, st_f, canon_views[0])
                    ren_f.append(vision_prior.render_npr_rgb(lib, dr_u, v_u, pic_f.rgb.shape[:2], bg=bg_f)[0])
                d_u = perc.score_renders(pic_f.rgb, fg_f, bg_f, ren_f)
                if len(d_u) == len(dedup_f):
                    d_bonus = 0.45 * (d_u - float(np.mean(d_u)))
            except Exception:
                pass
        order_u = sorted(range(len(dedup_f)), key=lambda i: -(dedup_f[i][0] + float(d_bonus[i]) + float(bp_bonus[i])))
        dedup_f = [dedup_f[i] for i in order_u]
    best_final = dedup_f[0]
    _rk, ms_f, unit_4, exp_f, prec_f, all_good = best_final
    alts_4 = [
        item[2] for item in dedup_f[1:3]
        if item[0] >= best_final[0] - 0.30 and len(item[2]) == len(unit_4)
        and item[3] >= MIN_EXPLAINED and item[4] >= MIN_PRECISION
    ]
    return (ms_f, unit_4, exp_f, prec_f, all_good, alts_4)


def solve_unit(lib, spec: dict, view, candidate_fn, deltas, collider=None, time_budget: float = 10.0) -> dict | None:
    """The panel solved alone under the main picture's camera angles using ModelScorer + exact placement
    (so internal seam lines, white-on-white tiles, all-grey curved slopes, black blasters, and purple/gold
    assemblies all align with pixel accuracy!). Uses progressive mini-step stages when the panel has
    numbered sub-steps (1, 2, ..., K), and compares/falls back to single-stage solving."""
    import time as _time
    from .render import View
    _deadline = _time.monotonic() + time_budget
    per_copy = spec["per_copy"]
    # Deduplicate candidate bases by part geometry so e.g. two 4070s of different colours don't crowd out 3023!
    ranked_all = sorted(list(dict.fromkeys(per_copy)), key=lambda pc: _base_priority(lib, pc), reverse=True)
    bases, seen_p = [], set()
    for pc in ranked_all:
        if pc[0] not in seen_p:
            seen_p.add(pc[0])
            bases.append(pc)
    view = upright(view)
    pic = spec["picture"]
    has_panel_arrows = int(pic.arrows.sum()) >= 20
    # ALWAYS solve seated (0.0,) first: mini-step panels often carry transition arrows even though
    # the final mini-step drawing itself is seated (e.g. 40271 s5)! Only fall back to SUB_DELTAS
    # when the panel has arrows AND seated fails to explain it cleanly.
    delta_passes = [(0.0,)]
    if has_panel_arrows and deltas != (0.0,):
        delta_passes.append(SUB_DELTAS)

    # LEGO draws sub-build panels in canonical upright frame at standard studio angles (~35 or ~55 deg yaw, ~35 deg pitch)
    base_pitch = view.pitch if 25.0 <= view.pitch <= 42.0 else 35.0
    yaw_order = [35.0, 55.0] if abs(view.yaw - 35.0) <= abs(view.yaw - 55.0) else [55.0, 35.0]
    canon_views = [View(np.eye(3), y, base_pitch, view.scale, (0.0, 0.0), 0.0) for y in yaw_order]

    def _pack_u4(u4_list):
        u3 = [(p, c, m) for p, c, m, _d in u4_list]
        fac = next((np.asarray(m, float) for _p, _c, m in u3 if np.allclose(np.asarray(m, float)[:3, 1], [0.0, 1.0, 0.0], atol=1e-2)), np.asarray(u3[0][2], float))
        inv = np.linalg.inv(fac)
        return {"parts": [(p, c, inv @ np.asarray(m, float)) for p, c, m in u3], "facing": fac}

    # 0. Progressive multi-stage sub-build solver when the panel has >= 2 numbered mini-steps!
    from ..viewfit import BOOKLET_SCALE
    panel_scale = float(BOOKLET_SCALE / pic.pts_per_px) if pic.pts_per_px else float(view.scale)
    staged = None
    n_stages = len(spec.get("stages") or [])
    if n_stages >= 2 and len(per_copy) >= 3:
        # Give deep multi-stage assemblies (3-6 stages, 5-11 parts) enough time to finish all stages cleanly!
        stage_budget = max(0.75 * time_budget, 3.5 * n_stages)
        up_deadline = _time.monotonic() + stage_budget
        staged = _solve_unit_staged(lib, spec, canon_views, panel_scale, bases, candidate_fn,
                                    collider=collider, deadline=up_deadline)
        # Steep top-down pitch (~58 deg) fallback when standard 35 deg staged fails to explain the panel
        # cleanly (e.g. top-down Infinity Gauntlet / weapon / shield panels like 41605 s23)!
        if staged is None or not staged[4] or staged[2] < 0.84 or staged[3] < 0.88:
            steep_views = [View(np.eye(3), y, 58.0, panel_scale, (0.0, 0.0), 0.0) for y in yaw_order]
            steep_deadline = _time.monotonic() + 0.70 * stage_budget
            staged_steep = _solve_unit_staged(lib, spec, steep_views, panel_scale, bases, candidate_fn,
                                              collider=collider, deadline=steep_deadline)
            if staged_steep is not None and (staged is None or staged_steep[0] > staged[0] + 0.03):
                staged = staged_steep
        # Only try upside-down staged when upright staged failed to produce a clean full assembly
        if staged is None or not staged[4] or staged[0] < 0.10:
            R_dn = np.diag([-1.0, -1.0, 1.0])
            dn_views = [View(R_dn, y, base_pitch, panel_scale, (0.0, 0.0), 0.0) for y in yaw_order]
            dn_deadline = _time.monotonic() + 0.65 * stage_budget
            staged_dn = _solve_unit_staged(lib, spec, dn_views, panel_scale, bases, candidate_fn,
                                           collider=collider, deadline=dn_deadline)
            if staged_dn is not None and (staged is None or staged_dn[0] > staged[0] + 0.05):
                staged = staged_dn
        if staged is not None:
            s_match, s_unit, s_exp, s_prec, s_all_good, s_alts = staged
            # Early return when ALL intermediate stages + final stage align tightly!
            if s_all_good and s_match >= 0.05 and s_exp >= 0.78 and s_prec >= 0.88:
                spec.setdefault("checks", []).append((round(s_exp, 2), round(s_prec, 2)))
                packed = _pack_u4(s_unit)
                if s_alts:
                    packed["alternatives"] = [_pack_u4(au) for au in s_alts]
                return packed

    def _is_great(tr) -> bool:
        return tr is not None and tr[0] >= 0.14 and tr[2] >= 0.90 and tr[3] >= 0.93 and len(tr[1]) == len(per_copy)

    def _tr_rank(tr) -> float:
        # Reward complete units (all parts in `per_copy` retained) over pruned partial units (e.g. 41620 s19!)
        return float(tr[0]) + (0.18 if len(tr[1]) == len(per_copy) else 0.0)

    best = None
    best_meta = None
    best_scale = view.scale
    best_deltas = (0.0,)
    alt_pool: list[tuple[float, list]] = []
    if staged is not None:
        s_match, s_unit, s_exp, s_prec, s_all_good, s_alts = staged
        # Multi-stage consensus proves occluded interior layers; prefer it over single-view overfitting!
        bonus = 0.22 if (s_all_good and len(spec.get("stages") or []) >= 3) else (0.12 if s_all_good else 0.04)
        best = (s_match + bonus, s_unit, s_exp, s_prec)
        if s_exp >= MIN_EXPLAINED and s_prec >= MIN_PRECISION:
            alt_pool.append((_tr_rank(best), s_unit))
            for au in s_alts:
                alt_pool.append((_tr_rank(best) - 0.05, au))
    for panel_deltas in delta_passes:
        if _time.monotonic() > _deadline:
            break
        if panel_deltas != (0.0,) and best is not None and best[2] >= 0.80 and best[3] >= 0.92 and best[0] >= 0.25 and len(best[1]) == len(per_copy):
            break
        # 1. Try native main-picture scale (f=1.0) on the largest base across BOTH standard studio yaws (35 & 55 deg)
        # Never early-exit between 35 and 55 deg so mirror-image left/right panels (e.g. 41620 s27) ALWAYS find their exact yaw!
        for bi, base in enumerate(bases[:2]):
            if _time.monotonic() > _deadline:
                break
            if bi > 0 and best is not None and best[2] >= 0.85 and best[3] >= 0.88 and len(best[1]) == len(per_copy):
                break
            others = list(per_copy)
            others.remove(base)
            turns = _distinct_turns(lib, base[0])
            for cv in canon_views:
                for k in turns:
                    if _time.monotonic() > _deadline:
                        break
                    trial = _try(lib, spec, cv, view.scale, base, others, k, candidate_fn, panel_deltas, collider, polish_starts=0)
                    if trial is not None:
                        if trial[2] >= MIN_EXPLAINED and trial[3] >= MIN_PRECISION:
                            alt_pool.append((_tr_rank(trial), trial[1]))
                        if best is None or _tr_rank(trial) > _tr_rank(best) + 1e-9:
                            best = trial
                            best_meta = (base, others, k, cv)
                            best_scale = view.scale
                            best_deltas = panel_deltas
            if _is_great(best):
                break
    panel_deltas = best_deltas
    # 2. Local fine-tuning (0.94, 1.06) on best (base, turn, view) when native scale matched reasonably
    if best is not None and best[2] >= MIN_EXPLAINED and best[3] >= MIN_PRECISION and best_meta is not None:
        if not _is_great(best) and _time.monotonic() < _deadline:
            base, others, k, cv = best_meta
            for f in (0.94, 1.06):
                if _time.monotonic() > _deadline:
                    break
                trial = _try(lib, spec, cv, view.scale * f, base, others, k, candidate_fn, panel_deltas, collider, fast=True)
                if trial is not None and _tr_rank(trial) > _tr_rank(best) + 1e-9:
                    best = trial
                    best_scale = view.scale * f
    elif _time.monotonic() < _deadline:
        # 3. Panel is zoomed relative to main picture: fast coarse scan over ZOOM_SCALES, then ONE exact refine!
        z_deltas = SUB_DELTAS if (has_panel_arrows and deltas != (0.0,)) else (0.0,)
        best_z = None
        best_z_meta = None
        for f in (1.25, 1.5, 0.8, 1.8):
            if _time.monotonic() > _deadline:
                break
            for base in bases[:1]:
                others = list(per_copy)
                others.remove(base)
                turns = _distinct_turns(lib, base[0])
                for cv in canon_views:
                    for k in turns:
                        if _time.monotonic() > _deadline:
                            break
                        trial = _try(lib, spec, cv, view.scale * f, base, others, k, candidate_fn, z_deltas, collider, fast=True)
                        if trial is not None and (best_z is None or _tr_rank(trial) > _tr_rank(best_z) + 1e-9):
                            best_z = trial
                            best_z_meta = (base, others, k, cv, f)
                    if _is_great(best_z):
                        break
            if _is_great(best_z):
                break
        if best_z is not None and best_z[2] >= MIN_EXPLAINED * 0.85 and best_z[3] >= MIN_PRECISION * 0.85 and best_z_meta is not None:
            zb, zo, zk, zcv, zf = best_z_meta
            refined = _try(lib, spec, zcv, view.scale * zf, zb, zo, zk, candidate_fn, z_deltas, collider, fast=False, polish_starts=0)
            cand_z = refined if (refined is not None and _tr_rank(refined) >= _tr_rank(best_z)) else best_z
            if cand_z[2] >= MIN_EXPLAINED and cand_z[3] >= MIN_PRECISION:
                alt_pool.append((_tr_rank(cand_z), cand_z[1]))
            if best is None or _tr_rank(cand_z) > _tr_rank(best) + 1e-9:
                best = cand_z
                best_meta = (zb, zo, zk, zcv)
                best_scale = view.scale * zf
                panel_deltas = z_deltas
    # 4. Run ONE fast joint polish pass ONLY on the single winning (base, yaw, turn, scale) (~0.5s vs 20x!)
    if best is not None and best_meta is not None and panel_deltas == (0.0,) and len(per_copy) >= 2 and _time.monotonic() < _deadline + 3.0:
        wb, wo, wk, wcv = best_meta
        polished = _try(lib, spec, wcv, best_scale, wb, wo, wk, candidate_fn, panel_deltas, collider, fast=False, polish_starts=1)
        if polished is not None and _tr_rank(polished) > _tr_rank(best) + 1e-9:
            best = polished
    if best is None:
        return None
    match, unit, explained, precision = best
    spec.setdefault("checks", []).append((round(explained, 2), round(precision, 2)))
    if explained < MIN_EXPLAINED or precision < MIN_PRECISION or match < -0.25:
        return None
    packed = _pack_u4(unit)
    # Attach up to 2 distinct high-scoring alternative unit assemblies so `place_units` can disambiguate
    # depth/stack-order ambiguities against the main step picture!
    from .exact_place import _state_geom_key as _sgk
    best_rk = _tr_rank(best)
    seen_pk = {_sgk(lib, packed["parts"])}
    alts_out = []
    for rk_a, u4_a in sorted(alt_pool, key=lambda x: -x[0]):
        if len(u4_a) != len(unit) or rk_a < best_rk - 0.30:
            continue
        pk_a = _pack_u4(u4_a)
        gk_a = _sgk(lib, pk_a["parts"])
        if gk_a not in seen_pk:
            seen_pk.add(gk_a)
            alts_out.append(pk_a)
        if len(alts_out) >= 2:
            break
    if alts_out:
        packed["alternatives"] = alts_out
    return packed


def _bottom_anchor_view(lib, part_entry, pic, view, scale: float):
    """Place `part_entry` so its projected bottom edge aligns with the bottom of `pic.foreground`
    and its horizontal centre aligns with `fg`'s horizontal centre. Essential for flat/stacked
    same-colour sub-build panels (e.g. grey plate under grey slopes in 40271 s16, white plate under
    white tiles in 41620 s23) where registering the base plate alone slides it up onto the top layer!"""
    from .render import bounds
    fg = pic.foreground & ~pic.arrows
    ys, xs = np.nonzero(fg)
    if not len(xs):
        return None
    v0 = view.replace(scale=scale, offset=(0.0, 0.0))
    lo, hi = bounds(lib, [part_entry], v0)
    cx_fg = 0.5 * (float(xs.min()) + float(xs.max()))
    by_fg = float(ys.max())
    cx_p = 0.5 * (float(lo[0]) + float(hi[0]))
    by_p = float(hi[1])
    return v0.replace(offset=(cx_fg - cx_p, by_fg - by_p))


def _try(lib, spec, view, scale, base, others, k, candidate_fn, deltas, collider=None,
         prune: bool = True, fast: bool = False, polish_starts: int = 0):
    """(score, unit, explained, precision) with `base` seated at one quarter turn, at one scale, or None.
    Driven by ModelScorer + solve_step_exact, trying BOTH template-registered base view and bottom-anchored
    base view (for flat/stacked same-colour sub-builds where the base plate sits at the bottom of the panel!)."""
    from .exact_place import solve_step_exact
    from .place import Scene, drawn_pose
    from .register import Aligner, register
    from .scorer import ModelScorer

    pic, classes, codes, ink, on_ink = spec["picture"], spec["classes"], spec["codes"], spec["ink"], spec["on_ink"]
    a = (base[0], base[1], _turn(k))
    reg = register(lib, [a], pic, codes, view.orientation, view.yaw, view.pitch, scale,
                   scale_range=(1.0,), angle_steps=(), classes=classes, on_ink=on_ink)
    cand_views = [reg.view]
    if not fast and len(others) >= 2:
        from .place import _world_aabb
        blo, bhi = _world_aabb(lib, a[0], a[2])
        # Only try bottom-anchor when base `a` is a flat plate/tile (height <= 14 LDU, e.g. 3031/3020/3710)
        if float(bhi[1] - blo[1]) <= 14.0:
            v_bot = _bottom_anchor_view(lib, a, pic, view, scale)
            if v_bot is not None and float(np.hypot(v_bot.offset[0] - reg.view.offset[0], v_bot.offset[1] - reg.view.offset[1])) > 3.5:
                cand_views.append(v_bot)

    def _solve_under(v, allow_milp: bool = True):
        unit_local = [(a[0], a[1], a[2], a[2])]
        if not others:
            return unit_local
        sc_unit = ModelScorer(lib, [a], pic, v, codes)
        def scene_for(model):
            s = Scene.build(lib, model, v, classes, codes, ink)
            s.picture = pic
            return s
        cand_cache: dict = {}
        def cached_cand(part, model):
            key = (part, tuple((p, tuple(np.round(np.asarray(m, float).ravel(), 2))) for p, _c, m in model))
            res = cand_cache.get(key)
            if res is None:
                res = candidate_fn(part, model)
                non_flush = [c for c in res if c.get("kind") != "flush"]
                if non_flush:
                    res = non_flush
                # Cap dense 15-deg/22.5-deg continuous clip/hinge sweeps inside small sub-build panels to 45-deg
                # steps (keeping all stud/ortho poses + coarse 45-deg clip/hinge poses; polish refines continuously!)
                if len(res) > 120:
                    kept_r = []
                    for c in res:
                        if c.get("kind") in ("clip", "hinge"):
                            r3 = np.abs(np.asarray(c["matrix"], float)[:3, :3])
                            # Keep multiples of 45 deg (entries near 0, 1, or sqrt(2)/2 ~= 0.7071)
                            if not np.all((r3 < 0.05) | (r3 > 0.95) | (np.abs(r3 - 0.7071) < 0.06)):
                                continue
                        kept_r.append(c)
                    if kept_r:
                        res = kept_r
                cand_cache[key] = res
            return res
        use_sub_milp = (not fast) and allow_milp and deltas == (0.0,) and 2 <= len(others) <= 10
        use_fill = (not fast) and deltas == (0.0,) and len(others) >= 2 and len(set(others)) >= 2
        b_use = 2 if fast else (3 if deltas != (0.0,) else 4)
        pp_use = 6 if (fast or deltas != (0.0,)) else 8
        p_pushes = pic.arrow_axes() if deltas != (0.0,) else []
        states = solve_step_exact(lib, scene_for, sc_unit, [a], others, cached_cand,
                                  collider=collider, beam=b_use, per_part=pp_use,
                                  deltas=deltas, pushes=p_pushes, fill=use_fill,
                                  polish_starts=0 if (fast or deltas != (0.0,)) else polish_starts,
                                  use_milp=use_sub_milp, milp_time_limit=0.15, milp_max_sols=2,
                                  polish_top_k=16, polish_rounds=2, fill_depth=1, fill_budget=16, float_base=0.0)
        if states:
            chosen_st = states[0]
            if deltas == (0.0,) and len(states) >= 2 and not fast:
                from .comparator import layout_patches, layout_weight, loaded_layout
                comp_v2 = loaded_layout()
                if comp_v2 is not None and layout_weight() > 0.0:
                    top_k = min(6, len(states))
                    top_sts = states[:top_k]
                    drawn_list = [[(p, c, drawn_pose(sc) if sc is not None else m) for (p, c, m), sc in zip(st.placed, st.scores)]
                                  for st in top_sts]
                    pats = layout_patches(lib, pic.rgb, pic.background, sc_unit.view, [a], drawn_list)
                    if pats is not None and len(pats) == top_k:
                        base_arr = np.array([float(st.total) for st in top_sts], dtype=float)
                        blended = comp_v2.blend(base_arr, comp_v2.logits(pats))
                        chosen_st = top_sts[int(np.argmax(blended))]
            for (p, c, m), sc in zip(chosen_st.placed, chosen_st.scores):
                unit_local.append((p, c, m, drawn_pose(sc) if sc is not None else m))
        return unit_local

    best_u = None
    best_v = reg.view
    best_m = (-1e9, 0.0, 0.0)
    for v_init in cand_views:
        u_try = _solve_under(v_init, allow_milp=True)
        v_use = v_init
        drawn_try = [(p, c, d) for p, c, _m, d in u_try]
        m_try = _unit_metrics(lib, drawn_try, v_use, pic, codes)
        # Re-align translation of the assembled unit to the panel and re-solve once if it shifted!
        if not fast and len(u_try) > 1:
            _av, aligned_v = Aligner(lib, drawn_try, classes, codes, on_ink=on_ink).evaluate(v_use)
            shift = float(np.hypot(aligned_v.offset[0] - v_use.offset[0], aligned_v.offset[1] - v_use.offset[1]))
            if shift > 1.5:
                m1 = _unit_metrics(lib, drawn_try, aligned_v, pic, codes)
                if m1[0] > m_try[0] + 0.03:
                    v_use, m_try = aligned_v, m1
                    u2 = _solve_under(v_use, allow_milp=(m_try[1] < 0.88))
                    m2 = _unit_metrics(lib, [(p, c, d) for p, c, _m, d in u2], v_use, pic, codes)
                    if m2[0] > m_try[0] + 1e-4:
                        u_try, m_try = u2, m2
        if best_u is None or m_try[0] > best_m[0] + 1e-6:
            best_u, best_v, best_m = u_try, v_use, m_try

    unit, cur_view = best_u, best_v
    match, explained, precision = best_m

    def measure(u):
        return _unit_metrics(lib, [(p, c, d) for p, c, _m, d in u], cur_view, pic, codes)
    full = len(unit)
    improved = prune and not fast
    while improved and len(unit) > 1:          # drop parts the drawing is clearly better without (e.g. arrow clutter)
        improved = False
        for j in range(1, len(unit)):
            trial = unit[:j] + unit[j + 1:]
            m2 = measure(trial)
            if m2[0] > match + 0.04:           # require meaningful ModelScorer gain to drop a real callout part
                unit, (match, explained, precision), improved = trial, m2, True
                break
    if prune and not fast and (len(unit) < full or len(unit) < len(others) + 1):
        kept = [(p, c) for p, c, _m, _d in unit[1:]]
        again = _try(lib, spec, view, scale, base, kept, k, candidate_fn, deltas, collider, prune=False, fast=True)
        if again is not None:
            return again
    return match, unit, explained, precision


def _explains(lib, drawn: list, view, pic, classes, codes) -> tuple[float, float]:
    """Colour by colour, over pixels whose colour the panel shows (outlines aside): (share of the panel's
    part-coloured pixels the unit draws in that colour, share of the unit's pixels landing on its colour).
    White plate over green drawn as green over white: same outline, no agreement."""
    from .render import render
    _depth, label = render(lib, drawn, view, classes.shape)
    index = {c: k for k, c in enumerate(codes)}
    colour = np.array([index.get(c, -99) for _p, c, _m in drawn] + [-98])
    drawn_colour = colour[label]
    mask = label >= 0
    known = (classes >= 0) & ~pic.arrows
    agree = np.count_nonzero(mask & known & (drawn_colour == classes))
    return agree / max(1, np.count_nonzero(known)), agree / max(1, np.count_nonzero(mask & known))


def _self_symmetries(lib, part: str) -> list[np.ndarray]:
    """Quarter-turn matrices `_turn(k)` that leave `part`'s own geometry unchanged (e.g. all 4 turns
    for a square 4x4 plate `3031` or round plate `6141`, 2 turns for a 2x4 plate `3020` or 1x2 `3023`).
    When `distinct()` deduplicates candidates for a single part, it drops these self-symmetric turns —
    which MUST be expanded back when seating a multi-part rigid unit on that part!"""
    from .place import _shape
    h0, lo0 = _shape(lib, part, np.eye(3))
    out = [np.eye(4)]
    for k in (1, 2, 3):
        tk = _turn(k)
        hk, lok = _shape(lib, part, tk[:3, :3])
        if hk == h0 and np.allclose(lok, lo0, atol=0.2):
            out.append(tk)
    return out


def _batch_score_unit_options(lib, sc_obj, cur_bufs, opt_list, deltas, pushes=()):
    """Batch-score all rigid unit poses `opt_list = [(world, axis, upright, faces)]` using C++ `bm_score_sprites`
    (~300x faster than looping Python `_sprite_delta_score` over thousands of candidate attachments!).
    When `deltas != (0.0,)` and `pushes` (from `picture.arrow_axes()`) is provided, ALSO scores back-projected
    arrow-axis displacements so hinged/clipped/sideways exploded sub-builds (whose connector axis is perpendicular
    to the red assembly arrow, e.g. 41605 Thanos arms!) match their floating drawings cleanly."""
    from . import native_bridge
    from .exact_place import _scene_score_planes, _sprite_delta_score
    from .place import FLOAT_PENALTY, part_sprite
    from .scorer import EDGE_PREC_WEIGHT, PAPER_PENALTY

    cur_depth, cur_label, cur_col_map, cur_edge_depth = cur_bufs
    old_score, base_edge, chg_plane = _scene_score_planes(sc_obj, cur_depth, cur_col_map, cur_edge_depth)
    use_cpp = native_bridge.available()

    # Precompute 3D back-projected arrow push moves once per call (shared across all unit options)
    push_moves: list[tuple[float, np.ndarray]] = []
    if deltas != (0.0,) and pushes:
        back = sc_obj.view.matrix.T
        v_sc = max(float(sc_obj.view.scale), 1e-6)
        for d_dir, length in pushes[:3]:
            for k_step in UNIT_PUSH_STEPS:
                for s_p in (1.0, -1.0):
                    du = s_p * k_step * length * float(d_dir[0])
                    dv = s_p * k_step * length * float(d_dir[1])
                    ldu = float(k_step * length / v_sc)
                    move = back @ np.array([du / v_sc, dv / v_sc, 0.0])
                    push_moves.append((ldu, move))

    # Build flat list of (opt_idx, d_idx, part_idx) grouped by (part, rot_bytes, colour_idx)
    # Each shift tuple is (sign, d_ldu, move_vec_or_None)
    opt_shifts: list[list[tuple[float, float, np.ndarray | None]]] = []
    groups: dict = {}
    for oi, (world, axis, _up, _fa) in enumerate(opt_list):
        ax = np.asarray(axis, float) if axis is not None else np.zeros(3)
        ds_try = deltas if axis is not None else (0.0,)
        signs_try = (1.0, -1.0) if (deltas != (0.0,) and axis is not None) else (1.0,)
        shifts: list[tuple[float, float, np.ndarray | None]] = [
            (s, float(d), None) for s in signs_try for d in ds_try if not (d == 0.0 and s < 0)
        ]
        if push_moves:
            for ldu, mv in push_moves:
                shifts.append((1.0, ldu, mv))
        opt_shifts.append(shifts)
        for pi, (q, cc, m) in enumerate(world):
            rk = (q, m[:3, :3].round(3).tobytes(), sc_obj.code_idx.get(cc, -1))
            grp = groups.setdefault(rk, {"rot": m[:3, :3], "items": []})
            pos0 = m[:3, 3]
            for di, (s, d, mv) in enumerate(shifts):
                pos_s = (pos0 + mv) if mv is not None else (pos0 + (s * d) * ax)
                grp["items"].append((oi, di, pi, pos_s))

    # Accumulate per-(opt_idx, d_idx, part_idx) results
    per_opt: list[list[list]] = [[[None] * len(opt_list[oi][0]) for _ in opt_shifts[oi]] for oi in range(len(opt_list))]
    for (q, _rb, cidx), grp in groups.items():
        sp = part_sprite(lib, q, grp["rot"], sc_obj.view)
        items = grp["items"]
        if not sp.mask.size:
            for oi, di, pi, _pos in items:
                per_opt[oi][di][pi] = (-1e6, -1e6, 0.0, 0)
            continue
        sp_total = int(sp.mask.sum())
        pos_arr = np.array([pos for _oi, _di, _pi, pos in items], dtype=np.float64)
        q = pos_arr @ sc_obj.view.matrix.T
        cols0 = np.rint(sc_obj.view.offset[0] + sc_obj.view.scale * q[:, 0]).astype(np.int32) + int(sp.corner[0])
        rows0 = np.rint(sc_obj.view.offset[1] + sc_obj.view.scale * q[:, 1]).astype(np.int32) + int(sp.corner[1])
        dds = np.ascontiguousarray(q[:, 2], dtype=np.float64)
        col_plane = sc_obj.col_planes[cidx] if 0 <= cidx < len(sc_obj.codes) else None
        res = (native_bridge.score_sprites(
            col_plane, old_score, cur_depth, base_edge, sc_obj.edge_prec_map, chg_plane,
            PAPER_PENALTY, EDGE_PREC_WEIGHT, sp.mask, sp.depth, sp.edge_img, sp_total, rows0, cols0, dds,
        ) if use_cpp else None)
        if res is not None:
            vals, cgs, egs, chgs = res
            for j, (oi, di, pi, _pos) in enumerate(items):
                per_opt[oi][di][pi] = (float(vals[j]), float(cgs[j]), float(egs[j]), int(chgs[j]))
        else:
            for j, (oi, di, pi, _pos) in enumerate(items):
                per_opt[oi][di][pi] = _sprite_delta_score(
                    sc_obj, sp, int(rows0[j]), int(cols0[j]), float(dds[j]), cidx,
                    cur_depth, cur_label, cur_col_map, cur_edge_depth,
                )

    out_best = []
    for oi, (world, axis, upright, faces) in enumerate(opt_list):
        shifts = opt_shifts[oi]
        best = None
        for di, (sign, d, mv) in enumerate(shifts):
            ss = []
            tot = 0.0
            for pi, (q, _cc, m) in enumerate(world):
                val, cg, eg, ch = per_opt[oi][di][pi]
                val_adj = val - FLOAT_PENALTY * d
                ss.append(Scored(val_adj, d, sign, {"matrix": m, "axis": axis}, cg, eg,
                                 val_adj if (d == 0.0 and mv is None) else 0.0, ch, move=mv))
                tot += val_adj
            if best is None or tot > best[0]:
                best = (tot, ss)
        total = best[0]
        total -= (0.0 if upright else TIPPED) * abs(total)
        total += (FACING if faces else 0.0) * abs(total)
        out_best.append((total, world, best[1], upright))
    return out_best


def place_units(lib, scene_for, base: list, units: list[tuple[list, int]], candidate_fn, collides=None,
                set_model=None, beam: int = 4, per_copy: int = 6, deltas=(0.0,), pushes=(),
                collider=None, scorer=None, next_scorer=None) -> list[State]:
    """Beam over the copies of every unit. A State's placed/scores list all unit parts placed. With
    `deltas` (the main picture has arrows) a unit may be drawn moved out along the connection it seats by.
    Uses C++ batch sprite pre-scoring + exact Z-buffered joint ModelScorer re-ranking on top non-colliding
    placements so intra-unit self-occlusion (e.g. tiles covering headlight bricks) never mis-ranks a unit!"""
    from .exact_place import _build_current_buffers, _drawn_entries

    copies = [(u["parts"], u["facing"]) for u, n in units for _ in range(n)]
    has_fast_col = collider is not None and getattr(collider, "native", None) is not None
    if has_fast_col:
        collider.set_model(base)
    # Keep distinct multi-unit steps (e.g. mirror left/right sub-builds like 41620 s27) wide so an
    # occluded unit never evicts the visible unit; tighten only identical 2x/4x repeats (`len(units) == 1`)!
    if len(units) >= 2:
        beam = max(beam, 6)
        per_copy = max(per_copy, 8)
    elif len(copies) >= 2:
        beam = max(beam, 4)
        per_copy = max(per_copy, 6)
    states = [State()]
    for copy_idx, (config, facing) in enumerate(copies):
        expanded = []
        for st in states:
            model = base + st.placed
            if not has_fast_col and set_model is not None:
                set_model(model)
            scene = None if scorer is not None else scene_for(model)
            cur_drawn = _drawn_entries(st.placed, st.scores)
            cur_bufs = _build_current_buffers(lib, scorer, cur_drawn) if scorer is not None else None
            nxt_bufs = _build_current_buffers(lib, next_scorer, st.placed) if (next_scorer is not None and deltas != (0.0,)) else None

            options: dict = {}
            for p, _c, rel in config:
                inv = np.linalg.inv(rel)
                syms = _self_symmetries(lib, p)
                for cand in candidate_fn(p, model):
                    if cand.get("kind") == "flush":
                        continue
                    is_joint = cand.get("kind") in ("hinge", "clip")
                    cm = np.asarray(cand["matrix"], float)
                    for sym in syms:
                        t = (cm @ sym) @ inv
                        key = tuple(np.round(t[:3, :4], 1).ravel())
                        if key not in options:
                            # Hinges/clips are physically designed to articulate at non-90 deg angles:
                            # never penalise them with `TIPPED`!
                            upright = bool(is_joint or np.allclose(t[:3, 1], [0.0, 1.0, 0.0], atol=1e-3))
                            faces = bool(np.allclose(t[:3, :3], facing[:3, :3], atol=1e-3))
                            options[key] = ([(q, cc, t @ r) for q, cc, r in config], cand.get("axis"), upright, faces, is_joint)
                        elif is_joint and not options[key][4]:
                            prev_o = options[key]
                            options[key] = (prev_o[0], prev_o[1], True, prev_o[3], True)

            raw_vals = list(options.values())
            opt_list = [(w, ax, up, fa) for w, ax, up, fa, _ij in raw_vals]
            opt_is_joint = [ij for _w, _ax, _up, _fa, ij in raw_vals]
            if scorer is not None:
                scored_raw = _batch_score_unit_options(lib, scorer, cur_bufs, opt_list, deltas, pushes=pushes)
                scored = [(tot, w, ss, up, ij) for (tot, w, ss, up), ij in zip(scored_raw, opt_is_joint)]
                scored_next_raw = (_batch_score_unit_options(lib, next_scorer, nxt_bufs, opt_list, (0.0,))
                                   if nxt_bufs is not None else [])
                scored_next = (
                    [(s_cur[0] + 0.6 * s_nxt[0], s_cur[1], s_cur[2], s_cur[3], ij)
                     for s_cur, s_nxt, ij in zip(scored_raw, scored_next_raw, opt_is_joint)]
                    if scored_next_raw else []
                )
            else:
                scored = []
                scored_next = []
                for (world, axis, upright, faces), ij in zip(opt_list, opt_is_joint):
                    best = None
                    for d in (deltas if axis is not None else (0.0,)):
                        ss = [score_candidates(lib, scene, q, cc, [{"matrix": m, "axis": axis}], deltas=(float(d),))[0]
                              for q, cc, m in world]
                        tot = sum(s.score for s in ss)
                        if best is None or tot > best[0]:
                            best = (tot, ss)
                    total = best[0]
                    total -= (0.0 if upright else TIPPED) * abs(total)
                    total += (FACING if faces else 0.0) * abs(total)
                    scored.append((total, world, best[1], upright, ij))

            def _hits(world) -> bool:
                if has_fast_col:
                    return any(collider.hits_extra(q, m, st.placed) for q, _cc, m in world)
                if any(_boxes_overlap(lib, w, o) for w in world for o in st.placed):
                    return True
                if collides is not None and any(collides(q, m, model) for q, _cc, m in world):
                    return True
                return False

            def _take_valid(ranked, limit, seen_w):
                out_k = []
                for total, world, ss, upright, ij in ranked:
                    if len(out_k) >= limit:
                        break
                    wkey = tuple((q, cc, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 2))) for q, cc, m in world)
                    if wkey in seen_w:
                        continue
                    if _hits(world):
                        continue
                    seen_w.add(wkey)
                    out_k.append((total, world, ss, upright, ij))
                return out_k

            # Exact Z-buffered joint ModelScorer re-ranking on the top non-colliding unit placements!
            # Keep full pool for single-unit & distinct multi-unit steps; tighten identical 2x+ repeat copies!
            if scorer is not None:
                if len(copies) == 1 or len(units) >= 2:
                    rescore_pool, joint_cap, up_cap = 72, 36, 24
                else:
                    rescore_pool = 28 if copy_idx == 0 else 16
                    joint_cap, up_cap = 16, 10
            else:
                rescore_pool, joint_cap, up_cap = per_copy, 0, 0
            seen_w: set = set()
            cand_valid = []
            if scored_next:
                scored_next.sort(key=lambda x: -x[0])
                cand_valid.extend(_take_valid(scored_next, rescore_pool, seen_w))
            scored.sort(key=lambda x: -x[0])
            cand_valid.extend(_take_valid(scored, rescore_pool, seen_w))
            if scorer is not None:
                joint_src = scored_next if scored_next else scored
                joint_only = [x for x in joint_src if x[4]]
                if joint_only:
                    cand_valid.extend(_take_valid(joint_only, joint_cap, seen_w))
                upright_only = [x for x in scored if x[3] and not x[4]]
                if upright_only:
                    cand_valid.extend(_take_valid(upright_only, up_cap, seen_w))

            if scorer is not None and cand_valid:
                # Physical multi-stud mating + BrickPriorNet v3 multi-neighbor structural prior!
                # Eliminates isometric depth-ray climbs (e.g. 40271 s10 brain tower perching 48 LDU high
                # on 1-2 rim studs instead of seating all 4 studs snugly in the center cavity!).
                bp_scores = np.zeros(len(cand_valid), dtype=np.float64)
                bp_w = float(os.environ.get("BOOKLET_SOLVER_BRICK_PRIOR_W", "35.0"))
                if bp_w > 0.0 and len(cand_valid) >= 2 and model:
                    try:
                        from . import brick_prior
                        bp = brick_prior.prior()
                        if bp is not None:
                            bp_raw = bp.score_layouts_batch(model, [w for _a, w, _ss, _u, _ij in cand_valid],
                                                            max_neighbors=4, radius=70.0)
                            cap_u = 55.0 * float(max(1, len(config)))
                            bp_scores = np.clip(bp_w * (bp_raw - float(np.mean(bp_raw))), -cap_u, cap_u)
                    except Exception:
                        pass

                raw_exact = []
                for idx_c, (_approx, world, ss, upright, ij) in enumerate(cand_valid):
                    w_drawn = _drawn_entries(world, ss)
                    cur_ex = float(scorer.score(cur_drawn + w_drawn))
                    nv_ex = (float(next_scorer.score_seated_in_next(st.placed + world))
                             if (next_scorer is not None and deltas != (0.0,)) else 0.0)
                    m_cnt = 0
                    if has_fast_col:
                        # Count physical connector mates onto `base` (already loaded in collider)
                        for q_w, _cc_w, m_w in world:
                            m_cnt += int(collider.mates(q_w, m_w)[0])
                    raw_exact.append((cur_ex, nv_ex, m_cnt, float(bp_scores[idx_c]), world, ss, upright, ij))
                # Only apply next-step confirmation when at least one candidate is positively confirmed
                # in step N+1 (prevents occlusion/rotation penalties from pushing visible parts behind the model!)
                use_nv = (next_scorer is not None and deltas != (0.0,)
                          and any(nv > 0.0 for _, nv, _, _, _, _, _, _ in raw_exact))
                exact_ranked = []
                for cur_ex, nv_ex, m_cnt, bp_s, world, ss, upright, ij in raw_exact:
                    ex_tot = cur_ex
                    if use_nv:
                        cur_d = cur_ex - float(scorer.base_score)
                        nv_eff = max(nv_ex, -0.35 * max(0.0, cur_d))
                        ex_tot += 0.6 * nv_eff
                    if m_cnt > 0:
                        ex_tot += 22.0 * float(min(m_cnt, 12))
                    ex_tot += bp_s
                    if ij:
                        # Dedicated hinge/clip joint mate bonus (open hinge mating to open hinge)
                        ex_tot += 120.0
                    elif not upright:
                        ex_tot -= 15.0
                    exact_ranked.append((ex_tot, world, ss, upright, ij))
                exact_ranked.sort(key=lambda x: -x[0])
                kept = exact_ranked[:per_copy]
            else:
                kept = cand_valid[:per_copy]

            for j, (total, world, ss, _u, _ij) in enumerate(kept):
                nxt = kept[j + 1][0] if j + 1 < len(kept) else total - 100.0
                for s in ss:
                    s.margin = (total - nxt) if j == 0 else (total - kept[0][0])
                # When scorer is active, `total` is already the exact cumulative joint ModelScorer score!
                st_tot = total if scorer is not None else (st.total + total)
                expanded.append(State(st.placed + world, st.scores + ss, st_tot))
        if not expanded:
            return []
        expanded.sort(key=lambda s: -s.total)
        unique, seen = [], set()
        for st in expanded:
            key = frozenset((p, c, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 2))) for p, c, m in st.placed)
            if key not in seen:
                seen.add(key)
                unique.append(st)
            if len(unique) >= beam:
                break
        states = unique
    return states
