"""Shaded software renderer for LDraw parts (synthetic training data, stage 2).

Painter's-algorithm orthographic raster with Lambert shading and thin dark edges.
It is deliberately simple: the goal is training images whose colour, shading and
stud/edge structure resemble the 3D-rendered build animations, not photorealism.
"""
from __future__ import annotations

import math
import random

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("part_render needs opencv-python-headless") from e

from assembly_model.ldraw import LDrawLibrary

INPUT = 64  # classifier input side (letterboxed)


class PartMesh:
    """Polygons of one part with precomputed flat normals."""

    def __init__(self, lib: LDrawLibrary, part: str):
        name = part if part.endswith(".dat") else part + ".dat"
        polys = [np.asarray(c, dtype=np.float32) for c in lib._tri_walk(name.lower(), np.eye(4)) if len(c) >= 3]
        self.part = part
        self.polys = polys
        self.n = len(polys)
        self.normals = np.zeros((self.n, 3), np.float32)
        self.cent = np.zeros((self.n, 3), np.float32)
        for i, p in enumerate(polys):
            nrm = np.cross(p[1] - p[0], p[2] - p[0])
            ln = float(np.linalg.norm(nrm))
            self.normals[i] = nrm / ln if ln > 1e-9 else (0, 0, 1)
            self.cent[i] = p.mean(0)
        # flat vertex array for fast projection
        self.sizes = np.array([len(p) for p in polys])
        self.verts = np.concatenate(polys) if polys else np.zeros((0, 3), np.float32)
        self.offsets = np.concatenate([[0], np.cumsum(self.sizes)])
        tri, poly = [], []
        for i in range(self.n):
            o = int(self.offsets[i])
            for k in range(1, int(self.sizes[i]) - 1):
                tri.append((o, o + k, o + k + 1))
                poly.append(i)
        self.tris = np.array(tri, np.int32).reshape(-1, 3)
        self.tri_poly = np.array(poly, np.int32)


def rotation(yaw: float, pitch: float, roll: float) -> np.ndarray:
    y, p, r = math.radians(yaw), math.radians(pitch), math.radians(roll)
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]], np.float32)
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]], np.float32)
    Rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]], np.float32)
    return Rz @ Rx @ Ry


def raster(px: np.ndarray, z: np.ndarray, tris: np.ndarray, tri_face: np.ndarray, face_nrm: np.ndarray,
           face_bgr: np.ndarray, light: np.ndarray, hw: tuple[int, int], edge: float = 0.5, jump: float = 2.0,
           depth_out: list | None = None):
    """Z-buffered raster of triangles (screen px (N,2), depth z (N,), smaller z = nearer).

    Faces are flat-shaded (Lambert + ambient); outlines are drawn where adjacent
    pixels differ in normal or jump in depth. Returns (bgr uint8 HxWx3, face-id HxW,
    -1 = background). If `depth_out` is a list, the z-buffer (inf = empty) is appended.
    """
    H, W = hw
    nr = face_nrm * np.where(face_nrm[:, 2] > 0, -1.0, 1.0)[:, None]  # face the camera (looks along +z)
    shade = 0.42 + 0.58 * np.clip(nr @ light, 0, 1)
    zbuf = np.full((H, W), np.inf, np.float32)
    fid = np.full((H, W), -1, np.int32)
    T = tris
    if len(T) == 0:
        return np.zeros((H, W, 3), np.uint8), fid
    P0, P1, P2 = px[T[:, 0]], px[T[:, 1]], px[T[:, 2]]
    z0, z1, z2 = z[T[:, 0]], z[T[:, 1]], z[T[:, 2]]
    x0 = np.maximum(0, np.floor(np.minimum(np.minimum(P0[:, 0], P1[:, 0]), P2[:, 0]))).astype(int)
    x1 = np.minimum(W - 1, np.ceil(np.maximum(np.maximum(P0[:, 0], P1[:, 0]), P2[:, 0]))).astype(int)
    y0 = np.maximum(0, np.floor(np.minimum(np.minimum(P0[:, 1], P1[:, 1]), P2[:, 1]))).astype(int)
    y1 = np.minimum(H - 1, np.ceil(np.maximum(np.maximum(P0[:, 1], P1[:, 1]), P2[:, 1]))).astype(int)
    for t in range(len(T)):
        xa, xb, ya, yb = x0[t], x1[t], y0[t], y1[t]
        if xb < xa or yb < ya:
            continue
        gx, gy = np.meshgrid(np.arange(xa, xb + 1) + 0.5, np.arange(ya, yb + 1) + 0.5)
        ax, ay = P0[t]
        bx, by = P1[t]
        cx, cy = P2[t]
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-9:
            continue
        w0 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / den
        w1 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / den
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue
        d = w0 * z0[t] + w1 * z1[t] + w2 * z2[t]
        zs = zbuf[ya : yb + 1, xa : xb + 1]
        win = inside & (d < zs)
        if win.any():
            zs[win] = d[win]
            fid[ya : yb + 1, xa : xb + 1][win] = tri_face[t]
    if depth_out is not None:
        depth_out.append(zbuf)
    covered = fid >= 0
    img = np.zeros((H, W, 3), np.float32)
    if covered.any():
        f = fid[covered]
        img[covered] = face_bgr[f] * shade[f][:, None]
        if edge:
            n_img = np.zeros((H, W, 3), np.float32)
            n_img[covered] = nr[f]
            d_img = np.where(covered, zbuf, 0).astype(np.float32)
            edge_m = np.zeros((H, W), bool)
            for dy, dx in ((0, 1), (1, 0)):
                a, b = covered[: H - dy, : W - dx], covered[dy:, dx:]
                na, nb = n_img[: H - dy, : W - dx], n_img[dy:, dx:]
                dd = np.abs(d_img[: H - dy, : W - dx] - d_img[dy:, dx:])
                diff = a & b & (((na * nb).sum(-1) < 0.88) | (dd > jump))
                # silhouette against background also gets a dark rim
                edge_m[: H - dy, : W - dx] |= diff
                edge_m[dy:, dx:] |= diff
            img[edge_m] *= edge
    return np.clip(img, 0, 255).astype(np.uint8), fid


def render(mesh: PartMesh, R: np.ndarray, rgb: tuple[int, int, int], light: np.ndarray, size: int = 128, edge: float = 0.5) -> np.ndarray | None:
    """Single part, auto-framed: tight-cropped BGR image on black, or None if empty."""
    if mesh.n == 0 or len(mesh.tris) == 0:
        return None
    v = mesh.verts @ R.T
    lo, hi = v[:, :2].min(0), v[:, :2].max(0)
    span = float(max(hi - lo))
    if span <= 1e-6:
        return None
    s = (size - 10) / span
    px = (v[:, :2] - lo) * s + 5.0
    face_bgr = np.tile(np.array(rgb[::-1], np.float32), (mesh.n, 1))
    img, fid = raster(px, v[:, 2], mesh.tris, mesh.tri_poly, mesh.normals @ R.T, face_bgr, light, (size, size), edge, 0.04 * span)
    covered = fid >= 0
    if not covered.any():
        return None
    ys, xs = np.where(covered)
    return img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def letterbox(img: np.ndarray, side: int = INPUT) -> np.ndarray:
    """Resize preserving aspect, centre on a black square (what the classifier sees)."""
    h, w = img.shape[:2]
    k = (side - 4) / max(h, w)
    nw, nh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    small = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    out = np.zeros((side, side, 3), np.uint8)
    y0, x0 = (side - nh) // 2, (side - nw) // 2
    out[y0 : y0 + nh, x0 : x0 + nw] = small
    return out


# Solid colours seen in the clips, as LDraw ids; resolved against LDConfig at runtime.
COLOUR_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 17, 19, 22, 25, 26, 27, 28, 29, 30, 31, 68, 69, 70, 71, 72, 73, 74,
              85, 86, 89, 92, 100, 110, 112, 115, 118, 120, 125, 191, 212, 226, 232, 272, 288, 308, 320, 321, 322, 323,
              326, 366, 378, 379, 484]


def random_view(rng: random.Random) -> np.ndarray:
    """Plausible build-animation orientations: mostly upright from above, some sideways (SNOT)."""
    yaw = rng.uniform(0, 360)
    pitch = rng.uniform(5, 80)
    roll = 0.0
    k = rng.random()
    if k < 0.22:
        roll = rng.choice((90, 180, 270)) + rng.uniform(-6, 6)
    elif k < 0.30:
        pitch = rng.uniform(-60, 5)
    return rotation(yaw, pitch, roll)


def random_light(rng: random.Random) -> np.ndarray:
    az, el = rng.uniform(0, 360), rng.uniform(35, 80)
    a, e = math.radians(az), math.radians(el)
    v = np.array([math.cos(e) * math.cos(a), -math.sin(e), -math.cos(e) * math.sin(a)], np.float32)
    # a light on the camera side so lit faces point toward -z
    v[2] = -abs(v[2])
    return v / np.linalg.norm(v)
