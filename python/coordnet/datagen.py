"""Synthetic training pairs for CoordNet: a booklet-style *picture* and a *render* of an estimate, with exact
dense correspondence between them.

    python -m coordnet.datagen --out .cache/coordnet/shard-000 --n 500 --seed 0 [--workers 8]

Each sample comes from a real build step (OMR official set models; the booklet evaluation sets are excluded):
the parts built so far plus the step's new parts. The picture uses the true camera, the new parts in place,
the red new-part outline and a random booklet style. The render uses a perturbed camera (a few degrees, a few
percent of scale, a few pixels of offset, perspective eye distance) and the new parts absent or at a candidate
pose (true, one stud off, one plate off, along the line of sight, turned 90 degrees) — what the solver renders
while it searches — in the default style.

Ground truth, for every picture pixel: the 3D point it shows (G-buffer), moved with its part to the part's pose
in the render (new parts at a candidate pose move with the candidate), projected with the render camera. The
flow is that pixel minus the picture pixel; it is valid when that point is the one visible there in the render
(same part, depth within 1 LDU).

Files per sample NNNNN (in --out):
  NNNNN.picture.png   RGB booklet-style picture (true camera)
  NNNNN.render.png    RGB render of the estimate
  NNNNN.flow.npz      flow int16 [2,H,W] in 1/8 px (x, y), valid uint8 [H,W], new uint8 [H,W] (picture pixel on a
                      new part), cand uint8 [H,W] (1 = new part whose render pose is the true one, 2 = wrong pose,
                      3 = absent from the render, 0 = not a new part)
  NNNNN.json          set, step, cameras, centre, parts, candidate kinds
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from .camera import TURN, BookletCamera, basis, project
from . import render as R

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
ROOT = Path(__file__).resolve().parents[2]
EXCLUDE_FILE = ROOT / ".cache/coordnet/eval-sets.json"


# ------------------------------------------------------------------ sources


def eval_sets() -> set[str]:
    """Sets used for real-booklet evaluation (never trained on)."""
    if EXCLUDE_FILE.exists():
        return set(json.loads(EXCLUDE_FILE.read_text()))
    from booklet_mpd.solver import dataset as D
    s = sorted(set(D.pairs()) | {"21065"})
    EXCLUDE_FILE.parent.mkdir(parents=True, exist_ok=True)
    EXCLUDE_FILE.write_text(json.dumps(s))
    return set(s)


def model_files() -> list[Path]:
    bad = eval_sets()
    out = []
    for d in sorted(OMR.iterdir()):
        if not d.is_dir() or d.name.split("-")[0] in bad:
            continue
        out.extend(sorted(d.glob("*.mpd")))
    return out


def steps_of(path: Path) -> list[dict]:
    from booklet_mpd.truth import build_scoped_steps
    try:
        return build_scoped_steps(str(path), warnings=[])
    except Exception:
        return []


def _part(p):
    name, colour, m = p
    return (name if name.lower().endswith(".dat") else name + ".dat", int(colour), np.asarray(m, float))


def pick_step(rng: random.Random, files: list[Path], max_parts: int = 260) -> tuple[Path, int, list, list] | None:
    for _ in range(50):
        f = rng.choice(files)
        steps = steps_of(f)
        good = [i for i, s in enumerate(steps) if 1 <= len(s["added"]) <= 12 and len(s["visible"]) >= 2
                and len(s["visible"]) + len(s["added"]) <= max_parts]
        if not good:
            continue
        i = rng.choice(good)
        base = [_part(p) for p in steps[i]["visible"]]
        new = [_part(p) for p in steps[i]["added"]]
        if all(len(R.part_triangles(p)) for p, _c, _m in base + new):
            return f, i, base, new
    return None


# ------------------------------------------------------------------ cameras


def sample_camera(rng: random.Random, parts: list, W: int, H: int) -> tuple[BookletCamera, np.ndarray]:
    """A booklet-like camera that frames the model in W x H."""
    centre = R.bounds_centre(parts)
    yaw = rng.choice([1, -1]) * rng.uniform(20, 60) + rng.choice([0, 0, 0, 180])
    cam = BookletCamera(yaw, rng.uniform(18, 48), rng.gauss(0, 1.5), 1.0, 0.0, 0.0,
                        eye=0.0 if rng.random() < 0.3 else rng.uniform(2000, 9000), turned=rng.random() < 0.15)
    pts = R.scene(parts)[0].reshape(-1, 3)
    uv, _ = project(cam, centre, pts)
    span = np.maximum(uv.max(0) - uv.min(0), 1e-6)
    fill = rng.uniform(0.45, 0.9)
    scale = fill * min(W / span[0], H / span[1])
    # perspective scale is set at the centre's depth; re-measure after scaling
    cam = cam.with_(scale=scale)
    uv, _ = project(cam, centre, pts)
    lo, hi = uv.min(0), uv.max(0)
    cx = rng.uniform(-lo[0] + 4, W - hi[0] - 4) if hi[0] - lo[0] < W - 8 else (W - hi[0] - lo[0]) / 2
    cy = rng.uniform(-lo[1] + 4, H - hi[1] - 4) if hi[1] - lo[1] < H - 8 else (H - hi[1] - lo[1]) / 2
    return cam.with_(cx=cx, cy=cy), centre


def perturb(rng: random.Random, cam: BookletCamera, level: float) -> BookletCamera:
    """The solver's estimate: degrees, percent of scale, pixels of offset, eye distance."""
    g = lambda s, lim: max(-lim, min(lim, rng.gauss(0, s * level)))
    return cam.with_(yaw=cam.yaw + g(1.5, 4), pitch=cam.pitch + g(1.5, 4), roll=cam.roll + g(0.8, 2.5),
                     scale=cam.scale * (1 + g(0.02, 0.06)), cx=cam.cx + g(5, 14), cy=cam.cy + g(5, 14),
                     eye=cam.eye * (1 + g(0.12, 0.35)) if cam.eye else 0.0)


def wrong_pose(rng: random.Random, m: np.ndarray, cam: BookletCamera) -> tuple[np.ndarray, str]:
    """A plausible wrong candidate for a new part."""
    m = m.copy()
    kind = rng.choice(["stud", "stud", "plate", "sight", "turn"])
    if kind == "stud":
        d = np.zeros(3)
        d[rng.choice([0, 2])] = rng.choice([-1, 1]) * 20 * rng.choice([1, 1, 2])
        m[:3, 3] += d
    elif kind == "plate":
        m[:3, 3] += np.array([0, rng.choice([-1, 1]) * 8 * rng.choice([1, 1, 3]), 0])
    elif kind == "sight":
        _, _, back = basis(cam)
        b = TURN @ back if cam.turned else back
        m[:3, 3] += b * rng.choice([-1, 1]) * rng.uniform(8, 40)
    else:
        a = rng.choice([math.pi / 2, -math.pi / 2, math.pi])
        Ry = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
        m[:3, :3] = m[:3, :3] @ Ry
    return m, kind


# ------------------------------------------------------------------ ground truth


def correspondence(gt_pic: R.GBuffer, pic_parts: list, ren_parts: list, cam_r: BookletCamera, centre_r,
                   gt_ren: R.GBuffer) -> tuple[np.ndarray, np.ndarray]:
    """flow [2,H,W] float32 (render pixel - picture pixel, pixel centres) and valid [H,W] bool.

    pic_parts / ren_parts are aligned lists (same index = same physical part); a None in ren_parts is absent."""
    H, W = gt_pic.part.shape
    flow = np.zeros((2, H, W), np.float32)
    valid = np.zeros((H, W), bool)
    for i, (pp, rp) in enumerate(zip(pic_parts, ren_parts)):
        if rp is None:
            continue
        sel = gt_pic.part == i
        if not sel.any():
            continue
        X = gt_pic.xyz[sel].astype(float)
        A = rp[2] @ np.linalg.inv(pp[2])                # picture pose -> render pose
        Xr = X @ A[:3, :3].T + A[:3, 3]
        uv, d = project(cam_r, centre_r, Xr)
        ys, xs = np.nonzero(sel)
        flow[0, ys, xs] = uv[:, 0] - (xs + 0.5)
        flow[1, ys, xs] = uv[:, 1] - (ys + 0.5)
        x, y = np.floor(uv[:, 0]).astype(int), np.floor(uv[:, 1]).astype(int)
        ok = (x >= 0) & (x < W) & (y >= 0) & (y < H)
        vis = np.zeros(len(X), bool)
        vis[ok] = (gt_ren.part[y[ok], x[ok]] == i) & (np.abs(gt_ren.depth[y[ok], x[ok]] - d[ok]) < 1.0)
        valid[ys, xs] = vis
    return flow, valid


# ------------------------------------------------------------------ one sample


def sample(seed: int, files: list[Path]) -> dict | None:
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    got = pick_step(rng, files)
    if got is None:
        return None
    f, step, base, new = got
    parts = base + new
    W = rng.choice([384, 448, 512, 576, 640])
    H = rng.choice([288, 320, 384, 448])
    cam, centre = sample_camera(rng, parts, W, H)
    newset = set(range(len(base), len(parts)))
    pic = R.render(parts, newset, cam, centre, W, H, R.Style.random(nrng), ss=2, rng=nrng)

    # the estimate
    cam_r = perturb(rng, cam, rng.choice([0.25, 0.5, 1.0, 1.0, 1.5]))
    mode = rng.random()
    ren_parts: list = list(base)
    kinds = []
    for p in new:
        if mode < 0.25:
            ren_parts.append(None)
            kinds.append("absent")
        elif mode < 0.55 or rng.random() < 0.4:
            ren_parts.append(p)
            kinds.append("true")
        else:
            m, k = wrong_pose(rng, p[2], cam_r)
            ren_parts.append((p[0], p[1], m))
            kinds.append(k)
    present = [p for p in ren_parts if p is not None]
    index = [i for i, p in enumerate(ren_parts) if p is not None]
    # the solver's render keeps the picture's model centre (the centre of the full step model)
    ren_new = {j for j, i in enumerate(index) if i >= len(base)}
    ren = R.render(present, ren_new, cam_r, centre, W, H, R.Style(), ss=2)
    # render G-buffer part indices back to the aligned list
    remap = np.array(index + [-1], np.int32)
    gt_r = ren.gt
    gt_r = R.GBuffer(np.where(gt_r.part >= 0, remap[gt_r.part], -1), gt_r.depth, gt_r.xyz, gt_r.normal, gt_r.tri)
    flow, valid = correspondence(pic.gt, parts, ren_parts, cam_r, centre, gt_r)
    newpix = np.isin(pic.gt.part, list(newset))
    cand = np.zeros((H, W), np.uint8)
    for j, k in enumerate(kinds):
        sel = pic.gt.part == len(base) + j
        cand[sel] = 1 if k == "true" else 3 if k == "absent" else 2
    camd = lambda c: dict(yaw=c.yaw, pitch=c.pitch, roll=c.roll, scale=c.scale, cx=c.cx, cy=c.cy, eye=c.eye,
                          turned=c.turned)
    meta = dict(file=str(f.relative_to(OMR)), step=step, W=W, H=H, cam=camd(cam), cam_render=camd(cam_r),
                centre=centre.tolist(), n_base=len(base),
                parts=[[p, c, m.tolist()] for p, c, m in parts],
                render_parts=[None if p is None else [p[0], p[1], p[2].tolist()] for p in ren_parts], kinds=kinds,
                valid_frac=float(valid.mean()), fg_frac=float((pic.gt.part >= 0).mean()))
    return dict(picture=pic.picture, render=ren.picture, flow=flow, valid=valid, new=newpix, cand=cand, meta=meta)


def write(out: Path, k: int, s: dict) -> None:
    stem = out / f"{k:05d}"
    cv2.imwrite(str(stem) + ".picture.png", cv2.cvtColor(s["picture"], cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(stem) + ".render.png", cv2.cvtColor(s["render"], cv2.COLOR_RGB2BGR))
    fl = np.clip(np.round(s["flow"] * 8), -32768, 32767).astype(np.int16)
    fl[:, ~s["valid"]] = 0
    np.savez_compressed(str(stem) + ".flow.npz", flow=fl, valid=s["valid"].astype(np.uint8),
                        new=s["new"].astype(np.uint8), cand=s["cand"])
    (Path(str(stem) + ".json")).write_text(json.dumps(s["meta"]))


def _work(args):
    out, k, seed = args
    if (out / f"{k:05d}.json").exists():
        return k, "exists"
    files = _FILES
    try:
        s = sample(seed, files)
    except Exception as e:  # a broken model must not stop a shard; it is reported
        return k, f"error {type(e).__name__}: {e}"
    if s is None or s["meta"]["valid_frac"] < 0.02:
        return k, "skip"
    write(out, k, s)
    return k, "ok"


_FILES: list[Path] = []


def _init(files):
    global _FILES
    _FILES = files
    cv2.setNumThreads(1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--n", type=int, default=500)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    files = model_files()
    jobs = [(a.out, k, a.seed * 1_000_003 + k) for k in range(a.n)]
    t0 = time.time()
    done = 0
    stats: dict[str, int] = {}
    if a.workers <= 1:
        _init(files)
        it = map(_work, jobs)
    else:
        import multiprocessing as mp
        pool = mp.get_context("spawn").Pool(a.workers, initializer=_init, initargs=(files,))
        it = pool.imap_unordered(_work, jobs)
    for k, status in it:
        done += 1
        key = status.split(" ")[0]
        stats[key] = stats.get(key, 0) + 1
        if key == "error":
            print(f"sample {k}: {status}", file=sys.stderr, flush=True)
        print(f"::progress {done}/{a.n} {stats} {time.time() - t0:.0f}s", flush=True)
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
