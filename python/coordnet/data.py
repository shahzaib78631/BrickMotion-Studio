"""Dataset for CoordNet: booklet *picture* / estimate *render* pairs with dense flow.

Each shard directory written by :mod:`coordnet.datagen` contains, per sample ``NNNNN``:

  NNNNN.picture.png   booklet-style picture
  NNNNN.render.png    render of the estimate
  NNNNN.flow.npz      flow int16 [2,H,W] in 1/8 px, valid/new/cand uint8 [H,W]

A sample is cropped with a common window on both images and every label, so the flow
values do not change (flow maps picture pixel ``p`` to render pixel ``p + flow``).
Train-time photometric augmentation is applied independently to the two images;
the only geometric augmentation is a joint horizontal flip, which negates flow x.
"""
from __future__ import annotations

import random
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset


def default_roots(cache: str = ".cache/coordnet") -> tuple[list[Path], list[Path]]:
    """(train_dirs, val_dirs) under the repo root; ``shard-000`` is validation."""
    root = Path(__file__).resolve().parents[2]
    base = Path(cache)
    if not base.is_absolute():
        base = root / base
    dirs = sorted(p for p in base.glob("shard-*") if p.is_dir())
    train = [p for p in dirs if p.name != "shard-000"]
    val = [p for p in dirs if p.name == "shard-000"]
    return train, val


def augment_image(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Photometric jitter on a float32 HWC image in [0,1] (in place-ish, returns a new array)."""
    alpha = 1.0 + rng.uniform(-0.15, 0.15)          # contrast
    beta = rng.uniform(-0.15, 0.15)                 # brightness
    out = img * alpha + beta
    gain = rng.uniform(0.92, 1.08, size=3).astype(np.float32)
    out = out * gain[None, None, :]
    sigma = rng.uniform(0.0, 0.02)
    if sigma > 0:
        out = out + rng.normal(0.0, sigma, size=out.shape).astype(np.float32)
    if rng.random() < 0.3:
        s = float(rng.uniform(0.5, 1.0))
        k = int(max(1, round(s * 3))) * 2 + 1
        out = cv2.GaussianBlur(out, (k, k), s)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def _crop_img(a: np.ndarray, top: int, left: int, ch: int, cw: int, H: int, W: int,
              fill=0) -> np.ndarray:
    """Crop an HWC image, padding bottom/right with ``fill``."""
    out = np.full((ch, cw) + a.shape[2:], fill, dtype=a.dtype)
    y1 = min(top + ch, H)
    x1 = min(left + cw, W)
    if y1 > top and x1 > left:
        out[: y1 - top, : x1 - left] = a[top:y1, left:x1]
    return out


def _crop(a: np.ndarray, top: int, left: int, ch: int, cw: int, H: int, W: int, fill=0) -> np.ndarray:
    """Crop the last two (spatial) dimensions, padding bottom/right with ``fill``."""
    out = np.full(a.shape[:-2] + (ch, cw), fill, dtype=a.dtype)
    y1 = min(top + ch, H)
    x1 = min(left + cw, W)
    if y1 > top and x1 > left:
        out[..., : y1 - top, : x1 - left] = a[..., top:y1, left:x1]
    return out


class PairDataset(Dataset):
    def __init__(self, roots: list[str | Path], crop: tuple[int, int] = (288, 384),
                 train: bool = True, seed: int = 0):
        self.roots = [Path(r) for r in roots]
        self.crop = (int(crop[0]), int(crop[1]))
        self.train = bool(train)
        self.seed = int(seed)
        self.index: list[Path] = []
        for root in self.roots:
            if root.is_dir():
                self.index.extend(sorted(root.glob("*.json")))

    def __len__(self) -> int:
        return len(self.index)

    # ------------------------------------------------------------------ loading

    def _window(self, valid: np.ndarray, rng: np.random.Generator) -> tuple[int, int]:
        ch, cw = self.crop
        H, W = valid.shape
        ys, xs = np.nonzero(valid > 0)
        if self.train:
            if len(ys):
                k = int(rng.integers(len(ys)))
                cy, cx = float(ys[k]) + 0.5, float(xs[k]) + 0.5
            else:
                cy, cx = H / 2.0, W / 2.0
        else:
            if len(ys):
                cy, cx = float(ys.mean()) + 0.5, float(xs.mean()) + 0.5
            else:
                cy, cx = H / 2.0, W / 2.0
        top = 0 if H <= ch else int(round(cy - ch / 2.0))
        left = 0 if W <= cw else int(round(cx - cw / 2.0))
        top = max(0, min(top, max(0, H - ch)))
        left = max(0, min(left, max(0, W - cw)))
        return top, left

    def _load(self, i: int) -> dict:
        js = self.index[i]
        stem = js.with_suffix("")
        pic_bgr = cv2.imread(str(stem) + ".picture.png", cv2.IMREAD_COLOR)
        ren_bgr = cv2.imread(str(stem) + ".render.png", cv2.IMREAD_COLOR)
        if pic_bgr is None or ren_bgr is None:
            raise FileNotFoundError(str(stem))
        with np.load(str(stem) + ".flow.npz") as z:
            flow = z["flow"].astype(np.float32) / 8.0
            valid = z["valid"].astype(np.float32)
            new = z["new"].astype(np.float32)

        H, W = pic_bgr.shape[:2]
        if ren_bgr.shape[:2] != (H, W) or flow.shape[-2:] != (H, W) or valid.shape != (H, W):
            raise ValueError(f"inconsistent sample {stem}")

        picture = pic_bgr[..., ::-1].astype(np.float32) / 255.0
        render = ren_bgr[..., ::-1].astype(np.float32) / 255.0

        # validation is deterministic; training draws a fresh crop, flip and jitter every time it sees a sample
        rng = np.random.default_rng((self.seed, i) if not self.train else None)
        ch, cw = self.crop
        top, left = self._window(valid, rng)
        picture = _crop_img(picture, top, left, ch, cw, H, W)
        render = _crop_img(render, top, left, ch, cw, H, W)
        flow = _crop(flow, top, left, ch, cw, H, W)
        valid = _crop(valid, top, left, ch, cw, H, W)
        new = _crop(new, top, left, ch, cw, H, W)

        if self.train:
            if rng.random() < 0.5:
                picture = picture[:, ::-1].copy()
                render = render[:, ::-1].copy()
                flow = flow[:, :, ::-1].copy()       # [2,H,W]: mirror the W axis
                flow[0] = -flow[0]
                valid = valid[:, ::-1].copy()
                new = new[:, ::-1].copy()
            picture = augment_image(picture, rng)
            render = augment_image(render, rng)

        return {
            "picture": torch.from_numpy(np.ascontiguousarray(picture.transpose(2, 0, 1))),
            "render": torch.from_numpy(np.ascontiguousarray(render.transpose(2, 0, 1))),
            "flow": torch.from_numpy(np.ascontiguousarray(flow)),
            "valid": torch.from_numpy(np.ascontiguousarray(valid)),
            "new": torch.from_numpy(np.ascontiguousarray(new)),
        }

    def __getitem__(self, i: int) -> dict:
        n = len(self)
        if n == 0:
            raise IndexError("empty PairDataset")
        last: Exception | None = None
        for attempt in range(min(n, 10)):
            j = i if attempt == 0 else int((i + attempt) % n)
            try:
                return self._load(j)
            except Exception as exc:                  # corrupt / half-written sample
                last = exc
        raise RuntimeError(f"could not load a sample: {last}")
