"""Real booklet pages of the booklet_mpd *train* sets, labelled through the solved camera.

For each step picture with an answer key: find the camera (the standard booklet views at the print scale the
first time in a set, keeping the tight fit that matches the most pixels; the previous step's camera after that), refine it with CoordNet against a render of the
step's full model, and keep the page only if the fit is tight (median < 1 px, p90 < 2 px) and the rendered new
parts agree with what changed on the page (this drops exploded drawings, whose new parts are drawn elsewhere).
Labels then come from the G-buffer exactly as for synthetic data. Held-out sets (21065, validation, test) are
refused: they are for grading only.

    python -m coordnet.realdata [--sets 40271,40274]
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from . import datagen, labels
from . import render as R
from .camera import BookletCamera, project
from .evaluate import ROOT, Net, line_distance, shift_summary, solve_camera
from .solve import EYE_RANGE  # noqa: F401  (bounds the fitted eye; re-exported for callers)
from .placedata import OUT, write

CKPT = ROOT / ".cache/coordnet/ckpt/best.pt"
MAX_SIDE = 640
MIN_SIDE = 512
EYE = 4200.0


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
    near = (np.abs(pic.astype(int) - paper).sum(-1) < tol).astype(np.uint8)
    # only paper-coloured regions connected to the picture's border: a white part inside its outline is not paper
    _n, lab = cv2.connectedComponents(near, connectivity=4)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    return np.isin(lab, edge[edge > 0])


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


STANDARD_YAWS = (35, 125, 215, 305)      # booklets draw models at ~35 deg yaw in one of four quadrants
STANDARD_PITCH = 35.0                     # and ~35 deg pitch (solved cameras on 21065 and train sets: 34.6-35.7)


def standard_views(pic: np.ndarray, parts: list, pts_per_px: float) -> list[BookletCamera]:
    """The booklet views to start from: four yaw quadrants, upright or turned over, at the print scale
    (booklet_mpd's BOOKLET_SCALE page points per LDU), framed on the picture's foreground."""
    from booklet_mpd.viewfit import BOOKLET_SCALE
    centre = R.bounds_centre(parts)
    pts = _points(parts)
    fg = ~paper_mask(pic)
    scale = BOOKLET_SCALE / pts_per_px
    return [frame(BookletCamera(yaw, STANDARD_PITCH, 0.0, scale, 0.0, 0.0, eye=EYE, turned=turned), centre, pts, fg,
                  fit_scale=False)
            for turned in (False, True) for yaw in STANDARD_YAWS]


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


def stroke_width(upscale: float) -> float:
    """Widest dark structure (px at picture resolution) still a line: booklet lines are up to ~2 px wide at native
    resolution, and `_prepare` may upscale small pictures."""
    return max(4.0, 2.0 * upscale)


def finite(x):
    """`x` with every non-finite float replaced by None (sample JSON must be strict JSON)."""
    if isinstance(x, dict):
        return {k: finite(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [finite(v) for v in x]
    if isinstance(x, (float, np.floating)):
        return float(x) if np.isfinite(x) else None
    return x


def camera_check(pic: np.ndarray, parts: list, cam: BookletCamera, centre, print_scale: float,
                 min_tiles: int = 8, max_shift: float = 1.0, max_line_p50: float = 1.2,
                 max_line_p90: float = 4.0, max_scale_err: float = 0.05, stroke: float = 4.0,
                 upscale: float = 1.0) -> dict:
    """Whether a solved camera draws the model where the page does, judged without the network: the median shift
    between page and render of the whole model over phase-correlated tiles (dense stud outlines make the nearest-
    line distance blind to a shift of several px; tiles are not), the dark-line p90, and the scale against the
    booklet's print scale. Returns the render (whole model, no red) and its G-buffer for reuse.

    Distances are judged in the booklet's own pixels: a picture enlarged `upscale` times before solving has its
    shift and line distances divided by it (a 1 px error in the source raster is `upscale` px here)."""
    H, W = pic.shape[:2]
    u = max(1.0, float(upscale))
    ren = R.render(parts, set(), cam, centre, W, H, R.Style(), ss=2, red=False).picture
    g = R.gbuffer(*R.scene(parts), cam, centre, W, H)
    region = cv2.dilate((g.part >= 0).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    sh = shift_summary(pic, ren, region)
    p50, p90 = line_distance(pic, ren, region, thin=stroke, native=u)
    scale_err = abs(cam.scale / print_scale - 1.0)
    shift = sh.get("median", float("inf")) / u
    ok = bool(sh["tiles"] >= min_tiles and shift <= max_shift and np.isfinite(p90) and p50 <= max_line_p50
              and p90 <= max_line_p90 and scale_err <= max_scale_err)
    return dict(ok=ok, tiles=int(sh["tiles"]), shift=float(shift), p50=p50, p90=p90, scale_err=float(scale_err),
                render=ren, gbuffer=g)


def edge_agreement(pic: np.ndarray, full: np.ndarray, base: np.ndarray, part: np.ndarray, new_ids: set,
                   render_without, max_p50: float = 1.5, max_p90: float = 4.0, min_gain: float = 0.5,
                   min_px: int = 40, informative_p90: float = 2.0, part_max_p50: float = 1.5,
                   part_max_p90: float = 5.0, stroke: float = 4.0, upscale: float = 1.0) -> dict:
    """Do the page's outlines show the new parts? Palette-free: compares dark-line maps, not colours.

    In the new parts' region the render of the whole model must fit the page's lines (p50, p90) and fit them
    clearly better than the render of the model so far (by `min_gain` px at p50). Then each new part with `min_px`
    visible pixels is removed in turn (`render_without(i)`): in its region the page must be fitted by the whole
    model and better with the part than without it (p90 by 1 px or p50 by `min_gain`); where removing it leaves no
    lines at all, its own lines fitting the page is the evidence. Every new pixel becomes a label, so a visible part
    that cannot be verified (too few lines; removal barely changes the drawing, e.g. mostly hidden) rejects the
    page. `part`: G-buffer part index per pixel of the whole model. Distances are in the booklet's own pixels
    (`upscale`: how much the picture was enlarged before solving)."""
    dist = lambda a, b, r: line_distance(a, b, r, thin=stroke, native=upscale)
    newvis = np.isin(part, list(new_ids))
    k9 = np.ones((9, 9), np.uint8)
    region = cv2.dilate(newvis.astype(np.uint8), k9).astype(bool)
    f50, f90 = dist(pic, full, region)
    b50, b90 = dist(pic, base, region)
    out = dict(full=[f50, f90], base=[b50, b90], parts={})
    if not np.isfinite(f50):
        return dict(out, ok=False, reason="too few lines")
    if not (f50 <= max_p50 and f90 <= max_p90):
        return dict(out, ok=False, reason="lines off")
    if np.isfinite(b50) and b50 < f50 + min_gain:
        return dict(out, ok=False, reason="no better than the model so far")
    for i in sorted(new_ids):
        own = part == i
        if own.sum() < min_px:
            continue                                  # too small to judge, and too small to matter as a label
        reg = cv2.dilate(own.astype(np.uint8), k9).astype(bool)
        pf = dist(pic, full, reg)
        if not np.isfinite(pf[0]):
            out["parts"][int(i)] = "too few lines"
            return dict(out, ok=False, reason=f"new part {i} cannot be verified (too few lines)")
        fits_page = pf[0] <= part_max_p50 and pf[1] <= part_max_p90
        minus = render_without(i)
        d = dist(full, minus, reg)
        if not np.isfinite(d[1]):
            # without the part the region has no lines left: the part's own lines are the evidence
            drawn, pm = fits_page, (float("nan"), float("nan"))
        elif d[1] < informative_p90:
            out["parts"][int(i)] = "uninformative"
            return dict(out, ok=False, reason=f"new part {i} cannot be verified (removing it barely changes "
                                              f"the drawing)")
        else:
            pm = dist(pic, minus, reg)
            drawn = fits_page and (not np.isfinite(pm[0]) or pm[1] >= pf[1] + 1.0 or pm[0] >= pf[0] + min_gain)
        out["parts"][int(i)] = dict(full=list(pf), without=list(pm), drawn=bool(drawn))
        if not drawn:
            return dict(out, ok=False, reason=f"new part {i} is not drawn")
    return dict(out, ok=True, reason="")


def _line_fit(pic, parts, centre, W, H, print_scale, fg, start, stroke, upscale, n_base,
              min_iou: float = 0.9) -> dict:
    """The network-free camera (docs/coordnet/linefit-design.md): line-fit hypotheses from the section's view and
    from the page's own line directions, each verified by `camera_check`. All passing fits of both searches are
    compared before any is kept: two that would label the new parts differently (new-part mask IoU < `min_iou`,
    or no G-buffer to tell) make the page ambiguous; equivalent ones (symmetric views, the same view found twice)
    are not. Returns best=(cam, fits, check) | ambiguous=[...] | lines=[diagnostics]."""
    from . import linefit
    feat = linefit.page_features(pic, stroke)
    newset = list(range(n_base, len(parts)))
    diag: list[str] = []
    passing = []
    for st in ([start] if start is not None else []) + [None]:
        for f in linefit.search(feat, parts, centre, W, H, print_scale, fg, start=st):
            chk = camera_check(pic, parts, f.cam, centre, print_scale, stroke=stroke, upscale=upscale)
            diag.append(f"{chk['tiles']}/{chk['shift']:.2f}/{chk['p90']:.2f}/{chk['scale_err']:.3f} line fit")
            if chk["ok"]:
                passing.append((f, chk))
    if not passing:
        return dict(lines=diag)
    passing.sort(key=lambda t: t[1]["shift"])
    f0, c0 = passing[0]
    mask = lambda c: None if c.get("gbuffer") is None else np.isin(c["gbuffer"].part, newset)
    m0 = mask(c0)
    for _f, c in passing[1:]:
        m = mask(c)
        if m0 is None or m is None or (m & m0).sum() / max(1, (m | m0).sum()) < min_iou:
            return dict(ambiguous=[f"{g.cam.yaw:.1f}/{g.cam.pitch:.1f}/{g.cam.cx:.1f}/{g.cam.cy:.1f}"
                                   for g, _c in passing])
    fit = dict(solver="linefit", score=f0.score, cover=f0.cover, n=f0.n)
    return dict(best=(f0.cam, [fit], c0))


def label_case(net, case, start: BookletCamera | None = None, rounds: int = 4,
               max_median: float = 1.0, max_p90: float = 2.0, why: list | None = None,
               checked: dict | None = None) -> dict | None:
    """Labels for one booklet step, or None when the camera or the new parts cannot be trusted (the reason is
    appended to `why`). A camera that passes `camera_check` is put in `checked["cam"]` even when the new parts
    then fail, so the next page of the section can start from it. A `start` (the section's view) is fitted with
    only the offset free first, then with everything free."""
    from booklet_mpd.viewfit import BOOKLET_SCALE
    reject = lambda reason: (why.append(reason) if why is not None else None)
    pic, pts_px = _prepare(case)
    upscale = (case.pts_per_px or 0.48) / pts_px
    stroke = stroke_width(upscale)
    H, W = pic.shape[:2]
    base = [norm(p) for p in case.visible]
    new = [norm(p) for p in case.added]
    parts = base + new
    if not new or not base:
        reject("no base or no new parts")
        return None
    centre = R.bounds_centre(parts)
    fg = ~paper_mask(pic)
    s0 = None
    if start is not None:
        s0 = frame(start, centre, _points(parts), fg, fit_scale=False)
        starts = [(s0, ("cx", "cy")), (s0, None)]
    else:
        starts = [(c, None) for c in standard_views(pic, parts, pts_px)]
    print_scale = BOOKLET_SCALE / pts_px
    # the network's residuals only say the fit is self-consistent; the page's lines decide between tight fits
    best, tried, lines = None, [], []
    for cam0, free in starts:
        cam, fits = solve_camera(net, pic, parts, cam0, centre, W, H, rounds, free=free)
        tried.append(f"{fits[-1]['median']:.2f}/{fits[-1]['p90']:.2f}/{fits[-1]['n']}" if fits else "none")
        if not fits or fits[-1]["median"] >= max_median or fits[-1]["p90"] >= max_p90:
            continue
        chk = camera_check(pic, parts, cam, centre, print_scale, stroke=stroke, upscale=upscale)
        lines.append(f"{chk['tiles']}/{chk['shift']:.2f}/{chk['p90']:.2f}/{chk['scale_err']:.3f}")
        if chk["ok"] and (best is None or chk["shift"] < best[2]["shift"]):
            best = (cam, fits, chk)
        if best is not None and free is not None:
            break                                   # the section's view with a new offset explains the page
    solver = "coordnet"
    if best is None:
        lf = _line_fit(pic, parts, centre, W, H, print_scale, fg, s0, stroke, upscale, len(base))
        if lf.get("ambiguous"):
            reject("camera: ambiguous line fits (yaw/pitch/cx/cy per passing fit: " + ", ".join(lf["ambiguous"]) + ")")
            return None
        if lf.get("best") is not None:
            best, solver = lf["best"], "linefit"
        else:
            lines += lf["lines"]
    if best is None:
        if not lines:
            reject("camera: no tight fit (median/p90/n per start: " + ", ".join(tried) + ")")
        elif all(int(x.split("/")[0]) < 8 for x in lines):
            reject("camera: too few tiles to verify (tiles/shift/line p90/scale error per tight start: "
                   + ", ".join(lines) + ")")
        else:
            reject("camera: off the page (tiles/shift/line p90/scale error per tight start: " + ", ".join(lines) + ")")
        return None
    cam, fits, chk = best
    if checked is not None:
        checked["cam"] = cam
    fit = fits[-1] if fits else {}
    newset = set(range(len(base), len(parts)))
    g = chk["gbuffer"]
    lab = labels.local_labels(g, parts, newset)
    base_img = R.render(base, set(), cam, centre, W, H, R.Style(), ss=2, red=False).picture
    without = lambda i: R.render([q for j, q in enumerate(parts) if j != i], set(), cam, centre, W, H, R.Style(),
                                 ss=2, red=False).picture
    agree = edge_agreement(pic, chk["render"], base_img, g.part, newset, without, stroke=stroke,
                           upscale=upscale)
    if lab["new"].sum() < 30 or not agree["ok"]:
        f, b = agree["full"], agree["base"]
        reject(f"new parts: {int(lab['new'].sum())} px, {agree.get('reason') or 'too small'} (lines full "
               f"{f[0]:.2f}/{f[1]:.2f}, base {b[0]:.2f}/{b[1]:.2f})")
        return None
    types: dict[tuple, int] = {}
    for p, c, _m in new:
        types[(p, c)] = types.get((p, c), 0) + 1
    camd = dict(yaw=cam.yaw, pitch=cam.pitch, roll=cam.roll, scale=cam.scale, cx=cam.cx, cy=cam.cy, eye=cam.eye,
                turned=cam.turned)
    agree_meta = dict(full=agree["full"], base=agree["base"], parts={str(k): v for k, v in agree["parts"].items()})
    meta = dict(real=True, set=case.set_number, step=case.step_number, W=W, H=H, cam=camd, pts_per_px=pts_px,
                solver=solver,
                centre=np.asarray(centre).tolist(), fit=fit, agree=agree_meta,
                camera_check=dict(tiles=chk["tiles"], shift=chk["shift"], p50=chk["p50"], p90=chk["p90"],
                                  scale_err=chk["scale_err"]),
                parts=[[p, c, m.tolist(), i >= len(base)] for i, (p, c, m) in enumerate(parts)],
                types=[[p, c, n] for (p, c), n in types.items()])
    return dict(picture=pic, base=base_img, labels=lab, meta=finite(meta), cam=cam)


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
        if out.exists():
            shutil.rmtree(out)                       # a rerun must not leave samples of an earlier run behind
        start, prev_pts, kept, dropped = None, None, 0, 0
        reasons: dict[str, int] = {}
        count = lambda why: reasons.__setitem__(why, reasons.get(why, 0) + 1)
        for ci, case in enumerate(cases):
            if case.rgb is None:
                dropped += 1
                count("no image")
                print(f"drop set {s} step {case.step_number}: no image (no picture box or main image)", flush=True)
                continue
            st, why, checked, pts_px = None, [], {}, None
            try:
                _pic, pts_px = _prepare(case)
                if start is not None:
                    st = start.with_(scale=start.scale * prev_pts / pts_px)
                smp = label_case(net, case, st, why=why, checked=checked)
                if smp is None and st is not None and "cam" not in checked:
                    smp = label_case(net, case, None, why=why, checked=checked)  # the view changed: search again
            except Exception as e:
                print(f"set {s} step {case.step_number}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
                smp = None
            if smp is None:
                dropped += 1
                count(why[-1].split(":")[0] if why else "error")
                print(f"drop set {s} step {case.step_number}: {' | '.join(why) or 'error'}", flush=True)
            else:
                write(out, kept, smp)
                kept += 1
            if "cam" in checked and pts_px:         # the camera passed its own check: the section's view
                start, prev_pts = checked["cam"], pts_px
            print(f"::progress {si}/{len(sets)} set {s} step {ci + 1}/{len(cases)} kept {kept} "
                  f"dropped {dropped} {time.time() - t0:.0f}s", flush=True)
        total["kept"] += kept
        total["dropped"] += dropped
        print(json.dumps(dict(set=s, kept=kept, dropped=dropped, reasons=reasons)), flush=True)
    print(json.dumps(total))


if __name__ == "__main__":
    main()
