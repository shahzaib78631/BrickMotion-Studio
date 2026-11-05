"""Synthetic exploded-build animation from an MPD, with exact per-frame ground truth.

Mimics the KenBrick / Studio clips: black background, the model so far at rest,
each step's new parts hovering in a column above their final spots and then
dropping straight down (-y in LDraw is up), while the camera orbits. Used to
measure the video -> model pipeline where real clips have no ground truth.
"""
from __future__ import annotations

import json
import math
import multiprocessing as mp
import os
from dataclasses import asdict, dataclass

import numpy as np

try:
    import cv2
except ImportError as e:  # pragma: no cover
    raise ImportError("video_synth needs opencv-python-headless") from e

from brickheadz import part_render as pr


@dataclass
class VCam:
    """Video camera: p' = R p, u = s k p'_x + ox, v = s k p'_y + oy (y down).

    `dist` is the camera's distance (LDU) from the world origin along the view axis;
    k = dist / (dist + p'_z) gives perspective, and dist = 0 means orthographic (k = 1).
    """

    yaw: float
    pitch: float
    scale: float
    ox: float
    oy: float
    dist: float = 0.0

    @property
    def R(self) -> np.ndarray:
        return pr.rotation(self.yaw, self.pitch, 0.0)  # +pitch looks down from above

    def project(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        p = np.asarray(pts, np.float32) @ self.R.T
        k = self.scale if self.dist <= 0 else self.scale * self.dist / np.maximum(self.dist + p[:, 2], 1e-3)
        return k * p[:, 0] + self.ox, k * p[:, 1] + self.oy, p[:, 2]

    def replace(self, **kw) -> "VCam":
        """Copy with some fields changed (keeps `dist`)."""
        from dataclasses import replace

        return replace(self, **kw)


class Scene:
    """Concatenated world-space meshes for a list of (part, colour, matrix)."""

    def __init__(self, meshes: dict, table: dict, pieces: list[tuple[str, int, np.ndarray]]):
        verts, tris, tri_face, nrm, bgr, owner = [], [], [], [], [], []
        vo = fo = 0
        for k, (part, colour, m) in enumerate(pieces):
            mesh = meshes.get(part)
            if mesh is None or mesh.n == 0:
                continue
            R, t = m[:3, :3].astype(np.float32), m[:3, 3].astype(np.float32)
            verts.append(mesh.verts @ R.T + t)
            tris.append(mesh.tris + vo)
            tri_face.append(mesh.tri_poly + fo)
            nrm.append(mesh.normals @ R.T)
            rgb = table.get(colour, (160, 160, 160))
            bgr.append(np.tile(np.array(rgb[::-1], np.float32), (mesh.n, 1)))
            owner.append(np.full(mesh.n, k, np.int32))
            vo += len(mesh.verts)
            fo += mesh.n
        self.verts = np.concatenate(verts) if verts else np.zeros((0, 3), np.float32)
        self.tris = np.concatenate(tris) if tris else np.zeros((0, 3), np.int32)
        self.tri_face = np.concatenate(tri_face) if tri_face else np.zeros(0, np.int32)
        self.nrm = np.concatenate(nrm) if nrm else np.zeros((0, 3), np.float32)
        self.bgr = np.concatenate(bgr) if bgr else np.zeros((0, 3), np.float32)
        self.owner = np.concatenate(owner) if owner else np.zeros(0, np.int32)


def render_scene(scene: Scene, cam: VCam, hw: tuple[int, int], light: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (BGR frame, per-pixel piece index or -1)."""
    u, v, z = cam.project(scene.verts)
    img, fid = pr.raster(np.stack([u, v], 1), z, scene.tris, scene.tri_face, scene.nrm @ cam.R.T, scene.bgr, light, hw,
                         edge=0.55, jump=6.0)
    owner = np.where(fid >= 0, scene.owner[np.maximum(fid, 0)], -1)
    return img, owner


def default_light() -> np.ndarray:
    v = np.array([-0.45, -0.75, -0.48], np.float32)
    return v / np.linalg.norm(v)


# ---- animation -----------------------------------------------------------------------

def approach_sides(steps, boxes: list[tuple[np.ndarray, np.ndarray]], eps: float = 1.0) -> dict[int, bool]:
    """Per piece: True if it attaches from below (its top meets an earlier piece's
    underside and nothing supports it), else False (it drops onto something)."""
    def touch_over(a, b):
        return a[0][0] < b[1][0] - eps and a[1][0] > b[0][0] + eps and a[0][2] < b[1][2] - eps and a[1][2] > b[0][2] + eps

    side: dict[int, bool] = {}
    placed: list[int] = []
    idx = 0
    for step in steps:
        ids = list(range(idx, idx + len(step)))
        idx += len(step)
        pending = list(ids)
        for _ in range(len(ids) + 1):
            nxt = []
            for i in pending:
                bi = boxes[i]
                under = any(touch_over(bi, boxes[j]) and abs(boxes[j][0][1] - bi[1][1]) <= eps for j in placed)
                over = any(touch_over(bi, boxes[j]) and abs(boxes[j][1][1] - bi[0][1]) <= eps for j in placed)
                if under or not placed:
                    side[i] = False
                    placed.append(i)
                elif over:
                    side[i] = True
                    placed.append(i)
                else:
                    nxt.append(i)
            if len(nxt) == len(pending):
                break
            pending = nxt
        for i in pending:  # floating in this step's order: treat as a drop
            side[i] = False
            placed.append(i)
    return side


def plan_frames(steps: list[list[tuple[str, int, np.ndarray]]], hover: int = 4, drop: int = 8, lift: float = 70.0,
                gap: float = 40.0, sides: dict[int, bool] | None = None) -> list[dict]:
    """Per frame: which pieces are placed, and the y-offset of each moving piece. Drops
    hover in a column above (nearest lowest); rises hover in a column below."""
    frames = []
    done: list[int] = []
    idx = 0
    sides = sides or {}
    for si, step in enumerate(steps):
        ids = list(range(idx, idx + len(step)))
        idx += len(step)
        flat = steps_flat(steps)
        drops = sorted([i for i in ids if not sides.get(i)], key=lambda i: -float(flat[i][2][1, 3]))
        rises = sorted([i for i in ids if sides.get(i)], key=lambda i: float(flat[i][2][1, 3]))
        offs = {i: -(lift + gap * k) for k, i in enumerate(drops)}
        offs.update({i: (lift + gap * k) for k, i in enumerate(rises)})
        for f in range(hover + drop):
            a = 0.0 if f < hover else (f - hover + 1) / drop
            moving = {i: offs[i] * (1.0 - a) for i in ids}
            frames.append({"step": si, "placed": list(done), "moving": moving})
        done.extend(ids)
    frames.append({"step": len(steps), "placed": list(done), "moving": {}})
    return frames


_FLAT: dict = {}


def steps_flat(steps):
    key = id(steps)
    if key not in _FLAT:
        _FLAT[key] = [p for s in steps for p in s]
    return _FLAT[key]


def orbit_cameras(pieces_all, n: int, hw: tuple[int, int], yaw0: float = 20.0, dyaw: float = 1.6, pitch: float = 28.0,
                  fill: float = 0.62, meshes=None, fov: float = 0.0) -> list[VCam]:
    """Fixed-scale orbit framed on the finished model's bounding sphere.

    `fov` (vertical, degrees) > 0 gives a perspective camera with that field of view.
    """
    pts = np.concatenate([meshes[p].verts @ m[:3, :3].T.astype(np.float32) + m[:3, 3].astype(np.float32)
                          for p, _c, m in pieces_all if p in meshes and meshes[p].n])
    c = (pts.min(0) + pts.max(0)) / 2
    r = float(np.linalg.norm(pts - c, axis=1).max())
    H, W = hw
    s = fill * min(W, H) / (2 * r)
    dist = (H / 2) / math.tan(math.radians(fov) / 2) / s if fov > 0 else 0.0
    cams = []
    for i in range(n):
        cam = VCam(yaw0 + dyaw * i, pitch, s, 0.0, 0.0, dist)
        u, v, _ = cam.project(c[None])
        cams.append(cam.replace(ox=W / 2 - float(u[0]), oy=H * 0.58 - float(v[0])))
    return cams


_G: dict = {}


def _init(root, parts, table, steps, cams, hw):
    from assembly_model.ldraw import load_library

    lib = load_library(root)
    _G.update(meshes={p: pr.PartMesh(lib, p) for p in parts}, table=table, steps=steps, cams=cams, hw=hw)


def _render_frame(args):
    fi, fr, out = args
    flat = steps_flat(_G["steps"])
    pieces = [flat[i] for i in fr["placed"]]
    for i, dy in fr["moving"].items():
        p, c, m = flat[int(i)]
        m2 = m.copy()
        m2[1, 3] += dy
        pieces.append((p, c, m2))
    img, _own = render_scene(Scene(_G["meshes"], _G["table"], pieces), _G["cams"][fi], _G["hw"], default_light())
    cv2.imwrite(os.path.join(out, f"{fi + 1:04d}.png"), img)
    return fi


def synthesize(root: str, mpd: str, out: str, hw: tuple[int, int] = (640, 360), workers: int | None = None, **kw) -> dict:
    from assembly_model.ldraw import load_library
    from brickheadz.image_spec import ldconfig_rgb
    from brickheadz.reconstruct import steps_from_omr

    os.makedirs(out, exist_ok=True)
    steps = steps_from_omr(mpd)
    lib = load_library(root)
    parts = sorted({p for s in steps for p, _c, _m in s})
    meshes = {p: pr.PartMesh(lib, p) for p in parts}
    table = ldconfig_rgb(os.path.join(root, "LDConfig.ldr"))
    from brickheadz.video_place import body_box

    flat0 = steps_flat(steps)
    sides = approach_sides(steps, [body_box(lib, p, m) for p, _c, m in flat0])
    frames = plan_frames(steps, sides=sides)
    cams = orbit_cameras(steps_flat(steps), len(frames), hw, meshes=meshes, **kw)
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers or max(1, (os.cpu_count() or 2) - 1), initializer=_init,
                  initargs=(root, parts, table, steps, cams, hw)) as pool:
        pool.map(_render_frame, [(i, f, out) for i, f in enumerate(frames)])
    flat = steps_flat(steps)
    gt = {
        "mpd": mpd,
        "hw": hw,
        "cams": [asdict(c) for c in cams],
        "from_below": [bool(sides.get(i, False)) for i in range(len(flat))],
        "frames": [{"step": f["step"], "placed": f["placed"], "moving": {str(k): v for k, v in f["moving"].items()}} for f in frames],
        "pieces": [{"part": p, "colour": c, "matrix": m.tolist()} for p, c, m in flat],
        "steps": [[i for i in range(sum(len(s) for s in steps[:k]), sum(len(s) for s in steps[: k + 1]))] for k in range(len(steps))],
    }
    with open(os.path.join(out, "gt.json"), "w") as fh:
        json.dump(gt, fh)
    return gt
