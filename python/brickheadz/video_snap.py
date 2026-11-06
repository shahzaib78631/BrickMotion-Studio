"""Connector snapping for video placement (stage 3c).

The colour matcher (`video_match`) searches a continuous box of positions, so its
mistakes are mostly heights and lattice offsets. A landed part, though, can only
sit where one of its studs or holes meets a free connector of what is already
built (`brickheadz.connectors`). So for each track, in landing order:

1. Candidate poses = every exact snap of the part onto a free connector of the
   build so far (all four 90-degree turns).
2. Keep the poses whose screen left/right edges agree with the hover track
   (screen u does not depend on height).
3. Score those by post-landing colour agreement (same score as `video_match`).
4. Take the best snap unless the free colour match is clearly better (the part
   sits on something we never tracked); then fall back to the free pose.

The build can be our own placements (`snap_all`) or, for evaluation, the true
pieces that had landed before the track (`built_of`).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_snap needs opencv-python-headless") from e

from brickheadz import connectors as cg
from brickheadz import video_match as vm
from brickheadz.part_render import PartMesh
from brickheadz.video_place import _sample, landing_order, silhouette_at
from brickheadz.video_synth import VCam


@dataclass
class Snap:
    part: str
    matrix: np.ndarray | None
    colour: float
    edge_px: float
    snapped: bool  # True: pose sits on a connector of the build; False: free colour fallback
    n_candidates: int
    host: int | None = None  # index of the built piece it snapped onto


def _hover_blobs(t):
    hover = [b for b in t.blobs if not b.touches_border]
    clean = [b for b in hover if b.isolated and b.text < 0.01]
    return clean if len(clean) >= 2 else hover


def _post_frames(t, n_frames: int, settle: int = 4, window: int = 40, stride: int = 2) -> list[int]:
    return list(range(t.last + settle, min(n_frames, t.last + settle + window), stride))


def edge_errors(mesh: PartMesh, poses: list[np.ndarray], t, cams: list[VCam]) -> np.ndarray:
    """Median over hover frames of the mean |left|,|right| screen-edge disagreement (px)."""
    hover = _hover_blobs(t)
    if not hover or not poses:
        return np.full(len(poses), np.inf)
    v = _sample(mesh.verts)
    per = np.zeros((len(hover), len(poses)))
    for j, m in enumerate(poses):
        pts = v @ m[:3, :3].T.astype(np.float32) + m[:3, 3].astype(np.float32)
        for i, b in enumerate(hover):
            u, _, _ = cams[b.frame].project(pts)
            per[i, j] = (abs(float(u.min()) - b.bbox[0]) + abs(float(u.max()) - (b.bbox[0] + b.bbox[2]))) / 2
    return np.median(per, axis=0)


def colour_scores(mesh: PartMesh, poses: list[np.ndarray], cams: list[VCam], mm: dict[int, np.ndarray]) -> np.ndarray:
    """Mean fraction of each pose's projected pixels that have the part's colour, over
    the frames in `mm` (frame -> colour likelihood map). Poses sharing a rotation share
    one template correlation per frame; a translation is a screen shift (exact for
    orthographic cameras, the shift of the part's centre under perspective)."""
    out = np.zeros(len(poses))
    if not poses or not mm:
        return out
    groups: dict[tuple, list[int]] = {}
    for i, m in enumerate(poses):
        groups.setdefault(tuple(np.round(m[:3, :3].ravel(), 3)), []).append(i)
    centre = mesh.verts.mean(axis=0)
    for idx in groups.values():
        R = poses[idx[0]][:3, :3]
        m0 = np.eye(4)
        m0[:3, :3] = R
        c0 = (R @ centre).astype(np.float32)
        T = np.array([poses[i][:3, 3] for i in idx], np.float32)
        for f, M in mm.items():
            sil = silhouette_at(mesh, m0, cams[f])
            if sil is None:
                continue
            tm, u0, v0 = sil
            if tm.shape[0] >= M.shape[0] or tm.shape[1] >= M.shape[1]:
                continue
            tmf = tm.astype(np.float32)
            C = cv2.matchTemplate(M, tmf, cv2.TM_CCORR) / max(1.0, float(tmf.sum()))
            uc, vc_, _ = cams[f].project(c0[None])
            us, vs, _ = cams[f].project(c0[None] + T)
            col = np.round(u0 + us - uc[0]).astype(int)
            row = np.round(v0 + vs - vc_[0]).astype(int)
            ok = (row >= 0) & (row < C.shape[0]) & (col >= 0) & (col < C.shape[1])
            out[np.array(idx)[ok]] += C[row[ok], col[ok]]
    return out / len(mm)


def snap_track(t, part: str, mesh: PartMesh, built: tuple[list[str], list[np.ndarray]], cams: list[VCam],
               frame_reader, n_frames: int, cat: cg.Catalog, edge_tol: float = 4.0, edge_max: float = 12.0,
               free: vm.Match | None = None, margin: float = 0.08, near_xz: float = 10.0,
               settle: int = 4, window: int = 40, stride: int = 2) -> Snap:
    """Best snap pose of one track onto the build (parts, matrices); `free` is the
    free colour match used as fallback and as the bar a snap has to clear."""
    fallback = Snap(part, None if free is None else free.matrix, 0.0 if free is None else free.colour,
                    np.inf if free is None else free.edge_px, False, 0)
    parts, mats = built
    if not parts or cat.connectors(part) is None:
        return fallback
    g = cg.build_graph(parts, [0] * len(parts), mats, cat)
    cands = cg.snap_candidates(part, cg.free_connectors(g, mats, cat), cat)
    if not cands:
        return fallback
    poses = [c["matrix"] for c in cands]
    E = edge_errors(mesh, poses, t, cams)
    keep = np.where((E <= E.min() + edge_tol) & (E <= edge_max))[0]
    if not len(keep) and free is not None and free.matrix is not None:
        # no usable hover edges (none clean, or merged blobs): snaps under the free colour pose
        fx, fz = free.matrix[0, 3], free.matrix[2, 3]
        keep = np.array([i for i, m in enumerate(poses) if math.hypot(m[0, 3] - fx, m[2, 3] - fz) <= near_xz], int)
    if not len(keep):
        return fallback
    rep = t.best
    hist = vm.colour_hist(frame_reader(rep.frame), rep.bbox, rep.mask)
    mm = {f: vm.match_map(frame_reader(f), hist) for f in _post_frames(t, n_frames, settle, window, stride)}
    S = colour_scores(mesh, [poses[i] for i in keep], cams, mm)
    k = int(np.argmax(S))
    i = int(keep[k])
    if free is not None and free.matrix is not None and S[k] < free.colour - margin:
        return Snap(part, free.matrix, free.colour, free.edge_px, False, len(keep))
    return Snap(part, poses[i], float(S[k]), float(E[i]), True, len(keep), cands[i]["host"])


def snap_all(tracks, part_of: dict[int, str], meshes: dict, cams: list[VCam], frame_reader, n_frames: int, bases,
             built_of=None, cat: cg.Catalog | None = None, margin: float = 0.08, free: dict | None = None,
             trust: float = 0.0, **kw) -> dict:
    """Snap every identified track in landing order.

    built_of(track) -> (parts, matrices) gives the build a track lands on; by default
    it is everything this function placed before it (our own build, grown as we go).
    `free`: precomputed `video_match.place_all` result (computed here if missing).
    trust: a free (unsnapped) pose joins our own build only if its colour score is at
    least this, so a doubtful fallback does not become support for later parts.
    """
    cat = cat or cg.catalog()
    free = free if free is not None else vm.place_all(tracks, part_of, meshes, cams, frame_reader, n_frames, bases, **kw)
    order = landing_order([t for t in tracks if t.id in part_of])
    own_parts: list[str] = []
    own_mats: list[np.ndarray] = []
    out = {}
    for t in order:
        part = part_of[t.id]
        built = built_of(t) if built_of is not None else (own_parts, own_mats)
        s = snap_track(t, part, meshes[part], built, cams, frame_reader, n_frames, cat, free=free.get(t.id), margin=margin,
                       **{k: kw[k] for k in ("settle", "window", "stride") if k in kw})
        out[t.id] = s
        if s.matrix is not None and (s.snapped or not own_parts or s.colour >= trust):
            own_parts.append(part)
            own_mats.append(s.matrix)
    return out
