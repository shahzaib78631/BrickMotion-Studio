"""Instruction step-image -> 3D placement (research prototype).

The goal: reconstruct a model's per-piece grid poses from a LEGO instruction
booklet, for sets that have no MPD. Nothing here is trained; it is
analysis-by-synthesis (inverse rendering) plus discrete search, grounded in
orthographic axonometric projection.

Math
----
LEGO instructions are drawn with an orthographic (axonometric) camera. A world
point p (LDraw: x right, y down, z front) is viewed through a rotation

    R = Rx(pitch) @ Ry(yaw)

and projected to the image plane with a uniform scale s and offset o:

    u = s * (R p)_x + o_x
    v = -s * (R p)_y + o_y          # screen v grows downward; up is -y
    depth = (R p)_z

A part is a set of part-space vertices; a placement is a 4x4 affine M, so world
vertices are M @ v. Its silhouette is the convex hull of the projected vertices
(a convex approximation that keeps this fast and is adequate for block parts).

Placement of a part is:  argmin_{pose}  cost(pose)
  cost = w_c * colourMismatch + w_s * (1 - silhouetteIoU)
         + collisionPenalty + supportPenalty
searched over grid poses (x, z, y from support, rot in {0,90,180,270}).

Status (measured on BrickHeadz 41600 Aquaman, OMR as ground truth)
-------------------------------------------------------------------
- camera + convex-hull renderer: working.
- calibration by silhouette IoU against the booklet step photo: best ~0.30 at
  (yaw 10, pitch 25). The renderer is sound; the STEP-IMAGE preprocessing
  (tight crop / background & outline removal / per-step camera fit) is not yet
  good enough for reliable placement. This is the next work item, not a
  reason to trust a from-images assembly yet.
"""
from __future__ import annotations

import math
import itertools
from dataclasses import dataclass

import numpy as np

# ---------------------------------------------------------------- camera -----


def rotation(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    t, q = math.radians(yaw_deg), math.radians(pitch_deg)
    ry = np.array([[math.cos(t), 0, math.sin(t)], [0, 1, 0], [-math.sin(t), 0, math.cos(t)]])
    rx = np.array([[1, 0, 0], [0, math.cos(q), -math.sin(q)], [0, math.sin(q), math.cos(q)]])
    return rx @ ry


@dataclass
class Camera:
    yaw: float = 30.0
    pitch: float = 25.0
    scale: float = 1.0
    ox: float = 0.0
    oy: float = 0.0

    @property
    def r(self) -> np.ndarray:
        return rotation(self.yaw, self.pitch)

    def project(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """world (N,3) LDU -> (u, v, depth)."""
        p = np.asarray(pts, float) @ self.r.T
        return self.scale * p[:, 0] + self.ox, -self.scale * p[:, 1] + self.oy, p[:, 2]


def fit_camera(points: np.ndarray, yaw: float, pitch: float, size: int, pad: int = 6) -> Camera:
    """Camera that fits the projected LDU points into a size×size canvas."""
    cam = Camera(yaw, pitch)
    u, v, _ = cam.project(points)
    span = max(float(u.max() - u.min()), float(v.max() - v.min())) or 1.0
    s = (size - 2 * pad) / span
    return Camera(yaw, pitch, s, pad - u.min() * s, pad - v.min() * s)


# --------------------------------------------------------------- geometry ----


def part_vertices(lib, part: str) -> np.ndarray:
    """All part-space vertices (LDraw LDU). Convex hull only needs vertices."""
    tri = lib.triangles(part if part.endswith(".dat") else part + ".dat")
    return np.asarray(tri, float) if tri.size else np.zeros((0, 3))


def plane_hull(points: np.ndarray) -> np.ndarray:
    """Convex hull (monotone chain) of 2D points, counter-clockwise."""
    pts = sorted(set(map(tuple, points)))
    if len(pts) < 3:
        return np.array(pts)
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])


def fill_polygon(mask: np.ndarray, poly: np.ndarray) -> None:
    size = mask.shape[0]
    if len(poly) < 3:
        return
    y0 = max(0, int(math.floor(poly[:, 1].min())))
    y1 = min(size - 1, int(math.ceil(poly[:, 1].max())))
    for y in range(y0, y1 + 1):
        yc = y + 0.5
        xs = []
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            if (a[1] <= yc < b[1]) or (b[1] <= yc < a[1]):
                xs.append(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            lo = max(0, int(math.ceil(xs[i])))
            hi = min(size, int(math.floor(xs[i + 1])) + 1)
            if hi > lo:
                mask[y, lo:hi] = True


def render(lib, pieces, cam: Camera, size: int):
    """Painter's-algorithm convex-hull render. `pieces` are Pieces (base_part,matrix,color)."""
    polys, allu, allv = [], [], []
    for p in pieces:
        part = getattr(p, "base_part", None) or getattr(p, "part", "")
        v = part_vertices(lib, part)
        if not len(v):
            continue
        m = p.matrix
        w = v @ m[:3, :3].T + m[:3, 3]
        u, vv, d = cam.project(w)
        polys.append((u, vv, d.mean(), p.color))
        allu.append(u); allv.append(vv)
    if not polys:
        return np.zeros((size, size), bool), None, []
    # normalise this candidate set into the canvas using its own projected bbox
    u = np.concatenate(allu)
    v = np.concatenate(allv)
    span = max(float(u.max() - u.min()), float(v.max() - v.min())) or 1.0
    s = (size - 12) / span
    ox, oy = 6 - u.min() * s, 6 - v.min() * s
    mask = np.zeros((size, size), bool)
    order = sorted(range(len(polys)), key=lambda i: -polys[i][2])  # back (+depth) first
    for i in order:
        pu, pv, _d, _c = polys[i]
        fill_polygon(mask, plane_hull(np.stack([pu * s + ox, pv * s + oy], 1)))
    return mask, None, order


# ------------------------------------------------------------- calibration ---


def foreground_mask(rgb: np.ndarray, tol: float = 26.0) -> np.ndarray:
    corners = np.stack([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]])
    bg = np.median(corners, axis=0)
    return np.linalg.norm(rgb.astype(float) - bg, axis=-1) > tol


def normalise_mask(mask: np.ndarray, size: int) -> np.ndarray:
    ys, xs = np.where(mask)
    if not ys.size:
        return np.zeros((size, size), bool)
    crop = mask[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]
    yi = (np.arange(size) * crop.shape[0] // size)
    xi = (np.arange(size) * crop.shape[1] // size)
    return crop[yi][:, xi]


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum()) / max(1, int((a | b).sum()))


def calibrate(lib, pieces, image_mask: np.ndarray, yaws=range(10, 61, 5), pitches=range(5, 51, 5), size: int = 96):
    """Best (yaw, pitch) by silhouette IoU against a normalised step-image mask."""
    target = normalise_mask(image_mask, size)
    best = (0.0, None)
    for yaw in yaws:
        for pitch in pitches:
            mask, _, _ = render(lib, pieces, Camera(yaw, pitch), size)
            v = iou(normalise_mask(mask, size), target)
            if v > best[0]:
                best = (v, (yaw, pitch))
    return best


# ------------------------------------------- analysis-by-synthesis solver ----

BACKGROUND = (211, 236, 247)
BUILT_GREY = (150, 150, 150)


def world_points(lib, part: str, matrix: np.ndarray) -> np.ndarray:
    v = part_vertices(lib, part)
    return v @ matrix[:3, :3].T + matrix[:3, 3]


def _erode(m: np.ndarray) -> np.ndarray:
    r = m.copy()
    r[1:, :] &= m[:-1, :]
    r[:-1, :] &= m[1:, :]
    r[:, 1:] &= m[:, :-1]
    r[:, :-1] &= m[:, 1:]
    return r


def components(mask: np.ndarray, max_n: int = 64):
    """Connected components (4-connectivity), largest first."""
    seen = np.zeros_like(mask, bool)
    comps = []
    h, w = mask.shape
    ys, xs = np.where(mask)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        pix = []
        while stack:
            y, x = stack.pop()
            pix.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        m = np.zeros_like(mask)
        py = np.array([p[0] for p in pix]); px = np.array([p[1] for p in pix])
        m[py, px] = True
        comps.append(m)
        if len(comps) >= max_n:
            break
    comps.sort(key=lambda c: -int(c.sum()))
    return comps


def render_pieces(lib, entries, cam: Camera, size: int, bg=BACKGROUND, grey=BUILT_GREY):
    """Render with an ABSOLUTE camera (no refit). entries = (part, rgb, matrix, is_new).

    Built pieces are drawn first (grey), new pieces on top (instruction style),
    each with a thin dark outline so adjacent same-colour pieces stay separable.
    """
    rgb = np.tile(np.array(bg, float), (size, size, 1))
    built = [(e, float(cam.project(world_points(lib, e[0], e[2]))[2].mean())) for e in entries if not e[3]]
    new = [(e, float(cam.project(world_points(lib, e[0], e[2]))[2].mean())) for e in entries if e[3]]
    mask = np.zeros((size, size), bool)
    for (part, colour, m, is_new), _d in sorted(built, key=lambda t: t[1]) + sorted(new, key=lambda t: t[1]):
        u, v, _ = cam.project(world_points(lib, part, m))
        mk = np.zeros((size, size), bool)
        fill_polygon(mk, plane_hull(np.stack([u, v], 1)))
        edge = mk & ~_erode(mk)
        rgb[mk] = np.array(colour if is_new else grey, float)
        rgb[edge] = np.array([70, 70, 70], float)
        mask |= mk
    return rgb, mask



def colour_mask(rgb: np.ndarray, target_rgb, bg=BACKGROUND, sat_min: float = 30.0, tol: float = 62.0) -> np.ndarray:
    sat = rgb.max(2) - rgb.min(2)
    bgd = np.linalg.norm(rgb - np.array(bg, float), axis=2)
    d = np.linalg.norm(rgb - np.array(target_rgb, float), axis=2)
    return (sat > sat_min) & (bgd > 30) & (d < tol)


def _rotations24():
    rots = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            M = np.zeros((3, 3))
            for i, (p, s) in enumerate(zip(perm, signs)):
                M[i, p] = s
            if round(float(np.linalg.det(M))) == 1 and not any(np.allclose(M, X) for X in rots):
                rots.append(M)
    return rots


# All 24 axis-aligned orientations of a cube (covers studs-up *and* SNOT).
CUBE_ROTATIONS = _rotations24()


def grid_matrix(lib, part: str, x, y, z, R) -> tuple[np.ndarray, int, int]:
    """Generalised studio grid: R is any of the 24 cube orientations."""
    from brickheadz.parts import info

    pi = info(lib, part)
    lo, hi = np.array(pi.lo), np.array(pi.hi)
    pts = np.array([[a, b, c] for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])])
    q = pts @ np.asarray(R).T
    rb_lo, rb_hi = q.min(0), q.max(0)
    fw = max(1, int(round((rb_hi[0] - rb_lo[0]) / 20.0)))
    fd = max(1, int(round((rb_hi[2] - rb_lo[2]) / 20.0)))
    pos = np.array(
        [
            (x + fw / 2) * 20 - (rb_lo[0] + rb_hi[0]) / 2,
            -y * 8 - rb_hi[1],
            (z + fd / 2) * 20 - (rb_lo[2] + rb_hi[2]) / 2,
        ]
    )
    m = np.eye(4)
    m[:3, :3] = np.asarray(R, float)
    m[:3, 3] = pos
    return m, fw, fd


def cells_of(lib, part, x, y, z, R):
    from brickheadz.parts import info

    pi = info(lib, part)
    m, fw, fd = grid_matrix(lib, part, x, y, z, R)
    return m, [(cx, cz, cy) for cx in range(x, x + fw) for cz in range(z, z + fd) for cy in range(y, y + pi.h)]


def solve_xz(lib, part, cam: Camera, target_uv, y: int, R):
    """Analytic grid (x, z) placing the part centroid at target_uv for given (y, R)."""
    from brickheadz.parts import info

    pi = info(lib, part)
    m0, _fw, _fd = grid_matrix(lib, part, 0, y, 0, R)
    v = part_vertices(lib, part)
    c_local = v.mean(0) if len(v) else (np.array(pi.lo) + np.array(pi.hi)) / 2.0
    base = np.asarray(R, float) @ c_local + m0[:3, 3]
    rr = cam.r
    u0 = cam.scale * (rr @ base)[0] + cam.ox
    v0 = -cam.scale * (rr @ base)[1] + cam.oy
    a = cam.scale * 20 * rr[0, 0]
    b = cam.scale * 20 * rr[0, 2]
    c = -cam.scale * 20 * rr[1, 0]
    d = -cam.scale * 20 * rr[1, 2]
    det = a * d - b * c
    if abs(det) < 1e-9:
        return None
    du, dv = target_uv[0] - u0, target_uv[1] - v0
    return float((d * du - b * dv) / det), float((-c * du + a * dv) / det)


def place_part(lib, part, mask: np.ndarray, cam: Camera, size: int, occupied: set, y_cands,
               top_k: int = 4, learn=None, builtm=None, rerank: int = 24, net=None, gray=None):
    """Search (R ∈ 24 orientations, y, local x/z) maximising IoU against a component.

    Candidates are ranked by IoU; when a verifier is given, the top ``rerank`` are
    re-scored: ``net`` (CNN over a local patch) if provided, else ``learn`` (the
    scalar-feature model). Re-ranking keeps the learned model cheap.
    """
    comps = components(mask)[:top_k]
    if not comps:
        return None
    cands = []
    for cm in comps:
        ys, xs = np.where(cm)
        target = (float(xs.mean()), float(ys.mean()))
        for R in CUBE_ROTATIONS:
            for y in y_cands:
                sxz = solve_xz(lib, part, cam, target, y, R)
                if sxz is None:
                    continue
                xc, zc = sxz
                if abs(xc) > 16 or abs(zc) > 16:
                    continue
                for dx in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        x, z = int(round(xc)) + dx, int(round(zc)) + dz
                        m, cells = cells_of(lib, part, x, y, z, R)
                        if any(cell in occupied for cell in cells):
                            continue
                        u, v, _ = cam.project(world_points(lib, part, m))
                        mk = np.zeros((size, size), bool)
                        fill_polygon(mk, plane_hull(np.stack([u, v], 1)))
                        inter = int((mk & mask).sum())
                        if inter == 0:
                            continue
                        iou = inter / max(1, int((mk | mask).sum()))
                        cands.append((iou, (x, y, z, tuple(map(tuple, R))), m, cells, R))
    if not cands:
        return None
    cands.sort(key=lambda t: -t[0])
    if net is not None and gray is not None:
        from brickheadz.verify_learn import patch_for, predict

        top = cands[:rerank]
        patches = [patch_for(lib, part, (t[1][0], t[1][1], t[1][2], t[4]), cam, size, gray, mask, builtm) for t in top]
        probs = predict(net, np.asarray(patches, np.float32))
        i = int(np.argmax(probs))
        _iou, key, m, cells, _R = top[i]
        return (float(probs[i]), key, m, cells)
    if learn is not None and builtm is not None:
        from brickheadz.place_learn import features as _feat
        from brickheadz.place_learn import score as _score

        best = (-1.0, None)
        for _iou, key, m, cells, R in cands[:rerank]:
            f, _m = _feat(lib, part, key[0], key[1], key[2], np.array(R), cam, size, mask, builtm, occupied)
            s = _score(learn, f)
            if s > best[0]:
                best = (s, key, m, cells)
        return best[1] and (best[0], best[1], best[2], best[3])
    iou, key, m, cells, _R = cands[0]
    return (iou, key, m, cells)



def reconstruct_step(lib, step_new, cam: Camera, size: int, occupied: set, y_cands, image_rgb, palette,
                     learn=None, builtm=None, net=None, gray=None):
    """Place each new part of a step from its colour pixels.

    step_new: list of (part, colour, gt_matrix, gt_grid) — gt used only for
    benchmarking. Masks are depleted as parts are explained so several same-
    colour parts in one step do not collapse to the same pose.
    """
    resid: dict[int, np.ndarray] = {}
    for part, colour, _m, _g in step_new:
        if colour not in resid:
            resid[colour] = colour_mask(image_rgb, palette[colour])
    out = []
    for part, colour, _m, gtgrid in step_new:
        mask = resid[colour]
        res = place_part(lib, part, mask, cam, size, occupied, y_cands, learn=learn, builtm=builtm, net=net, gray=gray)
        if res is None:
            out.append((part, colour, None, None, 0.0, gtgrid))
            continue
        score, grid, m, cells = res
        occupied.update(cells)
        u, v, _ = cam.project(world_points(lib, part, m))
        mk = np.zeros((size, size), bool)
        fill_polygon(mk, plane_hull(np.stack([u, v], 1)))
        resid[colour] = mask & ~mk
        out.append((part, colour, grid, m, score, gtgrid))
    return out


