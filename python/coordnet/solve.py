"""Camera and new-part solving from dense correspondences (picture pixel -> render pixel -> 3D point).

The render of the current estimate has an exact G-buffer, so a picture pixel p matched to render pixel q
(q = p + flow) gives the 3D point X shown at q. The camera that reproduces the picture minimises
|project(cam, X) - p| over all confident matches: a robust least-squares fit (scipy, soft-L1 loss) of yaw,
pitch, roll, scale, cx, cy and, for perspective cameras, the eye distance. Render -> match -> fit repeats until
the matches move less than a fraction of a pixel.

New parts: each candidate pose is rendered into the estimate; the flow on the picture's new-part pixels says
where the candidate's points must move to match. A correct candidate leaves residuals at the camera's noise
level; a wrong one (a stud off, a plate off, too deep along the line of sight) leaves a consistent offset.

`match` is the only function that needs the network; everything else is exact geometry and is tested with
ground-truth flow (tests/test_coordnet_solve.py).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import least_squares

from .camera import BookletCamera, project
from . import render as R

PARAMS = ("yaw", "pitch", "roll", "scale", "cx", "cy", "eye")


@dataclass
class Matches:
    p: np.ndarray        # [N,2] picture pixel centres
    X: np.ndarray        # [N,3] 3D points (model frame)
    w: np.ndarray        # [N] weights (confidence)
    part: np.ndarray     # [N] part index in the render's part list


def correspondences(flow: np.ndarray, weight: np.ndarray, gren: R.GBuffer, mask: np.ndarray | None = None,
                    stride: int = 2) -> Matches:
    """Matches from a flow field [2,H,W] (picture -> render), per-pixel weight [H,W] and the render's G-buffer.

    The 3D point is read at the render pixel the flow lands in (nearest pixel; the point must belong to a part).
    `mask` limits which picture pixels are used; `stride` subsamples the grid."""
    H, W = weight.shape
    ys, xs = np.mgrid[0:H:stride, 0:W:stride]
    ys, xs = ys.ravel(), xs.ravel()
    keep = weight[ys, xs] > 0
    if mask is not None:
        keep &= mask[ys, xs]
    ys, xs = ys[keep], xs[keep]
    qx = xs + 0.5 + flow[0, ys, xs]
    qy = ys + 0.5 + flow[1, ys, xs]
    ix, iy = np.floor(qx).astype(int), np.floor(qy).astype(int)
    ok = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H)
    ys, xs, qx, qy, ix, iy = ys[ok], xs[ok], qx[ok], qy[ok], ix[ok], iy[ok]
    part = gren.part[iy, ix]
    ok = part >= 0
    ys, xs, ix, iy, part = ys[ok], xs[ok], ix[ok], iy[ok], part[ok]
    X = gren.xyz[iy, ix].astype(float)
    # the render pixel centre's point; correct for the sub-pixel landing position along the local surface
    # (first-order: neighbouring pixel points of the same part)
    fx = (qx[ok] - (ix + 0.5))
    fy = (qy[ok] - (iy + 0.5))
    X = X + _local_step(gren, ix, iy, part, 1, 0) * fx[:, None] + _local_step(gren, ix, iy, part, 0, 1) * fy[:, None]
    return Matches(np.stack([xs + 0.5, ys + 0.5], 1), X, weight[ys, xs].astype(float), part)


def _local_step(g: R.GBuffer, ix, iy, part, dx, dy) -> np.ndarray:
    """dX per pixel along +x / +y from central differences on the same part (0 where not available)."""
    H, W = g.part.shape
    out = np.zeros((len(ix), 3))
    a = (np.clip(ix - dx, 0, W - 1), np.clip(iy - dy, 0, H - 1))
    b = (np.clip(ix + dx, 0, W - 1), np.clip(iy + dy, 0, H - 1))
    pa, pb = g.part[a[1], a[0]], g.part[b[1], b[0]]
    Xa, Xb, X0 = g.xyz[a[1], a[0]], g.xyz[b[1], b[0]], g.xyz[iy, ix]
    both = (pa == part) & (pb == part)
    onlyb = (pb == part) & ~both
    onlya = (pa == part) & ~both
    out[both] = (Xb[both] - Xa[both]) / 2
    out[onlyb] = Xb[onlyb] - X0[onlyb]
    out[onlya] = X0[onlya] - Xa[onlya]
    # reject steps across depth jumps within a part (more than 3x the median step)
    n = np.linalg.norm(out, axis=1)
    med = np.median(n[n > 0]) if (n > 0).any() else 0
    out[n > 3 * med + 1e-9] = 0
    return out


def _vec(cam: BookletCamera, free: tuple[str, ...]) -> np.ndarray:
    return np.array([getattr(cam, k) for k in free], float)


def _cam(cam: BookletCamera, free: tuple[str, ...], x: np.ndarray) -> BookletCamera:
    return cam.with_(**{k: float(v) for k, v in zip(free, x)})


@dataclass
class CameraFit:
    cam: BookletCamera
    rms: float
    median: float
    p90: float
    inliers: float
    n: int
    residuals: np.ndarray = field(repr=False, default=None)


def fit_camera(m: Matches, cam0: BookletCamera, centre, free: tuple[str, ...] | None = None,
               f_scale: float = 1.0) -> CameraFit:
    """Robust least-squares camera from matches (soft-L1 loss with a 1 px knee by default)."""
    if free is None:
        free = PARAMS if cam0.eye > 0 else PARAMS[:-1]
    x0 = _vec(cam0, free)
    sw = np.sqrt(m.w)

    def res(x):
        uv, _ = project(_cam(cam0, free, x), centre, m.X)
        return ((uv - m.p) * sw[:, None]).ravel()

    scale = np.array([1.0 if k in ("yaw", "pitch", "roll") else 0.01 * cam0.scale if k == "scale"
                      else 1.0 if k in ("cx", "cy") else 0.05 * max(cam0.eye, 1) for k in free])
    r = least_squares(res, x0, loss="soft_l1", f_scale=f_scale, x_scale=scale, max_nfev=200)
    cam = _cam(cam0, free, r.x)
    uv, _ = project(cam, centre, m.X)
    e = np.linalg.norm(uv - m.p, axis=1)
    return CameraFit(cam, float(np.sqrt((e ** 2).mean())), float(np.median(e)), float(np.percentile(e, 90)),
                     float((e < 1.0).mean()), len(e), e)


def candidate_offsets(m: Matches, cam: BookletCamera, centre, part: int) -> dict:
    """How far a candidate part's matched points must move in the picture: the residual of its matches under the
    solved camera (a correct pose gives the camera's noise level, a wrong pose a consistent offset)."""
    sel = m.part == part
    if not sel.any():
        return dict(n=0, median=float("inf"), mean_vec=[0.0, 0.0])
    uv, _ = project(cam, centre, m.X[sel])
    d = m.p[sel] - uv
    e = np.linalg.norm(d, axis=1)
    return dict(n=int(sel.sum()), median=float(np.median(e)), p90=float(np.percentile(e, 90)),
                mean_vec=np.median(d, 0).tolist())
