"""Place a step's new parts on the model by render-and-compare against the step picture.

For one registered view, the model so far is rendered once (depth, colour class and visible edge
lines). A candidate pose of a new part changes exactly the pixels where its sprite is nearer than the
model. Its evidence has two terms:
  colour  #(changed pixels whose picture class is the part's colour)
          - #(changed pixels whose picture class was explained by the model before)
          - #(sprite pixels off the picture);
  edges   in the same changed pixels, how much better the part's own line drawing explains the
          picture's ink than the model's line drawing there did (2 per ink pixel on an edge band,
          -1 per edge pixel with no ink nearby).
Pixels the picture leaves unclassified (outlines, arrows) are colour-neutral. Booklets draw new parts
either seated or floating above their place (the picture shows the model before the step), so each
candidate is also tried displaced along its approach axis; the best displacement wins.

A step's parts are placed jointly by beam search (each state re-renders the model with the parts
already placed in it), so two new parts cannot claim the same pixels or the same studs.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

import cv2
import numpy as np

from .edges import DEPTH_TOL, NEAR_INK, part_edges, sample_segments, visible_points
from .picture import BACKGROUND, UNKNOWN
from .render import View, mesh, rasterize, render, world_triangles

DELTAS = (0.0, 16.0, 32.0, 48.0, 64.0, 80.0, 96.0, 120.0, 150.0)
FILL = os.environ.get("BOOKLET_SOLVER_FILL", "1") != "0"   # floating parts over a gap the step fills (_filled_stacks)
FILL_DEPTH = 3
FILL_BUDGET = 40     # _fills calls per floating pose
MISMATCH = os.environ.get("BOOKLET_SOLVER_MISMATCH", "0") != "0"   # penalise covering another colour
PUSH_STEPS = (0.75, 1.0, 1.25, 1.5, 2.0, 2.5)   # displacement along an arrow, in arrow lengths
FLOAT_PENALTY = 0.02     # per LDU of displacement, in pixels: prefer seated when equal
DEDUPE = os.environ.get("BOOKLET_SOLVER_DEDUPE", "1") != "0"     # one pose per distinct geometry in the beam
ORDER = os.environ.get("BOOKLET_SOLVER_ORDER", "evidence")
COMPARE_TOP = 6          # candidates the learned comparator re-ranks per part (comparator.py)       # "evidence": best-shown part type first; "size": largest first
EDGE_WEIGHT = float(os.environ.get("BOOKLET_SOLVER_EDGE_WEIGHT", "1.0"))   # placement only; registration keeps its own


@dataclass
class Scene:
    """The model so far rendered under a registered view, compared with the picture."""
    view: View
    classes: np.ndarray            # picture class per pixel (colour index, BACKGROUND, UNKNOWN)
    codes: list[int]
    depth: np.ndarray
    colour: np.ndarray             # rendered colour index per pixel, BACKGROUND where empty
    on_ink: np.ndarray             # bool: picture ink within NEAR_INK px
    edge_depth: np.ndarray         # depth of the model's visible edge at a pixel, inf where none
    ink: np.ndarray = None         # bool: picture ink pixels
    edge_band: np.ndarray = None   # bool: model edge dilated by one pixel
    parts: list = None             # the model drawn (for the learned comparator)
    picture: object = None         # the Picture (for the learned comparator); set by the caller

    @classmethod
    def build(cls, lib, parts, view: View, classes: np.ndarray, codes: list[int], ink_dist: np.ndarray) -> "Scene":
        depth, label = render(lib, parts, view, classes.shape)
        index = {c: i for i, c in enumerate(codes)}
        colour_of = np.array([index.get(c, UNKNOWN) for _p, c, _m in parts] + [BACKGROUND])
        edge_depth = np.full(classes.shape, np.inf)
        pts = []
        for p, _c, m in parts:
            e = part_edges(lib, p)
            if len(e):
                w = e.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
                pts.append(sample_segments(view.project(w).reshape(-1, 2, 3)))
        if pts:
            allp = np.concatenate(pts)
            vis = visible_points(allp, depth)
            if len(vis):
                edge_depth[vis[:, 0], vis[:, 1]] = depth[vis[:, 0], vis[:, 1]]
        e = np.isfinite(edge_depth)
        band = cv2.dilate(e.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        return cls(view, classes, codes, depth, colour_of[label], ink_dist <= NEAR_INK, edge_depth, ink_dist < 0.5, band,
                   list(parts))

    def edge_precision(self) -> float:
        e = np.isfinite(self.edge_depth)
        return float(self.on_ink[e].mean()) if e.any() else 0.0


@dataclass
class PartSprite:
    """One part at one rotation, rasterised once with its origin at screen (0, 0), depth 0."""
    mask: np.ndarray
    depth: np.ndarray
    corner: tuple[int, int]               # (u, v) of mask[0, 0] relative to the projected origin
    edges: np.ndarray                     # (N, 3) self-visible edge points (u, v, depth), origin-relative
    edge_img: np.ndarray = None           # bool, sprite frame: self-visible edge pixels
    edge_band: np.ndarray = None          # bool, sprite frame: edge pixels dilated by one

    def place(self, view: View, translation: np.ndarray):
        du, dv, dd = view.shift(translation)
        u = view.offset[0] + du
        v = view.offset[1] + dv
        return int(round(v)) + self.corner[1], int(round(u)) + self.corner[0], dd, (u, v)


_SPRITES: dict = {}


def part_sprite(lib, part: str, rot: np.ndarray, view: View, pad: int = 1) -> PartSprite:
    key = (id(lib), part, tuple(np.round(rot, 4).ravel()), tuple(np.round(view.matrix, 6).ravel()), round(view.scale, 6))
    if key in _SPRITES:
        return _SPRITES[key]
    if len(_SPRITES) > 4000:
        _SPRITES.clear()
    m = np.eye(4)
    m[:3, :3] = rot
    t = world_triangles(lib, part, m)
    local_view = view.replace(offset=(0.0, 0.0))
    if not len(t):
        out = PartSprite(np.zeros((0, 0), bool), np.zeros((0, 0)), (0, 0), np.zeros((0, 3)), np.zeros((0, 0), bool), np.zeros((0, 0), bool))
    else:
        local = local_view.project(t.reshape(-1, 3)).reshape(-1, 3, 3)
        lo = np.floor(local[:, :, :2].reshape(-1, 2).min(0)).astype(int) - pad
        hi = np.ceil(local[:, :, :2].reshape(-1, 2).max(0)).astype(int) + pad
        local[:, :, 0] -= lo[0]
        local[:, :, 1] -= lo[1]
        depth, label = rasterize(local, np.zeros(len(local), np.int64), (int(hi[1] - lo[1] + 1), int(hi[0] - lo[0] + 1)))
        e = part_edges(lib, part)
        pts = np.zeros((0, 3))
        if len(e):
            w = e.reshape(-1, 3) @ rot.T
            pts = sample_segments(local_view.project(w).reshape(-1, 2, 3))
            shifted = pts.copy()
            shifted[:, 0] -= lo[0]
            shifted[:, 1] -= lo[1]
            vis = np.round(shifted[:, :2]).astype(int)
            hh, ww = depth.shape
            ok = (vis[:, 0] >= 0) & (vis[:, 0] < ww) & (vis[:, 1] >= 0) & (vis[:, 1] < hh)
            pts, vis, shifted = pts[ok], vis[ok], shifted[ok]
            keep = shifted[:, 2] <= depth[vis[:, 1], vis[:, 0]] + DEPTH_TOL
            pts = pts[keep]
            vis = vis[keep]
        img = np.zeros(depth.shape, bool)
        if len(e):
            img[vis[:, 1], vis[:, 0]] = True
        band = cv2.dilate(img.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        out = PartSprite(label >= 0, depth, (int(lo[0]), int(lo[1])), pts, img, band)
    _SPRITES[key] = out
    return out


def gain(scene: Scene, sp: PartSprite, row0: int, col0: int, dd: float, origin, colour_index: int) -> tuple[float, float, int]:
    """(colour gain, edge gain, changed pixels) of drawing the sprite at (row0, col0), depth offset dd."""
    h, w = sp.mask.shape
    H, W = scene.classes.shape
    r0, c0 = max(row0, 0), max(col0, 0)
    r1, c1 = min(row0 + h, H), min(col0 + w, W)
    total = int(sp.mask.sum())
    if r1 <= r0 or c1 <= c0:
        return -float(total), 0.0, total
    m = sp.mask[r0 - row0:r1 - row0, c0 - col0:c1 - col0]
    outside = total - int(m.sum())
    d = sp.depth[r0 - row0:r1 - row0, c0 - col0:c1 - col0] + dd
    changed = m & (d < scene.depth[r0:r1, c0:c1])
    pic = scene.classes[r0:r1, c0:c1][changed]
    old = scene.colour[r0:r1, c0:c1][changed]
    colour = float(np.count_nonzero(pic == colour_index)) - float(np.count_nonzero((pic == old) & (pic != UNKNOWN))) - outside
    if MISMATCH:
        # drawn over pixels the picture shows in another part colour the model does not explain: they
        # belong to another part (a black plate over the gold pair beside it)
        colour -= float(np.count_nonzero((pic >= 0) & (pic != colour_index) & (pic != old)))
    # edges: in the changed region, which line drawing explains the picture's ink better, the part's
    # own edges (after) or the model's (before)? agreement = 2*#(ink on the edge band) - #(edge pixels
    # with no ink nearby); the constant -#ink cancels in the difference
    ink = scene.ink[r0:r1, c0:c1][changed]
    near = scene.on_ink[r0:r1, c0:c1][changed]
    sb = sp.edge_band[r0 - row0:r1 - row0, c0 - col0:c1 - col0][changed]
    se = sp.edge_img[r0 - row0:r1 - row0, c0 - col0:c1 - col0][changed]
    bb = scene.edge_band[r0:r1, c0:c1][changed]
    be = np.isfinite(scene.edge_depth[r0:r1, c0:c1][changed])
    after = 2 * np.count_nonzero(ink & sb) - np.count_nonzero(se & ~near)
    before = 2 * np.count_nonzero(ink & bb) - np.count_nonzero(be & ~near)
    edge = float(after - before)
    return colour, edge, int(changed.sum()) + outside


def approach_axis(candidate: dict) -> np.ndarray:
    """Unit direction a part travels from to reach this pose: the host connector's outward axis when
    known, otherwise LDraw up (-y)."""
    axis = candidate.get("axis")
    if axis is not None:
        a = np.asarray(axis, float)
        return a / (np.linalg.norm(a) or 1.0)
    return np.array([0.0, -1.0, 0.0])


@dataclass
class Scored:
    score: float
    delta: float
    axis_sign: float
    candidate: dict
    colour: float = 0.0
    edge: float = 0.0
    seated: float = 0.0
    changed: int = 0
    margin: float = 0.0
    move: object = None          # world displacement of the drawn pose from the seat, when not along the axis


def score_candidates(lib, scene: Scene, part: str, colour: int, cands: list[dict], deltas=DELTAS,
                     edge_weight: float = EDGE_WEIGHT, pushes=()) -> list[Scored]:
    """`pushes`: arrow axes (unit image direction, length in pixels). Booklets often draw a part
    exploded along its arrow rather than along its approach axis (a plate drawn below and in front of
    the underside it goes on), so each candidate is also tried shifted along each arrow, both ways."""
    cidx = scene.codes.index(colour) if colour in scene.codes else UNKNOWN
    out = []
    for cand in cands:
        m = cand["matrix"]
        sp = part_sprite(lib, part, m[:3, :3], scene.view)
        if not sp.mask.size:
            out.append(Scored(-np.inf, 0.0, 1.0, cand))
            continue
        axis = approach_axis(cand)
        best = None
        seated = 0.0
        for sign in ((1.0, -1.0) if cand.get("axis") is None or cand.get("bidirectional") else (1.0,)):
            for delta in deltas:
                if delta == 0 and sign < 0:
                    continue
                row0, col0, dd, origin = sp.place(scene.view, m[:3, 3] + sign * delta * axis)
                c, e, changed = gain(scene, sp, row0, col0, dd, origin, cidx)
                value = c + edge_weight * e - FLOAT_PENALTY * delta
                if delta == 0:
                    seated = value
                if best is None or value > best[0]:
                    best = (value, delta, sign, c, e, changed, None)
        if pushes:
            row0, col0, dd, origin = sp.place(scene.view, m[:3, 3])
            back = scene.view.matrix.T
            for d, length in pushes:
                for k in PUSH_STEPS:
                    for sign in (1.0, -1.0):
                        du, dv = sign * k * length * d[0], sign * k * length * d[1]
                        c, e, changed = gain(scene, sp, row0 + int(round(dv)), col0 + int(round(du)), dd, origin, cidx)
                        ldu = k * length / max(scene.view.scale, 1e-6)
                        value = c + edge_weight * e - FLOAT_PENALTY * ldu
                        if value > best[0]:
                            move = back @ np.array([du / scene.view.scale, dv / scene.view.scale, 0.0])
                            best = (value, ldu, 1.0, c, e, changed, move)
        # a prior from elsewhere (a sub-build panel showing which way this part faces): a share of the score
        value = best[0] + float(cand.get("prior", 0.0)) * abs(best[0])
        out.append(Scored(value, best[1], best[2], cand, best[3], best[4], seated, best[5], move=best[6]))
    return out


@dataclass
class State:
    placed: list = field(default_factory=list)        # [(part, colour, matrix)]
    scores: list = field(default_factory=list)        # per placed part: Scored
    total: float = 0.0
    done: frozenset = frozenset()                     # indices into the step's parts already placed


def _boxes_overlap(lib, a, b, shrink: float = 2.0) -> bool:
    pa = world_triangles(lib, a[0], a[2]).reshape(-1, 3)
    pb = world_triangles(lib, b[0], b[2]).reshape(-1, 3)
    if not len(pa) or not len(pb):
        return False
    lo = np.maximum(pa.min(0), pb.min(0)) + shrink
    hi = np.minimum(pa.max(0), pb.max(0)) - shrink
    return bool(np.all(hi > lo))


def _same_spot(a: np.ndarray, b: np.ndarray, tol: float = 0.6) -> bool:
    # plain comparisons: called millions of times per step (np.allclose was half a step's time)
    return abs(a[0][3] - b[0][3]) <= tol and abs(a[1][3] - b[1][3]) <= tol and abs(a[2][3] - b[2][3]) <= tol


_SHAPES: dict = {}


def _shape(lib, part: str, rotation: np.ndarray) -> tuple[int, np.ndarray]:
    """(hash of the part's vertex set turned by `rotation`, its lowest corner): equal for turns that give
    the same geometry (a 1 x 1 plate's four quarter turns)."""
    key = (id(lib), part, tuple(np.round(rotation, 3).ravel()))
    if key not in _SHAPES:
        v = mesh(lib, part).reshape(-1, 3) @ np.asarray(rotation, float).T
        lo = v.min(0)
        _SHAPES[key] = (hash(np.unique(np.round(v - lo, 1), axis=0).tobytes()), lo)
    return _SHAPES[key]


def distinct(lib, part: str, cands: list[dict]) -> list[dict]:
    """Candidates with geometric duplicates dropped (first kept). Otherwise the turns of a symmetric part
    fill the beam with one placement and report a zero margin for it. Only the scored list is deduped:
    hole-stack filling (_fills) matches candidates by host connector and needs every one."""
    seen, out = set(), []
    # a twin carrying a facing prior is kept over one without
    for c in sorted(cands, key=lambda c: -float(c.get("prior", 0.0))):
        m = np.asarray(c["matrix"], float)
        h, lo = _shape(lib, part, m[:3, :3])
        key = (h, tuple(np.round((m[:3, 3] + lo) * 2).astype(int)), c.get("axis") is None)
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def compare(lib, scene: Scene, part: str, colour: int, scored: list) -> None:
    """Adds the learned comparator's view to the best few candidates' scores, in place: score +=
    w * spread * logit, spread being the gains' spread over those candidates (comparator-weight.txt, chosen
    on validation booklets). No-op when the comparator is off, untrained, or the scene has no picture."""
    if scene.picture is None:
        return
    from .comparator import loaded, weight
    model, w = loaded(), weight()
    if model is None or w <= 0:
        return
    top = sorted((s for s in scored if np.isfinite(s.score)), key=lambda s: -s.score)[:COMPARE_TOP]
    if len(top) < 2:
        return
    from .comparator import patch
    pats = [patch(lib, scene.picture.rgb, scene.picture.background, scene.view, scene.parts, part, colour,
                  drawn_pose(s)) for s in top]
    keep = [(s, x) for s, x in zip(top, pats) if x is not None]
    if len(keep) < 2:
        return
    logits = model.logits([x for _s, x in keep])
    spread = float(np.std([s.score for s, _x in keep])) or 1.0
    for (s, _x), lg in zip(keep, logits):
        s.score += w * spread * float(lg)


def _evidence_order(lib, scene, base: list, parts: list, candidate_fn, deltas) -> list[int]:
    """Part indices, the part type the picture shows best (highest first-placement gain) first. Largest
    first lets a big plate take the studs a smaller, clearly drawn part sits on."""
    best = {}
    for p, c in set(parts):
        cands = candidate_fn(p, base)
        scored = score_candidates(lib, scene, p, c, cands, deltas=deltas) if cands else []
        best[(p, c)] = max((s.score for s in scored), default=-1e9)
    return sorted(range(len(parts)), key=lambda i: (-best[parts[i]], -_size(lib, parts[i][0])))


def _fills(lib, model: list, seat: dict | None, target: np.ndarray, top: int, pool: list[int], parts, candidate_fn,
           line: tuple, budget: list, depth: int = FILL_DEPTH, base_cands: dict | None = None) -> list | None:
    """Parts from `pool` stacked from `seat` (a pose on the model) up to where part `top` sits at `target`:
    the first goes on the model at the seat, each next on the one below, and `top` on the last. Returns
    the stack [(index, entry)] or None. `seat` is the top part's candidate: the stack starts on its stud.
    Only parts between the seat and the target along the approach axis, under the target, are tried
    (`line` = (seat origin, axis, height)); `budget` bounds the calls."""
    if depth <= 0 or budget[0] <= 0:
        return None
    budget[0] -= 1
    origin, axis, height = line
    seen = set()
    tp, _tc = parts[top]
    for k in pool:
        part, colour = parts[k]
        if (part, colour) in seen:
            continue
        seen.add((part, colour))
        if seat is not None:
            listed = base_cands[part] if base_cands is not None and part in base_cands else candidate_fn(part, model)
            opts = [c["matrix"] for c in listed
                    if c.get("host") == seat.get("host") and c.get("host_conn") == seat.get("host_conn")]
        else:
            opts = [c["matrix"] for c in candidate_fn(part, model[-1:]) if c.get("host") == 0]
        done = set()
        for m in opts:
            key = tuple(np.round(np.asarray(m)[:3, :4], 2).ravel())
            if key in done:
                continue
            done.add(key)
            h = float(np.dot(np.asarray(m)[:3, 3] - origin, axis))
            if h < -0.6 or h > height + 0.6:
                continue
            entry = (part, colour, m)
            pts = world_triangles(lib, part, m).reshape(-1, 3)
            lateral = np.ones(3, bool)
            lateral[int(np.argmax(np.abs(axis)))] = False
            if len(pts) and not np.all((pts.min(0) - 1 <= target[:3, 3]) [lateral] & (target[:3, 3] <= pts.max(0) + 1)[lateral]):
                continue
            if any(_boxes_overlap(lib, entry, other) for other in model[-1:]):
                continue
            # does the top part go on this one, exactly where it is drawn?
            if any(_same_spot(c["matrix"], target) and np.allclose(c["matrix"][:3, :3], target[:3, :3], atol=1e-3)
                   for c in candidate_fn(tp, [entry]) if c.get("host") == 0):
                return [(k, entry)]
            rest = [j for j in pool if j != k]
            if rest:
                up = _fills(lib, model + [entry], None, target, top, rest, parts, candidate_fn, line, budget, depth - 1)
                if up:
                    return [(k, entry)] + up
    return None


def _filled_stacks(lib, scene, base, parts, candidate_fn, collides, order, per_part: int = 3) -> list[State]:
    """Start states for a step whose picture shows a part floating over a gap the step's other parts
    fill: a 1 x 1 brick and a round plate sunk in a hole, the plate that shows sitting on them. Each
    part's best floating poses (scored with displacement even when the picture has no arrows) are
    tried; when the other parts stack from the seat to exactly the drawn pose, the stack with the top
    part seated there is one move."""
    out = []
    listed = {p: candidate_fn(p, base) for p in {parts[k][0] for k in order}}
    memo: dict = {}
    raw_fn = candidate_fn

    def candidate_fn(part, model):       # noqa: F811 - the same, remembered for one-part hosts
        if len(model) != 1:
            return raw_fn(part, model)
        key = (part, model[0][0], tuple(np.round(np.asarray(model[0][2])[:3, :4], 2).ravel()))
        if key not in memo:
            memo[key] = raw_fn(part, model)
        return memo[key]

    tried = set()
    for top in order:
        part, colour = parts[top]
        if (part, colour) in tried:      # identical parts: the same stacks
            continue
        tried.add((part, colour))
        cands = listed[part]
        scored = score_candidates(lib, scene, part, colour, cands, deltas=DELTAS)
        # only where the picture shows the part better floating than anywhere it can sit
        seated_best = max((sc.seated for sc in scored), default=0.0)
        floating = [sc for sc in scored if sc.delta > 0 and sc.move is None and sc.score > max(0.0, seated_best)]
        floating.sort(key=lambda sc: -sc.score)
        for sc in floating[:per_part]:
            seat = sc.candidate
            target = drawn_pose(sc)
            pool = [k for k in order if k != top]
            axis = approach_axis(seat) * sc.axis_sign
            origin = np.asarray(seat["matrix"], float)[:3, 3]
            line = (origin, axis, float(np.dot(target[:3, 3] - origin, axis)))
            stack = _fills(lib, base, seat, target, top, pool, parts, candidate_fn, line, [FILL_BUDGET], base_cands=listed)
            if not stack:
                continue
            entries = [e for _k, e in stack] + [(part, colour, target)]
            if collides is not None and any(collides(p, m, base) for p, _c, m in entries):
                continue
            seated = Scored(sc.score + FLOAT_PENALTY * sc.delta, 0.0, 1.0, {**sc.candidate, "matrix": target},
                            sc.colour, sc.edge, sc.score, sc.changed)
            fill = [Scored(0.0, 0.0, 1.0, {"matrix": e[2]}) for _k, e in stack]
            out.append(State(entries, fill + [seated], seated.score, frozenset([k for k, _e in stack] + [top])))
    return out


def _size(lib, part: str) -> float:
    t = mesh(lib, part)
    return float(np.ptp(t.reshape(-1, 3), axis=0).prod()) if len(t) else 0.0


def drawn_pose(sc: "Scored") -> np.ndarray:
    """Where the picture shows the part: its pose moved by the chosen floating displacement."""
    m = np.array(sc.candidate["matrix"], float)
    if sc.move is not None:
        m[:3, 3] = m[:3, 3] + np.asarray(sc.move, float)
        return m
    m[:3, 3] = m[:3, 3] + sc.axis_sign * sc.delta * approach_axis(sc.candidate)
    return m


def solve_step(lib, scene_for, base: list, parts: list[tuple[str, int]], candidate_fn, collides=None,
               beam: int = 6, per_part: int = 12, deltas=DELTAS, pushes=(), fill: bool = True) -> list[State]:
    """Joint placement of a step's parts. `scene_for(model)` renders a Scene for a model state;
    `candidate_fn(part, model)` enumerates candidate dicts; `collides(part, matrix, model)` (optional)
    is the exact collision test. Returns final states, best first; each Scored carries the margin to the
    next-best distinct pose of that part in its state.

    Parts go the best-shown type first (ORDER="size": largest first). A part that is hidden wherever it goes scores alike everywhere, so a stack
    sunk in a hole (a 1 x 1 brick, a round plate, and the plate on top that shows) would be dropped
    anywhere and its top part placed on the wrong support. The top part does score where it is drawn, as
    if floating over the hole, so stacks that fill that gap start the search too (_filled_stacks)."""
    if ORDER == "evidence" and len(set(parts)) > 1:
        order = _evidence_order(lib, scene_for(base), base, parts, candidate_fn, deltas)
    else:
        order = sorted(range(len(parts)), key=lambda i: -_size(lib, parts[i][0]))
    states = [State()]
    if FILL and fill and len(parts) > 1:
        states += _filled_stacks(lib, scene_for(base), base, parts, candidate_fn, collides, order)
    while any(len(st.done) < len(parts) for st in states):
        expanded = [st for st in states if len(st.done) == len(parts)]
        advanced = False
        for st in states:
            if len(st.done) == len(parts):
                continue
            i = next(k for k in order if k not in st.done)
            part, colour = parts[i]
            model = base + st.placed
            drawn = base + [(p, c, drawn_pose(sc)) for (p, c, _m), sc in zip(st.placed, st.scores)]
            scene = scene_for(drawn)
            cands = candidate_fn(part, model)
            if DEDUPE:
                cands = distinct(lib, part, cands)
            if not cands:
                continue
            scored = score_candidates(lib, scene, part, colour, cands, deltas=deltas, pushes=pushes)
            compare(lib, scene, part, colour, scored)
            # on a tie (a hidden part scores 0 everywhere) a part goes on one added in the same step
            fresh = len(base)
            scored.sort(key=lambda s: (-s.score, 0 if (s.candidate.get("host") or -1) >= fresh else 1))
            kept = []
            for sc in scored:
                if len(kept) >= per_part:
                    break
                entry = (part, colour, sc.candidate["matrix"])
                if any(_boxes_overlap(lib, entry, other) for other in st.placed):
                    continue
                if collides is not None and collides(part, sc.candidate["matrix"], model):
                    continue
                kept.append(sc)
            for j, sc in enumerate(kept):
                nxt = kept[j + 1].score if j + 1 < len(kept) else (kept[j - 1].score if j else sc.score - 100.0)
                sc.margin = sc.score - nxt if j == 0 else sc.score - kept[0].score
                entry = (part, colour, sc.candidate["matrix"])
                expanded.append(State(st.placed + [entry], st.scores + [sc], st.total + sc.score, st.done | {i}))
                advanced = True
        if not advanced:
            return states if states[0].placed else []
        expanded.sort(key=lambda s: -s.total)
        unique, seen = [], set()
        for st in expanded:
            key = frozenset((p, c, tuple(np.round(m[:3, 3], 1)), tuple(np.round(m[:3, :3].ravel(), 2))) for p, c, m in st.placed)
            if key in seen:
                continue
            seen.add(key)
            unique.append(st)
            if len(unique) >= beam:
                break
        states = unique
    return states
