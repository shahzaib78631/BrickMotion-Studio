"""Pop-in build videos -> model (the KenBrick clips that end with a parts list).

These clips are step animations: every few frames one new piece appears in its
final place (no hover). The camera is still between steps but can cut to a new
view in the same frame as a piece appears; afterwards the camera turns once
round the finished model, and the parts list is shown at the end. The inventory
(part, colour, quantity) is known from that list.

So each step is solved by analysis-by-synthesis:

1. Step pixels: what changed between the frame before the piece appeared and the
   settled frame after it.
2. Camera: fitted by rendering the pieces placed so far and matching their
   silhouette to the frame's foreground (refined as the build grows). A step whose
   change covers most of the model is a camera cut: the camera is searched again
   and the step pixels become the foreground the build does not cover.
3. Candidates: every remaining inventory part, at every exact snap onto a free
   connector of the build so far (`brickheadz.connectors`).
4. Score: render each candidate with depth, keep only the pixels the build does not
   hide, and compare them with the step pixels (IoU) and their colour with the
   inventory colour. The best candidate is placed and its quantity used up.
"""
from __future__ import annotations

import difflib
import math
import os
import re
from dataclasses import dataclass, field

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_popin needs opencv-python-headless") from e

from brickheadz import connectors as cg
from brickheadz import part_render as pr
from brickheadz.part_render import PartMesh
from brickheadz.video_synth import Scene, VCam

DIFF = 25  # max-channel change that counts as a changed pixel
FG = 28  # max-channel level that counts as foreground (not the black background)


# ---------------------------------------------------------------- frames and steps

def read_frames(video: str) -> list[np.ndarray]:
    cap = cv2.VideoCapture(video)
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        out.append(f)
    return out


def changed(a: np.ndarray, b: np.ndarray, roi: tuple[int, int]) -> np.ndarray:
    """Pixels whose colour changed by more than DIFF, inside the rows roi = (y0, y1)."""
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2) > DIFF
    d[: roi[0]] = False
    d[roi[1] :] = False
    return d


@dataclass
class Steps:
    changes: list[int]  # first frame of each change
    settled: list[int]  # a frame where that step's render is fully shown
    turn_start: int  # first frame of the closing turntable (camera moves every frame)
    roi: tuple[int, int]


def find_steps(frames: list[np.ndarray], roi: tuple[int, int], min_px: int = 120, run: int = 6) -> Steps:
    """Change events in a step animation, up to the closing turntable.

    A frame "changes" when more than `min_px` pixels change. The turntable is the first
    run of `run` consecutive changing frames. Each step's settled frame is the frame just
    before the next change (or 2 frames after its own change, whichever is earlier)."""
    flags = [False] + [int(changed(frames[i - 1], frames[i], roi).sum()) > min_px for i in range(1, len(frames))]
    turn = len(frames)
    for i in range(len(flags) - run):
        if all(flags[i : i + run]):
            turn = i
            break
    ch = [i for i in range(1, turn) if flags[i] and not flags[i - 1]]
    settled = []
    for k, c in enumerate(ch):
        nxt = ch[k + 1] if k + 1 < len(ch) else turn
        settled.append(min(c + 2, nxt - 1))
    return Steps(ch, settled, turn, roi)


# ---------------------------------------------------------------- inventory

def ldconfig_names(path: str) -> dict[str, int]:
    """LDraw colour name (lower case, spaces) -> code."""
    out = {}
    for line in open(path, encoding="utf-8", errors="ignore"):
        m = re.match(r"\s*0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)", line)
        if m:
            out[m.group(1).replace("_", " ").lower()] = int(m.group(2))
    return out


def colour_code(name: str, names: dict[str, int]) -> int | None:
    """Best LDraw code for an OCR'd colour name ("Medium AzureMedium" -> Medium Azure)."""
    n = re.sub(r"\s+", " ", re.sub(r"([a-z])([A-Z])", r"\1 \2", name or "")).strip().lower()
    if not n:
        return None
    tries = [n]
    w = n.split()
    for k in range(len(w), 0, -1):  # OCR runs the next label into the name: try shorter prefixes
        tries.append(" ".join(w[:k]))
    for t in tries:
        if t in names:
            return names[t]
    best = difflib.get_close_matches(n, list(names), n=1, cutoff=0.6)
    return names[best[0]] if best else None


@dataclass
class Item:
    part: str
    colour: int
    qty: int


def inventory_items(rows: list[dict], names: dict[str, int]) -> list[Item]:
    """Inventory rows from `video_inventory` -> items (unknown quantities count as 1;
    rows of one part with no colour join that part's coloured row)."""
    agg: dict[tuple[str, int], int] = {}
    loose: dict[str, int] = {}
    for r in rows:
        q = int(r.get("qty") or 1)
        c = colour_code(r.get("color") or "", names)
        if c is None:
            loose[r["part"]] = loose.get(r["part"], 0) + q
        else:
            agg[(r["part"], c)] = agg.get((r["part"], c), 0) + q
    for p, q in loose.items():
        key = next((k for k in agg if k[0] == p), (p, 71))
        agg[key] = agg.get(key, 0) + q
    return [Item(p, c, q) for (p, c), q in agg.items()]


# ---------------------------------------------------------------- rendering

def half(cam: VCam, f: float) -> VCam:
    return cam.replace(scale=cam.scale * f, ox=cam.ox * f, oy=cam.oy * f)


def render_depth(meshes: dict, pieces: list[tuple[str, int, np.ndarray]], cam: VCam, hw: tuple[int, int],
                 table: dict | None = None):
    """(bgr, owner index per pixel or -1, depth with inf = empty) of the given pieces."""
    sc = Scene(meshes, table or {}, pieces)
    if len(sc.tris) == 0:
        H, W = hw
        return np.zeros((H, W, 3), np.uint8), np.full((H, W), -1, np.int32), np.full((H, W), np.inf, np.float32)
    u, v, z = cam.project(sc.verts)
    depth: list = []
    light = np.array([-0.45, -0.75, -0.48], np.float32)
    light /= np.linalg.norm(light)
    img, fid = pr.raster(np.stack([u, v], 1), z, sc.tris, sc.tri_face, sc.nrm @ cam.R.T, sc.bgr, light, hw,
                         edge=0.55, jump=6.0, depth_out=depth)
    owner = np.where(fid >= 0, sc.owner[np.maximum(fid, 0)], -1)
    return img, owner, depth[0]


def iou(a: np.ndarray, b: np.ndarray) -> float:
    u = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / u) if u else 0.0


# ---------------------------------------------------------------- camera

CAM_KEYS = ("yaw", "pitch", "scale", "ox", "oy", "dist")


def fit_camera(meshes: dict, pieces, fg: np.ndarray, init: VCam, f: float = 0.5, iters: int = 160,
               fixed_dist: bool = False) -> tuple[VCam, float]:
    """Camera that best matches the rendered silhouette of `pieces` to the foreground
    mask `fg` (full resolution), by Nelder-Mead on (yaw, pitch, log scale, ox, oy,
    log dist) at resolution factor `f`."""
    from scipy.optimize import minimize

    H, W = fg.shape
    hw = (int(H * f), int(W * f))
    target = cv2.resize(fg.astype(np.uint8), (hw[1], hw[0]), interpolation=cv2.INTER_NEAREST) > 0

    def cam_of(x):
        return VCam(yaw=x[0], pitch=x[1], scale=math.exp(x[2]), ox=x[3], oy=x[4],
                    dist=init.dist if fixed_dist else math.exp(x[5]))

    def loss(x):
        _, own, _ = render_depth(meshes, pieces, half(cam_of(x), f), hw)
        return 1.0 - iou(own >= 0, target)

    x0 = np.array([init.yaw, init.pitch, math.log(init.scale), init.ox, init.oy, math.log(max(init.dist, 50.0))])
    step = np.array([6.0, 4.0, 0.06, 8.0, 8.0, 0.4])
    simplex = [x0] + [x0 + np.eye(6)[i] * step[i] for i in range(6)]
    r = minimize(loss, x0, method="Nelder-Mead",
                 options={"maxfev": iters, "initial_simplex": np.array(simplex), "xatol": 1e-3, "fatol": 1e-4})
    return cam_of(r.x), 1.0 - float(r.fun)


def init_camera(meshes: dict, pieces, fg: np.ndarray, dists=(400.0, 800.0, 1600.0),
                yaws=range(0, 90, 15), pitches=(20.0, 30.0, 40.0), f: float = 0.25) -> VCam:
    """Coarse grid over yaw, pitch and distance; scale and centre from the foreground's
    bbox. The first piece is usually a square plate, so yaw is only known mod 90."""
    ys, xs = np.nonzero(fg)
    H, W = fg.shape
    hw = (int(H * f), int(W * f))
    target = cv2.resize(fg.astype(np.uint8), (hw[1], hw[0]), interpolation=cv2.INTER_NEAREST) > 0
    best = (-1.0, None)
    for d in dists:
        for p in pitches:
            for y in yaws:
                c = VCam(yaw=float(y), pitch=p, scale=1.0, ox=0.0, oy=0.0, dist=d)
                # scale and centre from the projected vertices
                pts = np.concatenate([meshes[pp].verts @ m[:3, :3].T.astype(np.float32) + m[:3, 3].astype(np.float32)
                                      for pp, _c, m in pieces])
                u, v, _ = c.project(pts)
                s = (xs.max() - xs.min()) / max(1e-3, float(u.max() - u.min()))
                ox = xs.min() - s * float(u.min())
                oy = ys.min() - s * float(v.min())
                cam = VCam(yaw=float(y), pitch=p, scale=s, ox=ox, oy=oy, dist=d)
                _, own, _ = render_depth(meshes, pieces, half(cam, f), hw)
                sc = iou(own >= 0, target)
                if sc > best[0]:
                    best = (sc, cam)
    return best[1]


def refit_after_cut(meshes: dict, pieces, fg: np.ndarray, cam: VCam,
                    yaws=(0, 45, -45, 90, -90, 135, -135, 180), pitches=(0, -10, 10)) -> tuple[VCam, float]:
    """Camera after a hard cut: the view can turn by any yaw (and change pitch and zoom),
    so seed coarse fits from several yaw/pitch offsets and refine the best one."""
    best = None
    for dy in yaws:
        for dp in pitches:
            c, s = fit_camera(meshes, pieces, fg, cam.replace(yaw=cam.yaw + dy, pitch=cam.pitch + dp),
                              f=0.25, iters=40)
            if best is None or s > best[1]:
                best = (c, s)
    return fit_camera(meshes, pieces, fg, best[0], iters=120)


# ---------------------------------------------------------------- placement

@dataclass
class Placed:
    step: int  # index into Steps.changes (-1: the first piece)
    part: str
    colour: int
    matrix: np.ndarray
    iou: float  # visible candidate pixels vs the step's changed pixels
    colour_err: float
    n_candidates: int


@dataclass
class Result:
    cam: VCam
    placed: list[Placed] = field(default_factory=list)
    skipped: list[tuple[int, str]] = field(default_factory=list)  # (step, reason)
    left: dict = field(default_factory=dict)  # inventory not used: (part, colour) -> qty
    cam_iou: list[tuple[int, float]] = field(default_factory=list)  # (step, silhouette IoU after refit)
    cuts: list[int] = field(default_factory=list)  # steps where the camera jumped

    def pieces(self):
        return [(p.part, p.colour, p.matrix) for p in self.placed]


def _corners(mesh: PartMesh) -> np.ndarray:
    lo, hi = mesh.verts.min(0), mesh.verts.max(0)
    return np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])], np.float32)


def _bbox_overlap(a, b) -> float:
    """Intersection area / area of a, for boxes (x0, y0, x1, y1)."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    return w * h / max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))


def _chroma_err(pixels: np.ndarray, rgb, light_w: float = 0.5) -> float:
    """Distance between the mean shaded colour of `pixels` (BGR) and an LDraw colour:
    brightness-normalised RGB (shading changes brightness much more than hue) plus a
    weaker brightness term, without which black, grey and white are the same colour."""
    if len(pixels) == 0:
        return 1.0
    m = pixels.reshape(-1, 3)[:, ::-1].astype(np.float32).mean(0)
    t = np.asarray(rgb, np.float32)
    a, b = m / max(1.0, float(np.linalg.norm(m))), t / max(1.0, float(np.linalg.norm(t)))
    light = abs(float(m.mean()) - float(t.mean())) / 255.0
    return float(np.linalg.norm(a - b)) + light_w * light


def first_piece(items: list[Item], meshes: dict) -> Item:
    """The base: the inventory plate/tile with the largest footprint (KenBrick builds start on it)."""
    def foot(it):
        v = meshes[it.part].verts
        ext = v.max(0) - v.min(0)
        return ext[0] * ext[2] / max(1.0, ext[1])  # wide and flat first
    return max(items, key=foot)


def solve(frames: list[np.ndarray], steps: Steps, items: list[Item], meshes: dict, table: dict, cat=None,
          f: float = 0.5, colour_w: float = 0.6, refit_every: int = 6, min_px: int = 150,
          cut_frac: float = 0.4, log=print) -> Result:
    """Place one inventory piece per step (see module doc)."""
    cat = cat or cg.catalog()
    roi = steps.roi
    H, W = frames[0].shape[:2]
    hw = (int(H * f), int(W * f))
    budget = {(it.part, it.colour): it.qty for it in items}

    def fg_of(img):
        m = img.max(axis=2) > FG
        m[: roi[0]] = False
        m[roi[1] :] = False
        return m

    base = first_piece(items, meshes)
    pieces = [(base.part, base.colour, np.eye(4))]
    budget[(base.part, base.colour)] -= 1
    fg0 = fg_of(frames[steps.settled[0]])
    cam = init_camera(meshes, pieces, fg0)
    cam, s = fit_camera(meshes, pieces, fg0, cam)
    res = Result(cam)
    res.placed.append(Placed(-1, base.part, base.colour, np.eye(4), s, 0.0, 1))
    res.cam_iou.append((0, s))
    log(f"base {base.part} camera IoU {s:.3f}")
    since = 0
    for k in range(1, len(steps.changes)):
        before = frames[steps.changes[k] - 1]
        after = frames[steps.settled[k]]
        D = changed(before, after, roi)
        fa = fg_of(after)
        if D.sum() > cut_frac * max(1, fa.sum()):
            # camera cut in the same frame as the piece: refit on the after frame (the new
            # piece is small next to the build), then take the piece as the foreground the
            # current build does not cover
            cam, s = refit_after_cut(meshes, pieces, fa, cam)
            res.cam_iou.append((k, s))
            res.cuts.append(k)
            log(f"step {k}: camera cut, refit silhouette IoU {s:.3f}")
            _, own_full, _ = render_depth(meshes, pieces, cam, (H, W))
            covered = cv2.dilate((own_full >= 0).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
            D = fa & ~covered
            since = 0
        D = cv2.morphologyEx(D.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
        if D.sum() < min_px:
            res.skipped.append((k, f"only {int(D.sum())} px changed"))
            continue
        Dh = cv2.resize(D.astype(np.uint8), (hw[1], hw[0]), interpolation=cv2.INTER_AREA) > 0
        afh = cv2.resize(after, (hw[1], hw[0]), interpolation=cv2.INTER_AREA)
        ys, xs = np.nonzero(Dh)
        dbox = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        camh = half(cam, f)
        _, _, zb = render_depth(meshes, pieces, camh, hw)
        mats = [m for _p, _c, m in pieces]
        parts = [p for p, _c, _m in pieces]
        g = cg.build_graph(parts, [c for _p, c, _m in pieces], mats, cat)
        free = cg.free_connectors(g, mats, cat)
        best = None
        n = 0
        for (part, colour), q in budget.items():
            if q <= 0:
                continue
            corners = _corners(meshes[part])
            for c in cg.snap_candidates(part, free, cat):
                m = c["matrix"]
                u, v, _ = camh.project(corners @ m[:3, :3].T.astype(np.float32) + m[:3, 3].astype(np.float32))
                cb = (float(u.min()), float(v.min()), float(u.max()), float(v.max()))
                if _bbox_overlap(cb, dbox) < 0.3:
                    continue
                n += 1
                _, own, zc = render_depth(meshes, [(part, colour, m)], camh, hw)
                vis = (own >= 0) & (zc < zb - 0.5)
                sc_iou = iou(vis, Dh)
                if sc_iou <= 0:
                    continue
                ce = _chroma_err(afh[vis], table.get(colour, (128, 128, 128)))
                score = sc_iou - colour_w * ce
                if best is None or score > best[0]:
                    best = (score, part, colour, m, sc_iou, ce)
        if best is None:
            res.skipped.append((k, f"no candidate ({n} tried)"))
            log(f"step {k}: no candidate ({n} tried, {int(D.sum())} px)")
            continue
        _, part, colour, m, sc_iou, ce = best
        pieces.append((part, colour, m))
        budget[(part, colour)] -= 1
        res.placed.append(Placed(k, part, colour, m, sc_iou, ce, n))
        log(f"step {k}: {part} c{colour} IoU {sc_iou:.2f} colour {ce:.2f} ({n} candidates)")
        since += 1
        if since >= refit_every:
            since = 0
            cam, s = fit_camera(meshes, pieces, fg_of(after), cam, iters=80)
            res.cam_iou.append((k, s))
            log(f"  camera refit: silhouette IoU {s:.3f}")
    res.cam = cam
    res.left = {k: q for k, q in budget.items() if q > 0}
    return res
