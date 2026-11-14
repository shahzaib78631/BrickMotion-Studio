"""P5: a learned callout <-> parts-list picture matcher.

A small CNN embeds a picture of one part (a callout crop, a printed parts-list crop or a render) to a unit
vector. Within a booklet, a callout is matched to the parts-list entry with the highest cosine. It is trained
on callout / parts-list pairs (answer-key labels where a set has one, confident reader labels elsewhere) to
pick the true entry among all the booklet's entries, and it is mixed with the hand-made `parts.similarity`.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
import torch
from torch import nn

PATCH = 64
WEIGHTS = Path(__file__).resolve().parents[3] / ".cache/booklet-mpd/partsnet.pt"


def patch(rgb: np.ndarray) -> np.ndarray:
    """The piece cut out (page made white, light or dark), centred on a PATCH x PATCH square, aspect kept."""
    from .parts import DARK_PAGE, INK, _background
    from ..stepimage import fill_holes
    bg = _background(rgb)
    fg = np.linalg.norm(rgb.astype(float) - bg, axis=-1) > 22
    if bg.max() >= DARK_PAGE:
        fg |= rgb.max(-1) < INK
    fg = fill_holes(cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)).astype(bool))
    out = np.full((PATCH, PATCH, 3), 255, np.uint8)
    if not fg.any():
        return out
    ys, xs = np.where(fg)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    piece = np.where(fg[y0:y1, x0:x1, None], rgb[y0:y1, x0:x1], 255).astype(np.uint8)
    h, w = piece.shape[:2]
    k = (PATCH - 4) / max(h, w)
    piece = cv2.resize(piece, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)
    h, w = piece.shape[:2]
    oy, ox = (PATCH - h) // 2, (PATCH - w) // 2
    out[oy:oy + h, ox:ox + w] = piece
    return out


def _block(i: int, o: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(),
                         nn.Conv2d(o, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(), nn.MaxPool2d(2))


class Net(nn.Module):
    def __init__(self, dim: int = 128):
        super().__init__()
        self.body = nn.Sequential(_block(3, 32), _block(32, 64), _block(64, 128), _block(128, 128))
        self.head = nn.Linear(128 * (PATCH // 16) ** 2, dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.head(self.body(x).flatten(1))
        return nn.functional.normalize(z, dim=1)


def to_tensor(patches: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(np.ascontiguousarray(patches)).permute(0, 3, 1, 2).float() / 255.0


@lru_cache(maxsize=1)
def loaded(path: str = str(WEIGHTS)) -> Net | None:
    if not Path(path).exists():
        return None
    net = Net()
    net.load_state_dict(torch.load(path, map_location="cpu"))
    return net.eval()


def embed(net: Net, pictures: list[np.ndarray]) -> np.ndarray:
    with torch.no_grad():
        return net(to_tensor(np.stack([patch(p) for p in pictures]))).numpy()
