"""Gate 1 of placement v2: with answer-key offsets, is every true pose on the centre-vote shortlist?

    python -m coordnet.bench_shortlist --suite synthetic [--n 300]
    python -m coordnet.bench_shortlist --suite 21065                # book 1 steps 2-8, camera solved per step

Parts that stand on other new parts of the step only have legal poses once those are placed (pass 2); here their
candidates come from the other true new parts (each left out in turn, so it does not occupy its own studs) and
they are counted separately ("on_new"). Writes
`.cache/coordnet/bench-shortlist/<suite>.json`.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from . import labels
from . import render as R
from .camera import BookletCamera
from .fastplace import connection_candidates
from .place import same_pose
from .shortlist import half_uv, shortlist

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".cache/coordnet/bench-shortlist"


def _need(truth):
    need: dict = {}
    for p, c, _m in truth:
        need[(p, c)] = need.get((p, c), 0) + 1
    return need


def step_recall(lib, base, truth, cam, centre, W, H, picture, base_depth) -> dict:
    """Answer-key offsets -> shortlist; which true parts are on it."""
    model = list(base) + list(truth)
    g = R.gbuffer(*R.scene(model), cam, centre, W, H)
    idx = list(range(len(base), len(model)))
    new = np.isin(g.part, idx)
    off, _ext = labels.centre_targets(g.part.astype(int), new, model, cam, centre)
    ys, xs = np.nonzero(new[::2, ::2])
    uv = half_uv(xs, ys)
    fy, fx = np.minimum(2 * ys, H - 1), np.minimum(2 * xs, W - 1)
    need = _need(truth)
    colours = {k: np.array(R.colour_table().get(k[1], (128, 128, 128)), float) for k in need}
    t0 = time.perf_counter()
    poses = connection_candidates(lib, need, list(base))
    # stand-in for pass 2: poses on the other true new parts (leave each part out, or it occupies its own studs)
    for i in range(len(truth)):
        more = connection_candidates(lib, need, list(truth[:i]) + list(truth[i + 1:]))
        poses = {k: list(v) + list(more.get(k, [])) for k, v in poses.items()}
    cands, info = shortlist(uv, off[::2, ::2][ys, xs], np.ones(len(xs)), picture[fy, fx].astype(float), cam, centre,
                            poses, colours, need, depth=base_depth[fy, fx])
    secs = time.perf_counter() - t0
    base_only = connection_candidates(lib, need, list(base))
    rows = []
    for i, (p, c, m) in zip(idx, truth):
        legal = any(same_pose(p, m, q) for q in poses[(p, c)])
        on_new = not any(same_pose(p, m, q) for q in base_only[(p, c)])
        rows.append(dict(part=p, colour=c, visible=int((g.part == i).sum()), legal=legal, on_new=on_new,
                         listed=any(same_pose(p, m, q) for q, _s in cands[(p, c)])))
    return dict(parts=rows, seconds=secs, kept=sum(len(v) for v in cands.values()),
                legal=sum(len(v) for v in poses.values()), info={f"{k[0]}|{k[1]}": v for k, v in info.items()})


def summary(steps: list[dict]) -> dict:
    parts = [r for s in steps for r in s["parts"] if r["legal"] and r["visible"] > 0]
    miss = [r for r in parts if not r["listed"]]
    return dict(steps=len(steps), parts=len(parts), recall=1 - len(miss) / max(len(parts), 1),
                recall_base=float(np.mean([r["listed"] for r in parts if not r["on_new"]] or [1.0])),
                recall_on_new=float(np.mean([r["listed"] for r in parts if r["on_new"]] or [1.0])),
                not_legal=sum(1 for s in steps for r in s["parts"] if not r["legal"]),
                hidden=sum(1 for s in steps for r in s["parts"] if r["visible"] == 0),
                missed=[(r["part"], r["visible"]) for r in miss][:20],
                median_kept_share=float(np.median([s["kept"] / max(s["legal"], 1) for s in steps])),
                median_seconds=float(np.median([s["seconds"] for s in steps])))


def synthetic(lib, n: int) -> list[dict]:
    import cv2
    from .placedata import OUT as DATA
    out = []
    for js in sorted((DATA / "shard-000").glob("*.json"))[:n]:
        meta = json.loads(js.read_text())
        stem = str(js)[: -len(".json")]
        pic = cv2.cvtColor(cv2.imread(stem + ".picture.jpg"), cv2.COLOR_BGR2RGB)
        parts = [(p, c, np.array(m, float)) for p, c, m, _n in meta["parts"]]
        base = [q for q, e in zip(parts, meta["parts"]) if not e[3]]
        truth = [q for q, e in zip(parts, meta["parts"]) if e[3]]
        cam, centre = BookletCamera(**meta["cam"]), np.array(meta["centre"])
        W, H = meta["W"], meta["H"]
        depth = R.gbuffer(*R.scene(base), cam, centre, W, H).depth
        s = step_recall(lib, base, truth, cam, centre, W, H, pic, depth)
        s["sample"] = js.stem
        out.append(s)
        print(json.dumps(dict(sample=js.stem, parts=s["parts"], kept=s["kept"], legal=s["legal"])), flush=True)
    return out


def book(lib, steps) -> list[dict]:
    import torch
    from .bench_place import EXPLODED_21065
    from .evaluate import Net, initial_camera, load_step, solve_camera
    net = Net(ROOT / ".cache/coordnet/ckpt/best.pt", "mps" if torch.backends.mps.is_available() else "cpu")
    out = []
    for n in steps:
        d, parts, new, pic = load_step(n)
        if n in EXPLODED_21065 or d.get("exploded"):
            continue
        base = [p for p, nw in zip(parts, new) if not nw]
        truth = [p for p, nw in zip(parts, new) if nw]
        W, H = d["width"], d["height"]
        cam0, centre = initial_camera(d, base, pic)
        cam, _fits = solve_camera(net, pic, base, cam0, centre, W, H)
        depth = R.gbuffer(*R.scene(base), cam, centre, W, H).depth
        s = step_recall(lib, base, truth, cam, centre, W, H, pic, depth)
        s["step"] = n
        out.append(s)
        print(json.dumps(dict(step=n, parts=s["parts"], kept=s["kept"], legal=s["legal"], info=s["info"])), flush=True)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", choices=["synthetic", "21065"], required=True)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--steps", default="2-8")
    a = ap.parse_args(argv)
    from assembly_model.ldraw import load_library
    lib = load_library(str(ROOT / "public/ldraw"))
    if a.suite == "synthetic":
        steps = synthetic(lib, a.n)
    else:
        lo, hi = (int(x) for x in a.steps.split("-"))
        steps = book(lib, range(lo, hi + 1))
    s = summary(steps)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{a.suite}.json").write_text(json.dumps(dict(summary=s, steps=steps), indent=1))
    print(json.dumps(s))


if __name__ == "__main__":
    main()
