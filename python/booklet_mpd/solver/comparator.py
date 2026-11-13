"""Learned comparator: does this candidate pose look like the picture?

The hand-made gain (colour agreement, dark edge lines) leaves close calls: a white plate one stud further
back, a symmetric part turned 180 degrees, black on black. A small network sees the picture around a
candidate next to a render of the model with that candidate in it, and scores the pair; among one part's
candidates the true pose should score highest. Trained on the train booklets (scripts/train_comparator.py),
used to break near-ties in placement (place.COMPARATOR_WEIGHT).

Inputs, all from the picture and renders (no answer key): 7 channels at PATCH x PATCH, a square window
around the candidate's drawn silhouette (2x its size, at least MIN_WINDOW pixels):
  0-2  picture RGB
  3-5  the model with the candidate drawn as a booklet draws it (flat colour, dark outlines)
  6    the candidate's visible pixels
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

PATCH = 64
MIN_WINDOW = 24
CHANNELS = 7
MODEL_PATH = Path(__file__).resolve().parents[3] / ".cache/booklet-mpd/comparator.pt"


def _window(mask: np.ndarray, shape) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    cy, cx = (ys.min() + ys.max()) / 2.0, (xs.min() + xs.max()) / 2.0
    half = max(MIN_WINDOW, 2 * max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1)) / 2.0
    return int(round(cy - half)), int(round(cx - half)), int(round(2 * half)), int(round(2 * half))


def _crop(img: np.ndarray, win, fill) -> np.ndarray:
    r0, c0, h, w = win
    out = np.empty((h, w) + img.shape[2:], img.dtype)
    out[...] = fill
    H, W = img.shape[:2]
    a0, b0, a1, b1 = max(r0, 0), max(c0, 0), min(r0 + h, H), min(c0 + w, W)
    if a1 > a0 and b1 > b0:
        out[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = img[a0:a1, b0:b1]
    interp = cv2.INTER_AREA if h > PATCH else cv2.INTER_NEAREST if img.dtype == bool else cv2.INTER_LINEAR
    return cv2.resize(out.astype(np.uint8) if out.dtype == bool else out, (PATCH, PATCH), interpolation=interp)


def drawing(lib, parts: list, view, shape) -> tuple[np.ndarray, np.ndarray]:
    """(RGB image of the parts drawn flat with dark outlines, label map)."""
    from .picture import colour_rgb
    from .render import render
    _depth, label = render(lib, parts, view, shape)
    palette = np.array([colour_rgb(c) for _p, c, _m in parts] + [(255, 255, 255)], np.uint8)
    img = palette[label].copy()
    edge = cv2.morphologyEx(label.astype(np.int32).astype(np.float32), cv2.MORPH_GRADIENT, np.ones((2, 2), np.uint8)) > 0
    img[edge] = (30, 30, 30)
    return img, label


def patch(lib, picture_rgb: np.ndarray, background, view, model: list, part: str, colour: int,
          matrix: np.ndarray) -> np.ndarray | None:
    """(CHANNELS, PATCH, PATCH) uint8 for one candidate drawn at `matrix` on `model`, or None when it
    falls outside the picture."""
    parts = list(model) + [(part, colour, np.asarray(matrix, float))]
    img, label = drawing(lib, parts, view, picture_rgb.shape[:2])
    own = label == len(model)
    from .render import render
    _d, alone = render(lib, [parts[-1]], view, picture_rgb.shape[:2])
    win = _window(alone >= 0, picture_rgb.shape[:2])
    if win is None:
        return None
    bg = np.asarray(background, float).astype(np.uint8)
    pic = _crop(picture_rgb, win, bg)
    rend = _crop(img, win, (255, 255, 255))
    vis = _crop(own, win, 0)
    return np.concatenate([pic, rend, (vis[..., None] > 0).astype(np.uint8) * 255], -1).transpose(2, 0, 1)


def net():
    import torch.nn as nn

    def block(a, b):
        return nn.Sequential(nn.Conv2d(a, b, 3, padding=1), nn.BatchNorm2d(b), nn.ReLU(),
                             nn.Conv2d(b, b, 3, padding=1), nn.BatchNorm2d(b), nn.ReLU(), nn.MaxPool2d(2))
    return nn.Sequential(block(CHANNELS, 32), block(32, 64), block(64, 96), block(96, 128),
                         nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, 1))


class Comparator:
    """Loaded network; `logits(patches)` -> one score per patch (higher: looks more like the picture)."""

    def __init__(self, path: Path = MODEL_PATH):
        import torch
        self.torch = torch
        self.model = net()
        self.model.load_state_dict(torch.load(path, map_location="cpu"))
        self.model.eval()

    def logits(self, patches: list[np.ndarray]) -> np.ndarray:
        if not patches:
            return np.zeros(0)
        x = self.torch.from_numpy(np.stack(patches).astype(np.float32) / 255.0)
        with self.torch.no_grad():
            return self.model(x).squeeze(-1).numpy().astype(float)


_LOADED: dict = {}


def weight() -> float:
    """Comparator weight against the gain (train_comparator.py writes it; BOOKLET_SOLVER_COMPARATOR_WEIGHT overrides)."""
    if "BOOKLET_SOLVER_COMPARATOR_WEIGHT" in os.environ:
        return float(os.environ["BOOKLET_SOLVER_COMPARATOR_WEIGHT"])
    f = MODEL_PATH.parent / "comparator-weight.txt"
    return float(f.read_text()) if f.exists() else 0.0


def loaded() -> Comparator | None:
    """The trained comparator, or None when it is switched off or not trained yet."""
    if os.environ.get("BOOKLET_SOLVER_COMPARATOR", "1") == "0" or not MODEL_PATH.exists():
        return None
    if "c" not in _LOADED:
        _LOADED["c"] = Comparator()
    return _LOADED["c"]
