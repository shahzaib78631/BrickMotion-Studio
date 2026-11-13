"""Per-pixel training labels for lattice-vote placement: where on its part each pixel is.

`local` is the part-local LDraw coordinate (LDU) of the surface point a pixel shows. A part that looks the same
after a turn about its own Y axis (`sym_order` 2 or 4) has several equally right labels; `canonical` lists them so
losses and votes can take the best.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
from scipy.spatial import cKDTree

from . import render as R


def _yaw(deg: float) -> np.ndarray:
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


@lru_cache(maxsize=None)
def _vertices(part: str) -> np.ndarray:
    return np.unique(R.part_triangles(part).reshape(-1, 3).round(2), axis=0)


@lru_cache(maxsize=None)
def sym_order(part: str) -> int:
    """Rotation-symmetry order about the part's local Y axis: 4, 2 or 1."""
    v = _vertices(part)
    if len(v) == 0:
        return 1
    tree = cKDTree(v)
    for order in (4, 2):
        if tree.query(v @ _yaw(360.0 / order).T)[0].max() < 0.5:
            return order
    return 1


@lru_cache(maxsize=None)
def part_box(part: str) -> np.ndarray:
    """Extent of the part's geometry in its own frame (LDU), [3]."""
    v = _vertices(part)
    if len(v) == 0:
        return np.zeros(3, np.float32)
    return (v.max(0) - v.min(0)).astype(np.float32)


@lru_cache(maxsize=None)
def part_centre(part: str) -> np.ndarray:
    """Centre of the part's geometry box in its own frame (LDU), [3]."""
    v = _vertices(part)
    if len(v) == 0:
        return np.zeros(3)
    return (v.max(0) + v.min(0)) / 2.0


def pose_centre_extent(part: str, m) -> tuple[np.ndarray, np.ndarray]:
    """World centre of the part's box and its extent along the world axes for pose `m` (4x4)."""
    m = np.asarray(m, float)
    return m[:3, 3] + m[:3, :3] @ part_centre(part), np.abs(m[:3, :3]) @ part_box(part)


def centre_targets(inst: np.ndarray, new: np.ndarray, parts: list, cam, centre) -> tuple[np.ndarray, np.ndarray]:
    """Per new pixel: the offset (image pixels / cam.scale) from the pixel's centre (x + 0.5, y + 0.5) to where its
    part's box centre is drawn, [H,W,2] -- a per-pixel field: pixel + offset * scale is the same point for every
    pixel of a part; and the part's box extent along the world axes, [H,W,3], constant per part. Both are unchanged
    by the part's symmetry turns. Zero elsewhere. Call on the full image, before any crop."""
    from .camera import project
    H, W = new.shape
    off = np.zeros((H, W, 2), np.float32)
    ext = np.zeros((H, W, 3), np.float32)
    ids = np.unique(inst[new])
    for i in ids[ids >= 0]:
        p, _c, m = parts[int(i)]
        c, e = pose_centre_extent(p, m)
        cuv = project(cam, centre, c[None])[0][0]
        ys, xs = np.nonzero(new & (inst == i))
        off[ys, xs] = (cuv - np.stack([xs + 0.5, ys + 0.5], 1)) / cam.scale
        ext[ys, xs] = e
    return off, ext


def camera_channels(cam, centre) -> np.ndarray:
    """What the network needs to know about the camera, [6]: how one LDU along world +X and +Z is drawn (image
    vector / cam.scale), log(cam.scale), and the perspective strength 1000 / eye (0 for orthographic)."""
    from .camera import project
    c = np.asarray(centre, float)
    uv, _ = project(cam, centre, np.stack([c, c + (1, 0, 0), c + (0, 0, 1)]))
    ax, az = (uv[1] - uv[0]) / cam.scale, (uv[2] - uv[0]) / cam.scale
    persp = 1000.0 / cam.eye if cam.eye > 0 else 0.0
    return np.array([ax[0], ax[1], az[0], az[1], np.log(cam.scale), persp], np.float32)


def canonical(local: np.ndarray, order: int) -> np.ndarray:
    """The label under each symmetry turn about local Y: [order, ..., 3]; entry 0 is the label itself."""
    local = np.asarray(local, float)
    return np.stack([local @ _yaw(360.0 * k / order).T for k in range(order)])


def local_labels(g: R.GBuffer, parts: list, new: set[int]) -> dict:
    """Labels for the pixels of the parts in `new` (indices into `parts`, the list the G-buffer was drawn from)."""
    H, W = g.part.shape
    local = np.full((H, W, 3), np.nan, np.float32)
    size = np.full((H, W, 3), np.nan, np.float32)
    newpix = np.isin(g.part, list(new)) if new else np.zeros((H, W), bool)
    for i in new:
        sel = g.part == i
        if not sel.any():
            continue
        p, _c, m = parts[i]
        m = np.asarray(m, float)
        local[sel] = (g.xyz[sel] - m[:3, 3]) @ m[:3, :3]        # R^T (x - t), R orthonormal
        size[sel] = part_box(p)
    return dict(local=local, size=size, new=newpix, inst=g.part.astype(np.int32))
