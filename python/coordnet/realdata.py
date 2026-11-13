"""Real booklet pages of the booklet_mpd *train* sets, labelled through the solved camera.

For each step picture with an answer key: find the camera (coarse silhouette search over booklet-like views the
first time in a set, the previous step's camera after that), refine it with CoordNet against a render of the
step's full model, and keep the page only if the fit is tight (median < 1 px, p90 < 2 px) and the rendered new
parts agree with what changed on the page (this drops exploded drawings, whose new parts are drawn elsewhere).
Labels then come from the G-buffer exactly as for synthetic data. Held-out sets (21065, validation, test) are
refused: they are for grading only.

    python -m coordnet.realdata [--sets 40271,40274]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from . import datagen, labels
from . import render as R
from .camera import BookletCamera, project
from .evaluate import ROOT, Net, solve_camera
from .place import change_evidence
from .placedata import OUT, write

CKPT = ROOT / ".cache/coordnet/ckpt/best.pt"
MAX_SIDE = 640
MIN_SIDE = 512
EYE = 4200.0
SCALES = (0.85, 1.0, 1.15)


def norm(p):
    return datagen._part(p)


def load_net(ckpt: Path = CKPT) -> Net:
    return Net(ckpt, "mps" if torch.backends.mps.is_available() else "cpu")


def _points(parts: list, n: int = 5000) -> np.ndarray:
    v = R.scene(parts)[0].reshape(-1, 3)
    if len(v) > n:
        v = v[np.random.default_rng(0).choice(len(v), n, replace=False)]
    return v


PAPER = np.array([137, 142, 146], np.uint8)


def paper_mask(pic: np.ndarray, tol: int = 40) -> np.ndarray:
    """Background: pixels near the colour of the picture's border (booklets differ: grey, light blue, white)."""
    ring = np.concatenate([pic[:3].reshape(-1, 3), pic[-3:].reshape(-1, 3), pic[:, :3].reshape(-1, 3),
                           pic[:, -3:].reshape(-1, 3)])
    paper = np.median(ring, 0)
    return np.abs(pic.astype(int) - paper).sum(-1) < tol


def normalise_paper(pic: np.ndarray) -> np.ndarray:
    """Repaint the background in the booklet grey CoordNet was trained on."""
    out = pic.copy()
    out[paper_mask(pic)] = PAPER
    return out


def frame(cam: BookletCamera, centre, pts: np.ndarray, fg: np.ndarray, fit_scale: bool = True,
          scale_mult: float = 1.0) -> BookletCamera:
    """Scale (optionally) and offset `cam` so the model's projected box matches the picture's foreground box. Where
    the model runs off the picture's edge, the opposite (uncut) side is matched instead of the centre."""
    ys, xs = np.nonzero(fg)
    if len(xs) == 0:
        return cam
    H, W = fg.shape
    flo, fhi = np.array([xs.min(), ys.min()], float), np.array([xs.max(), ys.max()], float)
    cut_lo = flo <= 1
    cut_hi = fhi >= np.array([W, H]) - 2
    if fit_scale:
        uv, _ = project(cam.with_(scale=1.0, cx=0.0, cy=0.0), centre, pts)
        span = np.maximum(uv.max(0) - uv.min(0), 1e-6)
        ratio = (fhi - flo) / span
        whole = ~(cut_lo | cut_hi)
        base = ratio[whole].mean() if whole.any() else ratio.max()
        cam = cam.with_(scale=float(base * scale_mult))
    uv, _ = project(cam.with_(cx=0.0, cy=0.0), centre, pts)
    lo, hi = uv.min(0), uv.max(0)
    off = (flo + fhi) / 2 - (lo + hi) / 2
    off = np.where(cut_lo & ~cut_hi, fhi - hi, off)
    off = np.where(cut_hi & ~cut_lo, flo - lo, off)
    return cam.with_(cx=float(off[0]), cy=float(off[1]))


def coarse(pic: np.ndarray, parts: list, top: int = 5) -> list[tuple[float, BookletCamera]]:
    """Booklet-like views ranked by silhouette IoU against the picture's foreground (quarter resolution)."""
    centre = R.bounds_centre(parts)
    pts = _points(parts)
    fg = ~paper_mask(pic)
    q = 4
    fgq = cv2.resize(fg.astype(np.uint8), (pic.shape[1] // q, pic.shape[0] // q), interpolation=cv2.INTER_AREA) > 0
    Hq, Wq = fgq.shape
    out = []
    yaws = [s * a + b for a in range(20, 75, 5) for s in (1, -1) for b in (0, 180)]
    for turned in (False, True):
        for pitch in range(15, 55, 5):
            for yaw, mult in ((y, k) for y in yaws for k in SCALES):
                cam = frame(BookletCamera(yaw, pitch, 0.0, 1.0, 0.0, 0.0, eye=EYE, turned=turned), centre, pts, fg,
                            scale_mult=mult)
                uv, _ = project(cam, centre, pts)
                ij = np.round(uv / q - 0.5).astype(int)
                ok = (ij[:, 0] >= 0) & (ij[:, 0] < Wq) & (ij[:, 1] >= 0) & (ij[:, 1] < Hq)
                m = np.zeros((Hq, Wq), np.uint8)
                m[ij[ok, 1], ij[ok, 0]] = 1
                m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)).astype(bool)
                iou = (m & fgq).sum() / max((m | fgq).sum(), 1)
                out.append((float(iou), cam))
    out.sort(key=lambda t: -t[0])
    return out[:top]


def _prepare(case) -> tuple[np.ndarray, float]:
    pic = np.asarray(case.rgb)
    if pic.dtype != np.uint8:
        pic = (np.clip(pic, 0, 1) * 255).round().astype(np.uint8) if pic.max() <= 1.0 else pic.astype(np.uint8)
    pic = pic[..., :3]
    side = max(pic.shape[:2])
    # booklets embed step pictures at their own resolution (some ~130 px): bring them to the scale CoordNet knows
    f = MAX_SIDE / side if side > MAX_SIDE else (MIN_SIDE / side if side < MIN_SIDE else 1.0)
    if f != 1.0:
        pic = cv2.resize(pic, (round(pic.shape[1] * f), round(pic.shape[0] * f)),
                         interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC)
    pts = (case.pts_per_px or 0.48) / f
    return np.ascontiguousarray(normalise_paper(pic)), pts


def label_case(net, case, start: BookletCamera | None = None, rounds: int = 4,
               max_median: float = 1.0, max_p90: float = 2.0, min_agree: float = 0.6) -> dict | None:
    """Labels for one booklet step, or None when the camera or the new parts cannot be trusted."""
    pic, pts_px = _prepare(case)
    H, W = pic.shape[:2]
    base = [norm(p) for p in case.visible]
    new = [norm(p) for p in case.added]
    parts = base + new
    if not new or not base:
        return None
    centre = R.bounds_centre(parts)
    fg = ~paper_mask(pic)
    starts = [frame(start, centre, _points(parts), fg, fit_scale=False)] if start is not None else \
        [c for _iou, c in coarse(pic, parts)]
    best = None
    for cam0 in starts:
        cam, fits = solve_camera(net, pic, parts, cam0, centre, W, H, rounds)
        if not fits:
            continue
        if best is None or fits[-1]["median"] < best[1][-1]["median"]:
            best = (cam, fits)
        if fits[-1]["median"] < max_median:
            break
    if best is None:
        return None
    cam, fits = best
    fit = fits[-1]
    if fit["median"] >= max_median or fit["p90"] >= max_p90:
        return None
    newset = set(range(len(base), len(parts)))
    g = R.gbuffer(*R.scene(parts), cam, centre, W, H)
    lab = labels.local_labels(g, parts, newset)
    base_img = R.render(base, set(), cam, centre, W, H, R.Style(), ss=2, red=False).picture
    ev = change_evidence(pic, base_img)
    k = np.ones((7, 7), np.uint8)
    newpix = lab["new"]
    recall = (newpix & cv2.dilate(ev.astype(np.uint8), k).astype(bool)).sum() / max(newpix.sum(), 1)
    precision = (ev & cv2.dilate(newpix.astype(np.uint8), k).astype(bool)).sum() / max(ev.sum(), 1)
    if newpix.sum() < 30 or recall < min_agree or precision < min_agree * 0.8:
        return None
    types: dict[tuple, int] = {}
    for p, c, _m in new:
        types[(p, c)] = types.get((p, c), 0) + 1
    camd = dict(yaw=cam.yaw, pitch=cam.pitch, roll=cam.roll, scale=cam.scale, cx=cam.cx, cy=cam.cy, eye=cam.eye,
                turned=cam.turned)
    meta = dict(real=True, set=case.set_number, step=case.step_number, W=W, H=H, cam=camd, pts_per_px=pts_px,
                centre=np.asarray(centre).tolist(), fit=fit, agree=dict(recall=float(recall), precision=float(precision)),
                parts=[[p, c, m.tolist(), i >= len(base)] for i, (p, c, m) in enumerate(parts)],
                types=[[p, c, n] for (p, c), n in types.items()])
    return dict(picture=pic, base=base_img, labels=lab, meta=meta, cam=cam)


def main(argv=None):
    from booklet_mpd.protocol import tuning_sets
    from booklet_mpd.solver import dataset as D

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sets", default="")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--ckpt", type=Path, default=CKPT)
    a = ap.parse_args(argv)
    allowed = tuning_sets(D.grades())
    sets = [s for s in a.sets.split(",") if s] or allowed
    bad = [s for s in sets if s not in allowed]
    if bad:
        ap.error(f"not booklet_mpd train sets (held-out sets are grading-only): {', '.join(bad)}")
    net = load_net(a.ckpt)
    t0 = time.time()
    total = dict(kept=0, dropped=0)
    for si, s in enumerate(sets):
        out = a.out / f"real-{s}"
        try:
            cases = D.cases(s)
        except Exception as e:
            print(f"set {s}: cannot load ({type(e).__name__}: {e})", file=sys.stderr, flush=True)
            continue
        start, prev_pts, kept, dropped = None, None, 0, 0
        for ci, case in enumerate(cases):
            if case.rgb is None:
                dropped += 1
                continue
            st = None
            if start is not None:
                _pic, pts_px = _prepare(case)
                st = start.with_(scale=start.scale * prev_pts / pts_px)
            try:
                smp = label_case(net, case, st)
                if smp is None and st is not None:
                    smp = label_case(net, case, None)          # the view changed: search again
            except Exception as e:
                print(f"set {s} step {case.step_number}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
                smp = None
            if smp is None:
                dropped += 1
            else:
                write(out, kept, smp)
                kept += 1
                start, prev_pts = smp["cam"], smp["meta"]["pts_per_px"]
            print(f"::progress {si}/{len(sets)} set {s} step {ci + 1}/{len(cases)} kept {kept} "
                  f"dropped {dropped} {time.time() - t0:.0f}s", flush=True)
        total["kept"] += kept
        total["dropped"] += dropped
        print(json.dumps(dict(set=s, kept=kept, dropped=dropped)), flush=True)
    print(json.dumps(total))


if __name__ == "__main__":
    main()
