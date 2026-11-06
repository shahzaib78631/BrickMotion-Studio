"""Tracked hovering part -> grid pose (stage 3 of video -> model).

Exploded build animations drop each new part straight down (LDraw -y is up)
while the camera orbits. With an orthographic camera p' = R p, R = Rx(pitch)Ry(yaw),
the screen u of a point is s*(cos(yaw) X + sin(yaw) Z) + ox: it does not depend on
height. So the horizontal bbox centre of a tracked part across frames gives its
world (X, Z) centre by least squares, and the drop does not disturb it. Height
comes from support (what is already built under the footprint); orientation
(one of the 24 cube rotations) is chosen by silhouette agreement with the tracked
blob. Every result carries its scores so callers can reject weak placements.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_place needs opencv-python-headless") from e

from brickheadz.instruction_place import CUBE_ROTATIONS, grid_matrix
from brickheadz.part_render import PartMesh
from brickheadz.video_synth import VCam


@dataclass
class Placement:
    part: str
    matrix: np.ndarray | None
    grid: tuple | None
    xz_resid: float  # px rms of the u-centre fit
    iou: float  # silhouette agreement at the representative frame
    cells: list = field(default_factory=list)


def fit_xz(obs: list[tuple[VCam, float]]) -> tuple[float, float, float] | None:
    """Least-squares world (X, Z) from [(cam, u_centre_px)]; returns (X, Z, rms px)."""
    if len(obs) < 2:
        return None
    A, b = [], []
    for cam, u in obs:
        y = math.radians(cam.yaw)
        A.append([cam.scale * math.cos(y), cam.scale * math.sin(y)])
        b.append(u - cam.ox)
    A, b = np.array(A), np.array(b)
    if np.linalg.cond(A) > 1e6:
        return None
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    rms = float(np.sqrt(np.mean((A @ sol - b) ** 2)))
    return float(sol[0]), float(sol[1]), rms


def blob_mask(frame: np.ndarray, bbox, thresh: int = 28, mask: np.ndarray | None = None) -> np.ndarray:
    """The blob's pixels inside its bbox; `mask` (a motion blob's own mask) wins when given."""
    if mask is not None:
        return mask
    x, y, w, h = bbox
    m = (frame[y : y + h, x : x + w].max(axis=2) > thresh).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        return m > 0
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == k


def silhouette_at(mesh: PartMesh, m: np.ndarray, cam: VCam) -> tuple[np.ndarray, float, float] | None:
    """Projected silhouette of a placed part: (mask, u0, v0) of its bbox."""
    pts = mesh.verts @ m[:3, :3].T.astype(np.float32) + m[:3, 3].astype(np.float32)
    u, v, _ = cam.project(pts)
    u0, v0 = float(u.min()), float(v.min())
    W, H = int(math.ceil(u.max() - u0)) + 2, int(math.ceil(v.max() - v0)) + 2
    if W <= 1 or H <= 1 or W * H > 4_000_000:
        return None
    img = np.zeros((H, W), np.uint8)
    q = np.stack([u - u0, v - v0], 1).astype(np.int32)
    o = mesh.offsets
    # one call per polygon: fillPoly on a list uses even-odd fill, so overlapping
    # faces would cancel into holes
    for i in range(mesh.n):
        cv2.fillConvexPoly(img, q[o[i] : o[i + 1]], 1)
    return img > 0, u0, v0


def hover_silhouette(mesh: PartMesh, m: np.ndarray, cam: VCam, rows: tuple[float, float] | None):
    """`silhouette_at`, but with a perspective camera the part is first lifted to the
    height where its outline's vertical centre meets the blob's rows (v0, v1)."""
    if cam.dist > 0 and rows is not None:
        pts = _sample(mesh.verts @ m[:3, :3].T.astype(np.float32)) + m[:3, 3].astype(np.float32)
        m = m.copy()
        m[1, 3] += hover_height(pts, cam, (rows[0] + rows[1]) / 2.0, 0.0)
    return silhouette_at(mesh, m, cam)


def iou_aligned(pred: tuple[np.ndarray, float, float], obs: np.ndarray, obs_u0: float) -> float:
    """IoU with u fixed by the camera and v aligned by bbox top (the drop offset is unknown)."""
    pm, pu0, _pv0 = pred
    du = int(round(pu0 - obs_u0))
    H = max(pm.shape[0], obs.shape[0])
    W = max(pm.shape[1] + max(du, 0), obs.shape[1] + max(-du, 0))
    a = np.zeros((H, W), bool)
    b = np.zeros((H, W), bool)
    a[: pm.shape[0], max(du, 0) : max(du, 0) + pm.shape[1]] = pm
    b[: obs.shape[0], max(-du, 0) : max(-du, 0) + obs.shape[1]] = obs
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


def body_box(lib, part: str, m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """World AABB of the part's body (studs pulled back), from parts.info."""
    from brickheadz.parts import info

    pi = info(lib, part)
    lo, hi = np.array(pi.lo, float), np.array(pi.hi, float)
    # Vertical extent from the mesh, not info(): info pulls back *any* outward male
    # connector, including downward ones under 1xN plates, which halves their height.
    tri = lib.triangles(part if part.endswith(".dat") else part + ".dat")
    if tri.size:
        lo[1] = float(tri[:, 1].min()) + (4.0 if pi.top_studs else 0.0)
        hi[1] = float(tri[:, 1].max())
    c = np.array([[a, b, d] for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for d in (lo[2], hi[2])])
    w = c @ np.asarray(m)[:3, :3].T + np.asarray(m)[:3, 3]
    return w.min(0), w.max(0)


PX = 2.0  # LDU per heightfield column
XZ_PENALTY = 0.02  # score per LDU of distance from the fitted (X, Z) centre (fallback)
EDGE_PENALTY = 0.015  # score per px of mean left/right edge disagreement across frames


def hover_height(pts: np.ndarray, cam: VCam, v_mid: float, y0: float, iters: int = 4) -> float:
    """World height offset putting the projected vertical centre of `pts` (already at
    their landed position) at screen row `v_mid` (secant steps; exact in one for
    orthographic cameras)."""
    def mid(dy):
        _u, v, _z = cam.project(pts + np.array([0.0, dy, 0.0], np.float32))
        return (float(v.min()) + float(v.max())) / 2.0
    dy, f = y0, mid(y0)
    for _ in range(iters):
        g = mid(dy + 1.0) - f
        if abs(g) < 1e-6:
            break
        step = (v_mid - f) / g
        dy += step
        f = mid(dy)
        if abs(step) < 0.05:
            break
    return dy


def _sample(v: np.ndarray, n: int = 400) -> np.ndarray:
    """Extreme-ish subsample of vertices: bbox-extreme points plus a strided set."""
    if len(v) <= n:
        return v
    idx = set(np.argmin(v, 0).tolist()) | set(np.argmax(v, 0).tolist())
    idx |= set(range(0, len(v), max(1, len(v) // n)))
    return v[sorted(idx)]


def predicted_edges(v_rot: np.ndarray, t, cam: VCam, rows: tuple[float, float] | None = None,
                    pts: np.ndarray | None = None) -> tuple[float, float]:
    """Predicted left/right screen edges (px) of a part at rest translation t; with a
    perspective camera and the blob's rows (v0, v1) the part is first lifted to the
    height where it hovers."""
    if cam.dist > 0 and rows is not None:
        if pts is None:
            pts = _sample(v_rot).astype(np.float32) + np.asarray(t, np.float32)
        dy = hover_height(pts, cam, (rows[0] + rows[1]) / 2.0, 0.0)
        u, _v, _z = cam.project(pts + np.array([0.0, dy, 0.0], np.float32))
        return float(u.min()), float(u.max())
    yv = math.radians(cam.yaw)
    a = v_rot[:, 0] * math.cos(yv) + v_rot[:, 2] * math.sin(yv)
    off = cam.scale * (math.cos(yv) * float(t[0]) + math.sin(yv) * float(t[2])) + cam.ox
    return cam.scale * float(a.min()) + off, cam.scale * float(a.max()) + off


def edge_error(v_rot: np.ndarray, t: np.ndarray, edges: list[tuple]) -> float:
    """Mean |predicted - observed| of the blob's left and right screen edges (px).

    v_rot: part vertices already rotated into world orientation; t: world translation
    at rest. Edges are (cam, u0, u1) or (cam, u0, u1, v0, v1). With an orthographic
    camera u is independent of height; with perspective the hover height per frame is
    first solved from the blob's rows (v0, v1).
    """
    errs = []
    pts = _sample(v_rot).astype(np.float32) + np.asarray(t, np.float32) if any(e[0].dist > 0 for e in edges) else None
    for e in edges:
        p0, p1 = predicted_edges(v_rot, t, e[0], (e[3], e[4]) if len(e) >= 5 else None, pts)
        errs.append(abs(p0 - e[1]) + abs(p1 - e[2]))
    return float(np.mean(errs)) / 2.0 if errs else 0.0


@dataclass
class Profile:
    """A part's vertical extent per 2x2 LDU column, in its own (rotated) frame:
    top = smallest y (highest point), bottom = largest y; nan where the part is absent."""

    x0: float
    z0: float
    top: np.ndarray
    bottom: np.ndarray


_PROFILES: dict = {}


def profile(mesh: PartMesh, R: np.ndarray) -> Profile:
    """Top-down and bottom-up z-buffer of the rotated part. Interlocking falls out of
    the geometry: studs raise a column's top by 4 LDU and a hollow underside raises the
    column's bottom by the same amount."""
    from brickheadz.part_render import raster

    key = (mesh.part, np.asarray(R).round(3).tobytes())
    if key in _PROFILES:
        return _PROFILES[key]
    v = mesh.verts @ np.asarray(R, np.float32).T
    x0, z0 = float(np.floor(v[:, 0].min() / PX) * PX), float(np.floor(v[:, 2].min() / PX) * PX)
    W = int(math.ceil((v[:, 0].max() - x0) / PX)) + 2
    H = int(math.ceil((v[:, 2].max() - z0) / PX)) + 2
    px = np.stack([(v[:, 0] - x0) / PX, (v[:, 2] - z0) / PX], 1)
    nrm = np.zeros((mesh.n, 3), np.float32)
    bgr = np.zeros((mesh.n, 3), np.float32)
    light = np.array([0, 0, -1], np.float32)
    d1: list = []
    d2: list = []
    raster(px, v[:, 1], mesh.tris, mesh.tri_poly, nrm, bgr, light, (H, W), edge=0, depth_out=d1)
    raster(px, -v[:, 1], mesh.tris, mesh.tri_poly, nrm, bgr, light, (H, W), edge=0, depth_out=d2)
    top = np.where(np.isfinite(d1[0]), d1[0], np.nan)
    bottom = np.where(np.isfinite(d2[0]), -d2[0], np.nan)
    p = Profile(x0, z0, top, bottom)
    _PROFILES[key] = p
    return p


class Heights:
    """Heightfield of what is built (LDU, LDraw y down) for a physical move along y:
    per 2x2 LDU column, the highest built point (min y) and the lowest (max y)."""

    SIZE = 640  # columns per axis (covers +-640 LDU)

    def __init__(self, ground: float = 0.0):
        self.ground = ground
        self.top = np.full((self.SIZE, self.SIZE), np.inf, np.float32)
        self.bottom = np.full((self.SIZE, self.SIZE), -np.inf, np.float32)
        self.empty = True

    def _window(self, prof: Profile, t: np.ndarray):
        j0 = int(round((prof.x0 + float(t[0])) / PX)) + self.SIZE // 2
        i0 = int(round((prof.z0 + float(t[2])) / PX)) + self.SIZE // 2
        h, w = prof.top.shape
        if i0 < 0 or j0 < 0 or i0 + h > self.SIZE or j0 + w > self.SIZE:
            return None
        return slice(i0, i0 + h), slice(j0, j0 + w)

    def add(self, items) -> None:
        for prof, t in items:
            win = self._window(prof, t)
            if win is None:
                continue
            ty, by = prof.top + float(t[1]), prof.bottom + float(t[1])
            m = ~np.isnan(ty)
            self.top[win][m] = np.minimum(self.top[win][m], ty[m])
            self.bottom[win][m] = np.maximum(self.bottom[win][m], by[m])
            self.empty = False

    def rest_shift(self, prof: Profile, t: np.ndarray, from_below: bool = False) -> float | None:
        """dy that moves the part (profile at translation t) along y until it touches
        built material: dropping onto tops, or rising into undersides. None if nothing
        is under (or over) it, except that the first part rests on the ground plane."""
        win = self._window(prof, t)
        if win is None:
            return None
        if from_below:
            built, own = self.bottom[win], prof.top + float(t[1])
            m = np.isfinite(built) & ~np.isnan(own)
            return float((built[m] - own[m]).max()) if m.any() else None
        built, own = self.top[win], prof.bottom + float(t[1])
        m = np.isfinite(built) & ~np.isnan(own)
        if not m.any():
            return (self.ground - float(np.nanmax(own))) if self.empty else None
        return float((built[m] - own[m]).min())

    # backwards-compatible helper for callers that seed from known pieces
    def add_piece(self, lib, part: str, m: np.ndarray, mesh: PartMesh | None = None) -> None:
        mesh = mesh or PartMesh(lib, part)
        self.add([(profile(mesh, m[:3, :3]), m[:3, 3])])


def place(lib, mesh: PartMesh, part: str, obs: list[tuple[VCam, float]], rep: tuple[VCam, np.ndarray, float],
          heights: Heights, rotations=None, search: int = 1, from_below: bool = False,
          edges: list[tuple] | None = None, rep_rows: tuple[float, float] | None = None) -> Placement:
    """Best grid pose for one tracked part.

    obs: (camera, u-centre) per tracked frame; rep: (camera, blob mask, blob u0) at the
    representative frame used for silhouette scoring; from_below: the part rises into
    place (see `approach`) instead of dropping.
    """
    fit = fit_xz(obs)
    if fit is None:
        return Placement(part, None, None, float("inf"), 0.0)
    X, Z, rms = fit
    cam, bmask, bu0 = rep
    if cam.dist > 0:
        search = max(search, 2)  # the orthographic (X, Z) fit is biased by perspective
    cands = []
    for R in rotations or CUBE_ROTATIONS:
        Rf = np.asarray(R, float)
        # (X, Z) is the centre of the projected extent = the rotated mesh's bbox centre;
        # the LDraw origin sits on a 10 LDU lattice, so snap the origin, not the centre
        v = mesh.verts @ Rf.T.astype(np.float32)
        cx_l = float(v[:, 0].min() + v[:, 0].max()) / 2.0
        cz_l = float(v[:, 2].min() + v[:, 2].max()) / 2.0
        ox0, oz0 = round((X - cx_l) / 10.0), round((Z - cz_l) / 10.0)
        for dx in range(-search, search + 1):
            for dz in range(-search, search + 1):
                x, z = int(ox0 + dx), int(oz0 + dz)
                m = np.eye(4)
                m[:3, :3] = Rf
                m[0, 3], m[2, 3] = 10.0 * x, 10.0 * z
                prof = profile(mesh, m[:3, :3])
                shift = heights.rest_shift(prof, m[:3, 3], from_below=from_below)  # straight move along y
                if shift is None:
                    continue
                m[1, 3] += shift
                cells = [(prof, m[:3, 3].copy())]
                y = int(round(-float(m[1, 3]) / 8))
                sil = hover_silhouette(mesh, m, cam, rep_rows)  # perspective: outline where it hovers
                if sil is None:
                    continue
                iou = iou_aligned(sil, bmask, bu0)
                # One frame's silhouette cannot tell positions along the view direction
                # apart; the orbit can. Compare the mesh's projected left/right edges with
                # the blob's in every tracked frame (exact for asymmetric parts too).
                s = iou - EDGE_PENALTY * edge_error(v, m[:3, 3], edges) if edges else iou - XZ_PENALTY * math.hypot(
                    10.0 * x + cx_l - X, 10.0 * z + cz_l - Z)
                cands.append((s, m, (x, y, z, tuple(map(tuple, np.asarray(R).astype(int)))), cells, iou))
    if not cands:
        return Placement(part, None, None, rms, 0.0)
    cands.sort(key=lambda c: -c[0])
    _s, m, grid, cells, iou = cands[0]
    return Placement(part, m, grid, rms, max(0.0, iou), cells)


def approach(track, min_px: float = 6.0) -> bool:
    """True if the part rises into place (moves up the screen), False if it drops."""
    pts = [b for b in track.blobs if not b.touches_border] or track.blobs
    return (pts[-1].centroid[1] - pts[0].centroid[1]) < -min_px


def landing_order(tracks, gap: int = 3) -> list:
    """Order tracks the way parts land. Parts of one step move together (their tracks
    end within `gap` frames of each other); within such a group the part nearest the
    model lands first: for drops the lowest in the column, for rises the highest."""
    ts = sorted(tracks, key=lambda t: t.last)
    groups, cur = [], []
    for t in ts:
        if cur and t.last - cur[-1].last > gap:
            groups.append(cur)
            cur = []
        cur.append(t)
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        # bottom edge of the blob at its representative frame; larger v = lower on screen
        drops = [t for t in g if not approach(t)]
        rises = [t for t in g if approach(t)]
        out.extend(sorted(drops, key=lambda t: -(t.best.bbox[1] + t.best.bbox[3])))
        out.extend(sorted(rises, key=lambda t: t.best.bbox[1]))
    return out


def vertex_error(mesh: PartMesh, m_pred: np.ndarray, m_true: np.ndarray) -> float:
    """Symmetric Hausdorff distance (LDU) between placed vertex sets; symmetric parts in
    equivalent orientations score ~0."""
    a = mesh.verts @ m_pred[:3, :3].T.astype(np.float32) + m_pred[:3, 3].astype(np.float32)
    b = mesh.verts @ m_true[:3, :3].T.astype(np.float32) + m_true[:3, 3].astype(np.float32)
    a, b = a[:: max(1, len(a) // 2000)], b[:: max(1, len(b) // 2000)]  # dense enough that rotated symmetric parts score ~0
    d = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=2)
    return float(max(d.min(1).max(), d.min(0).max()))


def _duplicate(t, pl, placed: list, min_overlap: float = 0.5) -> bool:
    """Same part, same (x, z, rotation) and mostly simultaneous with an already placed
    track: two pieces cannot fill one spot at the same time, so it is the same piece.
    The duplicate takes the original's pose."""
    for t0, p0 in placed:
        if p0.part != pl.part or p0.grid is None or pl.grid is None:
            continue
        if (p0.grid[0], p0.grid[2], p0.grid[3]) != (pl.grid[0], pl.grid[2], pl.grid[3]):
            continue
        ov = min(t.last, t0.last) - max(t.first, t0.first) + 1
        if ov >= min_overlap * min(t.last - t.first + 1, t0.last - t0.first + 1):
            pl.matrix, pl.grid, pl.cells = p0.matrix.copy(), p0.grid, p0.cells
            return True
    return False


def place_all(lib, tracks, part_of: dict[int, str], meshes: dict, cams: list[VCam], frame_reader) -> tuple[dict, float]:
    """Place every identified track in landing order on an empty build.

    Returns ({track id: Placement}, mean silhouette IoU). The first part to land rests
    on the ground plane; later parts move along y onto what is already built.
    """
    heights = Heights()
    out: dict = {}
    ious = []
    placed: list = []
    for t in landing_order([t for t in tracks if t.id in part_of]):
        part = part_of[t.id]
        mesh = meshes[part]
        obs = [(cams[b.frame], b.bbox[0] + b.bbox[2] / 2.0) for b in t.blobs if not b.touches_border]
        clean = [b for b in t.blobs if not b.touches_border and b.isolated and b.text < 0.01]
        edges = [(cams[b.frame], float(b.bbox[0]), float(b.bbox[0] + b.bbox[2]), float(b.bbox[1]),
                  float(b.bbox[1] + b.bbox[3])) for b in clean]
        rep_cam = cams[t.best.frame]
        bm = blob_mask(frame_reader(t.best.frame), t.best.bbox, mask=t.best.mask)
        pl = place(lib, mesh, part, obs, (rep_cam, bm, float(t.best.bbox[0])), heights, from_below=approach(t),
                   edges=edges if len(edges) >= 2 else None,
                   rep_rows=(float(t.best.bbox[1]), float(t.best.bbox[1] + t.best.bbox[3])))
        out[t.id] = pl
        if pl.matrix is None:
            continue
        ious.append(pl.iou)
        if _duplicate(t, pl, placed):
            continue  # the tracker split one piece into two tracks: it occupies its cells once
        placed.append((t, pl))
        heights.add(pl.cells)
    return out, float(np.mean(ious)) if ious else 0.0


def with_shift(cams: list[VCam], dx: float, dz: float) -> list[VCam]:
    """Cameras for a world frame translated by (dx, dz) (X' = X + dx)."""
    out = []
    for c in cams:
        y = math.radians(c.yaw)
        out.append(c.replace(ox=c.ox - c.scale * (math.cos(y) * dx + math.sin(y) * dz)))
    return out


def place_best_parity(lib, tracks, part_of, meshes, cams, frame_reader):
    """Part origins are snapped to a 10 LDU lattice, which has no stud-grid parity, so a
    single pass suffices (kept as a function so the pipeline has one entry point)."""
    res, score = place_all(lib, tracks, part_of, meshes, cams, frame_reader)
    return res, score, (0.0, 0.0)
