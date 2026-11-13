"""Fast placement: one network pass, ray/lattice voting onto legal poses, a whole-step pick, one check render.

    python -m coordnet.fastplace --step 8 [--ckpt .cache/coordnet/placenet/best.pt]

`net(picture, base_render, evidence)` returns half-resolution numpy maps: new [h,w] (probability), local [h,w,3]
LDU, size [h,w,3] LDU, conf [h,w] (probability). `PlaceModel` wraps a trained PlaceNet that way.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from . import lattice, pick
from . import render as R
from .camera import BookletCamera
from .place import change_evidence, connection_candidates, place_joint

ROOT = Path(__file__).resolve().parents[2]
CKPT = ROOT / ".cache/coordnet/placenet/best.pt"


class PlaceModel:
    def __init__(self, ckpt: Path = CKPT, device: str | None = None):
        from .placenet import PlaceNet
        self.dev = torch.device(device or ("mps" if torch.backends.mps.is_available() else "cpu"))
        self.net = PlaceNet().to(self.dev).eval()
        sd = torch.load(ckpt, map_location="cpu", weights_only=False)
        self.net.load_state_dict(sd.get("model", sd))

    @torch.no_grad()
    def __call__(self, picture: np.ndarray, base_img: np.ndarray, evidence: np.ndarray) -> dict:
        H, W = picture.shape[:2]
        ph, pw = (-H) % 32, (-W) % 32                                   # the U-Net wants multiples of 32
        t = lambda a: np.pad(a, ((0, ph), (0, pw), (0, 0)), constant_values=140) if a.ndim == 3 else \
            np.pad(a, ((0, ph), (0, pw)))
        x = np.concatenate([t(picture) / 255.0, t(base_img) / 255.0, t(evidence.astype(np.float32))[..., None]], -1)
        out = self.net(torch.from_numpy(x.astype(np.float32)).permute(2, 0, 1)[None].to(self.dev))
        h, w = (H + 1) // 2, (W + 1) // 2
        g = lambda k: out[k][0].permute(1, 2, 0).float().cpu().numpy()[:h, :w]
        return dict(new=1 / (1 + np.exp(-g("new")[..., 0])), local=g("local"), size=g("size"),
                    conf=1 / (1 + np.exp(-g("conf")[..., 0])))


def _key(k) -> str:
    return f"{k[0]}|{k[1]}"


def new_iou(base: list, placed: list, cam: BookletCamera, centre, newmask: np.ndarray) -> float:
    """Check: IoU at half resolution between where the placed parts show (G-buffer, no styling) and the new pixels."""
    h, w = newmask.shape
    half = cam.with_(scale=cam.scale / 2, cx=cam.cx / 2, cy=cam.cy / 2)
    if not placed:
        return 0.0
    g = R.gbuffer(*R.scene(list(base) + list(placed)), half, centre, w, h)
    shown = g.part >= len(base)
    return float((shown & newmask).sum() / max((shown | newmask).sum(), 1))


def _vote_pick(lib, out, picture, base, need, poses, cam, centre, collider, colours, newmask, depth):
    tables = {k: lattice.PoseTable.build(k[0], v) for k, v in poses.items()}
    sel = (out["new"] > 0.5) & (out["conf"] > 0.5)
    ys, xs = np.nonzero(sel)
    if len(xs) > 6000:
        keep = np.random.default_rng(0).choice(len(xs), 6000, replace=False)
        ys, xs = ys[keep], xs[keep]
    uv = np.stack([2 * xs + 1.0, 2 * ys + 1.0], 1)                     # half-res pixel centre in full-res px
    fy = np.clip(2 * ys + 1, 0, picture.shape[0] - 1)
    fx = np.clip(2 * xs + 1, 0, picture.shape[1] - 1)
    votes = lattice.vote(uv, out["local"][ys, xs], out["size"][ys, xs], picture[fy, fx].astype(float),
                         out["conf"][ys, xs], cam, centre, tables, colours, depth=depth[fy, fx]) if len(xs) else []
    if collider is not None and votes:                                 # drop poses that cut into the base
        collider.set_model(list(base))
        enough: dict = {}
        kept = []
        for v in votes:
            if enough.get(v.key, 0) >= 3 * need[v.key] + 4:
                continue
            if not collider.hits(v.key[0], v.pose):
                kept.append(v)
                enough[v.key] = enough.get(v.key, 0) + 1
        votes = kept
    p = pick.pick(votes, need, newmask, cam, centre, collider, ds=2.0)
    return p, tables, len(votes)


def place_fast(net, lib, picture: np.ndarray, base: list, need: dict, cam: BookletCamera, centre,
               collider=None, log=None, base_ren: "R.Rendered | None" = None) -> tuple[list, dict]:
    """`base_ren`: the plain render of `base` at `cam` (picture + G-buffer) if the caller has it; the camera solve
    makes exactly this render, so the placer does not draw the base again."""
    t0 = time.perf_counter()
    H, W = picture.shape[:2]
    if base_ren is None:
        base_ren = R.render(base, set(), cam, centre, W, H, R.Style(), ss=2, red=False)
    base_img = base_ren.picture
    ev = change_evidence(picture, base_img)
    out = net(picture, base_img, ev)
    newmask = out["new"] > 0.5
    rep = dict(review=False, pass2=False, fallback=[], unplaced={}, votes=0, margin=0.0)
    if not newmask.any():
        rep.update(review=True, reason="no new pixels", seconds=time.perf_counter() - t0)
        rep["unplaced"] = {_key(k): n for k, n in need.items()}
        return [], rep
    colours = {k: np.array(R.colour_table().get(k[1], (128, 128, 128)), float) for k in need}
    depth = base_ren.gt.depth                                           # the known model, to test what it hides
    poses = connection_candidates(lib, need, base)
    p, tables, nv = _vote_pick(lib, out, picture, base, need, poses, cam, centre, collider, colours, newmask, depth)
    rep["votes"] = nv
    if p.placed and (len(p.placed) > 1 or p.unplaced):
        # pass 2, always: poses on the parts just placed (parts stacked on new parts of the same step). Pass 1 can
        # only offer such a part a line-of-sight twin on the base, which it may then pick with confidence. The base
        # poses stay, since the placed parts now occupy some of the base's studs.
        more = connection_candidates(lib, need, p.placed) if p.placed else {}
        poses2 = {k: list(v) + list(more.get(k, [])) for k, v in poses.items()}
        p2, tables2, nv2 = _vote_pick(lib, out, picture, base, need, poses2, cam, centre, collider, colours, newmask,
                                      depth)
        better = (len(p2.placed), p2.score) > (len(p.placed), p.score)
        if better:
            p, tables, rep["votes"], rep["pass2"] = p2, tables2, nv2, True
    placed = list(p.placed)
    # parts with only non-axis-aligned legal poses: the slow search, for those parts alone
    fall = {k: n for k, n in p.unplaced.items() if k in tables and not tables[k].poses and tables[k].fallback}
    if fall:
        got, _stats = place_joint(picture, list(base) + placed, fall, {k: tables[k].fallback for k in fall}, cam,
                                  centre, collider)
        placed += got
        rep["fallback"] = [_key(k) for k in fall]
    left: dict = {}
    for k, n in need.items():
        have = sum(1 for q, c, _m in placed if (q, c) == k)
        if have < n:
            left[_key(k)] = n - have
    rep.update(unplaced=left, margin=p.margin, score=p.score, review=bool(p.review or left),
               new_iou=new_iou(base, placed, cam, centre, newmask),
               seconds=time.perf_counter() - t0)
    if log:
        log(rep)
    return placed, rep


def main(argv=None):
    from .evaluate import Net, initial_camera, load_step, solve_camera

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--step", type=int, required=True)
    ap.add_argument("--ckpt", type=Path, default=CKPT)
    ap.add_argument("--camera-ckpt", type=Path, default=ROOT / ".cache/coordnet/ckpt/best.pt")
    ap.add_argument("--no-oracle", action="store_true")
    ap.add_argument("--out", type=Path, default=ROOT / ".cache/coordnet/fastplace")
    a = ap.parse_args(argv)
    from assembly_model.ldraw import load_library
    from .place import same_pose
    d, parts, new, pic = load_step(a.step)
    W, H = d["width"], d["height"]
    base = [p for p, nw in zip(parts, new) if not nw]
    truth = [p for p, nw in zip(parts, new) if nw]                     # grading only
    need: dict = {}
    for p, c, _m in truth:
        need[(p, c)] = need.get((p, c), 0) + 1
    cam0, centre = initial_camera(d, base, pic)
    cam, _fits = solve_camera(Net(a.camera_ckpt, "mps" if torch.backends.mps.is_available() else "cpu"),
                              pic, base, cam0, centre, W, H)
    lib = load_library(str(ROOT / "public/ldraw"))
    collider = None
    if not a.no_oracle:
        from booklet_mpd.solver.collide import Collider
        collider = Collider(lib)
    try:
        placed, rep = place_fast(PlaceModel(a.ckpt), lib, pic, base, need, cam, centre, collider)
    finally:
        if collider is not None:
            collider.close()
    left = list(truth)
    exact = 0
    for p, c, m in placed:
        hit = next((i for i, t in enumerate(left) if (t[0], t[1]) == (p, c) and same_pose(p, t[2], m)), None)
        if hit is not None:
            exact += 1
            left.pop(hit)
    result = dict(step=a.step, placed=len(placed), needed=len(truth), exact=exact, report=rep,
                  poses=[dict(part=p, colour=c, pos=np.round(m[:3, 3], 2).tolist()) for p, c, m in placed])
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / f"step-{a.step:04d}.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
