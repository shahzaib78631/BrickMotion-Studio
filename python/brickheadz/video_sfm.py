"""Per-frame camera from the model itself (stage 3a', replaces the fixed-orbit fit).

The real clips do not orbit a fixed point at constant zoom: the camera follows the
build (pans, tilts, zooms) while it turns. The model is rigid once parts have
landed, so points tracked on it give the camera in every frame:

1. KLT feature tracks inside the model blob, with a forward-backward check, topped
   up with new corners as the model grows.
2. Bundle adjustment of a per-frame scaled-orthographic camera (yaw, pitch, scale,
   ox, oy; no roll) and the tracks' 3D points, with a robust loss. Gauges are
   fixed softly: yaw at frame 0, mean log-scale (px/LDU, from the part-based
   estimate), and the point cloud's mean at the origin. A weak second-difference
   prior keeps camera parameters smooth through frames with few points.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_sfm needs opencv-python-headless") from e

from brickheadz.video_place import blob_mask
from brickheadz.video_synth import VCam


@dataclass
class Tracks:
    """obs[k] = (frame, point id, u, v)."""

    frames: np.ndarray
    pts: np.ndarray
    uv: np.ndarray
    n_points: int


def model_mask(frame: np.ndarray, base) -> np.ndarray:
    m = np.zeros(frame.shape[:2], np.uint8)
    if base is None:
        return m
    x, y, w, h = base.bbox
    m[y : y + h, x : x + w] = blob_mask(frame, base.bbox).astype(np.uint8)
    return cv2.erode(m, np.ones((5, 5), np.uint8))  # keep corners off the silhouette rim


def klt_tracks(frame_reader, n_frames: int, bases, max_corners: int = 600, min_dist: int = 7,
               fb_tol: float = 1.0, min_len: int = 4) -> Tracks:
    lk = dict(winSize=(15, 15), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    obs: list[tuple[int, int, float, float]] = []
    live_ids = np.zeros(0, int)
    live_pts = np.zeros((0, 1, 2), np.float32)
    next_id = 0
    prev = None
    for f in range(n_frames):
        img = cv2.cvtColor(frame_reader(f), cv2.COLOR_BGR2GRAY)
        mask = model_mask(frame_reader(f), bases[f])
        if prev is not None and len(live_pts):
            p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev, img, live_pts, None, **lk)
            p0, st0, _ = cv2.calcOpticalFlowPyrLK(img, prev, p1, None, **lk)
            fb = np.linalg.norm((p0 - live_pts).reshape(-1, 2), axis=1)
            q = p1.reshape(-1, 2)
            inside = np.zeros(len(q), bool)
            ok_xy = (q[:, 0] >= 0) & (q[:, 1] >= 0) & (q[:, 0] < img.shape[1]) & (q[:, 1] < img.shape[0])
            inside[ok_xy] = mask[q[ok_xy, 1].astype(int), q[ok_xy, 0].astype(int)] > 0
            good = (st1.ravel() == 1) & (st0.ravel() == 1) & (fb < fb_tol) & inside
            live_ids, live_pts = live_ids[good], p1[good]
        # top up with new corners away from live ones
        if mask.any():
            room = mask.copy()
            for x, y in live_pts.reshape(-1, 2):
                cv2.circle(room, (int(x), int(y)), min_dist, 0, -1)
            need = max_corners - len(live_pts)
            if need > 0:
                new = cv2.goodFeaturesToTrack(img, need, 0.01, min_dist, mask=room)
                if new is not None:
                    live_pts = np.concatenate([live_pts, new.astype(np.float32)])
                    live_ids = np.concatenate([live_ids, np.arange(next_id, next_id + len(new))])
                    next_id += len(new)
        for i, (x, y) in zip(live_ids, live_pts.reshape(-1, 2)):
            obs.append((f, int(i), float(x), float(y)))
        prev = img
    o = np.array(obs, float).reshape(-1, 4)
    ids, counts = np.unique(o[:, 1].astype(int), return_counts=True)
    keep = set(ids[counts >= min_len].tolist())
    o = o[np.array([int(i) in keep for i in o[:, 1]], bool)]
    remap = {old: new for new, old in enumerate(sorted(keep))}
    pts = np.array([remap[int(i)] for i in o[:, 1]], int)
    return Tracks(o[:, 0].astype(int), pts, o[:, 2:4].copy(), len(remap))


def _project(cam: np.ndarray, P: np.ndarray, frames: np.ndarray, pts: np.ndarray):
    """cam: (F, 5) = yaw, pitch (radians), log scale, ox, oy; P: (N, 3)."""
    c = cam[frames]
    X, Y, Z = P[pts, 0], P[pts, 1], P[pts, 2]
    cy, sy, cp, spi = np.cos(c[:, 0]), np.sin(c[:, 0]), np.cos(c[:, 1]), np.sin(c[:, 1])
    s = np.exp(c[:, 2])
    xp = cy * X + sy * Z
    zp = -sy * X + cy * Z
    return s * xp + c[:, 3], s * (cp * Y - spi * zp) + c[:, 4]


def _triangulate(cam: np.ndarray, tr: Tracks, ridge: float = 1e-3) -> np.ndarray:
    """Linear least squares per point given cameras (u, v are linear in X, Y, Z)."""
    c = cam[tr.frames]
    s = np.exp(c[:, 2])
    cy, sy, cp, spi = np.cos(c[:, 0]), np.sin(c[:, 0]), np.cos(c[:, 1]), np.sin(c[:, 1])
    Au = np.stack([s * cy, np.zeros_like(s), s * sy], 1)
    Av = np.stack([s * spi * sy, s * cp, -s * spi * cy], 1)
    bu, bv = tr.uv[:, 0] - c[:, 3], tr.uv[:, 1] - c[:, 4]
    P = np.zeros((tr.n_points, 3))
    AtA = np.zeros((tr.n_points, 3, 3))
    Atb = np.zeros((tr.n_points, 3))
    for A, b in ((Au, bu), (Av, bv)):
        np.add.at(AtA, tr.pts, A[:, :, None] * A[:, None, :])
        np.add.at(Atb, tr.pts, A * b[:, None])
    AtA += ridge * np.eye(3) * np.mean(np.exp(cam[:, 2])) ** 2
    P = np.linalg.solve(AtA, Atb[:, :, None])[:, :, 0]
    return P


def bundle_adjust(tr: Tracks, init: list[VCam], scale_ref: float, smooth: float = 2.0, loss_px: float = 1.5,
                  iters: int = 60, rounds: int = 4, shared_pitch: bool = True, pan_stiff: float = 1.0, yaw_stiff: float = 1.0,
                  freeze_rotation: bool = False,
                  shared_scale: bool = False, view_yaws=None, view_px: float = 2.0, view_deg: float = 3.0
                  ) -> tuple[list[VCam], dict]:
    """Per-frame cameras + 3D points minimising reprojection error.

    Gauge freedoms are removed by freezing parameters, not by soft penalties (a robust
    loss would cap the penalties): yaw and scale at frame 0, ox/oy at frame 0 and ox at
    the last frame (pins the 3 dof of translation); scale is renormalised to mean
    `scale_ref` afterwards (s*P is invariant). Outliers get Huber weights by iterative
    reweighting of the reprojection residuals only. Pitch is bounded to views from
    above (this also removes the orthographic depth-reversal ambiguity) and, with
    `shared_pitch`, one value for the clip: per-frame pitch lets rotation, tilt and
    depth trade off (the orthographic bas-relief ambiguity) and yaw drifts.

    view_yaws: [(frame, yaw deg)] from part silhouettes, each the camera yaw modulo 90
    in brick axes. They anchor yaw in absolute terms (frame 0, where the model is
    tiny, is a poor anchor) and stop slow rate drift; each counts like a `view_px`
    reprojection residual per degree, with Huber weights at `view_deg`.
    """
    from scipy.optimize import least_squares
    from scipy.sparse import lil_matrix

    F, N, K = len(init), tr.n_points, len(tr.frames)
    cam0 = np.array([[math.radians(c.yaw), math.radians(c.pitch), math.log(c.scale), c.ox, c.oy] for c in init])
    nc = 5 * F
    full0 = np.concatenate([cam0.ravel(), np.zeros(3 * N)])
    frozen = np.zeros(len(full0), bool)
    vy = np.array(view_yaws or [], float).reshape(-1, 2)
    V = len(vy)
    vf = vy[:, 0].astype(int)
    frozen[[2, 3, 4, 5 * (F - 1) + 3] + ([] if V >= 3 else [0])] = True
    if shared_pitch:
        frozen[np.arange(1, F) * 5 + 1] = True
    if freeze_rotation:  # yaw, pitch, scale given (e.g. the part-based orbit): pan + points only
        frozen[0:nc:5] = frozen[1:nc:5] = frozen[2:nc:5] = True
    if shared_scale:  # one zoom for the clip (frame 0's, frozen as the s*P gauge)
        frozen[np.arange(1, F) * 5 + 2] = True
        cam0[:, 2] = cam0[:, 2].mean()
        full0[2:nc:5] = cam0[:, 2]
    free = np.flatnonzero(~frozen)
    w_s = math.sqrt(smooth)
    # pan (ox, oy) gets `pan_stiff` x the prior: per-frame pan otherwise lets the world
    # slide between parts of the clip that share no point tracks
    unit = np.array([yaw_stiff * math.degrees(1), math.degrees(1), 100.0, pan_stiff, pan_stiff])

    def unpack(x):
        full = full0.copy()
        full[free] = x
        cam = full[:nc].reshape(F, 5)
        if shared_pitch:
            cam[:, 1] = cam[0, 1]
        if shared_scale:
            cam[:, 2] = cam[0, 2]
        return cam, full[nc:].reshape(N, 3)

    def view_err(cam):
        return (np.degrees(cam[vf, 0]) - vy[:, 1] + 45.0) % 90.0 - 45.0

    def resid(x, sw, vw):
        cam, P = unpack(x)
        u, v = _project(cam, P, tr.frames, tr.pts)
        d2 = cam[2:] - 2 * cam[1:-1] + cam[:-2]
        return np.concatenate([(u - tr.uv[:, 0]) * sw, (v - tr.uv[:, 1]) * sw, (w_s * d2 * unit).ravel(),
                               view_px * view_err(cam) * vw])

    J = lil_matrix((2 * K + 5 * max(0, F - 2) + V, nc + 3 * N), dtype=np.uint8)
    rows = np.arange(K)
    for a in range(5):
        J[rows, 5 * tr.frames + a] = 1
        J[K + rows, 5 * tr.frames + a] = 1
    for a in range(3):
        J[rows, nc + 3 * tr.pts + a] = 1
        J[K + rows, nc + 3 * tr.pts + a] = 1
    for f in range(F - 2):
        for a in range(5):
            J[2 * K + 5 * f + a, [5 * g + a for g in (f, f + 1, f + 2)]] = 1
    for i, f in enumerate(vf):
        J[2 * K + 5 * max(0, F - 2) + i, 5 * f] = 1
    if shared_pitch:
        J[: 2 * K, 1] = 1
    J = J.tocsc()[:, free]
    full0[nc:] = _triangulate(cam0, tr).ravel()
    lo = np.full(len(full0), -np.inf)
    hi = np.full(len(full0), np.inf)
    lo[1:nc:5], hi[1:nc:5] = math.radians(2.0), math.radians(80.0)
    x = np.clip(full0, lo + 1e-9, hi - 1e-9)[free]
    sw = np.ones(K)
    vw = np.ones(V)
    sol = None
    for _ in range(rounds):
        sol = least_squares(resid, x, jac_sparsity=J, x_scale="jac", max_nfev=max(5, iters // rounds), method="trf",
                            tr_solver="lsmr", bounds=(lo[free], hi[free]), args=(sw, vw))
        x = sol.x
        cam, P = unpack(x)
        u, v = _project(cam, P, tr.frames, tr.pts)
        err = np.hypot(u - tr.uv[:, 0], v - tr.uv[:, 1])
        w = np.minimum(1.0, loss_px / np.maximum(err, 1e-9))
        # whole-track weight too: a corner sliding round a stud is off along its whole
        # track, not in one frame
        med = np.zeros(N)
        for i, e_i in zip(*_group_median(tr.pts, err, N)):
            med[i] = e_i
        w = np.minimum(w, np.minimum(1.0, loss_px / np.maximum(med[tr.pts], 1e-9)) ** 2)
        sw = np.sqrt(w)
        if V:
            ve = np.abs(view_err(cam))
            vw = np.sqrt(np.minimum(1.0, view_deg / np.maximum(ve, 1e-9)))
    cam, P = unpack(x)
    cam = cam.copy()
    k = scale_ref / float(np.exp(cam[:, 2].mean()))  # renormalise the s*P gauge
    cam[:, 2] += math.log(k)
    P = P / k
    u, v = _project(cam, P, tr.frames, tr.pts)
    err = np.hypot(u - tr.uv[:, 0], v - tr.uv[:, 1])
    cams = [VCam(math.degrees(c[0]), math.degrees(c[1]), math.exp(c[2]), c[3], c[4]) for c in cam]
    cost = float(np.sum(np.where(err < loss_px, 0.5 * err**2, loss_px * (err - 0.5 * loss_px))))
    return cams, {"median_px": float(np.median(err)), "p90_px": float(np.percentile(err, 90)), "n_obs": K, "n_points": N,
                  "inlier_frac": float((err < 2 * loss_px).mean()), "cost": cost, "points": P,
                  "view_med_deg": float(np.median(np.abs(view_err(cam)))) if V else float("nan")}


def _group_median(ids: np.ndarray, vals: np.ndarray, n: int):
    order = np.argsort(ids, kind="stable")
    i_s, v_s = ids[order], vals[order]
    starts = np.flatnonzero(np.r_[True, i_s[1:] != i_s[:-1]])
    ends = np.r_[starts[1:], len(i_s)]
    return i_s[starts], np.array([np.median(v_s[a:b]) for a, b in zip(starts, ends)])


def initial_cameras(n_frames: int, bases, yaw_rate: float, pitch: float, scale: float) -> list[VCam]:
    """Orbit at a constant rate, framed on the model blob's centre in each frame."""
    cams = []
    last = None
    for f in range(n_frames):
        b = bases[f] or last
        last = b
        cu = b.bbox[0] + b.bbox[2] / 2.0 if b else 360.0
        cv = b.bbox[1] + b.bbox[3] / 2.0 if b else 640.0
        cams.append(VCam(yaw_rate * f, pitch, scale, cu, cv))
    return cams


def segments(tr: Tracks, length: int = 12, overlap: int = 4) -> Tracks:
    """Cut tracks into overlapping pieces of at most `length` frames.

    Many corners on brick renders lie on stud outlines; a stud is round, so such a
    'corner' slides around it as the view turns and is not one 3D point over a long
    track (measured: 40+ frame tracks have ~4x the error of short ones). Short
    overlapping pieces keep the frame-to-frame linkage while bounding the slide.
    """
    order = np.lexsort((tr.frames, tr.pts))
    f, p, uv = tr.frames[order], tr.pts[order], tr.uv[order]
    out_f, out_p, out_uv = [], [], []
    nid = 0
    starts = np.flatnonzero(np.r_[True, p[1:] != p[:-1]])
    ends = np.r_[starts[1:], len(p)]
    step = max(1, length - overlap)
    for a, b in zip(starts, ends):
        n = b - a
        for s0 in range(0, max(1, n - overlap), step):
            s1 = min(n, s0 + length)
            if s1 - s0 < 4:
                continue
            out_f.append(f[a + s0 : a + s1])
            out_uv.append(uv[a + s0 : a + s1])
            out_p.append(np.full(s1 - s0, nid))
            nid += 1
    return Tracks(np.concatenate(out_f), np.concatenate(out_p), np.concatenate(out_uv), nid)


def subsample(tr: Tracks, max_points: int = 3000, seed: int = 0) -> Tracks:
    """Keep at most `max_points` tracks, spread over the clip: bundle adjustment cost
    grows with the point count, and frames early in the clip (small model, few
    corners) must keep theirs."""
    if tr.n_points <= max_points:
        return tr
    rng = np.random.default_rng(seed)
    first = np.full(tr.n_points, 10**9)
    np.minimum.at(first, tr.pts, tr.frames)
    # equal quota per starting frame, random within it
    keep = []
    frames = np.unique(first)
    quota = max(1, max_points // len(frames))
    for fr in frames:
        ids = np.flatnonzero(first == fr)
        keep.extend(rng.choice(ids, min(quota, len(ids)), replace=False).tolist())
    keep = np.array(sorted(keep))
    remap = np.full(tr.n_points, -1)
    remap[keep] = np.arange(len(keep))
    sel = remap[tr.pts] >= 0
    return Tracks(tr.frames[sel], remap[tr.pts[sel]], tr.uv[sel], len(keep))


def track_camera(frame_reader, n_frames: int, bases, est: dict, max_points: int = 3000, min_len: int = 8,
                 **kw) -> tuple[list[VCam], dict]:
    """KLT + bundle adjustment, started from the part-based orbit estimate
    (video_camera.estimate: yaw, pitch, scale) with ox/oy on the model blob's centre,
    and anchored by that estimate's per-part yaw views."""
    tr = subsample(klt_tracks(frame_reader, n_frames, bases, min_len=min_len), max_points)
    init = initial_cameras(n_frames, bases, 0.0, est["orbit"]["pitch"], est["orbit"]["scale"])
    init = [c.replace(yaw=e.yaw) for c, e in zip(init, est["cams"])]
    views = [(o.frame, o.yaw) for o in est["obs"]]
    cams, d = bundle_adjust(tr, init, est["orbit"]["scale"], view_yaws=views, **kw)
    d["tracks"] = tr
    return cams, d


def align_yaw(cams: list[VCam], view_obs) -> tuple[list[VCam], float, float]:
    """Rotate the world about y so its axes line up with the bricks.

    Bundle adjustment fixes yaw only relative to frame 0. Each part-silhouette view
    (video_camera.ViewObs) measures camera yaw modulo 90 deg in brick axes, so the
    offset is a robust 90-fold circular mean. Rotating the world about the vertical
    axis through the origin changes only the cameras' yaw. Returns (cams, offset deg,
    median abs residual deg).
    """
    if not view_obs:
        return cams, 0.0, float("nan")
    d = np.array([o.yaw - cams[o.frame].yaw for o in view_obs])
    ang = np.radians(d * 4.0)  # 90-fold -> full circle
    off = math.degrees(math.atan2(np.sin(ang).mean(), np.cos(ang).mean())) / 4.0
    for _ in range(3):  # re-centre on inliers
        r = (d - off + 45.0) % 90.0 - 45.0
        inl = np.abs(r) < 6.0
        if inl.sum() < 3:
            break
        off += float(np.median(r[inl]))
    r = (d - off + 45.0) % 90.0 - 45.0
    return [c.replace(yaw=c.yaw + off) for c in cams], float(off), float(np.median(np.abs(r)))


# ---- incremental rotation (handles fast, uneven turns) --------------------------------

def frame_pair_motion(tr: Tracks, n_frames: int, min_pts: int = 12, tukey: float = 2.0):
    """Per frame pair (f, f+1): alpha = sin(pitch) * d(yaw) [rad] and zoom k.

    For a camera turning about the vertical axis, a point's vertical screen motion is
    dv = sin(pitch) d(yaw) (u - ox) + k (v - oy) + d(oy): linear in its screen
    position, with no depth term (dv/d(yaw) = s sin(pitch) x'). So a robust fit
    dv ~ alpha u + k v + c over the points tracked in both frames gives the turn and
    zoom of that step. Returns (alpha, k, n_inliers), each length n_frames - 1; steps
    with too few points are interpolated.
    """
    order = np.lexsort((tr.frames, tr.pts))
    f, p, uv = tr.frames[order], tr.pts[order], tr.uv[order]
    nxt = (p[1:] == p[:-1]) & (f[1:] == f[:-1] + 1)
    i0 = np.flatnonzero(nxt)
    fr = f[i0]
    u, v = uv[i0, 0], uv[i0, 1]
    dv = uv[i0 + 1, 1] - v
    alpha = np.full(n_frames - 1, np.nan)
    zoom = np.zeros(n_frames - 1)
    n_in = np.zeros(n_frames - 1, int)
    for g in range(n_frames - 1):
        sel = fr == g
        if sel.sum() < min_pts:
            continue
        A = np.stack([u[sel], v[sel], np.ones(sel.sum())], 1)
        A[:, :2] -= A[:, :2].mean(0)  # conditioning; alpha, k unchanged
        b = dv[sel]
        w = np.ones(len(b))
        for _ in range(6):  # Tukey IRLS
            sol, *_ = np.linalg.lstsq(A * w[:, None], b * w, rcond=None)
            e = np.abs(A @ sol - b)
            w = np.sqrt(np.clip(1 - (e / tukey) ** 2, 0, 1) ** 2)
        alpha[g], zoom[g], n_in[g] = sol[0], sol[1], int((e < tukey).sum())
    ok = ~np.isnan(alpha)
    if ok.any() and not ok.all():
        alpha = np.interp(np.arange(len(alpha)), np.flatnonzero(ok), alpha[ok])
    return np.nan_to_num(alpha), zoom, n_in


def _clean_steps(a: np.ndarray, win: int = 9, k: float = 3.0) -> np.ndarray:
    """Replace step outliers (e.g. frames where a part lands in the tracked region)
    by the running median."""
    n = len(a)
    med = np.array([np.median(a[max(0, i - win // 2) : i + win // 2 + 1]) for i in range(n)])
    dev = np.abs(a - med)
    mad = 1.4826 * np.median(dev) + 1e-12
    return np.where(dev > k * mad, med, a)


def rotation_from_motion(alpha: np.ndarray, view_obs, rate_deg: float, scale_window: int = 30,
                         drift_window: int = 40):
    """Yaw per frame (deg), pitch and per-frame scale.

    alpha = sin(pitch) * d(yaw) per step is measured well, but pitch is not: part
    views (yaw mod 90) cannot pin it. The part-based orbit's mean turn rate can (it is
    unaliased once steps are well under 45 deg), so sin(pitch) = median(alpha) /
    rate. The absolute yaw offset comes from the part views; scale from their sizes,
    as a running median over time (summing per-step zoom factors drifts).
    """
    a = _clean_steps(alpha)
    ratio = abs(float(np.median(a))) / max(1e-9, abs(math.radians(rate_deg)))
    pitch = math.degrees(math.asin(min(0.99, max(0.05, ratio))))
    yaw = np.degrees(np.concatenate([[0.0], np.cumsum(a)]) / math.sin(math.radians(pitch)))
    vf = np.array([o.frame for o in view_obs], int)
    vy = np.array([o.yaw for o in view_obs], float)

    def fit_offset(y):
        d = vy - y[vf]
        ang = np.radians(d * 4.0)
        off = math.degrees(math.atan2(np.sin(ang).mean(), np.cos(ang).mean())) / 4.0
        r = np.abs((d - off + 45.0) % 90.0 - 45.0)
        return off, float(np.mean(np.minimum(r, 10.0)))

    # small overall rate correction (summed steps run a few % off); a narrow range
    # keeps the 90-degree view ambiguity from aliasing it
    if len(vf) >= 5:
        lam = min(np.arange(0.88, 1.1201, 0.002), key=lambda l: fit_offset(yaw * l)[1])
        yaw = yaw * lam
        pitch = math.degrees(math.asin(min(0.99, math.sin(math.radians(pitch)) / lam)))
    off, _ = fit_offset(yaw)
    d = vy - yaw[vf]
    for _ in range(3):
        r = (d - off + 45.0) % 90.0 - 45.0
        inl = np.abs(r) < 8.0
        if inl.sum() >= 3:
            off += float(np.median(r[inl]))
    yaw = yaw + off
    n = len(yaw)
    # complementary filter: steps give the fast detail, part views (absolute mod 90)
    # pull the slow drift back via a running robust correction
    for _ in range(3):
        r = (vy - yaw[vf] + 45.0) % 90.0 - 45.0
        corr = np.full(n, np.nan)
        for f in range(n):
            near = (np.abs(vf - f) <= drift_window) & (np.abs(r) < 20.0)
            if near.sum() >= 4:
                corr[f] = float(np.median(r[near]))
        ok = ~np.isnan(corr)
        if not ok.any():
            break
        corr = np.interp(np.arange(n), np.flatnonzero(ok), corr[ok])
        k = max(1, drift_window // 2)
        corr = np.convolve(np.pad(corr, k, mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
        yaw = yaw + corr
    resid = float(np.median(np.abs((vy - yaw[vf] + 45.0) % 90.0 - 45.0))) if len(vf) else float("nan")
    vs = np.array([o.scale for o in view_obs], float)
    scale = np.full(n, float(np.median(vs)) if len(vs) else 1.0)
    for f in range(n):
        near = np.abs(vf - f) <= scale_window
        if near.sum() >= 3:
            scale[f] = float(np.median(vs[near]))
    return yaw, float(pitch), scale, resid


def track_camera_incremental(frame_reader, n_frames: int, bases, est: dict, pan_stiff: float = 20.0,
                             max_points: int = 3000, **kw) -> tuple[list[VCam], dict]:
    """Turn per step from frame-pair motion; pitch from its ratio to the part-based
    orbit rate; yaw offset and scale from part views; then pan (and points) by bundle
    adjustment with rotation and scale held."""
    raw = klt_tracks(frame_reader, n_frames, bases, min_len=4)
    alpha, _zoom, n_in = frame_pair_motion(raw, n_frames)
    rate = float(est["orbit"]["coef"][-2])  # deg/frame of the part-based orbit (linear term)
    yaw, pitch, scale, vscore = rotation_from_motion(alpha, est["obs"], rate)
    init = initial_cameras(n_frames, bases, 0.0, pitch, 1.0)
    init = [c.replace(yaw=float(y), pitch=pitch, scale=float(s)) for y, s, c in zip(yaw, scale, init)]
    tr = subsample(klt_tracks(frame_reader, n_frames, bases, min_len=8), max_points)
    cams, d = bundle_adjust(tr, init, float(np.mean(scale)), freeze_rotation=True, pan_stiff=pan_stiff, **kw)
    d.update(tracks=tr, pitch=pitch, view_resid_deg=vscore, step_inliers_median=float(np.median(n_in)),
             yaw_span=float(yaw[-1] - yaw[0]), zoom_range=(float(scale.min()), float(scale.max())))
    return cams, d
