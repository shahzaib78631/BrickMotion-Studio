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
from .render import View, bounds, mesh, rasterize, render, world_triangles

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
        # Pre-transform and concatenate world geometry once so evaluate() avoids per-part Python loops
        tris, cols = [], []
        for p, c, m in parts:
            t = world_triangles(lib, p, np.asarray(m, float))
            if len(t):
                tris.append(t)
                cols.append(np.full(len(t), self.colour_index.get(c, -1), dtype=np.int64))
        self._tris = np.concatenate(tris, axis=0) if tris else np.zeros((0, 3, 3))
        self._tri_cols = np.concatenate(cols, axis=0) if cols else np.zeros(0, dtype=np.int64)
        self._verts = self._tris.reshape(-1, 3)
        self._edge_segs: np.ndarray | None = None

    def _get_edge_segs(self) -> np.ndarray:
        if self._edge_segs is None:
            from .edges import part_edges
            segs = []
            for p, _c, m in self.parts:
                e = part_edges(self.lib, p)
                if len(e):
                    m = np.asarray(m, float)
                    segs.append((e.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]).reshape(-1, 2, 3))
            self._edge_segs = np.concatenate(segs, axis=0) if segs else np.zeros((0, 2, 3))
        return self._edge_segs

    def _render_fast(self, scaled: View, edges: bool) -> tuple[np.ndarray, tuple[float, float], np.ndarray | None]:
        if not len(self._tris):
            return np.full((1, 1), -1, dtype=np.int64), (0.0, 0.0), None
        proj = scaled.project(self._verts)
        lo = proj[:, :2].min(0)
        hi = proj[:, :2].max(0)
        w, h = int(np.ceil(hi[0] - lo[0])) + 2 * PAD, int(np.ceil(hi[1] - lo[1])) + 2 * PAD
        shift_x = -lo[0] + PAD
        shift_y = -lo[1] + PAD
        proj[:, 0] += shift_x
        proj[:, 1] += shift_y
        depth, template = rasterize(proj.reshape(-1, 3, 3), self._tri_cols, (h, w))
        edge = None
        if edges:
            from .edges import sample_segments, visible_points
            segs = self._get_edge_segs()
            edge = np.zeros((h, w), np.float32)
            if len(segs):
                local = scaled.replace(offset=(scaled.offset[0] + shift_x, scaled.offset[1] + shift_y))
                pts = sample_segments(local.project(segs.reshape(-1, 3)).reshape(-1, 2, 3))
                vis = visible_points(pts, depth)
                if len(vis):
                    edge[vis[:, 0], vis[:, 1]] = 1.0
        return template, (float(lo[0] - PAD), float(lo[1] - PAD)), edge

    def planes(self, margin: int):
        if margin not in self._planes:
            self._planes = {margin: _class_planes(self.classes, self.n, margin, self.on_ink)}
        return self._planes[margin]

    def evaluate(self, view: View, use_edges: bool = True) -> tuple[float, View]:
        f = self.factor
        scaled = view.replace(scale=view.scale * f, offset=(view.offset[0] * f, view.offset[1] * f))
        want_edges = use_edges and (self.on_ink is not None)
        template, corner, edge = self._render_fast(scaled, edges=want_edges)
        shape = self.classes.shape
        margin = int(0.3 * max(template.shape)) + 8 + max(0, max(template.shape) - min(shape))
        margin = int(np.ceil(margin / 16) * 16)
        planes, bg, ink = self.planes(margin)
        if template.shape[0] >= planes[0].shape[0] or template.shape[1] >= planes[0].shape[1]:
            return -1.0, view
        value, (x, y) = _match(template, planes, bg, self.n, edge, ink if want_edges else None)
        ox = scaled.offset[0] + (x - margin) - corner[0]
        oy = scaled.offset[1] + (y - margin) - corner[1]
        return value, view.replace(offset=(ox / f, oy / f))


def _boundary_world_points(depth: np.ndarray, label: np.ndarray, view: View, max_pts: int = 1200) -> np.ndarray:
    """Exact 3D world points of rendered part-boundary and silhouette pixels."""
    e = np.zeros(label.shape, bool)
    e[:, 1:] |= label[:, 1:] != label[:, :-1]
    e[1:, :] |= label[1:, :] != label[:-1, :]
    fg = label >= 0
    e2 = np.zeros(label.shape, bool)
    e2[:, 1:] |= fg[:, 1:] != fg[:, :-1]
    e2[1:, :] |= fg[1:, :] != fg[:-1, :]
    mask = (e & fg) | (e2 & fg)
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return np.zeros((0, 3))
    if len(xs) > max_pts:
        idx = np.linspace(0, len(xs) - 1, max_pts, dtype=int)
        ys, xs = ys[idx], xs[idx]
    d = depth[ys, xs]
    ok = np.isfinite(d)
    ys, xs, d = ys[ok], xs[ok], d[ok]
    if not len(xs):
        return np.zeros((0, 3))
    qx = (xs.astype(float) - view.offset[0]) / max(view.scale, 1e-6)
    qy = (ys.astype(float) - view.offset[1]) / max(view.scale, 1e-6)
    q = np.stack([qx, qy, d], axis=1)
    # View.matrix is orthonormal, so inverse is transpose
    return q @ view.matrix


def _visible_edge_world_points(lib, parts, view: View, shape: tuple[int, int], max_pts: int = 2000) -> np.ndarray:
    """Sampled 3D world points of visible LDraw type-2 edges and part-boundary silhouettes."""
    from .edges import DEPTH_TOL, part_edges
    depth, label = render(lib, parts, view, shape)
    pts_list = [_boundary_world_points(depth, label, view, max_pts=max_pts // 2)]
    h, w = shape
    world_segs = []
    for p, _c, m in parts:
        e = part_edges(lib, p)
        if len(e):
            seg = e.reshape(-1, 3) @ np.asarray(m, float)[:3, :3].T + np.asarray(m, float)[:3, 3]
            world_segs.append(seg.reshape(-1, 2, 3))
    if world_segs:
        segs = np.concatenate(world_segs, axis=0)
        p0 = view.project(segs[:, 0])
        p1 = view.project(segs[:, 1])
        lens = np.linalg.norm(p1[:, :2] - p0[:, :2], axis=1)
        keep_seg = lens >= 1.5
        if keep_seg.any():
            segs = segs[keep_seg]
            lens = lens[keep_seg]
            n = np.clip(np.ceil(lens / 2.0).astype(int), 1, 24)
            idx = np.repeat(np.arange(len(segs)), n + 1)
            t = (np.arange(len(idx)) - np.repeat(np.cumsum(n + 1) - (n + 1), n + 1)) / np.repeat(n, n + 1)
            W3 = segs[idx, 0] + (segs[idx, 1] - segs[idx, 0]) * t[:, None]
            uvd = view.project(W3)
            cols = np.round(uvd[:, 0]).astype(int)
            rows = np.round(uvd[:, 1]).astype(int)
            inside = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)
            W3, rows, cols, uvd = W3[inside], rows[inside], cols[inside], uvd[inside]
            vis = uvd[:, 2] <= depth[rows, cols] + DEPTH_TOL
            W3 = W3[vis]
            if len(W3) > max_pts:
                W3 = W3[np.linspace(0, len(W3) - 1, max_pts, dtype=int)]
            pts_list.append(W3)
    pts_list = [p for p in pts_list if len(p)]
    return np.concatenate(pts_list, axis=0) if pts_list else np.zeros((0, 3))


def refine_view(lib, parts, picture: Picture, view: View, scale_tol: float = 0.06,
                max_angle: float = 8.0, max_roll: float = 3.0, max_shift: float = 12.0,
                outer: int = 2) -> View:
    """Continuous sub-pixel camera refinement via ICP of visible 3D edges/silhouettes onto picture ink.

    Optimises (yaw, pitch, roll, scale, ox, oy) with scipy soft-L1 least squares so visible LDraw edges
    and part boundaries snap onto the booklet's ink strokes to sub-pixel accuracy. Keeps the start view
    if refinement fails to reduce mean clipped ink distance."""
    from scipy.optimize import least_squares
    from scipy.spatial import cKDTree
    from .edges import ink as ink_mask_fn

    if not parts:
        return view
    shape = picture.rgb.shape[:2]
    im = ink_mask_fn(picture.rgb)
    iys, ixs = np.nonzero(im)
    if len(ixs) < 30:
        return view
    ink_pts = np.stack([ixs.astype(float), iys.astype(float)], axis=1)
    tree = cKDTree(ink_pts)
    dist_map = cv2.distanceTransform((~im).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)

    def mean_dist(v: View, X: np.ndarray, clip: float = 4.0) -> float:
        if not len(X):
            return float("inf")
        uv = v.project(X)[:, :2]
        h, w = dist_map.shape
        x = np.clip(np.round(uv[:, 0]).astype(int), 0, w - 1)
        y = np.clip(np.round(uv[:, 1]).astype(int), 0, h - 1)
        inside = (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
        d = np.where(inside, np.minimum(dist_map[y, x], clip), clip)
        return float(d.mean())

    cur = view
    X0 = _visible_edge_world_points(lib, parts, cur, shape)
    if len(X0) < 25:
        return view
    best_view = cur
    best_score = mean_dist(cur, X0)

    lo = np.array([
        view.yaw - max_angle, view.pitch - max_angle, view.roll - max_roll,
        view.scale * max(0.5, 1.0 - scale_tol),
        view.offset[0] - max_shift, view.offset[1] - max_shift,
    ])
    hi = np.array([
        view.yaw + max_angle, view.pitch + max_angle, view.roll + max_roll,
        view.scale * (1.0 + scale_tol),
        view.offset[0] + max_shift, view.offset[1] + max_shift,
    ])
    orient = np.asarray(view.orientation, float)
    radii = (6.0, 3.5, 2.5, 2.0)

    for _outer in range(outer):
        X = X0 if _outer == 0 else _visible_edge_world_points(lib, parts, cur, shape)
        if len(X) < 25:
            break
        for radius in radii:
            uv0 = cur.project(X)[:, :2]
            d, j = tree.query(uv0, distance_upper_bound=radius)
            ok = np.isfinite(d)
            if int(ok.sum()) < 25:
                continue
            Xm = X[ok]
            target = ink_pts[j[ok]]
            x0 = np.array([cur.yaw, cur.pitch, cur.roll, cur.scale, cur.offset[0], cur.offset[1]])
            x0 = np.clip(x0, lo + 1e-7, hi - 1e-7)

            def res(p):
                v = View(orient, float(p[0]), float(p[1]), float(p[3]), (float(p[4]), float(p[5])), float(p[2]))
                return (v.project(Xm)[:, :2] - target).ravel()

            sol = least_squares(
                res, x0, loss="soft_l1", f_scale=1.0, bounds=(lo, hi),
                x_scale=[1.0, 1.0, 1.0, max(0.01 * view.scale, 1e-4), 1.0, 1.0],
                max_nfev=35,
            )
            p = sol.x
            cand = View(orient, float(p[0]), float(p[1]), float(p[3]), (float(p[4]), float(p[5])), float(p[2]))
            sc = mean_dist(cand, X)
            if sc < mean_dist(cur, X) + 0.05:
                cur = cand
                if sc < best_score - 1e-4:
                    best_score = sc
                    best_view = cand
    return best_view


def register(lib, parts, picture: Picture, codes: list[int], orientation, yaw: float, pitch: float,
             scale: float, scale_range=np.linspace(0.9, 1.1, 7), angle_steps=((4.0, 0.0), (-4.0, 0.0), (0.0, 4.0), (0.0, -4.0)),
             classes: np.ndarray | None = None, on_ink: np.ndarray | None = None,
             subpixel: bool = False, roll: float = 0.0) -> Registration:
    """Local registration around (orientation, yaw, pitch, scale, roll)."""
    classes = picture.classes(codes) if classes is None else classes
    aligner = Aligner(lib, parts, classes, codes, on_ink=on_ink)
    base = View(np.asarray(orientation, float), yaw, pitch, scale, (0.0, 0.0), roll)
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
    if subpixel and on_ink is not None and len(parts):
        span = max(0.05, float(max(scale_range) - min(scale_range)) / 2.0 + 0.03) if len(scale_range) > 1 else 0.04
        refined = refine_view(lib, parts, picture, best[1], scale_tol=span)
        # Verify the refined view does not collapse colour/edge template agreement
        val_r, _ = aligner.evaluate(refined)
        if val_r >= best[0] - 0.08:
            best = (max(best[0], val_r), refined)
    return Registration(best[1], float(best[0]), classes.shape)


COARSE_YAWS = (5, 20, 35, 50, 65, 80)
COARSE_PITCHES = (20, 30, 40, 50, 60)


def search(lib, parts, picture: Picture, codes: list[int], orientations: list[int], scale: float,
           classes: np.ndarray | None = None, refine: int = 3, on_ink: np.ndarray | None = None,
           diverse: bool = False, separation: float = 0.0,
           scale_range=np.linspace(0.9, 1.1, 7), subpixel: bool = True) -> list[Registration]:
    """Coarse registration over orientations x a yaw/pitch grid at half resolution, then local
    refinement of the `refine` best. Returns refined registrations, best first."""
    from ..viewfit import ORIENTATIONS

    classes = picture.classes(codes) if classes is None else classes
    coarse = Aligner(lib, parts, classes, codes, factor=0.5, on_ink=on_ink)
    found = []
    for oi in orientations:
        for yaw in COARSE_YAWS:
            for pitch in COARSE_PITCHES:
                value, _view = coarse.evaluate(View(ORIENTATIONS[oi], yaw, pitch, scale, (0.0, 0.0)), use_edges=False)
                found.append((value, oi, yaw, pitch))
    found.sort(key=lambda r: -r[0])
    # Re-score the top coarse candidates per orientation with edges when available
    if on_ink is not None:
        shortlist, per_oi = [], {}
        for _v, oi, yaw, pitch in found:
            c = per_oi.get(oi, 0)
            if c >= 4:
                continue
            per_oi[oi] = c + 1
            val, _view = coarse.evaluate(View(ORIENTATIONS[oi], yaw, pitch, scale, (0.0, 0.0)), use_edges=True)
            shortlist.append((val, oi, yaw, pitch))
            if len(shortlist) >= max(24, refine * 6):
                break
        found = sorted(shortlist, key=lambda r: -r[0])
    out, seen = [], set()
    for value, oi, yaw, pitch in found:
        if len(out) >= refine:
            break
        if separation:
            # distinct camera peaks: coarse views of one orientation closer than `separation` degrees are one
            if any(o == oi and abs(y - yaw) < separation and abs(q - pitch) < separation for o, y, q in seen):
                continue
            seen.add((oi, yaw, pitch))
        else:
            key = oi if diverse else (oi, yaw, pitch)    # diverse: the best coarse view of each orientation
            if key in seen:
                continue
            seen.add(key)
        reg = register(lib, parts, picture, codes, ORIENTATIONS[oi], yaw, pitch, scale, classes=classes, on_ink=on_ink,
                       angle_steps=((5.0, 0.0), (-5.0, 0.0), (0.0, 5.0), (0.0, -5.0)), scale_range=scale_range,
                       subpixel=False)
        reg.orientation_index = oi
        out.append(reg)
    out.sort(key=lambda r: -r.score)
    if subpixel and on_ink is not None and len(parts):
        span = max(0.05, float(max(scale_range) - min(scale_range)) / 2.0 + 0.03) if len(scale_range) > 1 else 0.04
        for idx in range(min(2, len(out))):
            reg = out[idx]
            refined = refine_view(lib, parts, picture, reg.view, scale_tol=span, outer=2)
            out[idx] = Registration(refined, reg.score, reg.shape, reg.orientation_index)
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
