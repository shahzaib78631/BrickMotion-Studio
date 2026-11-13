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
MIN_COLOUR_PX = 20          # working pixels of a part colour (arrows aside) before the panel counts as drawing it
MIN_SHOWN = 5.0             # a unit part scoring less than this in its own panel is not drawn there: dropped
MIN_EXPLAINED = 0.6         # share of the panel's drawn pixels the solved unit must cover ...
MIN_PRECISION = 0.7         # ... and share of the unit's pixels that must land on drawn pixels; otherwise the
                            # panel is not this unit (cover art, a finished-model preview, a zoomed detail)
TIPPED = 0.15               # a tipped placement gives up this share of its score to an upright one
FACING = 0.03               # a placement facing as the panel draws it gains this share (a tie-breaker)


def unit_parts(parts: list[tuple[str, int]], picture, count: int) -> list[tuple[str, int]]:
    """The parts one copy of the panel's unit may hold: step parts whose colour the panel draws (arrow
    pixels aside), with at least `count` of them in the step (one copy gets count // N)."""
    codes = sorted({c for _p, c in parts})
    classes = picture.classes(codes)
    present = {c for k, c in enumerate(codes) if np.count_nonzero((classes == k) & ~picture.arrows) >= MIN_COLOUR_PX}
    out = []
    for (p, c), n in Counter(parts).items():
        if c in present and n >= count:
            out += [(p, c)] * (n // count)
    return out


def _turn(k: int) -> np.ndarray:
    a = np.radians(90.0 * k)
    m = np.eye(4)
    m[:3, :3] = [[np.cos(a), 0.0, np.sin(a)], [0.0, 1.0, 0.0], [-np.sin(a), 0.0, np.cos(a)]]
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


SAME_SCALES = (0.94, 1.0, 1.06)
ZOOM_SCALES = (0.8, 1.25, 1.5, 1.8, 2.2)
MIN_MATCH = 0.6


def solve_unit(lib, spec: dict, view, candidate_fn, deltas, collider=None) -> dict | None:
    """The panel solved alone under the main picture's camera angles (panels are drawn from the same
    view; a lone small part cannot fix a camera by itself). Judged by how well the whole unit's drawing
    matches the panel (both shares: a gain total or a registration score alone prefers a shrunken unit
    inside one colour). Panels are usually drawn at the main picture's scale; zoomed scales are tried only
    when that fails. Returns {"parts": [(part, colour, matrix)] in the unit's frame (base at the origin),
    "facing": the unit's rotation as the panel draws it}, or None. `collider` (exact collision): unit parts
    may not pass through one another (bricks of a stack drawn inside each other); the caller restores its
    model afterwards."""
    per_copy = spec["per_copy"]
    bases = list(dict.fromkeys(per_copy))
    view = upright(view)
    best = None
    for scales in (SAME_SCALES, ZOOM_SCALES):
        for f in scales:
            for base in bases:
                others = list(per_copy)
                others.remove(base)
                for k in range(4):
                    trial = _try(lib, spec, view, view.scale * f, base, others, k, candidate_fn, deltas, collider)
                    if trial is not None and (best is None or trial[0] > best[0] + 1e-9):
                        best = trial
        if best is not None and best[0] >= MIN_MATCH:
            break
    if best is None:
        return None
    match, unit, explained, precision = best
    spec.setdefault("checks", []).append((round(explained, 2), round(precision, 2)))
    if explained < MIN_EXPLAINED or precision < MIN_PRECISION:
        return None
    unit = [(p, c, m) for p, c, m, _d in unit]
    facing = np.asarray(unit[0][2], float)
    inv = np.linalg.inv(facing)
    return {"parts": [(p, c, inv @ np.asarray(m, float)) for p, c, m in unit], "facing": facing}


def _try(lib, spec, view, scale, base, others, k, candidate_fn, deltas, collider=None, prune: bool = True):
    """(match, unit, explained, precision) with `base` seated at one quarter turn, at one scale, or None.
    The unit's parts may not collide with one another, the base included (exact test; parts added in the
    step are also kept apart by solve_step's box test). Parts the drawing is better without
    are dropped and the rest solved again without them (a part attached to a dropped one would float)."""
    from .place import Scene, solve_step, drawn_pose
    from .register import register
    pic, classes, codes, ink, on_ink = spec["picture"], spec["classes"], spec["codes"], spec["ink"], spec["on_ink"]
    a = (base[0], base[1], _turn(k))
    reg = register(lib, [a], pic, codes, view.orientation, view.yaw, view.pitch, scale,
                   scale_range=(1.0,), angle_steps=(), classes=classes, on_ink=on_ink)

    def scene_for(model):
        return Scene.build(lib, model, reg.view, classes, codes, ink)
    unit = [(a[0], a[1], a[2], a[2])]          # (part, colour, seated pose, drawn pose)
    if others:
        # no hole stacks here: a panel draws parts pulled apart, not sunk out of sight
        overlaps = None
        if collider is not None:
            # a bounding box test would reject a plate on a headlight brick's recessed side stud
            def overlaps(part, matrix, model):
                collider.set_model(model)
                return collider.hits(part, matrix)
        states = solve_step(lib, scene_for, [a], others, candidate_fn, collides=overlaps, deltas=deltas, fill=False)
        if states:
            unit += [(p, c, m, drawn_pose(sc)) for (p, c, m), sc in zip(states[0].placed, states[0].scores)
                     if sc.score >= MIN_SHOWN]

    def measure(u):
        e, pr = _explains(lib, [(p, c, d) for p, c, _m, d in u], reg.view, pic, classes, codes)
        return 2 * e * pr / max(1e-9, e + pr), e, pr
    match, explained, precision = measure(unit)
    full = len(unit)
    improved = prune
    while improved and len(unit) > 1:          # drop parts the drawing is better without
        improved = False
        for j in range(1, len(unit)):
            trial = unit[:j] + unit[j + 1:]
            m2 = measure(trial)
            if m2[0] > match + 1e-6:
                unit, (match, explained, precision), improved = trial, m2, True
                break
    if prune and (len(unit) < full or len(unit) < len(others) + 1):
        kept = [(p, c) for p, c, _m, _d in unit[1:]]
        again = _try(lib, spec, view, scale, base, kept, k, candidate_fn, deltas, collider, prune=False)
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


def place_units(lib, scene_for, base: list, units: list[tuple[list, int]], candidate_fn, collides=None,
                set_model=None, beam: int = 4, per_copy: int = 6, deltas=(0.0,)) -> list[State]:
    """Beam over the copies of every unit. A State's placed/scores list all unit parts placed. With
    `deltas` (the main picture has arrows) a unit may be drawn moved out along the connection it seats by."""
    copies = [(u["parts"], u["facing"]) for u, n in units for _ in range(n)]
    states = [State()]
    for config, facing in copies:
        expanded = []
        for st in states:
            model = base + st.placed
            if set_model is not None:
                set_model(model)
            scene = scene_for(model)
            options: dict = {}
            for p, _c, rel in config:
                inv = np.linalg.inv(rel)
                for cand in candidate_fn(p, model):
                    t = np.asarray(cand["matrix"], float) @ inv
                    key = tuple(np.round(t[:3, :4], 1).ravel())
                    if key not in options:
                        upright = bool(np.allclose(t[:3, 1], [0.0, 1.0, 0.0], atol=1e-3))
                        faces = bool(np.allclose(t[:3, :3], facing[:3, :3], atol=1e-3))
                        options[key] = ([(q, cc, t @ r) for q, cc, r in config], cand.get("axis"), upright, faces)
            scored = []
            for world, axis, upright, faces in options.values():
                best = None
                for d in (deltas if axis is not None else (0.0,)):
                    ss = [score_candidates(lib, scene, q, cc, [{"matrix": m, "axis": axis}], deltas=(float(d),))[0]
                          for q, cc, m in world]
                    total = sum(s.score for s in ss)
                    if best is None or total > best[0]:
                        best = (total, ss)
                total = best[0]
                # drawn the way up the panel draws it is preferred (a unit tipped over and hanging by
                # another part is legal but rarely meant); facing as drawn breaks ties
                total -= (0.0 if upright else TIPPED) * abs(total)
                total += (FACING if faces else 0.0) * abs(total)
                scored.append((total, world, best[1], upright))
            scored.sort(key=lambda x: -x[0])
            kept = []
            for total, world, ss, upright in scored:
                if len(kept) >= per_copy:
                    break
                if any(_boxes_overlap(lib, w, o) for w in world for o in st.placed):
                    continue
                if collides is not None and any(collides(q, m, model) for q, _cc, m in world):
                    continue
                kept.append((total, world, ss, upright))
            for j, (total, world, ss, _u) in enumerate(kept):
                nxt = kept[j + 1][0] if j + 1 < len(kept) else total - 100.0
                for s in ss:
                    s.margin = (total - nxt) if j == 0 else (total - kept[0][0])
                expanded.append(State(st.placed + world, st.scores + ss, st.total + total))
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
