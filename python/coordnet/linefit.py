"""Camera fit to the page's drawn lines, without the network (docs/coordnet/linefit-design.md).

Built bottom-up; this module so far holds the page side: where the page draws lines, at sub-pixel precision,
whatever the booklet's palette.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .place import red_band


@dataclass
class Features:
    p: np.ndarray        # [N,2] sub-pixel positions, pixel-centre convention (pixel i spans [i, i+1))
    n: np.ndarray        # [N,2] unit normal across the line / edge
    kind: np.ndarray     # [N] 0 dark line, 1 light line, 2 step edge (a silhouette with no stroke)


def _derivatives(g: np.ndarray):
    gx = (np.roll(g, -1, 1) - np.roll(g, 1, 1)) / 2
    gy = (np.roll(g, -1, 0) - np.roll(g, 1, 0)) / 2
    gxx = np.roll(g, -1, 1) - 2 * g + np.roll(g, 1, 1)
    gyy = np.roll(g, -1, 0) - 2 * g + np.roll(g, 1, 0)
    gxy = (np.roll(np.roll(g, -1, 0), -1, 1) - np.roll(np.roll(g, -1, 0), 1, 1)
           - np.roll(np.roll(g, 1, 0), -1, 1) + np.roll(np.roll(g, 1, 0), 1, 1)) / 4
    return gx, gy, gxx, gyy, gxy


def _ridges(g: np.ndarray, sigma: float, min_curv: float, dark_below: float = 100.0):
    """Steger's line detector: centre lines of strokes of either polarity, with sub-pixel offsets. A stroke of
    width w has one ridge for sigma >= w / (2 sqrt 3); a flat face has none; a step edge's extremum sits ~sigma
    off the step and is rejected by the half-pixel test."""
    s = cv2.GaussianBlur(g, (0, 0), sigma)
    gx, gy, gxx, gyy, gxy = _derivatives(s)
    half = (gxx - gyy) / 2
    root = np.sqrt(half ** 2 + gxy ** 2)
    l1, l2 = (gxx + gyy) / 2 + root, (gxx + gyy) / 2 - root
    lam = np.where(np.abs(l1) >= np.abs(l2), l1, l2)
    nx, ny = gxy, lam - gxx
    flat = (np.abs(nx) + np.abs(ny)) < 1e-12
    nx, ny = np.where(flat, lam - gyy, nx), np.where(flat, gxy, ny)
    flat = (np.abs(nx) + np.abs(ny)) < 1e-12
    nx, ny = np.where(flat, 1.0, nx), np.where(flat, 0.0, ny)
    norm = np.hypot(nx, ny)
    nx, ny = nx / norm, ny / norm
    with np.errstate(divide="ignore", invalid="ignore"):
        t = -(gx * nx + gy * ny) / lam
    ok = (np.abs(lam) > min_curv) & (np.abs(t * nx) <= 0.5) & (np.abs(t * ny) <= 0.5)
    ok[:2] = ok[-2:] = False
    ok[:, :2] = ok[:, -2:] = False
    ys, xs = np.nonzero(ok)
    tt = t[ys, xs]
    p = np.stack([xs + 0.5 + tt * nx[ys, xs], ys + 0.5 + tt * ny[ys, xs]], 1)
    n = np.stack([nx[ys, xs], ny[ys, xs]], 1)
    kind = np.where(lam[ys, xs] > 0, 0, 1)                    # dark line: intensity curves up across it
    # a light line is only drawn on a dark part: between two close dark outlines the paper is a light ridge too
    around = cv2.GaussianBlur(g, (0, 0), 3 * sigma + 2)[ys, xs]
    keep = (kind == 0) | (around < dark_below)
    return p[keep], n[keep], kind[keep]


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """img sampled at array coordinates (x, y) (pixel i's value sits at i), bilinear, clamped to the border."""
    H, W = img.shape
    x = np.clip(x, 0, W - 1.001)
    y = np.clip(y, 0, H - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    return ((1 - fx) * (1 - fy) * img[y0, x0] + fx * (1 - fy) * img[y0, x0 + 1]
            + (1 - fx) * fy * img[y0 + 1, x0] + fx * fy * img[y0 + 1, x0 + 1])


def _steps(g: np.ndarray, sigma: float, min_grad: float):
    """Sub-pixel step edges: maxima of the gradient magnitude along the gradient direction."""
    s = cv2.GaussianBlur(g, (0, 0), sigma)
    gx, gy = cv2.Sobel(s, cv2.CV_32F, 1, 0, ksize=1) / 2, cv2.Sobel(s, cv2.CV_32F, 0, 1, ksize=1) / 2
    mag = np.hypot(gx, gy)
    H, W = g.shape
    ys, xs = np.nonzero(mag > min_grad)
    keep = (xs > 1) & (xs < W - 2) & (ys > 1) & (ys < H - 2)
    xs, ys = xs[keep], ys[keep]
    if not len(xs):
        return np.zeros((0, 2)), np.zeros((0, 2))
    m0 = mag[ys, xs]
    nx, ny = gx[ys, xs] / m0, gy[ys, xs] / m0
    sample = lambda dx, dy: _bilinear(mag, xs + dx, ys + dy)
    mp, mm = sample(nx, ny), sample(-nx, -ny)
    peak = (m0 >= mp) & (m0 > mm)
    den = mm - 2 * m0 + mp
    with np.errstate(divide="ignore", invalid="ignore"):
        off = np.where(den < 0, (mm - mp) / (2 * den), 0.0)
    off = np.clip(off, -0.5, 0.5)
    xs, ys, nx, ny, off = xs[peak], ys[peak], nx[peak], ny[peak], off[peak]
    p = np.stack([xs + 0.5 + off * nx, ys + 0.5 + off * ny], 1)
    return p, np.stack([nx, ny], 1)


def page_features(pic: np.ndarray, stroke: float = 4.0, min_curv: float = 3.0, min_grad: float = 15.0) -> Features:
    """Where the page draws lines: centre lines of dark strokes (outlines) and light strokes (lines on dark parts),
    plus step edges away from any stroke (the silhouette of a dark part on the paper, where outline and face
    merge). Positions are sub-pixel, in picture px. The red new-part band is not a line. `stroke`: widest stroke
    (px, grows with upscaling)."""
    g = cv2.cvtColor(np.ascontiguousarray(pic[..., :3]), cv2.COLOR_RGB2GRAY).astype(np.float32)
    sigma = max(0.8, stroke / (2 * np.sqrt(3)))
    rp, rn, rk = _ridges(g, sigma, min_curv)
    sp, sn = _steps(g, 1.0, min_grad)
    if len(rp) and len(sp):
        H, W = g.shape
        near = np.zeros((H, W), np.uint8)
        near[np.clip(rp[:, 1].astype(int), 0, H - 1), np.clip(rp[:, 0].astype(int), 0, W - 1)] = 1
        r = int(np.ceil(stroke / 2)) + 1
        near = cv2.dilate(near, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))).astype(bool)
        away = ~near[np.clip(sp[:, 1].astype(int), 0, H - 1), np.clip(sp[:, 0].astype(int), 0, W - 1)]
        sp, sn = sp[away], sn[away]
    p = np.concatenate([rp, sp]) if len(sp) else rp
    n = np.concatenate([rn, sn]) if len(sp) else rn
    kind = np.concatenate([rk, np.full(len(sp), 2)]) if len(sp) else rk
    band = red_band(pic)
    if band.any():
        band = cv2.dilate(band.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
        H, W = band.shape
        on = band[np.clip(p[:, 1].astype(int), 0, H - 1), np.clip(p[:, 0].astype(int), 0, W - 1)]
        p, n, kind = p[~on], n[~on], kind[~on]
    return Features(p, n, kind.astype(np.int8))


# --- refinement --------------------------------------------------------------------------------------------------

@dataclass
class Fit:
    cam: object          # BookletCamera
    score: float         # mean clipped distance (px) from the visible model-line samples to the page's lines
    cover: float         # share of the visible samples within 1.5 px of a page line
    n: int               # visible samples


STAGES = (                     # (free parameters, match radius px, iterations)
    (("cx", "cy"), 8.0, 3),
    (("yaw", "pitch", "roll", "cx", "cy"), 4.0, 4),
    (("yaw", "pitch", "roll", "scale", "cx", "cy"), 2.5, 3),
    (("yaw", "pitch", "roll", "scale", "cx", "cy", "eye"), 2.0, 3),
)


def _samples(parts, cam, centre, W, H, lines):
    from . import render as R
    g = R.gbuffer(*R.scene(parts), cam, centre, W, H)
    return R.visible_line_samples(*lines, g, cam, centre, 1)


def evaluate(feat: Features, tree, s, clip: float = 4.0) -> tuple[float, float]:
    """(mean distance clipped at `clip`, share within 1.5 px) from line samples `s` to the page's features: the one
    fixed objective every iterate is judged by."""
    if not len(s.uv):
        return float("inf"), 0.0
    d, _ = tree.query(s.uv, distance_upper_bound=clip)
    d = np.minimum(d, clip)
    return float(d.mean()), float((d < 1.5).mean())


def refine(feat: Features, parts: list, cam0, centre, W: int, H: int, print_scale: float,
           scale_tol: float = 0.05, min_samples: int = 200, lines=None) -> Fit | None:
    """Fit the camera so the model's visible LDraw lines lie on the page's lines, from a start already within a
    few px and degrees. Each iteration: visible samples (`render.visible_line_samples`), each matched to its
    nearest page feature within the stage's radius, the residual taken along that feature's normal
    (point-to-line: samples may slide along a line), then `solve.fit_camera` with the stage's free parameters --
    scale within `scale_tol` of the print scale, eye within its training range. The best iterate by `evaluate`
    is returned; None when the page or the model offers too few lines."""
    from scipy.spatial import cKDTree
    from . import render as R
    from .solve import Matches, fit_camera
    if len(feat.p) < min_samples:
        return None
    lines = lines if lines is not None else R.scene_lines(parts)
    tree = cKDTree(feat.p)
    bounds = {"scale": (print_scale * (1 - scale_tol), print_scale * (1 + scale_tol))}
    cam = cam0.with_(scale=float(np.clip(cam0.scale, *bounds["scale"])))
    s = _samples(parts, cam, centre, W, H, lines)
    if len(s.uv) < min_samples:
        return None
    best = Fit(cam, *evaluate(feat, tree, s), len(s.uv))
    for free, radius, iters in STAGES:
        if "eye" in free and cam.eye <= 0:
            free = tuple(k for k in free if k != "eye")
        for _ in range(iters):
            d, j = tree.query(s.uv, distance_upper_bound=radius)
            ok = np.isfinite(d)
            if ok.sum() < min_samples:
                break
            uv, fp, fn = s.uv[ok], feat.p[j[ok]], feat.n[j[ok]]
            # foot of the perpendicular from the sample onto the page line through the matched feature
            target = uv - ((uv - fp) * fn).sum(1, keepdims=True) * fn
            fit = fit_camera(Matches(target, s.X[ok], np.ones(ok.sum()), s.part[ok]), cam, centre, free,
                             bounds=bounds)
            if fit is None:
                break
            cam = fit.cam
            s = _samples(parts, cam, centre, W, H, lines)
            if len(s.uv) < min_samples:
                break
            score, cover = evaluate(feat, tree, s)
            if score < best.score:
                best = Fit(cam, score, cover, len(s.uv))
    return best


# --- coarse search -----------------------------------------------------------------------------------------------

def feature_distance(feat: Features, W: int, H: int, clip: float = 4.0) -> np.ndarray:
    """Distance (px, clipped) from every pixel to the nearest page feature: the coarse search's lookup table."""
    m = np.ones((H, W), np.uint8)
    q = np.floor(feat.p).astype(int)
    ok = (q[:, 0] >= 0) & (q[:, 0] < W) & (q[:, 1] >= 0) & (q[:, 1] < H)
    m[q[ok, 1], q[ok, 0]] = 0
    return np.minimum(cv2.distanceTransform(m, cv2.DIST_L2, cv2.DIST_MASK_PRECISE), clip).astype(np.float32)


def coarse(feat: Features, parts: list, cam0, centre, W: int, H: int, reach: float = 56.0, step: float = 2.0,
           angles: tuple = (-4.0, -2.0, 0.0, 2.0, 4.0), k: int = 3, n_pts: int = 1500, clip: float = 4.0,
           lines=None) -> list:
    """Hypotheses for `refine`: the visible model-line samples at the start (visibility held fixed) re-projected for
    small yaw/pitch corrections, then slid over a grid of offsets within `reach` px; each placement is scored by
    the mean clipped distance to the page's features. Sliding projected points cannot wrap around, and every
    placement is scored on the same samples. Returns up to `k` (score, camera) with distinct offsets or angles,
    best first (a neighbouring stud is a candidate, not a fate)."""
    from . import render as R
    lines = lines if lines is not None else R.scene_lines(parts)
    s = _samples(parts, cam0, centre, W, H, lines)
    if len(s.X) < 50:
        return []
    X = s.X[np.random.default_rng(0).choice(len(s.X), min(n_pts, len(s.X)), replace=False)]
    dist = feature_distance(feat, W, H, clip)
    shifts = np.arange(-reach, reach + 1e-9, step)
    dx, dy = np.meshgrid(shifts, shifts)
    dx, dy = dx.ravel(), dy.ravel()
    from .camera import project
    found = []
    for da in angles:
        for db in angles:
            cam = cam0.with_(yaw=cam0.yaw + da, pitch=cam0.pitch + db)
            uv, _ = project(cam, centre, X)
            # pixel index of every sample under every shift [S, N]
            x = np.floor(uv[None, :, 0] + dx[:, None]).astype(np.int32)
            y = np.floor(uv[None, :, 1] + dy[:, None]).astype(np.int32)
            inside = (x >= 0) & (x < W) & (y >= 0) & (y < H)
            d = np.where(inside, dist[np.clip(y, 0, H - 1), np.clip(x, 0, W - 1)], clip)
            score = d.mean(1)
            for i in np.argsort(score)[: 4 * k]:
                found.append((float(score[i]), cam.with_(cx=cam.cx + float(dx[i]), cy=cam.cy + float(dy[i]))))
    found.sort(key=lambda t: t[0])
    out = []
    for sc, cam in found:
        if all(abs(cam.cx - c.cx) + abs(cam.cy - c.cy) >= 3 * step or
               abs(cam.yaw - c.yaw) + abs(cam.pitch - c.pitch) > 0.5 for _s, c in out):
            out.append((sc, cam))
        if len(out) == k:
            break
    return out


def fit_view(feat: Features, parts: list, start, centre, W: int, H: int, print_scale: float, k: int = 3,
             **kw) -> list:
    """Coarse hypotheses around `start`, each refined; the fits, best (lowest score) first. The caller verifies
    them (`realdata.camera_check`): this only proposes."""
    from . import render as R
    lines = R.scene_lines(parts)
    fits = []
    for _sc, cam in coarse(feat, parts, start, centre, W, H, k=k, lines=lines, **kw):
        r = refine(feat, parts, cam, centre, W, H, print_scale, lines=lines)
        if r is not None:
            fits.append(r)
    return sorted(fits, key=lambda f: f.score)


# --- the view from the line directions --------------------------------------------------------------------------

_NB = 180


def _direction_hist(theta: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Unit-norm histogram of line directions (mod 180 deg, 1 deg bins, circularly smoothed)."""
    h = np.bincount((np.mod(theta, np.pi) / np.pi * _NB).astype(int) % _NB, w, _NB)
    k = np.exp(-0.5 * (np.arange(-4, 5) / 1.5) ** 2)
    h = np.convolve(np.r_[h[-4:], h, h[:4]], k, "valid")
    return h / (np.linalg.norm(h) + 1e-12)


def view_angles(feat: Features, parts: list, centre, print_scale: float, k: int = 2,
                pitches=tuple(np.arange(20.0, 52.5, 2.5)), eye: float = 4200.0) -> list[tuple[float, float]]:
    """(yaw in [0, 360), pitch) of the views whose projected model edges run in the page's line directions, best
    first, at least 6 deg of yaw apart. No translation, colour or network is involved (on BrickHeadz 40348 the
    booklet views are yaw 145, not the standard 35 + k*90). The whole circle is scored: an upright brick model
    repeats every quarter turn, but a tilted one does not."""
    from . import render as R
    from .camera import BookletCamera, project
    if len(feat.n) == 0:
        return []
    hp = _direction_hist(np.arctan2(feat.n[:, 1], feat.n[:, 0]) + np.pi / 2, np.ones(len(feat.n)))
    E = R.scene_lines(parts)[0]
    if len(E) == 0:
        return []

    def score(yaw, pitch):
        cam = BookletCamera(yaw, pitch, 0.0, print_scale, 0.0, 0.0, eye=eye)
        a, _ = project(cam, centre, E[:, 0])
        b, _ = project(cam, centre, E[:, 1])
        d = b - a
        return float(_direction_hist(np.arctan2(d[:, 1], d[:, 0]), np.hypot(d[:, 0], d[:, 1])) @ hp)

    grid = sorted(((score(y, p), y, p) for p in pitches for y in np.arange(0.0, 360.0, 1.0)), reverse=True)
    out: list[tuple[float, float]] = []
    for _s, y, p in grid:
        if any(min((y - a) % 360, (a - y) % 360) < 6 for a, _ in out):
            continue
        best = max(((score(yy, pp), yy, pp) for yy in np.arange(y - 1, y + 1.01, 0.25)
                    for pp in np.arange(p - 2, p + 2.01, 0.5)), key=lambda t: t[0])
        out.append((best[1] % 360.0, best[2]))
        if len(out) >= k:
            break
    return out


def search(feat: Features, parts: list, centre, W: int, H: int, print_scale: float, fg: np.ndarray,
           start=None, eye: float = 4200.0, n_angles: int = 2, lines=None) -> list:
    """Camera hypotheses for a page, best (lowest score) first; the caller verifies them all.

    With `start` (the section's verified view) the fits around it. Otherwise each direction-histogram view
    (`view_angles`) in its four quarter turns, upright and turned, framed on the page foreground at the print
    scale, goes through the coarse translation search, and the best hypothesis of *every* view is refined: the
    caller needs the competing views verified to notice an ambiguous page."""
    from . import render as R
    from .camera import BookletCamera
    from .realdata import _points, frame
    lines = R.scene_lines(parts) if lines is None else lines
    if start is not None:
        hyp = [cam for _s, cam in coarse(feat, parts, start, centre, W, H, k=3, lines=lines)]
    else:
        P = _points(parts)
        views: list = []
        for yaw, pitch in view_angles(feat, parts, centre, print_scale, k=n_angles, eye=eye):
            for q in range(4):
                for turned in (False, True):
                    y = (yaw + 90 * q) % 360
                    if any(t == turned and min((y - v) % 360, (v - y) % 360) < 6 for v, _p, t in views):
                        continue
                    views.append((y, pitch, turned))
        hyp = []
        for y, pitch, turned in views:
            cam = frame(BookletCamera(y, pitch, 0.0, print_scale, 0.0, 0.0, eye=eye, turned=turned), centre, P, fg,
                        fit_scale=False)
            c = coarse(feat, parts, cam, centre, W, H, reach=48, step=2, angles=(-2.0, 0.0, 2.0), k=1, lines=lines)
            hyp += [cm for _s, cm in c[:1]]
    fits = [r for r in (refine(feat, parts, cam, centre, W, H, print_scale, lines=lines) for cam in hyp)
            if r is not None]
    return sorted(fits, key=lambda f: f.score)
