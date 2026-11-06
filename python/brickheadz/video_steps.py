"""Build-animation video -> per-part tracks (stage 1 of video -> model).

The KenBrick clips are 3D-rendered exploded build animations on a black
background: each step's new parts hover above the model, then snap on. This
stage finds those hovering parts and tracks each one across frames so a later
stage can classify it and place it. It does no part identification itself.

Output per clip: a list of `PartTrack` (first/last frame, the best crop, median
colour). Overlay graphics (logo, animated title banner) are rejected by
heuristics; every rejection rule is conservative and reported via `reject`.
"""
from __future__ import annotations

import glob
import os
import subprocess
import tempfile
from dataclasses import dataclass, field

import numpy as np

try:  # opencv is an optional dependency of the video tooling
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_steps needs opencv-python-headless") from e

FG_LUMA = 28          # max-channel threshold for "not background"
MIN_AREA = 1500       # px at 720x1280; smaller blobs are noise / text glyphs
MATCH_DIST = 140      # px: max centroid jump between frames to continue a track


@dataclass
class Blob:
    frame: int
    bbox: tuple[int, int, int, int]  # x, y, w, h
    area: int
    centroid: tuple[float, float]
    touches_border: bool
    solidity: float = 1.0  # area / convex-hull area; low => several parts merged
    isolated: bool = True  # no other blob within a few px (not touching/occluding)
    text: float = 0.0  # share of the bbox covered by removed overlay-text strokes
    motion: bool = False  # found by its motion in front of the model, not as a separate outline
    mask: np.ndarray | None = field(default=None, repr=False)  # bbox-sized pixel mask (motion blobs only)


@dataclass
class PartTrack:
    id: int
    blobs: list[Blob] = field(default_factory=list)
    best: Blob | None = None
    crop_path: str | None = None
    rgb: tuple[int, int, int] | None = None

    @property
    def first(self) -> int:
        return self.blobs[0].frame

    @property
    def last(self) -> int:
        return self.blobs[-1].frame


def extract(video: str, directory: str | None = None, fps: int = 10) -> list[str]:
    directory = directory or tempfile.mkdtemp(prefix="bhsteps-")
    os.makedirs(directory, exist_ok=True)
    for old in glob.glob(os.path.join(directory, "[0-9]*.png")):
        os.remove(old)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video, "-vf", f"fps={fps}", os.path.join(directory, "%04d.png")], check=True)
    return sorted(glob.glob(os.path.join(directory, "[0-9]*.png")))


def static_overlay(frames: np.ndarray) -> np.ndarray:
    """Pixels that stay bright and unchanged for the whole clip (the logo)."""
    f = frames.astype(np.float32)
    std = f.std(axis=0).mean(axis=2)
    peak = f.mean(axis=0).max(axis=2)
    mask = (std < 3) & (peak > 40)
    return cv2.dilate(mask.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0


def is_overlay_blob(frame: np.ndarray, b: Blob, mask: np.ndarray) -> str | None:
    """Return a reason string if the blob is title-banner graphics, else None."""
    x, y, w, h = b.bbox
    sel = mask[y : y + h, x : x + w]
    px = frame[y : y + h, x : x + w][sel]
    if px.size == 0:
        return "empty"
    # animated banner: a thin bar / text strip in the upper-left band
    if y + h < 280 and x < 620 and h < 70:
        return "banner"
    # pure yellow strip
    yellow = ((px[:, 2] > 225) & (px[:, 1] > 225) & (px[:, 0] < 70)).mean()
    if yellow > 0.6 and h < 40:
        return "yellow-bar"
    # text / logo glyphs: large share of flat, near-pure white or yellow pixels
    # (shaded brick faces rarely exceed ~240 on all channels)
    white = (px.min(axis=1) > 240).mean()
    if (white + yellow) > 0.30:
        return "text-or-logo"
    # anything wholly inside the banner box that contains some text-coloured pixels
    if y + h < 320 and x + w < 680 and (white + yellow) > 0.08:
        return "banner"
    return None


def thin_text_strokes(frame: np.ndarray) -> np.ndarray:
    """Pixels of pure white / yellow that form strokes thinner than ~9 px (title text,
    banner bar). Parts' faces are wider than that, so they survive the opening."""
    b, g, r = frame[..., 0], frame[..., 1], frame[..., 2]
    white = (frame.min(axis=2) > 235)
    yellow = (r > 225) & (g > 215) & (b < 90)
    cand = (white | yellow).astype(np.uint8)
    if not cand.any():
        return np.zeros(cand.shape, bool)
    thick = cv2.morphologyEx(cand, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    thick = cv2.dilate(thick, np.ones((5, 5), np.uint8))
    strokes = (cand > 0) & (thick == 0)
    return cv2.dilate(strokes.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0


def blobs_in_frame(frame: np.ndarray, static: np.ndarray, index: int) -> tuple[list[Blob], list[tuple[Blob, str]]]:
    h, w = frame.shape[:2]
    fg = ((frame.max(axis=2) > FG_LUMA) & ~static)
    strokes = thin_text_strokes(frame)
    fg &= ~strokes
    fg = cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(fg, connectivity=8)
    kept, rejected = [], []
    for k in range(1, n):
        area = int(stats[k, cv2.CC_STAT_AREA])
        if area < MIN_AREA:
            continue
        x, y, bw, bh = (int(v) for v in stats[k, :4])
        blob = Blob(index, (x, y, bw, bh), area, (float(cent[k, 0]), float(cent[k, 1])), x <= 2 or y <= 2 or x + bw >= w - 2 or y + bh >= h - 2)
        sub = (lab[y : y + bh, x : x + bw] == k).astype(np.uint8)
        cnts, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        hull = cv2.contourArea(cv2.convexHull(max(cnts, key=cv2.contourArea))) if cnts else 0
        blob.solidity = round(area / hull, 3) if hull else 1.0
        blob.text = float(strokes[y : y + bh, x : x + bw].mean())
        reason = is_overlay_blob(frame, blob, lab == k)
        (rejected if reason else kept).append((blob, reason) if reason else blob)
    return kept, rejected  # type: ignore[return-value]


MOTION_T = 3.0  # px/frame: vertical motion this far from the model's own motion marks a moving part
MOTION_WIN = 9  # optical-flow window; small keeps part outlines tight


def motion_blobs(a: np.ndarray, b: np.ndarray, base: Blob | None, others: list[Blob], index: int,
                 thresh: float = MOTION_T, min_area: int = MIN_AREA // 2) -> list[Blob]:
    """Parts moving in front of (or overlapping) the model, which outline segmentation merges into it.

    The model turns about a vertical axis, so its vertical screen motion is linear in screen
    position (plus pan and zoom) and does not depend on depth; a dropping or rising part
    moves vertically much faster. Pixels inside the model whose vertical optical flow departs
    from a robust linear fit of the model's are a moving part.
    """
    if base is None:
        return []
    fg = a.max(axis=2) > FG_LUMA
    ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    x0, y0, w0, h0 = base.bbox
    pad = 12
    xa, ya = max(0, x0 - pad), max(0, y0 - pad)
    xb, yb = min(a.shape[1], x0 + w0 + pad), min(a.shape[0], y0 + h0 + pad)
    fl = cv2.calcOpticalFlowFarneback(ga[ya:yb, xa:xb], gb[ya:yb, xa:xb], None, 0.5, 4, MOTION_WIN, 3, 5, 1.2, 0)
    sub = fg[ya:yb, xa:xb]
    ys, xs = np.nonzero(sub)
    if len(xs) < 200:
        return []
    A = np.stack([xs, ys, np.ones_like(xs)], 1).astype(np.float64)
    y = fl[ys, xs, 1].astype(np.float64)
    w = np.ones(len(y))
    for _ in range(4):  # robust: the moving parts themselves are outliers
        coef = np.linalg.lstsq(A * w[:, None], y * w, rcond=None)[0]
        r = y - A @ coef
        w = (np.abs(r) < 2.5 * max(1.4826 * float(np.median(np.abs(r))), 1.0)).astype(float)
    gx, gy = np.meshgrid(np.arange(sub.shape[1]), np.arange(sub.shape[0]))
    res = np.abs(fl[..., 1] - (coef[0] * gx + coef[1] * gy + coef[2]))
    m = ((res > thresh) & sub).astype(np.uint8)
    for o in others:  # parts already seen as their own outline
        ox, oy, ow, oh = o.bbox
        m[max(0, oy - ya) : max(0, oy - ya + oh), max(0, ox - xa) : max(0, ox - xa + ow)] = 0
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(m, connectivity=8)
    out = []
    for k in range(1, n):
        area = int(stats[k, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x, y_, bw, bh = (int(v) for v in stats[k, :4])
        bl = Blob(index, (x + xa, y_ + ya, bw, bh), area, (float(cent[k, 0]) + xa, float(cent[k, 1]) + ya),
                  x + xa <= 2 or y_ + ya <= 2 or x + xa + bw >= a.shape[1] - 2 or y_ + ya + bh >= a.shape[0] - 2,
                  isolated=False, motion=True, mask=lab[y_ : y_ + bh, x : x + bw] == k)
        out.append(bl)
    return out


def split_base(blobs: list[Blob]) -> tuple[Blob | None, list[Blob]]:
    """The model is the largest blob in the frame; everything else floats."""
    if not blobs:
        return None, []
    base = max(blobs, key=lambda b: b.area)
    return base, [b for b in blobs if b is not base]


def _gap(a: Blob, b: Blob) -> float:
    ax, ay, aw, ah = a.bbox
    bx, by, bw, bh = b.bbox
    dx = max(0, max(ax, bx) - min(ax + aw, bx + bw))
    dy = max(0, max(ay, by) - min(ay + ah, by + bh))
    return float(np.hypot(dx, dy))


def mark_isolation(blobs: list[Blob], others: list[Blob], gap: float = 8.0) -> None:
    for b in blobs:
        b.isolated = all(_gap(b, o) > gap for o in others + blobs if o is not b)


def track_parts(per_frame_floaters: list[list[Blob]]) -> list[PartTrack]:
    """Merge-aware tracking: a blob claimed by several tracks and clearly larger than
    any of them is a merge; it is assigned to none (tracks coast), so their crops come
    from frames where the parts were still apart."""
    tracks: list[PartTrack] = []
    active: list[PartTrack] = []
    for i, floaters in enumerate(per_frame_floaters):
        active = [t for t in active if t.blobs[-1].frame >= i - 6]
        pred = {}
        for t in active:
            last = t.blobs[-1]
            vx = vy = 0.0
            if len(t.blobs) >= 2:
                p = t.blobs[-2]
                dt = max(1, last.frame - p.frame)
                vx, vy = (last.centroid[0] - p.centroid[0]) / dt, (last.centroid[1] - p.centroid[1]) / dt
            gap = i - last.frame
            pred[id(t)] = (last.centroid[0] + vx * gap, last.centroid[1] + vy * gap)
        claims: dict[int, list[PartTrack]] = {}
        for bi, b in enumerate(floaters):
            for t in active:
                px_, py_ = pred[id(t)]
                if np.hypot(b.centroid[0] - px_, b.centroid[1] - py_) < MATCH_DIST:
                    claims.setdefault(bi, []).append(t)
        assigned: set[int] = set()
        used: set[int] = set()
        pairs = []
        for bi, ts in claims.items():
            b = floaters[bi]
            merged = len(ts) >= 2 and b.area > 1.35 * max(t.blobs[-1].area for t in ts)
            if merged:
                assigned.add(bi)  # consumed as a merge: no track gets it, no new track born
                continue
            for t in ts:
                px_, py_ = pred[id(t)]
                pairs.append((float(np.hypot(b.centroid[0] - px_, b.centroid[1] - py_)), bi, t))
        for d, bi, t in sorted(pairs, key=lambda p: p[0]):
            if bi in assigned or id(t) in used:
                continue
            t.blobs.append(floaters[bi])
            assigned.add(bi)
            used.add(id(t))
        for bi, b in enumerate(floaters):
            if bi not in assigned:
                t = PartTrack(len(tracks) + 1, [b])
                tracks.append(t)
                active.append(t)
    return tracks


def opening_track(bases: list[Blob | None], jump: float = 1.25, min_move: float = 8.0) -> PartTrack | None:
    """The first part (usually the base plate) is the largest blob from frame 0, so it
    is taken as "the model" and never tracked. If it moves at the start, it is really a
    hovering part: track it until its area jumps (something merged into it)."""
    run: list[Blob] = []
    for b in bases:
        if b is None:
            if run:
                break
            continue
        if run:
            p = run[-1]
            if b.area > jump * p.area or np.hypot(b.centroid[0] - p.centroid[0], b.centroid[1] - p.centroid[1]) > MATCH_DIST:
                break
        run.append(b)
    if len(run) < 3:
        return None
    if abs(run[-1].centroid[1] - run[0].centroid[1]) < min_move:
        return None  # a static base: really the model, not a moving part
    return PartTrack(0, run)


MOTION_MIN_AREA = 2500  # px: a track seen only by motion must be this big (median) ...
MOTION_MIN_LEN = 4  # ... and this long; flow noise on the model makes small, short tracks


def finalize(tracks: list[PartTrack], frames_dir: str, out: str | None, min_len: int = 3) -> list[PartTrack]:
    kept = []
    for t in tracks:
        if len(t.blobs) < min_len:
            continue
        if all(b.motion for b in t.blobs) and (len(t.blobs) < MOTION_MIN_LEN or
                                               float(np.median([b.area for b in t.blobs])) < MOTION_MIN_AREA):
            continue
        xs = [b.centroid[0] for b in t.blobs]
        ys = [b.centroid[1] for b in t.blobs]
        if len(t.blobs) >= 40 or (len(t.blobs) >= 25 and max(max(xs) - min(xs), max(ys) - min(ys)) < 30):
            continue  # an intro logo / static graphic, not a part (parts fly in for ~0.5-2.5 s)
        if min(b.text for b in t.blobs) > 0.03:
            continue  # only ever seen under banner text
        inside = [b for b in t.blobs if not b.touches_border] or t.blobs
        untext = [b for b in inside if b.text < 0.01] or inside
        clean = [b for b in untext if b.isolated and b.solidity >= 0.85] or [b for b in untext if b.isolated] or untext
        t.best = max(clean, key=lambda b: b.area * b.solidity)
        img = cv2.imread(os.path.join(frames_dir, f"{t.best.frame + 1:04d}.png"))
        x, y, w, h = t.best.bbox
        crop = img[y : y + h, x : x + w].copy()
        if t.best.mask is not None:
            crop[~t.best.mask] = 0  # motion blob: drop the model pixels behind the part
        lit = crop[crop.max(axis=2) > 60]
        if len(lit):
            b, g, r = np.median(lit, axis=0)
            t.rgb = (int(r), int(g), int(b))
        if out:
            os.makedirs(out, exist_ok=True)
            t.crop_path = os.path.join(out, f"part{t.id:03d}_f{t.best.frame:03d}.png")
            cv2.imwrite(t.crop_path, crop)
        kept.append(t)
    return kept


def analyse(video: str, work: str, out: str | None = None, fps: int = 10, motion: bool = False) -> dict:
    """motion: also find parts moving in front of the model by optical flow (`motion_blobs`)."""
    paths = extract(video, work, fps)
    frames = np.stack([cv2.imread(p) for p in paths])
    static = static_overlay(frames)
    per_frame, bases, rejected = [], [], 0
    for i, fr in enumerate(frames):
        kept, rej = blobs_in_frame(fr, static, i)
        rejected += len(rej)
        base, floaters = split_base(kept)
        mark_isolation(floaters, [base] if base else [])
        if motion and i + 1 < len(frames):
            floaters = floaters + motion_blobs(fr, frames[i + 1], base, floaters, i)
        bases.append(base)
        per_frame.append(floaters)
    raw = track_parts(per_frame)
    first = opening_track(bases)
    if first is not None:
        raw.insert(0, first)
    tracks = finalize(raw, work, out)
    return {"frames": len(paths), "fps": fps, "staticFrac": float(static.mean()), "rejectedOverlay": rejected, "tracks": tracks, "bases": bases}
