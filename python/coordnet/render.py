"""Booklet-style rendering with exact per-pixel ground truth (numpy + OpenCV, no GL).

`gbuffer` z-buffers the scene's triangles with the page camera (camera.py) and returns, per pixel centre, the
visible triangle's part index, depth (LDU from the eye), perspective-correct world xyz and face normal. All
triangles are rasterised at once: grouped by bounding-box size, each group is tested on a fixed pixel grid and
written with one np.minimum.at over (depth, triangle) keys, so cost is numpy work, not a Python loop per triangle.

`booklet_style` turns a G-buffer into the LEGO instruction look: flat part colour with mild shading, lines where
the part changes, the depth jumps or the surface folds (light lines on dark parts, dark lines on light parts),
grey paper, and the red outline around the new parts' own contour (red only where a new part's silhouette ends,
not where an earlier part in front hides it — the booklet's rule).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from .camera import TURN, BookletCamera, basis, project

ROOT = Path(__file__).resolve().parents[2]
LDRAW = ROOT / "public/ldraw"

# ------------------------------------------------------------------ geometry


_LIB: dict = {}


def library():
    if "lib" not in _LIB:
        from assembly_model.ldraw import load_library
        _LIB["lib"] = load_library(str(LDRAW))
    return _LIB["lib"]


_MESH: dict = {}


def part_triangles(part: str) -> np.ndarray:
    """(T, 3, 3) triangles of a part in its own frame; quads split in two."""
    name = (part if part.lower().endswith(".dat") else part + ".dat").lower()
    if name not in _MESH:
        from assembly_model.ldraw import _parse_file
        lib = library()
        out: list[np.ndarray] = []

        def walk(n: str, mat: np.ndarray, depth: int = 0) -> None:
            path = lib.find(n)
            if path is None or depth > 32:
                return
            tris, refs = _parse_file(path)
            for q in tris:
                q = q @ mat[:3, :3].T + mat[:3, 3]
                out.append(q[:3])
                if len(q) == 4:
                    out.append(q[[0, 2, 3]])
            for ref, sub in refs:
                walk(ref, mat @ sub, depth + 1)

        walk(name, np.eye(4))
        _MESH[name] = np.asarray(out, float).reshape(-1, 3, 3)
    return _MESH[name]


_EDGES: dict = {}


def part_lines(part: str) -> tuple[np.ndarray, np.ndarray]:
    """LDraw lines of a part in its own frame: edges [E,2,3] (type 2) and conditional lines [C,4,3] (type 5:
    p1, p2, control1, control2). Studio's instruction renderer draws exactly these (its edge-line macro)."""
    name = (part if part.lower().endswith(".dat") else part + ".dat").lower()
    if name not in _EDGES:
        from assembly_model.ldraw import _type1
        lib = library()
        e2: list[np.ndarray] = []
        e5: list[np.ndarray] = []
        cache: dict = {}

        def parse(path):
            if path not in cache:
                l2, l5, refs = [], [], []
                for line in open(path, errors="ignore").read().splitlines():
                    t = line.split()
                    if not t or t[0] not in ("1", "2", "5"):
                        continue
                    if t[0] == "1":
                        mat, ref = _type1(t)
                        if ref is not None:
                            refs.append((ref.lower(), mat))
                        continue
                    n = 2 if t[0] == "2" else 4
                    try:
                        v = np.array([float(x) for x in t[2:2 + 3 * n]], float).reshape(n, 3)
                    except ValueError:
                        continue
                    (l2 if n == 2 else l5).append(v)
                cache[path] = (np.array(l2).reshape(-1, 2, 3), np.array(l5).reshape(-1, 4, 3), refs)
            return cache[path]

        bores: list[np.ndarray] = []

        def walk(n: str, mat: np.ndarray, depth: int = 0) -> None:
            r = _bore_radius(n)
            if r:
                bores.append(np.concatenate([np.linalg.inv(mat).ravel(), [r]]))
            path = lib.find(n)
            if path is None or depth > 32:
                return
            l2, l5, refs = parse(path)
            if len(l2):
                e2.append(l2 @ mat[:3, :3].T + mat[:3, 3])
            if len(l5):
                e5.append(l5 @ mat[:3, :3].T + mat[:3, 3])
            for ref, sub in refs:
                walk(ref, mat @ sub, depth + 1)

        walk(name, np.eye(4))
        _EDGES[name] = (np.concatenate(e2) if e2 else np.zeros((0, 2, 3)),
                        np.concatenate(e5) if e5 else np.zeros((0, 4, 3)))
        _BORES[name] = np.array(bores).reshape(-1, 17)
    return _EDGES[name]


_BORES: dict = {}


def _bore_radius(ref: str) -> float:
    """Inner radius of an open stud / open tube primitive (the booklet draws their walls black), minus the radius
    of a solid tube (its side is drawn black), else 0."""
    b = ref.replace("\\", "/").split("/")[-1].lower()
    if re.fullmatch(r"stud4(a|o|s|f\w*)?\.dat", b):
        return 6.0
    if re.fullmatch(r"stud2a?\.dat", b):
        return 4.0
    if re.fullmatch(r"stud3a?\.dat", b):
        return -4.0                # solid tube (1 x n plates' underside): Studio draws its side black
    return 0.0


def bore_mask(parts: list, g: "GBuffer") -> np.ndarray:
    """[H,W] uint8: 1 = seen through an open stud / tube bore (floor or beyond), 2 = the bore's inner wall
    (Studio: wall black, floor in the part colour).
    Visible pixels inside a part's open stud / tube bores: within the bore radius of its axis, from the open
    end (primitive y = -4) inwards, including whatever is seen beyond the bore's floor (primitive y = 0)."""
    out = np.zeros(g.part.shape, bool)
    walls = np.zeros(g.part.shape, bool)
    for i, (p, _c, m) in enumerate(parts):
        part_lines(p)
        B = _BORES[(p if p.lower().endswith(".dat") else p + ".dat").lower()]
        if not len(B):
            continue
        sel = g.part == i
        if not sel.any():
            continue
        X = g.xyz[sel].astype(float)
        Minv = np.linalg.inv(np.asarray(m, float))
        X = X @ Minv[:3, :3].T + Minv[:3, 3]          # part frame
        inside = np.zeros(len(X), bool)
        wall = np.zeros(len(X), bool)
        for b in B:
            A = b[:16].reshape(4, 4)
            L = X @ A[:3, :3].T + A[:3, 3]           # primitive frame: axis = Y, open end at y = 0, bore to -4
            r2 = L[:, 0] ** 2 + L[:, 2] ** 2
            if b[16] < 0:          # solid tube: its outer side is drawn like a bore wall
                R0 = -b[16]
                wall |= (np.abs(np.sqrt(r2) - R0) < 0.35) & (L[:, 1] > -4.3) & (L[:, 1] < 0.3)
                continue
            core = (L[:, 1] > -4.3) & (L[:, 1] < 12)
            inside |= core & (r2 < (b[16] - 0.4) ** 2)
            wall |= core & (r2 >= (b[16] - 0.4) ** 2) & (r2 < (b[16] + 0.3) ** 2) & (L[:, 1] < -0.3)
        out[sel] = inside
        walls[sel] = wall & ~inside
    return np.where(walls, 2, np.where(out, 1, 0)).astype(np.uint8)


def scene_lines(parts: list) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(edges [E,2,3], edge part [E], conditional [C,4,3], conditional part [C]) in world space."""
    E, Ei, C, Ci = [], [], [], []
    for i, (p, _c, m) in enumerate(parts):
        e, c = part_lines(p)
        m = np.asarray(m, float)
        if len(e):
            E.append(e @ m[:3, :3].T + m[:3, 3]); Ei.append(np.full(len(e), i, np.int32))
        if len(c):
            C.append(c @ m[:3, :3].T + m[:3, 3]); Ci.append(np.full(len(c), i, np.int32))
    cat = lambda xs, shape: np.concatenate(xs) if xs else np.zeros(shape)
    return cat(E, (0, 2, 3)), cat(Ei, (0,)).astype(np.int32), cat(C, (0, 4, 3)), cat(Ci, (0,)).astype(np.int32)


def line_mask(edges: np.ndarray, edge_part: np.ndarray, cond: np.ndarray, cond_part: np.ndarray, g: "GBuffer",
              cam: BookletCamera, centre, ss: int, eps: float = 0.5) -> np.ndarray:
    """Pixels (at the G-buffer's resolution) covered by visible LDraw lines.

    Conditional lines are drawn when both control points project on the same side of the line (the LDraw rule:
    a curved surface's silhouette). A line sample is visible when it is no more than `eps` LDU behind the visible
    surface at its pixel (plus one pixel's depth footprint), so hidden edges of the same part stay hidden.
    """
    H, W = g.part.shape
    c = cam.with_(scale=cam.scale * ss, cx=cam.cx * ss, cy=cam.cy * ss)
    segs, sp = edges, edge_part
    if len(cond):
        uv, _ = project(c, centre, cond.reshape(-1, 3))
        uv = uv.reshape(-1, 4, 2)
        d = uv[:, 1] - uv[:, 0]
        side = lambda q: d[:, 0] * (q[:, 1] - uv[:, 0, 1]) - d[:, 1] * (q[:, 0] - uv[:, 0, 0])
        keep = side(uv[:, 2]) * side(uv[:, 3]) > 0
        segs = np.concatenate([segs, cond[keep, :2]])
        sp = np.concatenate([sp, cond_part[keep]])
    mask = np.zeros(H * W, bool)
    if not len(segs):
        return mask.reshape(H, W)
    uv, z = project(c, centre, segs.reshape(-1, 3))
    uv = uv.reshape(-1, 2, 2)
    n = np.clip(np.ceil(np.linalg.norm(uv[:, 1] - uv[:, 0], axis=1) * 2).astype(int) + 1, 2, 4000)
    seg = np.repeat(np.arange(len(segs)), n)
    t = (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)) / np.repeat(n - 1, n)
    P = segs[seg, 0] + t[:, None] * (segs[seg, 1] - segs[seg, 0])
    puv, pz = project(c, centre, P)
    x = np.floor(puv[:, 0]).astype(np.int64)
    y = np.floor(puv[:, 1]).astype(np.int64)
    ok = (x >= 0) & (x < W) & (y >= 0) & (y < H)
    x, y, pz, seg = x[ok], y[ok], pz[ok], seg[ok]
    flat = y * W + x
    # an edge lies where faces meet, so compare with the deepest surface around its pixel (3x3): the face it
    # belongs to is always among them; samples that fail it are behind something by more than that
    dmax = cv2.dilate(np.where(np.isfinite(g.depth), g.depth, 1e9).astype(np.float32), np.ones((3, 3), np.uint8))
    gd = dmax.reshape(-1)[flat]
    gp = g.part.reshape(-1)[flat]
    # a line on the visible surface is within about a pixel's depth footprint of it; anything further is hidden
    vis = pz <= gd + eps + 1.5 / c.scale
    mask[flat[vis]] = True
    return mask.reshape(H, W)


def scene(parts: list) -> tuple[np.ndarray, np.ndarray]:
    """parts: [(part, colour, 4x4 row-major world matrix)] -> (triangles [T,3,3] world, part index [T])."""
    tris, idx = [], []
    for i, (p, _c, m) in enumerate(parts):
        t = part_triangles(p)
        if not len(t):
            continue
        m = np.asarray(m, float)
        tris.append(t @ m[:3, :3].T + m[:3, 3])
        idx.append(np.full(len(t), i, np.int32))
    if not tris:
        return np.zeros((0, 3, 3)), np.zeros(0, np.int32)
    return np.concatenate(tris), np.concatenate(idx)


def bounds_centre(parts: list) -> np.ndarray:
    """Centre of the parts' bounding box (the page's scene centre)."""
    t, _ = scene(parts)
    p = t.reshape(-1, 3)
    return (p.min(0) + p.max(0)) / 2


# ------------------------------------------------------------------ rasteriser


@dataclass
class GBuffer:
    part: np.ndarray      # [H,W] int32, -1 = background
    depth: np.ndarray     # [H,W] float32, LDU from the eye (inf on background)
    xyz: np.ndarray       # [H,W,3] float32 world point (nan on background)
    normal: np.ndarray    # [H,W,3] float32 face normal facing the camera
    tri: np.ndarray       # [H,W] int32 triangle index


_BUCKETS = (2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096)


def gbuffer(tris: np.ndarray, tri_part: np.ndarray, cam: BookletCamera, centre, W: int, H: int,
            ss: int = 1) -> GBuffer:
    """Rasterise at ss x ss samples per pixel (sample centres at (k + 0.5) / ss)."""
    Ws, Hs = W * ss, H * ss
    c = cam.with_(scale=cam.scale * ss, cx=cam.cx * ss, cy=cam.cy * ss)
    T = len(tris)
    part = np.full(Hs * Ws, -1, np.int32)
    tri_of = np.full(Hs * Ws, -1, np.int64)
    if T == 0:
        return _empty(Hs, Ws)
    uv, z = project(c, centre, tris.reshape(-1, 3))
    uv = uv.reshape(T, 3, 2)
    z = z.reshape(T, 3)
    persp = cam.eye > 0
    ok = (z > 1e-3).all(1) if persp else np.isfinite(z).all(1)
    zmin = float(z[ok].min()) - 1.0 if ok.any() else 0.0   # keys need non-negative depth
    x0 = np.ceil(uv[..., 0].min(1) - 0.5).astype(np.int64)
    x1 = np.floor(uv[..., 0].max(1) - 0.5).astype(np.int64)
    y0 = np.ceil(uv[..., 1].min(1) - 0.5).astype(np.int64)
    y1 = np.floor(uv[..., 1].max(1) - 0.5).astype(np.int64)
    x0c, x1c, y0c, y1c = np.maximum(x0, 0), np.minimum(x1, Ws - 1), np.maximum(y0, 0), np.minimum(y1, Hs - 1)
    a, b, cc = uv[:, 0], uv[:, 1], uv[:, 2]
    area = (b[:, 0] - a[:, 0]) * (cc[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (cc[:, 0] - a[:, 0])
    ok &= (x1c >= x0c) & (y1c >= y0c) & (np.abs(area) > 1e-12)
    size = np.maximum(x1c - x0c + 1, y1c - y0c + 1)
    zq_scale = 64.0                       # depth quantum 1/64 LDU in the key
    key = np.full(Hs * Ws, np.iinfo(np.int64).max, np.int64)
    lo = 0
    for B in _BUCKETS:
        sel = np.nonzero(ok & (size > lo) & (size <= B))[0]
        lo = B
        if not len(sel):
            continue
        chunk = max(1, 4_000_000 // (B * B))
        gy, gx = np.mgrid[0:B, 0:B]
        gx, gy = gx.ravel(), gy.ravel()
        for s in range(0, len(sel), chunk):
            t = sel[s:s + chunk]
            px = x0c[t, None] + gx[None]
            py = y0c[t, None] + gy[None]
            inside = (px <= x1c[t, None]) & (py <= y1c[t, None])
            fx, fy = px + 0.5, py + 0.5
            w0, w1, w2 = _bary(uv[t], fx, fy, area[t])
            inside &= (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
            zt = z[t]
            if persp:
                inv = w0 / zt[:, 0:1] + w1 / zt[:, 1:2] + w2 / zt[:, 2:3]
                d = 1.0 / inv
            else:
                d = w0 * zt[:, 0:1] + w1 * zt[:, 1:2] + w2 * zt[:, 2:3]
            ti, pi = np.nonzero(inside)
            flat = py[ti, pi] * Ws + px[ti, pi]
            k = (np.round((d[ti, pi] - zmin) * zq_scale).astype(np.int64) << 24) | t[ti].astype(np.int64)
            np.minimum.at(key, flat, k)
    hit = key != np.iinfo(np.int64).max
    tri_of[hit] = key[hit] & ((1 << 24) - 1)
    part[hit] = tri_part[tri_of[hit]]
    # exact attributes at the winning triangle
    depth = np.full(Hs * Ws, np.inf, np.float64)
    xyz = np.full((Hs * Ws, 3), np.nan, np.float64)
    normal = np.zeros((Hs * Ws, 3), np.float64)
    pix = np.nonzero(hit)[0]
    if len(pix):
        t = tri_of[pix]
        fx = (pix % Ws) + 0.5
        fy = (pix // Ws) + 0.5
        w0, w1, w2 = _bary(uv[t], fx[:, None], fy[:, None], area[t])
        w0, w1, w2 = w0[:, 0], w1[:, 0], w2[:, 0]
        zt = z[t]
        P = tris[t]
        if persp:
            inv = w0 / zt[:, 0] + w1 / zt[:, 1] + w2 / zt[:, 2]
            depth[pix] = 1.0 / inv
            xyz[pix] = (w0[:, None] * P[:, 0] / zt[:, 0:1] + w1[:, None] * P[:, 1] / zt[:, 1:2]
                        + w2[:, None] * P[:, 2] / zt[:, 2:3]) / inv[:, None]
        else:
            depth[pix] = w0 * zt[:, 0] + w1 * zt[:, 1] + w2 * zt[:, 2]
            xyz[pix] = w0[:, None] * P[:, 0] + w1[:, None] * P[:, 1] + w2[:, None] * P[:, 2]
        n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        # face the camera. Eye position / view axis in the (unturned) model frame: TURN is its own inverse.
        _, _, back = basis(cam)
        T = TURN if cam.turned else np.eye(3)
        if persp:
            towards = T @ (T @ np.asarray(centre, float) + back * cam.eye) - xyz[pix]
        else:
            towards = np.broadcast_to(T @ back, n.shape)
        flip = (n * towards).sum(1) < 0
        n[flip] *= -1
        normal[pix] = n
    return GBuffer(part.reshape(Hs, Ws), depth.reshape(Hs, Ws).astype(np.float32),
                   xyz.reshape(Hs, Ws, 3).astype(np.float32), normal.reshape(Hs, Ws, 3).astype(np.float32),
                   tri_of.reshape(Hs, Ws).astype(np.int32))


def _bary(uvt, fx, fy, area):
    a, b, c = uvt[:, 0], uvt[:, 1], uvt[:, 2]
    w0 = ((b[:, 0:1] - fx) * (c[:, 1:2] - fy) - (b[:, 1:2] - fy) * (c[:, 0:1] - fx)) / area[:, None]
    w1 = ((c[:, 0:1] - fx) * (a[:, 1:2] - fy) - (c[:, 1:2] - fy) * (a[:, 0:1] - fx)) / area[:, None]
    return w0, w1, 1.0 - w0 - w1


def _empty(H, W):
    return GBuffer(np.full((H, W), -1, np.int32), np.full((H, W), np.inf, np.float32),
                   np.full((H, W, 3), np.nan, np.float32), np.zeros((H, W, 3), np.float32), np.full((H, W), -1, np.int32))


# ------------------------------------------------------------------ booklet style


@lru_cache(maxsize=1)
def colour_table() -> dict[int, tuple[int, int, int]]:
    """Studio's instruction colours (studio_colours.json), falling back to LDConfig for codes Studio lacks."""
    out = _ldconfig()
    studio = json.loads((Path(__file__).with_name("studio_colours.json")).read_text())["colours"]
    out.update({int(k): tuple(v) for k, v in studio.items()})
    return out


def _ldconfig() -> dict[int, tuple[int, int, int]]:
    out = {}
    for line in (LDRAW / "LDConfig.ldr").read_text(errors="ignore").splitlines():
        m = re.search(r"CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})", line)
        if m:
            h = m.group(2)
            out[int(m.group(1))] = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return out


@dataclass
class Style:
    paper: tuple = (137, 142, 146)            # booklet grey
    black: tuple = (42, 42, 44)               # booklet draws LDraw black as a neutral dark grey
    top: float = 0.92                        # brightness of faces at the usual booklet pitch
    side: float = 1.22                       # relative brightness of faces looking straight at the camera
    light: tuple = (-0.35, -1.0, 0.45)        # LDraw -Y is up
    light_line: tuple = (205, 208, 210)       # lines on dark parts
    dark_line: tuple = (25, 27, 29)           # lines on light parts and outer outlines
    line_px: float = 1.5                      # line width at picture resolution
    crease_deg: float = 35.0
    red: tuple = (205, 30, 38)
    red_px: float = 2.6
    red_over: bool = False                   # red band also across earlier parts in front
    blur: float = 0.0
    noise: float = 0.0
    chroma: float = 0.3
    white: float = 0.96
    gain: float = 1.0                        # booklet colours are lighter than LDConfig's
    ao_radius: float = 8.0                   # LDU
    ao_floor: float = 0.25                   # AO below this leaves the colour alone
    ao_gamma: float = 0.7
    bore_floor: float = 0.85
    bore: tuple = (22, 23, 25)               # inside open studs and tubes
    cavity: float = 0.0                      # darkening of pits (stud holes, tubes) seen from above

    @staticmethod
    def random(rng: np.random.Generator) -> "Style":
        g = rng.integers(120, 160)
        return Style(paper=tuple(int(g + rng.integers(-6, 7)) for _ in range(3)),
                     black=tuple(int(v) for v in rng.integers(30, 58, 3)),
                     top=float(rng.uniform(0.9, 1.05)), side=float(rng.uniform(1.0, 1.4)),
                     light=tuple(rng.normal([-0.35, -1.0, 0.45], 0.3)),
                     light_line=tuple(int(v) for v in rng.integers(170, 240, 3)),
                     dark_line=tuple(int(v) for v in rng.integers(0, 50, 3)),
                     line_px=float(rng.uniform(0.9, 2.0)), crease_deg=float(rng.uniform(25, 45)),
                     red=(int(rng.integers(180, 235)), int(rng.integers(0, 60)), int(rng.integers(10, 70))),
                     red_px=float(rng.uniform(1.8, 3.6)), red_over=bool(rng.random() < 0.3), blur=float(rng.choice([0, 0, 0.4, 0.7])),
                     noise=float(rng.choice([0, 0, 2, 4])), cavity=float(rng.choice([0.0, 0.0, 0.3, 0.6])), bore=tuple(int(v) for v in rng.integers(5, 45, 3)), bore_floor=float(rng.uniform(0.7, 1.0)), ao_radius=float(rng.uniform(6, 12)), ao_floor=float(rng.uniform(0.15, 0.35)), ao_gamma=float(rng.uniform(0.5, 1.0)), gain=float(rng.uniform(0.92, 1.12)), chroma=float(rng.uniform(0.3, 1.0)), white=float(rng.uniform(0.9, 1.0)))


def _boundaries(g: GBuffer, crease_deg: float, px_ldu: float) -> np.ndarray:
    """Pixels on a line: part change, depth step (> 3 pixel footprints) or a fold sharper than crease_deg."""
    H, W = g.part.shape
    line = np.zeros((H, W), bool)
    cosk = np.cos(np.radians(crease_deg))
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        a = (slice(0, H - dy), slice(max(0, -dx), W - max(0, dx)))
        b = (slice(dy, H), slice(max(0, dx), W - max(0, -dx)) if dx >= 0 else slice(0, W + dx))
        if dx < 0:
            a = (slice(0, H - dy), slice(-dx, W))
            b = (slice(dy, H), slice(0, W + dx))
        pa, pb = g.part[a], g.part[b]
        diff = pa != pb
        both = (pa >= 0) & (pb >= 0)
        gap = np.linalg.norm(g.xyz[a] - g.xyz[b], axis=-1)
        step = np.where(both, gap > 3.0 * px_ldu * (1.5 if dx and dy else 1.0), False)
        fold = both & ((g.normal[a] * g.normal[b]).sum(-1) < cosk)
        e = diff | step | fold
        # the nearer side carries the line (a contour belongs to the part in front)
        da, db = g.depth[a], g.depth[b]
        near_a = da <= db
        line[a] |= e & near_a
        line[b] |= e & ~near_a
    return line


def booklet_style(gss: GBuffer, parts: list, new: set[int], own_new: np.ndarray | None, style: Style,
                  ss: int, scale: float, rng: np.random.Generator | None = None,
                  lines: np.ndarray | None = None, bores: np.ndarray | None = None,
                  view: np.ndarray | None = None) -> np.ndarray:
    """RGB uint8 picture at 1/ss of the G-buffer resolution.

    parts: [(part, colour, matrix)] (the G-buffer's part indices); new: indices of the step's new parts;
    own_new: [Hs,Ws] bool silhouette of the new parts alone (None = no red outline).
    """
    H, W = gss.part.shape
    table = colour_table()
    def tone(c):
        if c == 0:
            return np.array(style.black, float)
        v = np.array(table.get(int(c), (150, 150, 150)), float)
        grey = v @ np.array([0.3, 0.59, 0.11])
        v = grey + style.chroma * (v - grey)              # the printed booklet is close to neutral
        return np.clip(np.maximum(v * style.gain, style.black), 0, 255 * style.white)
    cols = np.array([tone(c) for _p, c, _m in parts] + [style.paper], float)
    lum = cols @ np.array([0.3, 0.59, 0.11]) / 255
    idx = np.where(gss.part >= 0, gss.part, len(parts))
    # Studio lights from the camera: faces turned to the viewer are brightest. Normalised so a face at the
    # booklet's usual 35 degree pitch (top faces) gets `top`, a face looking straight at the camera `top*side`.
    v = np.asarray(view if view is not None else (0.0, -0.57, 0.82), float)
    v /= np.linalg.norm(v)
    nv = np.clip(gss.normal @ v, 0, 1)
    k = (style.side - 1) / (1 - 0.574)
    shade = style.top * (1 + k * (nv - 0.574))
    if style.cavity:
        # ambient occlusion (Studio's real-time look darkens tube interiors, stud holes and gaps nearly black)
        shade = shade * (1 - style.cavity * np.clip((ambient_occlusion(gss, scale * ss, style.ao_radius) - style.ao_floor)
                                                     / (1 - style.ao_floor), 0, 1) ** style.ao_gamma)
    img = cols[idx] * np.where(gss.part >= 0, shade, 1.0)[..., None]
    if bores is not None:
        # Studio draws a bore's inner wall nearly black; its floor keeps the part colour, a little darker
        img = np.where((bores == 2)[..., None], np.array(style.bore, float), img)
        img = np.where((bores == 1)[..., None], img * style.bore_floor, img)
    # lines (computed at the supersampled resolution, width set at picture resolution)
    line = _boundaries(gss, 181.0, 1.0 / (scale * ss))
    if lines is not None:
        line |= lines
    r = max(1, int(round(style.line_px * ss / 2)))
    if r > 1 or style.line_px * ss > 1.5:
        line = cv2.dilate(line.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r - 1, 2 * r - 1))).astype(bool)
    on_dark = lum[idx] < 0.33
    outer = gss.part < 0
    # a part's outline against the paper stays dark; inside dark parts lines are light
    lc = np.where((on_dark & ~_touches(outer, 2 * ss))[..., None], np.array(style.light_line, float),
                  np.array(style.dark_line, float))
    img = np.where(line[..., None], lc, img)
    if own_new is not None and new:
        img = _red_outline(img, gss.part, new, own_new, style, ss)
    out = cv2.resize(img.astype(np.float32), (W // ss, H // ss), interpolation=cv2.INTER_AREA)
    if style.blur:
        out = cv2.GaussianBlur(out, (0, 0), style.blur)
    if style.noise and rng is not None:
        out = out + rng.normal(0, style.noise, out.shape)
    return np.clip(out, 0, 255).astype(np.uint8)


def ambient_occlusion(g: GBuffer, px_per_ldu: float, radius: float = 8.0, dirs: int = 8,
                      steps: int = 12) -> np.ndarray:
    """Horizon-based AO from the G-buffer: for each of `dirs` screen directions, the steepest rise (sine of the
    elevation above the tangent plane) of any visible point within `radius` LDU; AO = mean over directions."""
    H, W = g.part.shape
    P = np.nan_to_num(g.xyz.astype(np.float32), nan=1e6)
    N = g.normal.astype(np.float32)
    hit = g.part >= 0
    rpx = max(2.0, radius * px_per_ldu)
    ao = np.zeros((H, W), np.float32)
    for a in np.linspace(0, 2 * np.pi, dirs, endpoint=False):
        best = np.zeros((H, W), np.float32)
        for k in np.linspace(1.0, rpx, steps):
            dx, dy = int(round(np.cos(a) * k)), int(round(np.sin(a) * k))
            if dx == 0 and dy == 0:
                continue
            Q = np.full_like(P, 1e6)
            ys, yd = slice(max(dy, 0), H + min(dy, 0)), slice(max(-dy, 0), H + min(-dy, 0))
            xs, xd = slice(max(dx, 0), W + min(dx, 0)), slice(max(-dx, 0), W + min(-dx, 0))
            Q[yd, xd] = P[ys, xs]
            v = Q - P
            dist = np.linalg.norm(v, axis=-1) + 1e-6
            sin_e = (v * N).sum(-1) / dist
            best = np.maximum(best, np.where(dist < radius, sin_e, 0))
        ao += best
    return np.where(hit, ao / dirs, 0)


def _pits(depth: np.ndarray, r: int, step: float) -> np.ndarray:
    d = np.where(np.isfinite(depth), depth, 1e9)
    H, W = d.shape
    walls = np.ones((H, W), bool)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        hit = np.zeros((H, W), bool)
        for k in range(1, r + 1):
            q = np.full((H, W), 1e9)
            ys, yd = slice(max(dy * k, 0), H + min(dy * k, 0)), slice(max(-dy * k, 0), H + min(-dy * k, 0))
            xs, xd = slice(max(dx * k, 0), W + min(dx * k, 0)), slice(max(-dx * k, 0), W + min(-dx * k, 0))
            q[yd, xd] = d[ys, xs]
            hit |= q < d - step
        walls &= hit
    return walls & np.isfinite(depth)


def _touches(mask: np.ndarray, r: int) -> np.ndarray:
    return cv2.dilate(mask.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)).astype(bool)


def red_rim(part: np.ndarray, new: set[int], own_new: np.ndarray) -> np.ndarray:
    """Boundary pixels of the new parts' visible area where the pixel beyond is outside their own silhouette."""
    vis = np.isin(part, list(new))
    H, W = vis.shape
    rim = np.zeros_like(vis)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        q_vis = np.zeros_like(vis)
        q_own = np.zeros_like(vis)
        ys = slice(max(dy, 0), H + min(dy, 0))
        yd = slice(max(-dy, 0), H + min(-dy, 0))
        xs = slice(max(dx, 0), W + min(dx, 0))
        xd = slice(max(-dx, 0), W + min(-dx, 0))
        q_vis[yd, xd] = vis[ys, xs]
        q_own[yd, xd] = own_new[ys, xs]
        rim |= vis & ~q_vis & ~q_own
    edge = np.zeros_like(vis)
    edge[0, :] = edge[-1, :] = True
    edge[:, 0] = edge[:, -1] = True
    return rim | (vis & edge)


def red_band(part: np.ndarray, new: set[int], own_new: np.ndarray, px: float, over_occluders: bool) -> np.ndarray:
    """Studio's new-part highlight (cakeslice OutlineEffect): pixels outside the new parts' own silhouette within
    `px` of it. over_occluders=False keeps only the band next to visible new pixels (not across earlier parts
    in front)."""
    r = max(1, int(round(px)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    src = own_new if over_occluders else (np.isin(part, list(new)) & own_new)
    return cv2.dilate(src.astype(np.uint8), k).astype(bool) & ~own_new


def _red_outline(img, part, new, own_new, style, ss):
    band = red_band(part, new, own_new, style.red_px * ss, style.red_over)
    return np.where(band[..., None], np.array(style.red, float), img)


# ------------------------------------------------------------------ one call


@dataclass
class Rendered:
    picture: np.ndarray           # [H,W,3] uint8
    gt: GBuffer                   # at pixel centres (ss = 1)
    new_visible: np.ndarray       # [H,W] bool
    red: np.ndarray | None = None  # [H,W] bool red rim at picture resolution (ss = 1)
    extra: dict = field(default_factory=dict)


def render(parts: list, new: set[int], cam: BookletCamera, centre, W: int, H: int, style: Style | None = None,
           ss: int = 2, red: bool = True, rng: np.random.Generator | None = None) -> Rendered:
    style = style or Style()
    tris, tp = scene(parts)
    gss = gbuffer(tris, tp, cam, centre, W, H, ss)
    own = None
    if red and new:
        sel = np.isin(tp, list(new))
        own = gbuffer(tris[sel], tp[sel], cam, centre, W, H, ss).part >= 0
    E, Ei, C, Ci = scene_lines(parts)
    lines = line_mask(E, Ei, C, Ci, gss, cam, centre, ss)
    _, _, back = basis(cam)
    view = (TURN @ back) if cam.turned else back           # towards the camera, in the model frame
    pic = booklet_style(gss, parts, new, own, style, ss, cam.scale, rng, lines, bore_mask(parts, gss), view)
    gt = gbuffer(tris, tp, cam, centre, W, H, 1)
    newvis = np.isin(gt.part, list(new)) if new else np.zeros(gt.part.shape, bool)
    red_mask = None
    if own is not None:
        own1 = gbuffer(tris[np.isin(tp, list(new))], tp[np.isin(tp, list(new))], cam, centre, W, H, 1).part >= 0
        red_mask = red_band(gt.part, new, own1, style.red_px, style.red_over)
    return Rendered(pic, gt, newvis, red_mask)
