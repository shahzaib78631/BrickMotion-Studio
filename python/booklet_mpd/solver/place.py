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

from dataclasses import dataclass, field

import cv2
import numpy as np

from .edges import DEPTH_TOL, NEAR_INK, part_edges, sample_segments, visible_points
from .picture import BACKGROUND, UNKNOWN
from .render import View, mesh, rasterize, render, world_triangles

DELTAS = (0.0, 16.0, 32.0, 48.0, 64.0, 80.0, 96.0, 120.0, 150.0)
FLOAT_PENALTY = 0.02     # per LDU of displacement, in pixels: prefer seated when equal
EDGE_WEIGHT = 1.0


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
        return cls(view, classes, codes, depth, colour_of[label], ink_dist <= NEAR_INK, edge_depth, ink_dist < 0.5, band)

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


def score_candidates(lib, scene: Scene, part: str, colour: int, cands: list[dict], deltas=DELTAS,
                     edge_weight: float = EDGE_WEIGHT) -> list[Scored]:
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
                    best = (value, delta, sign, c, e, changed)
        out.append(Scored(best[0], best[1], best[2], cand, best[3], best[4], seated, best[5]))
    return out


@dataclass
class State:
    placed: list = field(default_factory=list)        # [(part, colour, matrix)]
    scores: list = field(default_factory=list)        # per placed part: Scored
    total: float = 0.0


def _boxes_overlap(lib, a, b, shrink: float = 2.0) -> bool:
    pa = world_triangles(lib, a[0], a[2]).reshape(-1, 3)
    pb = world_triangles(lib, b[0], b[2]).reshape(-1, 3)
    if not len(pa) or not len(pb):
        return False
    lo = np.maximum(pa.min(0), pb.min(0)) + shrink
    hi = np.minimum(pa.max(0), pb.max(0)) - shrink
    return bool(np.all(hi > lo))


def _size(lib, part: str) -> float:
    t = mesh(lib, part)
    return float(np.ptp(t.reshape(-1, 3), axis=0).prod()) if len(t) else 0.0


def drawn_pose(sc: "Scored") -> np.ndarray:
    """Where the picture shows the part: its pose moved by the chosen floating displacement."""
    m = np.array(sc.candidate["matrix"], float)
    m[:3, 3] = m[:3, 3] + sc.axis_sign * sc.delta * approach_axis(sc.candidate)
    return m


def solve_step(lib, scene_for, base: list, parts: list[tuple[str, int]], candidate_fn, collides=None,
               beam: int = 6, per_part: int = 12, deltas=DELTAS) -> list[State]:
    """Joint placement of a step's parts. `scene_for(model)` renders a Scene for a model state;
    `candidate_fn(part, model)` enumerates candidate dicts; `collides(part, matrix, model)` (optional)
    is the exact collision test. Returns final states, best first; each Scored carries the margin to the
    next-best distinct pose of that part in its state."""
    order = sorted(range(len(parts)), key=lambda i: -_size(lib, parts[i][0]))
    states = [State()]
    for i in order:
        part, colour = parts[i]
        expanded = []
        for st in states:
            model = base + st.placed
            drawn = base + [(p, c, drawn_pose(sc)) for (p, c, _m), sc in zip(st.placed, st.scores)]
            scene = scene_for(drawn)
            cands = candidate_fn(part, model)
            if not cands:
                continue
            scored = score_candidates(lib, scene, part, colour, cands, deltas=deltas)
            scored.sort(key=lambda s: -s.score)
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
                expanded.append(State(st.placed + [entry], st.scores + [sc], st.total + sc.score))
        if not expanded:
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
