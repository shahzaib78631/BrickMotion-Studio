"""Register a known model to a step picture: camera angles, scale and pixel offset.

`viewfit.fit_view` finds the cube orientation and approximate (yaw, pitch) from bounding-box
normalised silhouettes. Placing parts needs pixel registration, so here the model's colour-label
render is slid over the picture's colour classes (template matching) at scales around the booklet
scale prior, then yaw/pitch are refined locally. Score per rendered pixel: +1 when the picture shows
the part's colour there, -1 when it shows background, 0 otherwise (outline, arrow, or a new part
drawn in front of the model).
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .picture import BACKGROUND, Picture
from .render import View, bounds, render

PAD = 6


@dataclass
class Registration:
    view: View
    score: float          # matched minus contradicted pixels, over rendered pixels
    shape: tuple[int, int]
    orientation_index: int | None = None


EDGE_WEIGHT = 1.0


def _class_planes(classes: np.ndarray, n: int, margin: int, on_ink: np.ndarray | None):
    padded = np.pad(classes, margin, constant_values=BACKGROUND)
    planes = [(padded == k).astype(np.float32) for k in range(n)]
    ink = None
    if on_ink is not None:
        ink = np.pad(on_ink.astype(np.float32) * 2.0 - 1.0, margin, constant_values=-1.0)
    return planes, (padded == BACKGROUND).astype(np.float32), ink


def _render_template(lib, parts, colour_index, view: View, edges: bool = False):
    lo, hi = bounds(lib, parts, view)
    w, h = int(np.ceil(hi[0] - lo[0])) + 2 * PAD, int(np.ceil(hi[1] - lo[1])) + 2 * PAD
    local = view.replace(offset=(view.offset[0] - lo[0] + PAD, view.offset[1] - lo[1] + PAD))
    depth, label = render(lib, parts, local, (h, w))
    colour_of = np.array([colour_index[c] for _p, c, _m in parts] + [-1])
    edge = None
    if edges:
        from .edges import part_edges, sample_segments, visible_points
        pts = []
        for p, _c, m in parts:
            e = part_edges(lib, p)
            if len(e):
                world = e.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
                pts.append(sample_segments(local.project(world).reshape(-1, 2, 3)))
        edge = np.zeros((h, w), np.float32)
        if pts:
            vis = visible_points(np.concatenate(pts), depth)
            if len(vis):
                edge[vis[:, 0], vis[:, 1]] = 1.0
    return colour_of[label], (lo[0] - PAD, lo[1] - PAD), edge


def _match(template, planes, bg, n, edge=None, ink=None, edge_weight: float = EDGE_WEIGHT):
    """Best (score, (x, y)) of the template over the padded picture: colour agreement per rendered
    pixel plus, when given, edge agreement per rendered edge pixel (+1 on ink, -1 off)."""
    total = None
    for k in range(n):
        t = (template == k).astype(np.float32)
        if not t.any():
            continue
        r = cv2.matchTemplate(planes[k], t, cv2.TM_CCORR)
        total = r if total is None else total + r
    anyt = (template >= 0).astype(np.float32)
    r = cv2.matchTemplate(bg, anyt, cv2.TM_CCORR)
    total = -r if total is None else total - r
    total = total / max(1.0, float(anyt.sum()))
    if edge is not None and ink is not None and edge.any():
        total = total + edge_weight * cv2.matchTemplate(ink, edge, cv2.TM_CCORR) / float(edge.sum())
    _min, best, _minloc, loc = cv2.minMaxLoc(total)
    return best, loc


class Aligner:
    """Template matching of a model's colour-label (and edge) render against picture classes (and
    ink) at a resolution factor (1 = working resolution); views are expressed at working resolution."""

    def __init__(self, lib, parts, classes: np.ndarray, codes: list[int], factor: float = 1.0,
                 on_ink: np.ndarray | None = None):
        self.lib, self.parts, self.factor = lib, parts, factor
        self.colour_index = {c: i for i, c in enumerate(codes)}
        self.n = len(codes)
        if factor != 1.0:
            size = (max(1, round(classes.shape[1] * factor)), max(1, round(classes.shape[0] * factor)))
            classes = cv2.resize(classes.astype(np.int16), size, interpolation=cv2.INTER_NEAREST).astype(int)
            if on_ink is not None:
                on_ink = cv2.resize(on_ink.astype(np.float32), size, interpolation=cv2.INTER_AREA) > 0.2
        self.classes, self.on_ink = classes, on_ink
        self._planes: dict = {}

    def planes(self, margin: int):
        if margin not in self._planes:
            self._planes = {margin: _class_planes(self.classes, self.n, margin, self.on_ink)}
        return self._planes[margin]

    def evaluate(self, view: View) -> tuple[float, View]:
        f = self.factor
        scaled = view.replace(scale=view.scale * f, offset=(view.offset[0] * f, view.offset[1] * f))
        template, corner, edge = _render_template(self.lib, self.parts, self.colour_index, scaled, edges=self.on_ink is not None)
        shape = self.classes.shape
        margin = int(0.3 * max(template.shape)) + 8 + max(0, max(template.shape) - min(shape))
        margin = int(np.ceil(margin / 16) * 16)
        planes, bg, ink = self.planes(margin)
        if template.shape[0] >= planes[0].shape[0] or template.shape[1] >= planes[0].shape[1]:
            return -1.0, view
        value, (x, y) = _match(template, planes, bg, self.n, edge, ink)
        ox = scaled.offset[0] + (x - margin) - corner[0]
        oy = scaled.offset[1] + (y - margin) - corner[1]
        return value, view.replace(offset=(ox / f, oy / f))


def register(lib, parts, picture: Picture, codes: list[int], orientation, yaw: float, pitch: float,
             scale: float, scale_range=np.linspace(0.9, 1.1, 7), angle_steps=((4.0, 0.0), (-4.0, 0.0), (0.0, 4.0), (0.0, -4.0)),
             classes: np.ndarray | None = None, on_ink: np.ndarray | None = None) -> Registration:
    """Local registration around (orientation, yaw, pitch, scale)."""
    classes = picture.classes(codes) if classes is None else classes
    aligner = Aligner(lib, parts, classes, codes, on_ink=on_ink)
    base = View(np.asarray(orientation, float), yaw, pitch, scale, (0.0, 0.0))
    best = (-np.inf, base)
    for f in scale_range:
        value, view = aligner.evaluate(base.replace(scale=scale * f))
        if value > best[0]:
            best = (value, view)
    for _round in range(2):
        centre = best[1]
        for dy, dp in angle_steps:
            value, view = aligner.evaluate(centre.replace(yaw=centre.yaw + dy / (1 + _round), pitch=centre.pitch + dp / (1 + _round)))
            if value > best[0]:
                best = (value, view)
    centre = best[1]
    for f in (0.98, 1.02):
        value, view = aligner.evaluate(centre.replace(scale=centre.scale * f))
        if value > best[0]:
            best = (value, view)
    return Registration(best[1], float(best[0]), classes.shape)


COARSE_YAWS = (5, 20, 35, 50, 65, 80)
COARSE_PITCHES = (20, 30, 40, 50, 60)


def search(lib, parts, picture: Picture, codes: list[int], orientations: list[int], scale: float,
           classes: np.ndarray | None = None, refine: int = 3, on_ink: np.ndarray | None = None) -> list[Registration]:
    """Coarse registration over orientations x a yaw/pitch grid at half resolution, then local
    refinement of the `refine` best. Returns refined registrations, best first."""
    from ..viewfit import ORIENTATIONS

    classes = picture.classes(codes) if classes is None else classes
    coarse = Aligner(lib, parts, classes, codes, factor=0.5, on_ink=on_ink)
    found = []
    for oi in orientations:
        for yaw in COARSE_YAWS:
            for pitch in COARSE_PITCHES:
                value, view = coarse.evaluate(View(ORIENTATIONS[oi], yaw, pitch, scale, (0.0, 0.0)))
                found.append((value, oi, yaw, pitch))
    found.sort(key=lambda r: -r[0])
    out, seen = [], set()
    for value, oi, yaw, pitch in found:
        if len(out) >= refine:
            break
        key = (oi, yaw, pitch)
        if key in seen:
            continue
        seen.add(key)
        reg = register(lib, parts, picture, codes, ORIENTATIONS[oi], yaw, pitch, scale, classes=classes, on_ink=on_ink,
                       angle_steps=((5.0, 0.0), (-5.0, 0.0), (0.0, 5.0), (0.0, -5.0)))
        reg.orientation_index = oi
        out.append(reg)
    out.sort(key=lambda r: -r.score)
    return out


def rank_views(lib, parts, rgb: np.ndarray, pts_per_px: float | None, scale_prior: float | None,
               top: int = 6, size: int = 80, scale_tol: float = 0.10) -> list[tuple[float, int, float, float]]:
    """Best hull-silhouette IoU per cube orientation over the booklet camera grid (as viewfit.fit_view,
    which keeps only the overall best): [(iou, orientation index, yaw, pitch)], best first."""
    from brickheadz.instruction_place import iou

    from ..camera_fit import _clouds, normalise, silhouette
    from ..stepimage import model_components
    from ..viewfit import ORIENTATIONS, PITCHES, YAWS, _ldu_extent

    clouds = _clouds(lib, parts)
    components = model_components(rgb)
    if not clouds or not components:
        return []
    targets = [normalise(c, size) for c in components]
    extents = []
    for c in components:
        ys, xs = np.where(c)
        extents.append(float(max(np.ptp(xs), np.ptp(ys))))
    constrained = bool(pts_per_px and scale_prior)
    out = []
    for oi, R in enumerate(ORIENTATIONS):
        rotated = [c @ R.T for c in clouds]
        allp = np.concatenate(rotated)
        best = (-1.0, 0.0, 0.0)
        for yaw in YAWS:
            for pitch in PITCHES:
                mask = normalise(silhouette(rotated, yaw, pitch, size), size)
                ldu = _ldu_extent(allp, yaw, pitch)
                for k, t in enumerate(targets):
                    if constrained and abs(extents[k] * pts_per_px / ldu - scale_prior) > scale_tol * scale_prior:
                        continue
                    value = iou(mask, t)
                    if value > best[0]:
                        best = (value, yaw, pitch)
        if best[0] >= 0:
            out.append((best[0], oi, best[1], best[2]))
    out.sort(key=lambda r: -r[0])
    # identical silhouettes (symmetric models) tie: keep them all within the top list
    return out[:top]
