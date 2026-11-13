"""Placement benchmark: exactness, speed, fallbacks, and whether every wrong step was flagged.

    python -m coordnet.bench_place --suite synthetic [--n 100]
    python -m coordnet.bench_place --suite 21065          # book 1 steps 2-8, camera solved per step
    python -m coordnet.bench_place --suite chained        # 21065 steps 2-8, each built on our own previous output

Writes `.cache/coordnet/bench-place/<suite>.json` with per-step rows and a summary. Answer keys are used only to
grade (and, for `synthetic`, the sample's own camera stands in for a solved one).
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch

from . import render as R
from .camera import BookletCamera
from .fastplace import CKPT, PlaceModel, place_fast
from .place import same_pose

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".cache/coordnet/bench-place"
EXPLODED_21065 = {1}            # step 1 is an exploded drawing (its json lacks the flag)


def grade(placed: list, truth: list) -> int:
    left = list(truth)
    exact = 0
    for p, c, m in placed:
        hit = next((i for i, t in enumerate(left) if (t[0], t[1]) == (p, c) and same_pose(p, t[2], m)), None)
        if hit is not None:
            exact += 1
            left.pop(hit)
    return exact


def summary(rows: list[dict]) -> dict:
    run = [r for r in rows if not r.get("skipped")]
    parts = sum(r["needed"] for r in run)
    wrong = [r for r in run if r["exact"] < r["needed"] or r["placed"] != r["needed"]]
    secs = sorted(r["seconds"] for r in run)
    return dict(steps=len(run), skipped=len(rows) - len(run),
                exact_part_rate=sum(r["exact"] for r in run) / max(parts, 1),
                exact_step_rate=sum(1 for r in run if r not in wrong) / max(len(run), 1),
                median_seconds=float(np.median(secs)) if secs else None,
                fallback_rate=sum(1 for r in run if r["fallback"]) / max(len(run), 1),
                review_rate=sum(1 for r in run if r["review"]) / max(len(run), 1),
                unflagged_wrong=sum(1 for r in wrong if not r["review"]))


def _need(truth: list) -> dict:
    need: dict = {}
    for p, c, _m in truth:
        need[(p, c)] = need.get((p, c), 0) + 1
    return need


def _row(step, placed, truth, rep) -> dict:
    return dict(step=step, exact=grade(placed, truth), placed=len(placed), needed=len(truth),
                seconds=rep["seconds"], review=rep["review"], fallback=rep["fallback"], pass2=rep["pass2"],
                new_iou=rep.get("new_iou"), unplaced=rep["unplaced"],
                poses=[[p, c, np.round(m[:3, 3], 1).tolist()] for p, c, m in placed])


def synthetic(model, lib, collider, n: int) -> list[dict]:
    import cv2
    from .placedata import OUT as DATA
    rows = []
    for js in sorted((DATA / "shard-000").glob("*.json"))[:n]:
        meta = json.loads(js.read_text())
        stem = str(js)[: -len(".json")]
        pic = cv2.cvtColor(cv2.imread(stem + ".picture.jpg"), cv2.COLOR_BGR2RGB)
        parts = [(p, c, np.array(m, float)) for p, c, m, _new in meta["parts"]]
        base = [q for q, (_p, _c, _m, nw) in zip(parts, meta["parts"]) if not nw]
        truth = [q for q, (_p, _c, _m, nw) in zip(parts, meta["parts"]) if nw]
        cam = BookletCamera(**meta["cam"])
        centre = np.array(meta["centre"])
        base_ren = R.render(base, set(), cam, centre, meta["W"], meta["H"], R.Style(), ss=2, red=False)
        placed, rep = place_fast(model, lib, pic, base, _need(truth), cam, centre, collider, base_ren=base_ren)
        rows.append(_row(js.stem, placed, truth, rep))
        print(json.dumps(rows[-1]), flush=True)
    return rows


class TruthLabels:
    """Diagnostic stand-in for the network: the answer key's labels at the solved camera. An upper bound for the
    geometry (voting + pick); never a result."""

    def __init__(self, base: list, truth: list, cam, centre, W: int, H: int):
        from . import labels
        model = list(base) + list(truth)
        lab = labels.local_labels(R.gbuffer(*R.scene(model), cam, centre, W, H), model,
                                  set(range(len(base), len(model))))
        h = lambda a: a[::2, ::2]
        self.out = dict(new=h(lab["new"]).astype(np.float32), local=np.nan_to_num(h(lab["local"])),
                        size=np.nan_to_num(h(lab["size"])), conf=np.ones(h(lab["new"]).shape, np.float32))

    def __call__(self, picture, base_img, evidence):
        return self.out


def book(model, lib, collider, steps, chained: bool) -> list[dict]:
    from .evaluate import Net, initial_camera, load_step, solve_camera
    net = Net(ROOT / ".cache/coordnet/ckpt/best.pt", "mps" if torch.backends.mps.is_available() else "cpu")
    rows, ours = [], None
    for n in steps:
        d, parts, new, pic = load_step(n)
        if n in EXPLODED_21065 or d.get("exploded"):
            rows.append(dict(step=n, skipped="exploded"))
            continue
        base = [p for p, nw in zip(parts, new) if not nw]
        truth = [p for p, nw in zip(parts, new) if nw]
        if chained and ours is not None:
            base = ours
        W, H = d["width"], d["height"]
        cam0, centre = initial_camera(d, base, pic)
        t0 = time.perf_counter()
        cam, _fits = solve_camera(net, pic, base, cam0, centre, W, H)
        cam_s = time.perf_counter() - t0
        base_ren = R.render(base, set(), cam, centre, W, H, R.Style(), ss=2, red=False)
        net_n = TruthLabels(base, truth, cam, centre, W, H) if model == "truth" else model
        placed, rep = place_fast(net_n, lib, pic, base, _need(truth), cam, centre, collider, base_ren=base_ren)
        row = _row(n, placed, truth, rep)
        row["camera_seconds"] = cam_s
        rows.append(row)
        ours = base + placed
        print(json.dumps(row), flush=True)
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", choices=["synthetic", "21065", "chained"], required=True)
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--steps", default="1-8")
    ap.add_argument("--ckpt", type=Path, default=CKPT)
    ap.add_argument("--no-oracle", action="store_true")
    ap.add_argument("--truth-labels", action="store_true", help="diagnostic upper bound: answer-key labels")
    a = ap.parse_args(argv)
    from assembly_model.ldraw import load_library
    lib = load_library(str(ROOT / "public/ldraw"))
    collider = None
    if not a.no_oracle:
        from booklet_mpd.solver.collide import Collider
        collider = Collider(lib)
    model = "truth" if a.truth_labels else PlaceModel(a.ckpt)
    try:
        if a.suite == "synthetic":
            rows = synthetic(model, lib, collider, a.n)
        else:
            lo, hi = (int(x) for x in a.steps.split("-"))
            rows = book(model, lib, collider, range(lo, hi + 1), chained=a.suite == "chained")
    finally:
        if collider is not None:
            collider.close()
    s = summary(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    name = a.suite + ("-truth-labels" if a.truth_labels else "")
    (OUT / f"{name}.json").write_text(json.dumps(dict(summary=s, rows=rows), indent=1))
    print(json.dumps(s))


if __name__ == "__main__":
    main()
