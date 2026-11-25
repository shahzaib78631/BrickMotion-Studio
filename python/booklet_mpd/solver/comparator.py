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


# ------------------------------------------------------------------ V2: NPR Whole-Layout & Sub-Build Reranker

LAYOUT_PATCH = 96
LAYOUT_CHANNELS = 8
LAYOUT_MIN_WINDOW = 36
LAYOUT_MODEL_PATH = Path(__file__).resolve().parents[3] / ".cache/booklet-mpd/layout-comparator.pt"


def npr_drawing(lib, parts: list, view, shape) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Booklet-style NPR render: depth-graded face shading + crisp internal depth/part-boundary seams,
    using light-grey seams on dark/black bricks and dark seams on light bricks (matching LEGO booklets).
    Returns (rgb uint8 HxWx3, label int32 HxW, depth float32 HxW)."""
    from .picture import colour_rgb
    from .render import render

    H, W = shape
    depth, label = render(lib, parts, view, (H, W))
    rgb = np.full((H, W, 3), 255, np.uint8)
    fg = label >= 0
    if not fg.any():
        return rgb, label, depth
    palette = np.array([colour_rgb(c) for _p, c, _m in parts], np.float32)
    base_rgb = palette[np.clip(label, 0, max(0, len(parts) - 1))]
    # Subtle depth shading (front faces brighter, deeper faces darker)
    d_fg = depth[fg]
    d_lo, d_hi = float(d_fg.min()), float(d_fg.max())
    shade = np.ones((H, W), np.float32)
    if d_hi > d_lo + 1e-3:
        shade[fg] = 1.06 - 0.18 * ((depth[fg] - d_lo) / (d_hi - d_lo))
    shaded = np.clip(base_rgb * shade[:, :, None], 0, 255).astype(np.uint8)
    rgb[fg] = shaded[fg]

    # Part-boundary seams + internal depth-discontinuity seams (studs, ridges, steps)
    lab_edge = np.zeros((H, W), bool)
    lab_edge[:, 1:] |= label[:, 1:] != label[:, :-1]
    lab_edge[1:, :] |= label[1:, :] != label[:-1, :]
    d_fill = np.where(fg, depth, d_hi + 30.0).astype(np.float32)
    gx = np.abs(np.diff(d_fill, axis=1, prepend=d_fill[:, :1]))
    gy = np.abs(np.diff(d_fill, axis=0, prepend=d_fill[:1, :]))
    depth_edge = fg & ((gx > 2.0) | (gy > 2.0))
    seam = fg & (lab_edge | depth_edge)
    if seam.any():
        is_dark = (base_rgb.max(axis=-1) < 65.0) & seam
        is_light = seam & ~is_dark
        rgb[is_dark] = (155, 155, 155)
        rgb[is_light] = (26, 26, 26)
    return rgb, label, depth


def _crop_to(img: np.ndarray, win: tuple[int, int, int, int], fill, size: int) -> np.ndarray:
    r0, c0, h, w = win
    out = np.empty((h, w) + img.shape[2:], img.dtype)
    out[...] = fill
    H, W = img.shape[:2]
    a0, b0, a1, b1 = max(r0, 0), max(c0, 0), min(r0 + h, H), min(c0 + w, W)
    if a1 > a0 and b1 > b0:
        out[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = img[a0:a1, b0:b1]
    interp = cv2.INTER_AREA if h > size else cv2.INTER_NEAREST if img.dtype == bool else cv2.INTER_LINEAR
    return cv2.resize(out.astype(np.uint8) if out.dtype == bool else out, (size, size), interpolation=interp)


def _pic_edge_map(rgb: np.ndarray) -> np.ndarray:
    """High-contrast local edge magnitude of the booklet picture (0..255 uint8), capturing both
    dark outlines on light bricks and light seams on black bricks."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    scale = max(float(np.percentile(mag, 98)), 25.0)
    return np.clip(mag * (255.0 / scale), 0, 255).astype(np.uint8)


def layout_patches(lib, picture_rgb: np.ndarray, background, view, base: list,
                   layouts: list[list]) -> list[np.ndarray] | None:
    """Build (LAYOUT_CHANNELS, LAYOUT_PATCH, LAYOUT_PATCH) uint8 patches for K candidate layouts
    on ONE shared crop window covering the union of all candidates' added parts (zero shift bias!).
    Channels: 0-2 picture RGB, 3-5 NPR render RGB, 6 visible mask of added parts, 7 picture edge map."""
    if not layouts:
        return None
    H, W = picture_rgb.shape[:2]
    n_base = len(base)
    rendered = []
    union_mask = np.zeros((H, W), bool)
    for lay in layouts:
        parts = list(base) + [(p, int(c), np.asarray(m, float)) for p, c, m in lay]
        rgb, lab, _d = npr_drawing(lib, parts, view, (H, W))
        added_vis = lab >= n_base
        rendered.append((rgb, added_vis))
        union_mask |= added_vis
        if not added_vis.any():
            # Fallback to unoccluded added parts bounds when fully occluded
            from .render import render as _ren
            _da, la = _ren(lib, [(p, int(c), np.asarray(m, float)) for p, c, m in lay], view, (H, W))
            union_mask |= (la >= 0)
    ys, xs = np.nonzero(union_mask)
    if not len(xs):
        return None
    cy, cx = (ys.min() + ys.max()) / 2.0, (xs.min() + xs.max()) / 2.0
    span = max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1)
    side = max(LAYOUT_MIN_WINDOW, int(round(1.65 * span)))
    win = (int(round(cy - side / 2.0)), int(round(cx - side / 2.0)), side, side)

    bg = np.asarray(background, float).astype(np.uint8)
    pic_crop = _crop_to(picture_rgb, win, bg, LAYOUT_PATCH)
    edge_crop = _crop_to(_pic_edge_map(picture_rgb), win, 0, LAYOUT_PATCH)[..., None]

    out = []
    for rend_rgb, added_vis in rendered:
        r_crop = _crop_to(rend_rgb, win, (255, 255, 255), LAYOUT_PATCH)
        m_crop = (_crop_to(added_vis, win, 0, LAYOUT_PATCH) > 0).astype(np.uint8)[..., None] * 255
        patch_k = np.concatenate([pic_crop, r_crop, m_crop, edge_crop], axis=-1).transpose(2, 0, 1)
        out.append(patch_k)
    return out


def layout_net():
    """Lightweight residual NPR render-and-compare CNN (~420K params) taking (B, 8, 96, 96) -> (B, 1)."""
    import torch
    import torch.nn as nn

    class ResBlock(nn.Module):
        def __init__(self, ci: int, co: int, stride: int = 1):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv2d(ci, co, 3, stride=stride, padding=1, bias=False),
                nn.BatchNorm2d(co),
                nn.SiLU(inplace=True),
                nn.Conv2d(co, co, 3, padding=1, bias=False),
                nn.BatchNorm2d(co),
            )
            self.skip = (nn.Sequential(nn.Conv2d(ci, co, 1, stride=stride, bias=False), nn.BatchNorm2d(co))
                         if (stride != 1 or ci != co) else nn.Identity())
            self.act = nn.SiLU(inplace=True)

        def forward(self, x):
            return self.act(self.conv(x) + self.skip(x))

    class NetV2(nn.Module):
        def __init__(self):
            super().__init__()
            self.stem = nn.Sequential(
                nn.Conv2d(LAYOUT_CHANNELS, 32, 3, padding=1, bias=False),
                nn.BatchNorm2d(32),
                nn.SiLU(inplace=True),
            )
            self.stage1 = ResBlock(32, 32, stride=2)     # 48x48
            self.stage2 = ResBlock(32, 64, stride=2)     # 24x24
            self.stage3 = ResBlock(64, 96, stride=2)     # 12x12
            self.stage4 = ResBlock(96, 128, stride=2)    # 6x6
            self.head = nn.Sequential(
                nn.Linear(256, 64),
                nn.SiLU(inplace=True),
                nn.Dropout(0.15),
                nn.Linear(64, 1),
            )

        def forward(self, x):
            f = self.stage4(self.stage3(self.stage2(self.stage1(self.stem(x)))))
            avg_p = f.mean(dim=(2, 3))
            max_p = f.amax(dim=(2, 3))
            return self.head(torch.cat([avg_p, max_p], dim=1))

    return NetV2()


class LayoutComparator:
    """Loaded NPR whole-layout / sub-build comparator (`logits(patches)` -> 1 score per layout)."""

    def __init__(self, path: Path = LAYOUT_MODEL_PATH):
        import torch
        self.torch = torch
        self.model = layout_net()
        self.model.load_state_dict(torch.load(path, map_location="cpu"))
        self.model.eval()

    def logits(self, patches: list[np.ndarray]) -> np.ndarray:
        if not patches:
            return np.zeros(0, dtype=float)
        x = self.torch.from_numpy(np.ascontiguousarray(np.stack(patches)).astype(np.float32) / 255.0)
        with self.torch.no_grad():
            return self.model(x).squeeze(-1).numpy().astype(float)

    def blend(self, base_scores: np.ndarray, logits: np.ndarray, w: float | None = None,
              max_spread: float = 250.0) -> np.ndarray:
        """Conservatively combine `base_scores` (ModelScorer) with centered comparator logits.
        Spread is computed on the top-4 candidates and capped at `max_spread` so the neural reranker
        breaks genuine close visual ties without ever overriding a decisive geometric win."""
        if len(base_scores) < 2 or len(logits) != len(base_scores):
            return base_scores.copy()
        wt = layout_weight() if w is None else float(w)
        if wt <= 0.0:
            return base_scores.copy()
        s = np.asarray(base_scores, dtype=float)
        z = np.asarray(logits, dtype=float)
        z = z - float(z.mean())
        top_n = min(4, len(s))
        top_s = np.sort(s)[-top_n:]
        spread = min(max(float(np.std(top_s)), 15.0), max_spread)
        return s + wt * spread * z


def layout_weight() -> float:
    if "BOOKLET_SOLVER_LAYOUT_COMPARATOR_W" in os.environ:
        return float(os.environ["BOOKLET_SOLVER_LAYOUT_COMPARATOR_W"])
    f = LAYOUT_MODEL_PATH.parent / "layout-comparator-weight.txt"
    return float(f.read_text().strip()) if f.exists() else 0.0


def loaded_layout() -> LayoutComparator | None:
    if os.environ.get("BOOKLET_SOLVER_LAYOUT_COMPARATOR", "1") == "0" or not LAYOUT_MODEL_PATH.exists():
        return None
    if "v2" not in _LOADED:
        _LOADED["v2"] = LayoutComparator()
    return _LOADED["v2"]
