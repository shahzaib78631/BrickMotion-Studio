"""Real-booklet evaluation: solve the camera of verified 21065 book-1 steps with CoordNet.

    python -m coordnet.evaluate [--ckpt .cache/coordnet/ckpt/best.pt] [--steps 1-8] [--out .cache/coordnet/eval]
                                [--export]

--export writes the solved cameras to public/_booklet/21065/coordnet.json, which the booklet-camera page loads
in place of its own fit: per step yaw/pitch/roll/scale (px per LDU at that step's raster), cx/cy, eye (LDU),
turned, and the model centre the camera looks at (LDraw, before any turn).

Each step starts from the page's shared camera (yaw/pitch/roll/scale/eye recalibrated on steps 1-8) with the crop
offset found by silhouette cross-correlation, then repeats: render the verified model -> network flow picture ->
render -> matches (confident, not new-part pixels) -> robust camera fit. Exploded steps (new parts drawn lifted)
render only the parts built before the step.

Reported per step, before and after: the network's own residual (median / p90 px of the fitted reprojection) and
an independent check that uses no network: distance from the render's lines to the picture's dark lines and back
(p50 / p90 px). Overlays go to --out.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch

from .camera import BookletCamera, raster_scale
from . import render as R
from .solve import correspondences, fit_camera

ROOT = Path(__file__).resolve().parents[2]
BOOK = ROOT / "public/_booklet/21065"
# start camera: the CoordNet fits of steps 2-8 averaged (was the page fit 36.777, 35.123, 1.277, 1.71098, 4593)
SHARED = dict(yaw=35.2329, pitch=35.4154, roll=0.2443, scale=1.6848, ref_pts=0.478468, eye=4188.0)


def load_step(n: int):
    d = json.loads((BOOK / f"step-{n:04d}.json").read_text())
    parts = [(p["part"], p["color"], np.array(p["matrix"], float).reshape(4, 4).T) for p in d["parts"]]
    new = [bool(p.get("new")) for p in d["parts"]]
    pic = cv2.cvtColor(cv2.imread(str(BOOK / f"step-{n:04d}.png")), cv2.COLOR_BGR2RGB)
    pic = cv2.resize(pic, (d["width"], d["height"]), interpolation=cv2.INTER_AREA)
    return d, parts, new, pic


def foreground(pic: np.ndarray) -> np.ndarray:
    paper = np.median(pic.reshape(-1, 3), 0)
    return np.abs(pic.astype(int) - paper).sum(-1) > 30


def initial_camera(d, parts, pic) -> tuple[BookletCamera, np.ndarray]:
    W, H = d["width"], d["height"]
    cam = BookletCamera(SHARED["yaw"], SHARED["pitch"], SHARED["roll"],
                        raster_scale(SHARED["scale"], SHARED["ref_pts"], d["ptsPerPx"]), W / 2, H / 2,
                        eye=SHARED["eye"], turned=bool(d["flipped"]))
    centre = R.bounds_centre(parts)
    m = R.gbuffer(*R.scene(parts), cam, centre, W, H).part >= 0
    fg = foreground(pic)
    cc = np.fft.irfft2(np.fft.rfft2(fg.astype(float)) * np.conj(np.fft.rfft2(m.astype(float))), s=fg.shape)
    dy, dx = np.unravel_index(cc.argmax(), cc.shape)
    dy -= H * (dy > H / 2)
    dx -= W * (dx > W / 2)
    return cam.with_(cx=W / 2 + dx, cy=H / 2 + dy), centre


def dark_lines(img: np.ndarray, up: int = 1, thin: float = 0.0) -> np.ndarray:
    """Thin dark-line mask (line centres), at `up` times the image resolution. thin > 0 drops filled dark regions
    (a black part's face is not a line; booklets print it anywhere from black to mid grey): only dark structures
    an opening `thin` px wide (at picture resolution; True means 4) removes are kept -- pass a wider stroke for
    upscaled pictures, whose lines are wider."""
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
    if up > 1:
        g = cv2.resize(g, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    dark = (g < cv2.GaussianBlur(g, (0, 0), 3 * up) - 25) | (g < 45)
    if thin:
        w = int(round((4.0 if thin is True else float(thin)) * up)) + 1
        k = np.ones((w, w), np.uint8)
        filled = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_OPEN, k).astype(bool)
        dark &= ~filled
    # keep the darkest pixel across each line: a local minimum along x or y
    mx = (g <= np.roll(g, 1, 1)) & (g <= np.roll(g, -1, 1))
    my = (g <= np.roll(g, 1, 0)) & (g <= np.roll(g, -1, 0))
    return dark & (mx | my)


def line_distance(pic: np.ndarray, ren: np.ndarray, region: np.ndarray, up: int = 4,
                  thin: float = 0.0, native: float = 1.0, clip: float = 15.0) -> tuple[float, float]:
    """Two-way distance between the centres of the render's dark lines and the picture's, within `region`
    (p50, p90; measured at `up` x so it resolves sub-pixel offsets). Reported in the source raster's pixels: a
    picture enlarged `native` times before solving has its distances divided by `native`, and clipped at `clip`
    of those pixels."""
    reg = cv2.resize(region.astype(np.uint8), None, fx=up, fy=up, interpolation=cv2.INTER_NEAREST).astype(bool)
    a, b = dark_lines(pic, up, thin) & reg, dark_lines(ren, up, thin) & reg
    if a.sum() < 50 * up or b.sum() < 50 * up:
        return float("nan"), float("nan")
    da = cv2.distanceTransform((~a).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    db = cv2.distanceTransform((~b).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    d = np.minimum(np.concatenate([da[b], db[a]]) / (up * max(1.0, float(native))), clip)
    return float(np.median(d)), float(np.percentile(d, 90))


def tile_shifts(pic: np.ndarray, ren: np.ndarray, region: np.ndarray, tile: int = 96) -> np.ndarray:
    """Sub-pixel shift (dx, dy) of the render against the picture in each tile with enough structure, by phase
    correlation of high-passed grey images. Independent of the network; [N,2] in px."""
    hp = lambda im: (lambda g: g - cv2.GaussianBlur(g, (0, 0), 4))(cv2.cvtColor(im, cv2.COLOR_RGB2GRAY).astype(np.float32))
    a, b = hp(pic), hp(ren)
    H, W = region.shape
    win = cv2.createHanningWindow((tile, tile), cv2.CV_32F)
    out = []
    for y in range(0, H - tile + 1, tile // 2):
        for x in range(0, W - tile + 1, tile // 2):
            if region[y:y + tile, x:x + tile].mean() < 0.5:
                continue
            # copies: phaseCorrelate applies the window to its inputs in place, and tiles overlap
            ta, tb = a[y:y + tile, x:x + tile].copy(), b[y:y + tile, x:x + tile].copy()
            if ta.std() < 8 or tb.std() < 8:
                continue
            (dx, dy), resp = cv2.phaseCorrelate(ta, tb, win)
            if resp > 0.1 and abs(dx) < tile / 4 and abs(dy) < tile / 4:
                out.append((dx, dy))
    return np.array(out).reshape(-1, 2)


def shift_summary(pic, ren, region) -> dict:
    t = tile_shifts(pic, ren, region)
    if not len(t):
        return dict(tiles=0)
    m = np.linalg.norm(t, axis=1)
    return dict(tiles=len(t), median=float(np.median(m)), p90=float(np.percentile(m, 90)), max=float(m.max()),
                mean_dx=float(t[:, 0].mean()), mean_dy=float(t[:, 1].mean()))


class Net:
    def __init__(self, ckpt: Path, device: str, iters: int = 12):
        from .model import CoordNet
        self.dev = torch.device(device)
        self.model = CoordNet().to(self.dev).eval()
        sd = torch.load(ckpt, map_location="cpu", weights_only=False)
        self.model.load_state_dict(sd.get("model", sd))
        self.iters = iters

    @torch.no_grad()
    def __call__(self, picture: np.ndarray, render: np.ndarray):
        t = lambda a: torch.from_numpy(a).permute(2, 0, 1)[None].float().div(255).to(self.dev)
        out = self.model(t(picture), t(render), iters=self.iters)
        flow = out["flows"][-1][0].cpu().numpy()
        conf = torch.sigmoid(out["conf"][0, 0]).cpu().numpy()
        new = torch.sigmoid(out["newmask"][0, 0]).cpu().numpy()
        return flow, conf, new


def solve_camera(net: Net, pic, parts, cam, centre, W, H, rounds: int = 4, log=None, free=None):
    """Iterate network matches and robust fits; `free`: camera parameters to fit (default all)."""
    fits = []
    for r in range(rounds):
        ren = R.render(parts, set(), cam, centre, W, H, R.Style(), ss=2, red=False)
        flow, conf, new = net(pic, ren.picture)
        w = np.where((conf > 0.5) & (new < 0.5), conf, 0)
        m = correspondences(flow, w, ren.gt)
        if len(m.p) < 200:
            break
        fit = fit_camera(m, cam, centre, free)
        if fit is None:
            break
        moved = float(np.median(np.linalg.norm(flow[:, w > 0], axis=0)))
        fits.append(dict(round=r, n=fit.n, median=fit.median, p90=fit.p90, inliers=fit.inliers, flow_median=moved))
        if log:
            log(fits[-1])
        cam = fit.cam
        if moved < 0.3:
            break
    return cam, fits


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", type=Path, default=ROOT / ".cache/coordnet/ckpt/best.pt")
    ap.add_argument("--steps", default="1-8")
    ap.add_argument("--out", type=Path, default=ROOT / ".cache/coordnet/eval")
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    ap.add_argument("--rounds", type=int, default=4)
    ap.add_argument("--export", action="store_true", help="write public/_booklet/21065/coordnet.json for the page")
    a = ap.parse_args(argv)
    lo, hi = (int(x) for x in a.steps.split("-"))
    a.out.mkdir(parents=True, exist_ok=True)
    net = Net(a.ckpt, a.device)
    rows = []
    for n in range(lo, hi + 1):
        d, parts, new, pic = load_step(n)
        W, H = d["width"], d["height"]
        use = [p for p, nw in zip(parts, new) if not (nw and d.get("exploded"))]
        cam0, centre = initial_camera(d, use, pic)
        region = cv2.dilate(foreground(pic).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
        ren0 = R.render(use, set(), cam0, centre, W, H, R.Style(), ss=2, red=False).picture
        before = line_distance(pic, ren0, region)
        shift0 = shift_summary(pic, ren0, region)
        cam, fits = solve_camera(net, pic, use, cam0, centre, W, H, a.rounds,
                                 log=lambda f: print(f"  step {n}", json.dumps(f), flush=True))
        ren1 = R.render(use, set(), cam, centre, W, H, R.Style(), ss=2, red=False).picture
        after = line_distance(pic, ren1, region)
        shift1 = shift_summary(pic, ren1, region)
        row = dict(step=n, exploded=bool(d.get("exploded")), lines_before=before, lines_after=after,
                   shift_before=shift0, shift_after=shift1,
                   fit=fits[-1] if fits else None,
                   cam=dict(yaw=cam.yaw, pitch=cam.pitch, roll=cam.roll, scale=cam.scale, cx=cam.cx, cy=cam.cy,
                            eye=cam.eye, turned=cam.turned),
                   centre=[float(x) for x in centre], name=f"step-{n:04d}",
                   cam_change=dict(yaw=cam.yaw - cam0.yaw, pitch=cam.pitch - cam0.pitch, roll=cam.roll - cam0.roll,
                                   scale=cam.scale / cam0.scale - 1, cx=cam.cx - cam0.cx, cy=cam.cy - cam0.cy))
        rows.append(row)
        print(json.dumps(row), flush=True)
        blend = lambda r: (0.5 * pic + 0.5 * r).astype(np.uint8)
        cv2.imwrite(str(a.out / f"step-{n:04d}.png"),
                    cv2.cvtColor(np.concatenate([blend(ren0), blend(ren1)], 0), cv2.COLOR_RGB2BGR))
    (a.out / "report.json").write_text(json.dumps(rows, indent=1))
    if a.export:
        dst = BOOK / "coordnet.json"
        old = json.loads(dst.read_text()) if dst.exists() else {}
        steps = old.get("steps", {})
        for r in rows:
            steps[r["name"]] = dict(cam=r["cam"], centre=r["centre"], fit=r["fit"], shift=r["shift_after"],
                                    shift_before=r["shift_before"])
        dst.write_text(json.dumps(dict(
            source="python -m coordnet.evaluate --export", checkpoint=str(a.ckpt.relative_to(ROOT)
                                                                          if a.ckpt.is_relative_to(ROOT) else a.ckpt),
            note="per-step CoordNet camera; scale is px/LDU at the step's own raster; centre is LDraw before turn",
            steps=dict(sorted(steps.items()))), indent=1))
        print("wrote", dst)


if __name__ == "__main__":
    main()
