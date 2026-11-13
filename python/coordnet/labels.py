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
