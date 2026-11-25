"""Z-buffered orthographic rendering of LDraw parts into label and depth images.

The booklet camera is orthographic: a world point p (LDU, LDraw axes, y down) maps to
    q = rotation(yaw, pitch) @ orientation @ p,   u = scale*q_x + ox,   v = scale*q_y + oy,   depth = q_z
(smaller depth is nearer the viewer). Because the projection is affine, translating a part by t moves
its whole image by scale*(M t)[:2] and its depth by (M t)[2]; `Sprite` exploits this so every candidate
pose of a part that shares a rotation is scored from ONE rasterisation (MEPNet's observation that one
keypoint fixes a rigid part's whole projection, used here for rendering).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from brickheadz.instruction_place import rotation

_MESHES: dict = {}


def mesh(lib, part: str) -> np.ndarray:
    """(T, 3, 3) triangles of a part in part space; LDraw quads are split in two."""
    key = (id(lib), part)
    if key not in _MESHES:
        name = (part if part.endswith(".dat") else part + ".dat").lower()
        tris = []
        for chunk in lib._tri_walk(name, np.eye(4)):
            if len(chunk) == 3:
                tris.append(chunk)
            elif len(chunk) == 4:
                tris.append(chunk[[0, 1, 2]])
                tris.append(chunk[[0, 2, 3]])
        _MESHES[key] = np.array(tris, np.float64).reshape(-1, 3, 3)
    return _MESHES[key]


@dataclass(frozen=True)
class View:
    orientation: np.ndarray = field(default_factory=lambda: np.eye(3))
    yaw: float = 35.0
    pitch: float = 35.0
    scale: float = 1.0
    offset: tuple[float, float] = (0.0, 0.0)
    roll: float = 0.0
    _matrix: np.ndarray = field(init=False, repr=False, compare=False)

    def __post_init__(self):
        R = rotation(self.yaw, self.pitch) @ np.asarray(self.orientation, float)
        if self.roll:
            t = np.radians(self.roll)
            c, s = float(np.cos(t)), float(np.sin(t))
            Rz = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
            R = Rz @ R
        object.__setattr__(self, "_matrix", np.ascontiguousarray(R, dtype=np.float64))

    @property
    def matrix(self) -> np.ndarray:
        return self._matrix

    def project(self, points: np.ndarray) -> np.ndarray:
        """(N, 3) world points -> (N, 3) of (u, v, depth)."""
        q = np.asarray(points, float) @ self._matrix.T
        out = np.empty_like(q)
        out[:, 0] = self.scale * q[:, 0] + self.offset[0]
        out[:, 1] = self.scale * q[:, 1] + self.offset[1]
        out[:, 2] = q[:, 2]
        return out

    def shift(self, translation: np.ndarray) -> np.ndarray:
        """(du, dv, ddepth) caused by translating a part by `translation` (LDU)."""
        q = self._matrix @ np.asarray(translation, float)
        return np.array([self.scale * q[0], self.scale * q[1], q[2]])

    def replace(self, **changes) -> "View":
        values = {
            "orientation": self.orientation,
            "yaw": self.yaw,
            "pitch": self.pitch,
            "scale": self.scale,
            "offset": self.offset,
            "roll": self.roll,
        }
        values.update(changes)
        return View(**values)


def rasterize(tris: np.ndarray, labels: np.ndarray, shape: tuple[int, int], chunk: int = 4_000_000):
    """Z-buffer (T, 3, 3) screen-space triangles (u, v, depth) into (depth, label) images.
    Pixel (row i, column j) samples the point u=j, v=i. Empty pixels: depth inf, label -1."""
    h, w = shape
    if not len(tris):
        return np.full((h, w), np.inf), np.full((h, w), -1, np.int64)
    from . import native_bridge
    fast = native_bridge.rasterize_tris(tris, labels, shape)
    if fast is not None:
        return fast
    depth = np.full(h * w, np.inf)
    label = np.full(h * w, -1, np.int64)
    u, v, d = tris[:, :, 0], tris[:, :, 1], tris[:, :, 2]
    area = (u[:, 1] - u[:, 0]) * (v[:, 2] - v[:, 0]) - (u[:, 2] - u[:, 0]) * (v[:, 1] - v[:, 0])
    x0 = np.clip(np.ceil(u.min(1)), 0, w).astype(np.int64)
    x1 = np.clip(np.floor(u.max(1)), -1, w - 1).astype(np.int64)
    y0 = np.clip(np.ceil(v.min(1)), 0, h).astype(np.int64)
    y1 = np.clip(np.floor(v.max(1)), -1, h - 1).astype(np.int64)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    ok = (np.abs(area) > 1e-9) & (bw > 0) & (bh > 0)
    index = np.where(ok)[0]
    counts = (bw * bh)[index]
    order = np.cumsum(counts)
    start = 0
    while start < len(index):
        stop = int(np.searchsorted(order, (order[start - 1] if start else 0) + chunk, side="right"))
        stop = max(stop, start + 1)
        sel = index[start:stop]
        n = (bw * bh)[sel]
        tri = np.repeat(sel, n)
        offsets = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
        width = np.repeat(bw[sel], n)
        px = np.repeat(x0[sel], n) + offsets % width
        py = np.repeat(y0[sel], n) + offsets // width
        ua, va = u[tri], v[tri]
        a = area[tri]
        w0 = ((ua[:, 1] - px) * (va[:, 2] - py) - (ua[:, 2] - px) * (va[:, 1] - py)) / a
        w1 = ((ua[:, 2] - px) * (va[:, 0] - py) - (ua[:, 0] - px) * (va[:, 2] - py)) / a
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        if inside.any():
            da = d[tri[inside]]
            z = w0[inside] * da[:, 0] + w1[inside] * da[:, 1] + w2[inside] * da[:, 2]
            pix = py[inside] * w + px[inside]
            lab = labels[tri[inside]]
            order_z = np.lexsort((z, pix))
            pix, z, lab = pix[order_z], z[order_z], lab[order_z]
            first = np.ones(len(pix), bool)
            first[1:] = pix[1:] != pix[:-1]
            pix, z, lab = pix[first], z[first], lab[first]
            nearer = z < depth[pix]
            depth[pix[nearer]] = z[nearer]
            label[pix[nearer]] = lab[nearer]
        start = stop
    return depth.reshape(h, w), label.reshape(h, w)


def world_triangles(lib, part: str, matrix: np.ndarray) -> np.ndarray:
    t = mesh(lib, part)
    return t @ matrix[:3, :3].T + matrix[:3, 3]


def render(lib, parts, view: View, shape: tuple[int, int]):
    """parts: [(id, colour, 4x4)] -> (depth, label) where label indexes `parts`."""
    tris, labels = [], []
    for k, (part, _colour, matrix) in enumerate(parts):
        t = world_triangles(lib, part, matrix)
        if len(t):
            tris.append(view.project(t.reshape(-1, 3)).reshape(-1, 3, 3))
            labels.append(np.full(len(t), k))
    if not tris:
        return np.full(shape, np.inf), np.full(shape, -1, np.int64)
    return rasterize(np.concatenate(tris), np.concatenate(labels), shape)


def bounds(lib, parts, view: View) -> tuple[np.ndarray, np.ndarray]:
    """Screen-space (u, v) min and max of the parts under `view`."""
    pts = [view.project(world_triangles(lib, p, m).reshape(-1, 3))[:, :2] for p, _c, m in parts if len(mesh(lib, p))]
    allp = np.concatenate(pts)
    return allp.min(0), allp.max(0)


@dataclass
class Sprite:
    """One part at one rotation, rasterised once with the part origin at screen (0, 0) depth 0."""
    mask: np.ndarray        # (h, w) bool
    depth: np.ndarray       # (h, w) float, relative to the origin's depth
    corner: tuple[int, int]  # (u, v) of mask[0, 0] relative to the projected origin

    def place(self, view: View, translation: np.ndarray):
        """(row0, col0, depth offset) of the sprite for a part translated by `translation`."""
        du, dv, dd = view.shift(translation)
        origin = np.array(view.offset) + (du, dv)
        col0 = int(round(origin[0])) + self.corner[0]
        row0 = int(round(origin[1])) + self.corner[1]
        return row0, col0, dd


def sprite(lib, part: str, rotation3: np.ndarray, view: View, pad: int = 1) -> Sprite:
    m = np.eye(4)
    m[:3, :3] = rotation3
    t = world_triangles(lib, part, m)
    if not len(t):
        return Sprite(np.zeros((0, 0), bool), np.zeros((0, 0)), (0, 0))
    local = view.replace(offset=(0.0, 0.0)).project(t.reshape(-1, 3)).reshape(-1, 3, 3)
    lo = np.floor(local[:, :, :2].reshape(-1, 2).min(0)).astype(int) - pad
    hi = np.ceil(local[:, :, :2].reshape(-1, 2).max(0)).astype(int) + pad
    local[:, :, 0] -= lo[0]
    local[:, :, 1] -= lo[1]
    depth, label = rasterize(local, np.zeros(len(local), np.int64), (int(hi[1] - lo[1] + 1), int(hi[0] - lo[0] + 1)))
    return Sprite(label >= 0, depth, (int(lo[0]), int(lo[1])))
