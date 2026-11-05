"""Camera estimation from tracked, identified parts (stage 3a of video -> model).

The clips are rendered with an orbiting camera. We model it as orthographic,
p' = Rx(pitch) Ry(yaw_f) p, u = s p'_x + ox, with yaw_f = yaw0 + w*f (+ a small
quadratic term), constant pitch, scale s and ox. (oy is not needed: placement
aligns vertically by bbox and gets height from contact.)

1. Per blob: render the identified part over a (yaw, pitch) grid and keep the best
   silhouette match. The part's own rotation about y is unknown, so a blob gives
   yaw only modulo 90 degrees (yaw_total = yaw_f + k*90). Size gives s.
2. Global: pitch and s are robust medians; yaw_f is fitted to the per-blob yaws
   with 4-fold circular residuals; the world frame is therefore fixed only up to a
   multiple of 90 degrees about y, which is harmless for a model.
3. ox and every track's (X, Z) come from one joint least squares on bbox u-centres.
4. The stud lattice offset: footprint centres sit on a 10 LDU half-stud lattice, so
   the circular mean of (X, Z) mod 10 gives the shift that puts the pivot-centred
   frame on the brick grid.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_camera needs opencv-python-headless") from e

from brickheadz import part_render as pr
from brickheadz.part_match import normalise, silhouette
from brickheadz.video_synth import VCam

YAWS = np.arange(0.0, 360.0, 4.0)
PITCHES = np.arange(10.0, 61.0, 5.0)


class ViewBank:
    """Silhouette templates of one part over a (yaw, pitch) grid."""

    def __init__(self, mesh: pr.PartMesh, yaws=YAWS, pitches=PITCHES):
        polys = mesh.polys
        self.keys, masks, asp, wl = [], [], [], []
        for yw in yaws:
            for pt in pitches:
                res = silhouette(polys, pr.rotation(float(yw), float(pt), 0.0), with_size=True)
                if res is None:
                    continue
                sil, (w_ldu, _h_ldu) = res
                m, a = normalise(sil)
                self.keys.append((float(yw), float(pt)))
                masks.append(m.reshape(-1))
                asp.append(a)
                wl.append(w_ldu)
        self.masks = np.array(masks, np.float32)
        self.area = self.masks.sum(1)
        self.aspect = np.array(asp, np.float32)
        self.w_ldu = np.array(wl, np.float32)

    def match(self, blob: np.ndarray) -> tuple[float, float, float, float]:
        """(yaw, pitch, px-per-LDU, score) for a tight blob mask."""
        cm, ca = normalise(blob)
        c = cm.reshape(-1).astype(np.float32)
        inter = self.masks @ c
        iou = inter / (self.area + c.sum() - inter + 1e-6)
        score = iou * np.exp(-np.abs(np.log(ca / self.aspect)))
        i = int(np.argmax(score))
        s = blob.shape[1] / max(1e-6, float(self.w_ldu[i]))
        return self.keys[i][0], self.keys[i][1], s, float(score[i])


@dataclass
class ViewObs:
    track: int
    frame: int
    yaw: float  # yaw_total (camera yaw + part rotation), degrees
    pitch: float
    scale: float
    score: float
    u: float  # bbox u-centre px
    v: float = 0.0  # bbox v-centre px


def _tight(mask: np.ndarray) -> np.ndarray | None:
    ys, xs = np.where(mask)
    if ys.size == 0:
        return None
    return mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def observe(tracks, part_of: dict[int, str], meshes: dict[str, pr.PartMesh], frame_reader, per_track: int = 4,
            banks: dict | None = None) -> list[ViewObs]:
    """Per-blob view estimates for tracks whose part is known."""
    from brickheadz.video_place import blob_mask

    banks = banks if banks is not None else {}
    out: list[ViewObs] = []
    for t in tracks:
        part = part_of.get(t.id)
        if part is None or part not in meshes or meshes[part].n == 0:
            continue
        if part not in banks:
            banks[part] = ViewBank(meshes[part])
        good = [b for b in t.blobs if not b.touches_border and b.isolated and b.text < 0.01] or [b for b in t.blobs if not b.touches_border]
        if not good:
            continue
        idx = np.linspace(0, len(good) - 1, min(per_track, len(good))).round().astype(int)
        for b in [good[i] for i in sorted(set(idx))]:
            m = _tight(blob_mask(frame_reader(b.frame), b.bbox))
            if m is None or m.sum() < 200:
                continue
            yw, pt, s, sc = banks[part].match(m)
            out.append(ViewObs(t.id, b.frame, yw, pt, s, sc, b.bbox[0] + b.bbox[2] / 2.0, b.bbox[1] + b.bbox[3] / 2.0))
    return out


def _wrap90(a):
    return (np.asarray(a) + 45.0) % 90.0 - 45.0


def fit_orbit(obs: list[ViewObs], n_frames: int, quad: bool = True) -> dict:
    """Global yaw(f), pitch, scale from per-blob views (robust, 4-fold circular)."""
    good = [o for o in obs if o.score > 0.55] or obs
    pitch = float(np.median([o.pitch for o in good]))
    scale = float(np.median([o.scale for o in good]))
    f = np.array([o.frame for o in good], float)
    y = np.array([o.yaw for o in good], float)
    w = np.array([o.score for o in good], float)
    def coherence(omega):
        ang = np.radians(4 * (y - omega * f))
        c, s_ = (w * np.cos(ang)).sum(), (w * np.sin(ang)).sum()
        return math.hypot(c, s_) / w.sum(), math.degrees(math.atan2(s_, c)) / 4

    # angular speed: coarse then fine (a 0.05 deg/frame error drifts ~20 deg over a clip)
    grid = np.arange(-4.0, 4.0001, 0.02)
    om = float(grid[int(np.argmax([coherence(o)[0] for o in grid]))])
    fine = np.arange(om - 0.03, om + 0.03001, 0.0005)
    om = float(fine[int(np.argmax([coherence(o)[0] for o in fine]))])
    coef = np.array([0.0, om, coherence(om)[1]])

    def resid(c):
        return _wrap90(y - np.polyval(c, f))

    for _ in range(4):  # IRLS on wrapped residuals (linear)
        r = resid(coef)
        keep = np.abs(r) < 10
        if keep.sum() < 4:
            break
        lin = np.polyfit(f[keep], np.polyval(coef, f[keep]) + r[keep], 1, w=w[keep])
        coef = np.array([0.0, *lin])
    if quad and len(f) > 12:  # keep a quadratic term only if it clearly helps
        r = resid(coef)
        keep = np.abs(r) < 10
        q = np.polyfit(f[keep], np.polyval(coef, f[keep]) + r[keep], 2, w=w[keep])
        if np.median(np.abs(resid(q)[keep])) < 0.8 * np.median(np.abs(r[keep])):
            coef = q
    inliers = float(np.mean(np.abs(resid(coef)) < 8))
    return {"coef": coef.tolist(), "pitch": pitch, "scale": scale, "inliers": inliers, "n": len(good)}


def fit_offset(tracks_u: dict[int, list[tuple[int, float]]], yaw_of, scale: float) -> tuple[float, dict[int, tuple[float, float]]]:
    """Joint least squares: u = s (cos yaw X_i + sin yaw Z_i) + ox over all tracks."""
    ids = sorted(tracks_u)
    rows, rhs = [], []
    for k, tid in enumerate(ids):
        for fr, u in tracks_u[tid]:
            yv = math.radians(yaw_of(fr))
            row = np.zeros(1 + 2 * len(ids))
            row[0] = 1.0
            row[1 + 2 * k] = scale * math.cos(yv)
            row[2 + 2 * k] = scale * math.sin(yv)
            rows.append(row)
            rhs.append(u)
    if not rows:
        return 0.0, {}
    A, b = np.array(rows), np.array(rhs)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    return float(sol[0]), {tid: (float(sol[1 + 2 * k]), float(sol[2 + 2 * k])) for k, tid in enumerate(ids)}


def lattice_shift(xz: list[tuple[float, float]]) -> tuple[float, float]:
    """Shift (dx, dz) so footprint centres fall on the 10 LDU half-stud lattice."""
    if not xz:
        return 0.0, 0.0
    a = np.array(xz)
    out = []
    for col in (0, 1):
        ang = np.radians(a[:, col] / 10.0 * 360.0)
        m = math.degrees(math.atan2(np.sin(ang).mean(), np.cos(ang).mean())) / 360.0 * 10.0
        out.append(-m)
    return out[0], out[1]


def pivot_column(bases, tail: float = 0.4) -> float | None:
    """Screen u of the orbit axis. A turntable orbits the model's centre, so the model
    blob's bbox u-centre stays on it; use the late frames, when the model is nearly
    complete. (Fitting ox jointly with every part's X, Z is nearly singular: each track
    sees ~15 degrees of orbit, over which an ox change is absorbed by shifting X, Z.)"""
    us = [b.bbox[0] + b.bbox[2] / 2.0 for b in bases[int(len(bases) * (1 - tail)) :] if b is not None]
    return float(np.median(us)) if us else None


def pivot_row(bases, tail: float = 0.4) -> float | None:
    """Screen v of the orbit centre (the model blob's bbox v-centre late in the clip).
    World height is only defined up to a constant, so this fixes y = 0 at that point."""
    vs = [b.bbox[1] + b.bbox[3] / 2.0 for b in bases[int(len(bases) * (1 - tail)) :] if b is not None]
    return float(np.median(vs)) if vs else None


def _fit_tracks(tracks_u, yaw_of, scale, ox) -> dict[int, tuple[float, float]]:
    xz = {}
    for tid, pts in tracks_u.items():
        A = np.array([[scale * math.cos(math.radians(yaw_of(f))), scale * math.sin(math.radians(yaw_of(f)))] for f, _u in pts])
        b = np.array([u - ox for _f, u in pts])
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        xz[tid] = (float(sol[0]), float(sol[1]))
    return xz


def lattice_coherence(xz: list[tuple[float, float]]) -> float:
    """How tightly part centres sit on a common 10 LDU lattice (0..2)."""
    if not xz:
        return 0.0
    a = np.radians(np.array(xz) / 10.0 * 360.0)
    return float(np.hypot(np.cos(a[:, 0]).mean(), np.sin(a[:, 0]).mean()) + np.hypot(np.cos(a[:, 1]).mean(), np.sin(a[:, 1]).mean()))


def refine_pivot(tracks_u, yaw_of, scale, ox0: float, span: float = 15.0, step: float = 0.25):
    """Self-calibrate the orbit column with the brick grid: the right ox puts the
    fitted part centres on a common 10 LDU lattice."""
    best = None
    for ox in np.arange(ox0 - span, ox0 + span + 1e-9, step):
        xz = _fit_tracks(tracks_u, yaw_of, scale, float(ox))
        c = lattice_coherence(list(xz.values()))
        if best is None or c > best[0]:
            best = (c, float(ox), xz)
    return best[1], best[2]


def estimate(tracks, part_of, meshes, frame_reader, n_frames: int, banks=None, bases=None) -> dict:
    """Full camera estimate: per-frame VCam list plus diagnostics."""
    obs = observe(tracks, part_of, meshes, frame_reader, banks=banks)
    orbit = fit_orbit(obs, n_frames)
    coef, pitch, scale = np.array(orbit["coef"]), orbit["pitch"], orbit["scale"]

    def yaw_of(fr):
        return float(np.polyval(coef, fr))

    tracks_u = {}
    for t in tracks:
        if t.id not in part_of:
            continue
        pts = [(b.frame, b.bbox[0] + b.bbox[2] / 2.0) for b in t.blobs if not b.touches_border]
        if len(pts) >= 2:
            tracks_u[t.id] = pts
    ox = pivot_column(bases) if bases else None
    if ox is None:
        ox, xz = fit_offset(tracks_u, yaw_of, scale)
    else:
        ox, xz = refine_pivot(tracks_u, yaw_of, scale, ox)
    dx, dz = lattice_shift(list(xz.values()))
    # moving the world origin by (-dx, -dz) changes ox and oy per frame; fold it in
    oy = (pivot_row(bases) if bases else None) or 0.0
    sp = math.sin(math.radians(pitch))
    cams = []
    for fr in range(n_frames):
        yv = math.radians(yaw_of(fr))
        ox_f = ox - scale * (math.cos(yv) * dx + math.sin(yv) * dz)
        oy_f = oy + scale * sp * (-math.sin(yv) * dx + math.cos(yv) * dz)
        cams.append(VCam(yaw_of(fr), pitch, scale, ox_f, oy_f))
    return {"cams": cams, "orbit": orbit, "ox": ox, "shift": (dx, dz), "n_obs": len(obs), "obs": obs}


def refine(cams: list[VCam], placements: dict, tracks, meshes, frame_reader, min_iou: float = 0.85,
           pitch_span: float = 3.0, pitch_step: float = 0.5, shift: tuple[float, float] = (0.0, 0.0),
           fovs: tuple[float, ...] | None = None, min_parts: int = 3) -> tuple[list[VCam], dict]:
    """Self-calibration from confidently placed parts.

    Screen u of a placed part does not depend on its (uncertain) height, so the left
    and right blob edges over all tracked frames pin down a constant ox error, a linear
    ox drift and a scale error by robust least squares. Pitch is then chosen by mean
    silhouette IoU at the parts' representative frames (orientation only, no height).
    `shift` is the lattice shift folded into ox/oy by `estimate`; oy is kept consistent
    with it when pitch changes. Returns (new cameras, diagnostics).
    """
    from brickheadz import video_place as vp

    n = max(1, len(cams) - 1)
    rows, rhs = [], []
    good = []
    for t in tracks:
        pl = placements.get(t.id)
        if pl is None or pl.matrix is None or pl.iou < min_iou:
            continue
        good.append((t, pl))
        R, T = pl.matrix[:3, :3], pl.matrix[:3, 3]
        v = meshes[pl.part].verts @ R.T.astype(np.float32)
        for b in t.blobs:
            if b.touches_border or not b.isolated or b.text >= 0.01:
                continue
            c = cams[b.frame]
            # a scale error stretches screen offsets from ox: u_obs - u = k (u - ox) + c0 + d f / n
            pe = vp.predicted_edges(v, T, c, (float(b.bbox[1]), float(b.bbox[1] + b.bbox[3])))
            for up, u in zip(pe, (float(b.bbox[0]), float(b.bbox[0] + b.bbox[2]))):
                rows.append([up - c.ox, 1.0, b.frame / n])
                rhs.append(u - up)
    diag = {"n_edges": len(rows), "n_parts": len(good)}
    out = list(cams)
    if len(good) < min_parts:
        return out, diag  # too few anchors: a fit to one or two parts runs away
    if len(rows) >= 8:
        M, r = np.array(rows), np.array(rhs)
        w = np.ones(len(r))
        for _ in range(5):  # Huber IRLS, 2 px
            sol, *_ = np.linalg.lstsq(M * w[:, None], r * w, rcond=None)
            e = np.abs(M @ sol - r)
            w = np.sqrt(np.where(e <= 2.0, 1.0, 2.0 / np.maximum(e, 1e-9)))
        k, c0, d = (float(x) for x in sol)
        diag.update(scale_k=k, ox_c=c0, ox_drift=d, resid_px=float(np.median(np.abs(M @ sol - r))))
        out = [cm.replace(scale=cm.scale * (1 + k), ox=cm.ox + c0 + d * f / n) for f, cm in enumerate(cams)]
    if good:
        reps = [(pl, vp.blob_mask(frame_reader(t.best.frame), t.best.bbox), t.best) for t, pl in good]
        best = (-1.0, 0.0)
        for dp in np.arange(-pitch_span, pitch_span + 1e-6, pitch_step):
            ious = []
            for pl, bm, b in reps:
                c = out[b.frame]
                sil = vp.hover_silhouette(meshes[pl.part], pl.matrix, c.replace(pitch=c.pitch + float(dp)),
                                          (float(b.bbox[1]), float(b.bbox[1] + b.bbox[3])))
                ious.append(vp.iou_aligned(sil, bm, float(b.bbox[0])) if sil is not None else 0.0)
            m = float(np.mean(ious))
            if m > best[0]:
                best = (m, float(dp))
        diag.update(pitch_delta=best[1], pitch_iou=best[0])
        dx, dz = shift

        def oy_term(c, p):
            yv = math.radians(c.yaw)
            return c.scale * math.sin(math.radians(p)) * (-math.sin(yv) * dx + math.cos(yv) * dz)

        out = [c.replace(pitch=c.pitch + best[1], oy=c.oy - oy_term(c, c.pitch) + oy_term(c, c.pitch + best[1]))
               for c in out]
        if fovs:
            # perspective: one camera distance (LDU) per clip, picked from a set of vertical
            # fields of view by the same silhouette score; 0 = orthographic
            H = frame_reader(reps[0][2].frame).shape[0]
            s_med = float(np.median([c.scale for c in out]))
            scored = []
            for fov in fovs:
                dist = (H / 2) / math.tan(math.radians(fov) / 2) / s_med if fov > 0 else 0.0
                ious = []
                for pl, bm, b in reps:
                    sil = vp.hover_silhouette(meshes[pl.part], pl.matrix, out[b.frame].replace(dist=dist),
                                              (float(b.bbox[1]), float(b.bbox[1] + b.bbox[3])))
                    ious.append(vp.iou_aligned(sil, bm, float(b.bbox[0])) if sil is not None else 0.0)
                scored.append((float(np.mean(ious)), fov, dist))
            m, fov, dist = max(scored)
            diag.update(fov=fov, fov_iou=m, fov_scores={f: round(x, 4) for x, f, _ in scored})
            out = [c.replace(dist=dist) for c in out]
    return out, diag


def solve(lib, tracks, part_of, meshes, cams, frame_reader, rounds: int = 2, shift: tuple[float, float] = (0.0, 0.0),
          fovs: tuple[float, ...] | None = None, pitch_spans: tuple[float, ...] | None = None):
    """Place, self-calibrate the camera from the placements, place again."""
    from brickheadz import video_place as vp

    res, score = vp.place_all(lib, tracks, part_of, meshes, cams, frame_reader)
    diags = []
    spans = pitch_spans or (3.0,) * rounds
    for span in spans:
        cams, dg = refine(cams, res, tracks, meshes, frame_reader, shift=shift, fovs=fovs, pitch_span=span,
                          pitch_step=1.0 if span > 5 else 0.5)
        diags.append(dg)
        res, score = vp.place_all(lib, tracks, part_of, meshes, cams, frame_reader)
    return res, score, cams, diags


def solve_fov(lib, tracks, part_of, meshes, cams, frame_reader, fovs=(0, 15, 20, 25, 30, 40),
              shift: tuple[float, float] = (0.0, 0.0), pitch_spans=(10.0, 3.0, 1.5), obs=None):
    """`solve` once per candidate vertical field of view (degrees, 0 = orthographic),
    starting from a camera distance that gives that view at each frame's scale; keeps
    the run with the best mean silhouette IoU. Returns (res, score, cams, diags, table)."""
    H = frame_reader(0).shape[0]
    best, table = None, []
    for fov in fovs:
        init = [c.replace(dist=(H / 2) / math.tan(math.radians(fov) / 2) / c.scale if fov > 0 else 0.0) for c in cams]
        if obs and fov > 0:
            # outline-based pitches see each part along its own ray: a part above the
            # optical centre (ox, oy) looks flatter by atan((oy - v) / f)
            f_px = (H / 2) / math.tan(math.radians(fov) / 2)
            good = [o for o in obs if o.score > 0.55 and o.v > 0] or [o for o in obs if o.v > 0]
            if good:
                pitch = float(np.median([o.pitch + math.degrees(math.atan((cams[o.frame].oy - o.v) / f_px)) for o in good]))
                init = [c.replace(pitch=pitch) for c in init]
        res, score, out, dg = solve(lib, tracks, part_of, meshes, init, frame_reader, shift=shift, pitch_spans=pitch_spans)
        table.append((fov, score, out[0].pitch))
        if best is None or score > best[1]:
            best = (res, score, out, dg)
    return (*best, table)
