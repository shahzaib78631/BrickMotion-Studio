"""Synthetic placement dataset for the placement network.

Each sample is a booklet-style step picture (true camera, new parts in place with the red outline, random style),
a plain render of the model *without* the new parts (the CoordNet-aligned base render the placer sees at run time,
camera perturbed by at most ~0.5 px / 0.3 degrees), and per-pixel labels for the new parts: `new`, part-local
coordinates (1/4 LDU, int16), the part's box size (LDU) and the part index.

Shard layout (`.cache/coordnet/place-data/shard-NNN/`):
  NNNNN.picture.jpg (JPEG q92: style noise makes PNG ~270 KB)  NNNNN.base.png  NNNNN.labels.npz (new, local[3,H,W], size[3,H,W], inst)  NNNNN.json

    python -m coordnet.placedata --shards 10 --per-shard 1000 --workers 6
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

from .camera import BookletCamera
from . import datagen, labels
from . import render as R
from .data import augment_image
from .place import change_evidence

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".cache/coordnet/place-data"


def _jitter(rng: random.Random, cam):
    g = lambda s, lim: max(-lim, min(lim, rng.gauss(0, s)))
    return cam.with_(yaw=cam.yaw + g(0.1, 0.3), pitch=cam.pitch + g(0.1, 0.3), roll=cam.roll + g(0.05, 0.2),
                     cx=cam.cx + g(0.2, 0.5), cy=cam.cy + g(0.2, 0.5))


def sample(seed: int, files: list[Path]) -> dict | None:
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    got = datagen.pick_step(rng, files)
    if got is None:
        return None
    f, step, base, new = got
    parts = base + new
    W = rng.choice([384, 448, 512, 576, 640])
    H = rng.choice([288, 320, 384, 448])
    cam, centre = datagen.sample_camera(rng, parts, W, H)
    newset = set(range(len(base), len(parts)))
    pic = R.render(parts, newset, cam, centre, W, H, R.Style.random(nrng), ss=2, rng=nrng)
    lab = labels.local_labels(pic.gt, parts, newset)
    if lab["new"].sum() < 30:
        return None
    base_img = R.render(base, set(), _jitter(rng, cam), centre, W, H, R.Style(), ss=2, red=False).picture
    types: dict[tuple, int] = {}
    for p, c, _m in new:
        types[(p, c)] = types.get((p, c), 0) + 1
    camd = dict(yaw=cam.yaw, pitch=cam.pitch, roll=cam.roll, scale=cam.scale, cx=cam.cx, cy=cam.cy, eye=cam.eye,
                turned=cam.turned)
    meta = dict(file=str(f.relative_to(datagen.OMR)), step=step, W=W, H=H, cam=camd, centre=np.asarray(centre).tolist(),
                parts=[[p, c, m.tolist(), i >= len(base)] for i, (p, c, m) in enumerate(parts)],
                types=[[p, c, n] for (p, c), n in types.items()])
    return dict(picture=pic.picture, base=base_img, labels=lab, meta=meta)


def write(out: Path, k: int, s: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    stem = str(out / f"{k:05d}")
    cv2.imwrite(stem + ".picture.jpg", cv2.cvtColor(s["picture"], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    cv2.imwrite(stem + ".base.png", cv2.cvtColor(s["base"], cv2.COLOR_RGB2BGR))
    lab = s["labels"]
    new = lab["new"]
    local = np.where(new[..., None], np.nan_to_num(lab["local"]) * 4, 0).round()
    size = np.where(new[..., None], np.nan_to_num(lab["size"]), 0).round()
    np.savez_compressed(stem + ".labels.npz", new=new.astype(np.uint8),
                        local=np.clip(local, -32768, 32767).astype(np.int16).transpose(2, 0, 1),
                        size=size.astype(np.int16).transpose(2, 0, 1), inst=lab["inst"].astype(np.int16))
    Path(stem + ".json").write_text(json.dumps(s["meta"]))


# ------------------------------------------------------------------ dataset


def _read(path: str) -> np.ndarray:
    return cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)


class PlaceDataset(Dataset):
    """Training items; crops keep the new parts in view. No flips (a mirror image is a different part)."""

    def __init__(self, dirs, crop=(384, 512), train: bool = True, seed: int = 0):
        self.items = sorted(str(p)[: -len(".json")] for d in dirs for p in Path(d).glob("*.json"))
        self.crop = crop
        self.train = train
        self.seed = seed
        self.epoch = 0

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int) -> dict:
        stem = self.items[i]
        rng = np.random.default_rng((self.seed, self.epoch, i) if self.train else (self.seed, i))
        pic = _read(stem + ".picture.jpg")
        base = _read(stem + ".base.png")
        lab = np.load(stem + ".labels.npz")
        meta = json.loads(Path(stem + ".json").read_text())
        new = lab["new"].astype(bool)
        inst = lab["inst"].astype(np.int64)
        cam = BookletCamera(**meta["cam"])
        centre = np.array(meta["centre"], float)
        parts = [(p, c, np.array(m, float)) for p, c, m, _n in meta["parts"]]
        offset, _extent = labels.centre_targets(inst, new, parts, cam, centre)     # full image, before the crop
        ev = change_evidence(pic, base)
        H, W = new.shape
        ch, cw = self.crop
        ys, xs = np.nonzero(new)
        top = self._start(rng, H, ch, ys)
        left = self._start(rng, W, cw, xs)

        def cut(a, fill=0):
            out = np.full((ch, cw) + a.shape[2:], fill, a.dtype)
            src = a[max(top, 0): top + ch, max(left, 0): left + cw]
            out[max(-top, 0): max(-top, 0) + src.shape[0], max(-left, 0): max(-left, 0) + src.shape[1]] = src
            return out

        p = cut(pic, 140).astype(np.float32) / 255.0
        b = cut(base, 140).astype(np.float32) / 255.0
        if self.train:
            p = augment_image(p, rng)
        t = lambda a: torch.from_numpy(np.ascontiguousarray(a))
        return dict(picture=t(p.transpose(2, 0, 1)), base=t(b.transpose(2, 0, 1)),
                    evidence=t(cut(ev).astype(np.float32)[None]), new=t(cut(new).astype(np.float32)),
                    offset=t(cut(offset).transpose(2, 0, 1)),
                    camera=t(labels.camera_channels(cam, centre)),
                    origin=torch.tensor([top, left]))

    def _start(self, rng, n: int, c: int, idx: np.ndarray) -> int:
        """Crop start along one axis: the new pixels' span stays inside when it fits."""
        if n <= c:
            return -((c - n) // 2) if not self.train else -int(rng.integers(0, c - n + 1))
        lo, hi = (int(idx.min()), int(idx.max())) if len(idx) else (0, n - 1)
        a, b = max(0, hi - c + 1), min(lo, n - c)
        if a > b:
            a = b = min(max(0, (lo + hi) // 2 - c // 2), n - c)
        return int(rng.integers(a, b + 1)) if self.train else (a + b) // 2


# ------------------------------------------------------------------ generation


_FILES: list[Path] = []


def _init(files):
    global _FILES
    _FILES = files
    cv2.setNumThreads(1)


def _work(args):
    out, k, seed = args
    if (out / f"{k:05d}.json").exists():
        return k, "exists"
    try:
        s = sample(seed, _FILES)
    except Exception as e:  # a broken model must not stop a shard; it is reported
        return k, f"error {type(e).__name__}: {e}"
    if s is None:
        return k, "skip"
    write(out, k, s)
    return k, "ok"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--shards", type=int, default=10)
    ap.add_argument("--per-shard", type=int, default=1000)
    ap.add_argument("--first-shard", type=int, default=0)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--budget-gb", type=float, default=2.4)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    a = ap.parse_args(argv)
    files = datagen.model_files()
    jobs = [(a.out / f"shard-{s:03d}", k, a.seed * 1_000_003 + s * 100_000 + k)
            for s in range(a.first_shard, a.first_shard + a.shards) for k in range(a.per_shard)]
    for s in {j[0] for j in jobs}:
        s.mkdir(parents=True, exist_ok=True)
    import multiprocessing as mp
    pool = mp.get_context("spawn").Pool(a.workers, initializer=_init, initargs=(files,))
    t0, done, stats = time.time(), 0, {}
    for k, status in pool.imap(_work, jobs, chunksize=4):
        done += 1
        key = status.split(" ")[0]
        stats[key] = stats.get(key, 0) + 1
        if key == "error":
            print(f"sample {k}: {status}", file=sys.stderr, flush=True)
        if done % 50 == 0 or done == len(jobs):
            size = sum(p.stat().st_size for p in a.out.rglob("*") if p.is_file()) / 1e9
            print(f"::progress {done}/{len(jobs)} {stats} {size:.2f} GB {time.time() - t0:.0f}s", flush=True)
            if size > a.budget_gb:
                print(f"dataset budget {a.budget_gb} GB reached; stopping", flush=True)
                pool.terminate()
                break
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
