"""Post-landing colour matching: place a part by where it sits on the model (stage 3b).

A part hovers for well under a second, so the orbit barely turns while it is
tracked and its depth along the view direction is nearly unobservable from the
hover alone. Once it lands it stays on the model for the rest of the clip while
the camera keeps turning. So:

1. Learn the part's colour from its hover crop (a BGR histogram, which already
   contains its shading) and back-project it into frames after the landing.
2. For each candidate orientation (best hover-silhouette shapes) and world
   position, project the part into those frames. Orthographic projection makes a
   world translation a pure pixel shift, so one template correlation per frame
   scores every position at once.
3. Positions must also agree with the hover track's left/right screen edges
   (screen u is independent of height), which leaves essentially one line of
   (X, Z) lattice positions; colour agreement across many frames picks depth and
   height.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_match needs opencv-python-headless") from e

from brickheadz.instruction_place import CUBE_ROTATIONS
from brickheadz.part_render import PartMesh
from brickheadz.video_place import blob_mask, iou_aligned, silhouette_at
from brickheadz.video_synth import VCam

BINS = 12
BG = 28  # max-channel threshold for background


@dataclass
class Match:
    part: str
    matrix: np.ndarray | None
    colour: float  # mean fraction of projected pixels that have the part's colour
    shape: float  # hover silhouette IoU of the chosen orientation
    edge_px: float  # mean hover edge disagreement
    n_frames: int


def colour_hist(frame: np.ndarray, bbox) -> np.ndarray:
    x, y, w, h = bbox
    m = blob_mask(frame, bbox).astype(np.uint8)
    hist = cv2.calcHist([frame[y : y + h, x : x + w]], [0, 1, 2], m, [BINS] * 3, [0, 256] * 3)
    return hist / max(1.0, float(hist.max()))


def match_map(frame: np.ndarray, hist: np.ndarray) -> np.ndarray:
    """Per-pixel likelihood (0..1) that the pixel shows the part's colour."""
    idx = (frame.astype(np.int32) * BINS) // 256
    m = hist[idx[..., 0], idx[..., 1], idx[..., 2]].astype(np.float32)
    m[frame.max(axis=2) <= BG] = 0.0
    return m


def _screen_shift(cam: VCam, X, Y, Z):
    """Pixel shift (du, dv) of a world translation (orthographic)."""
    y, p = math.radians(cam.yaw), math.radians(cam.pitch)
    zp = -math.sin(y) * X + math.cos(y) * Z
    return cam.scale * (math.cos(y) * X + math.sin(y) * Z), cam.scale * (math.cos(p) * Y - math.sin(p) * zp)


def shape_rotations(mesh: PartMesh, cam: VCam, bmask: np.ndarray, top: int = 4) -> list[tuple[float, np.ndarray]]:
    """Orientations ranked by silhouette shape IoU at the representative hover frame
    (position-free: the bboxes are left-aligned)."""
    out = []
    for R in CUBE_ROTATIONS:
        m = np.eye(4)
        m[:3, :3] = np.asarray(R, float)
        sil = silhouette_at(mesh, m, cam)
        if sil is not None:
            out.append((iou_aligned(sil, bmask, sil[1]), m[:3, :3]))
    out.sort(key=lambda r: -r[0])
    return out[:top]


@dataclass
class Scores:
    """Colour scores of one track over its candidate poses: per orientation, the
    hover-consistent (X, Z) lattice positions x a grid of Y."""

    part: str
    Ys: np.ndarray
    rots: list  # [(R, shape_iou, X, Z, edge_px, S[len(X), len(Ys)])]
    n_frames: int

    def free_best(self, lattice: tuple[float, float] | None = None, tol: float = 1.0) -> Match:
        """Best pose; with `lattice` = (x0, z0), only (X, Z) within `tol` LDU of the
        10 LDU brick lattice through (x0, z0), snapped onto it."""
        best = Match(self.part, None, -1.0, 0.0, float("inf"), self.n_frames)
        for R, shape, X, Z, E, S in self.rots:
            if lattice is not None:
                ok = (np.abs(_wrap10(X - lattice[0])) <= tol) & (np.abs(_wrap10(Z - lattice[1])) <= tol)
                if not ok.any():
                    continue
                S = np.where(ok[:, None], S, -np.inf)
            i, j = np.unravel_index(int(np.argmax(S)), S.shape)
            if S[i, j] > best.colour:
                x, z = float(X[i]), float(Z[i])
                if lattice is not None:
                    x -= _wrap10(x - lattice[0])
                    z -= _wrap10(z - lattice[1])
                best = Match(self.part, _matrix(R, x, self.Ys[j], z), float(S[i, j]), shape, float(E[i]), self.n_frames)
        return best

    def at(self, ri: int, xi: int, Y: float) -> float:
        """Score at a given height (nearest grid Y; 0 outside the grid)."""
        j = int(round((Y - self.Ys[0]) / (self.Ys[1] - self.Ys[0]))) if len(self.Ys) > 1 else 0
        return float(self.rots[ri][5][xi, j]) if 0 <= j < len(self.Ys) else 0.0


def _wrap10(a):
    return (np.asarray(a) + 5.0) % 10.0 - 5.0


def lattice_offset(matches: list[Match]) -> tuple[float, float]:
    """(x0, z0) of the 10 LDU lattice that part origins sit on, as a colour-weighted
    circular mean of X and Z modulo 10 over all placed parts."""
    ms = [m for m in matches if m.matrix is not None and m.colour > 0]
    if not ms:
        return 0.0, 0.0
    w = np.array([m.colour for m in ms])
    out = []
    for k in (0, 2):
        a = np.array([m.matrix[k, 3] for m in ms]) * (2 * math.pi / 10.0)
        out.append(math.atan2((w * np.sin(a)).sum(), (w * np.cos(a)).sum()) * 10.0 / (2 * math.pi))
    return out[0], out[1]


def _matrix(R, X, Y, Z) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = R
    m[:3, 3] = (X, Y, Z)
    return m


def track_scores(t, mesh: PartMesh, part: str, cams: list[VCam], frame_reader, n_frames: int, extent: float,
                 height: float, settle: int = 4, window: int = 40, stride: int = 2, edge_tol: float = 4.0,
                 y_step: float = 2.0, rotations: int = 4, xz_step: float = 10.0) -> Scores | None:
    """Colour scores for one tracked part over (orientation, X, Z, Y) candidates.

    extent: half-size (LDU) of the X/Z search box around the orbit axis; height:
    half-range (LDU) of the Y search around the orbit centre. xz_step: X/Z grid step;
    use less than 10 when the world origin is not on the brick lattice (bundle-
    adjusted cameras) and snap with `lattice_offset` afterwards.


    """
    rep = t.best
    frame = frame_reader(rep.frame)
    bmask = blob_mask(frame, rep.bbox)
    hist = colour_hist(frame, rep.bbox)
    hover = [b for b in t.blobs if not b.touches_border]
    clean = [b for b in hover if b.isolated and b.text < 0.01]
    hover = clean if len(clean) >= 2 else hover
    frames = list(range(t.last + settle, min(n_frames, t.last + settle + window), stride))
    if not hover or not frames:
        return None
    mm = {f: match_map(frame_reader(f), hist) for f in frames}

    g = np.arange(-extent, extent + 1e-6, xz_step)
    GX, GZ = np.meshgrid(g, g, indexing="ij")
    GX, GZ = GX.ravel(), GZ.ravel()
    Ys = np.arange(-height, height + 1e-6, y_step)
    rots = []
    for shape_iou, R in shape_rotations(mesh, cams[rep.frame], bmask, rotations):
        v = mesh.verts @ np.asarray(R, np.float32).T
        # hover edges: u does not depend on Y
        # median over hover frames: a few merged or cut blobs must not veto the truth
        per = []
        for b in hover:
            c = cams[b.frame]
            yv = math.radians(c.yaw)
            a = v[:, 0] * math.cos(yv) + v[:, 2] * math.sin(yv)
            du, _ = _screen_shift(c, GX, 0.0, GZ)
            per.append((np.abs(c.scale * float(a.min()) + c.ox + du - b.bbox[0])
                        + np.abs(c.scale * float(a.max()) + c.ox + du - (b.bbox[0] + b.bbox[2]))) / 2)
        err = np.median(np.array(per), axis=0)
        keep = err <= err.min() + edge_tol
        X, Z, E = GX[keep], GZ[keep], err[keep]
        CX, CZ, CY = np.repeat(X, len(Ys)), np.repeat(Z, len(Ys)), np.tile(Ys, len(X))
        m0 = _matrix(R, 0.0, 0.0, 0.0)

        def colour_score(fs):
            out = np.zeros(len(CX))
            for f in fs:
                sil = silhouette_at(mesh, m0, cams[f])
                if sil is None:
                    continue
                tm, u0, v0 = sil
                tmf = tm.astype(np.float32)
                M = mm[f]
                if tmf.shape[0] >= M.shape[0] or tmf.shape[1] >= M.shape[1]:
                    continue
                C = cv2.matchTemplate(M, tmf, cv2.TM_CCORR) / max(1.0, float(tmf.sum()))
                du, dv = _screen_shift(cams[f], CX, CY, CZ)
                col = np.round(u0 + du).astype(int)
                row = np.round(v0 + dv).astype(int)
                ok = (row >= 0) & (row < C.shape[0]) & (col >= 0) & (col < C.shape[1])
                out[ok] += C[row[ok], col[ok]]
            return out / max(1, len(fs))

        score = colour_score(frames)
        rots.append((np.asarray(R, float), float(shape_iou), X, Z, E, score.reshape(len(X), len(Ys))))
    return Scores(part, Ys, rots, len(frames))


SNAP = 6.0  # LDU: a supported height this close to the colour height replaces it


def _search_box(cams, bases) -> tuple[float, float]:
    late = [b for b in bases[int(len(bases) * 0.6) :] if b is not None]
    s = cams[0].scale
    w = max(b.bbox[2] for b in late) if late else 400
    h = max(b.bbox[3] for b in late) if late else 400
    extent = math.ceil(0.6 * w / s / 10.0) * 10.0
    height = 0.6 * h / (s * max(0.3, math.cos(math.radians(cams[0].pitch))))
    return extent, height


def place_all(tracks, part_of: dict[int, str], meshes: dict, cams: list[VCam], frame_reader, n_frames: int, bases,
              lattice: bool = True, xz_step: float = 2.0, **kw) -> dict:
    """Colour-matched pose for every track, in landing order. Colour decides
    orientation and position; when resting on (or hanging from) what is already
    placed gives a height within SNAP of the colour height, that exact height is used.
    Support never overrides colour: one wrong support would cascade upward.

    With `lattice`, X/Z are searched finely, the brick lattice offset is estimated
    from all parts, and each part is re-picked among lattice positions.
    """
    from brickheadz.video_place import Heights, approach, landing_order, profile

    extent, height = _search_box(cams, bases)
    order = landing_order([t for t in tracks if t.id in part_of])
    scores = {t.id: track_scores(t, meshes[part_of[t.id]], part_of[t.id], cams, frame_reader, n_frames, extent, height,
                                 xz_step=xz_step if lattice else 10.0, **kw) for t in order}
    lat = lattice_offset([s.free_best() for s in scores.values() if s]) if lattice else None
    heights = Heights()
    out: dict = {}
    for t in order:
        part = part_of[t.id]
        sc = scores[t.id]
        m = sc.free_best(lat) if sc else Match(part, None, 0.0, 0.0, float("inf"), 0)
        out[t.id] = m
        if m.matrix is None:
            continue
        prof = profile(meshes[part], m.matrix[:3, :3])
        if not heights.empty:
            T = m.matrix[:3, 3].copy()
            T[1] = 0.0
            shift = heights.rest_shift(prof, T, from_below=approach(t))
            if shift is not None and abs(shift - m.matrix[1, 3]) <= SNAP:
                m.matrix[1, 3] = shift
        heights.add([(prof, m.matrix[:3, 3].copy())])
    return out


def match_all(tracks, part_of: dict[int, str], meshes: dict, cams: list[VCam], frame_reader, n_frames: int,
              bases, **kw) -> dict:
    """Colour-only pose (no support) for every identified track."""
    extent, height = _search_box(cams, bases)
    out = {}
    for t in tracks:
        if t.id not in part_of:
            continue
        sc = track_scores(t, meshes[part_of[t.id]], part_of[t.id], cams, frame_reader, n_frames, extent, height, **kw)
        out[t.id] = sc.free_best() if sc else Match(part_of[t.id], None, 0.0, 0.0, float("inf"), 0)
    return out
