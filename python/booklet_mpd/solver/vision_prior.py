"""Foundation-model visual perception (frozen DINOv2 ViT-S/14 on MPS/CPU) + fast Studio NPR rendering.

Provides zero-shot, shading- and print-invariant dense geometric-semantic similarity between LEGO
booklet step pictures and candidate 3D LDraw renders:
  1. `render_npr_rgb`: fast (<20ms) Studio-style directional-shaded + dual-ink-outlined RGB render
     from our C++ Z-buffer rasterizer (`render.py`) + LDraw edges.
  2. `DinoPerceptor`: lazy singleton `dinov2_vits14` (running in ~8ms/image on Apple Silicon MPS)
     computing mask-weighted 16x16 dense spatial patch cosine similarity + CLS similarity at both
     whole-model scale and zoomed local changed-region scale.
  3. Zero training-set leakage: uses strictly pretrained self-supervised DINOv2 weights (no tuning on
     any validation/test LEGO set).
"""
from __future__ import annotations

import os
import warnings
from typing import Sequence

import cv2
import numpy as np

from .picture import colour_rgb
from .render import View, render
from .scorer import _edge_depth_map, _label_edges

DINO_SIZE = 224
DINO_GRID = 16  # 224 / 14
_SINGLETON: "DinoPerceptor | None" = None
_LOAD_FAILED = False


def enabled() -> bool:
    return os.environ.get("BOOKLET_SOLVER_DINO", "1") != "0"


def render_npr_rgb(lib, parts: list, view: View, shape: tuple[int, int],
                   bg: tuple[int, int, int] = (255, 255, 255),
                   depth_label: tuple[np.ndarray, np.ndarray] | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fast (~15ms) Studio-style directional-shaded + dual-ink-outlined NPR render.

    Returns `(rgb uint8 HxWx3, depth float64 HxW, label int64 HxW)`.
    Uses light-grey outlines on very dark/black bricks and dark outlines on light bricks, matching
    official LEGO instruction manuals so DINOv2 sees clean part boundaries even on black-on-black builds.
    """
    H, W = shape
    if depth_label is None:
        depth, label = render(lib, parts, view, shape)
    else:
        depth, label = depth_label
    rgb = np.empty((H, W, 3), dtype=np.float32)
    rgb[:] = bg
    fg = label >= 0
    if not fg.any() or not parts:
        return rgb.astype(np.uint8), depth, label

    palette = np.array([colour_rgb(int(c)) for _p, c, _m in parts], dtype=np.float32)
    col_img = np.zeros((H, W, 3), dtype=np.float32)
    col_img[fg] = palette[label[fg]]

    # Smooth surface normals from depth gradient (suppressing inter-part depth jumps)
    d_fill = np.where(fg, depth, 0.0).astype(np.float32)
    gx = cv2.Sobel(d_fill, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(d_fill, cv2.CV_32F, 0, 1, ksize=3)
    jump = (np.abs(gx) > 8.0) | (np.abs(gy) > 8.0)
    gx[jump] = 0.0
    gy[jump] = 0.0
    nx, ny, nz = -gx * 0.35, -gy * 0.35, np.ones_like(gx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-6
    ndotl = np.clip((nx * (-0.35) + ny * (-0.45) + nz * 0.82) / norm, 0.0, 1.0)
    shade = 0.72 + 0.34 * ndotl
    rgb[fg] = np.clip(col_img * shade[..., None], 0.0, 255.0)[fg]

    ed = _edge_depth_map(lib, parts, view, depth)
    edge = np.isfinite(ed) | _label_edges(label)
    luma = 0.299 * col_img[..., 0] + 0.587 * col_img[..., 1] + 0.114 * col_img[..., 2]
    dark_part = fg & (luma < 55.0)
    rgb[edge & ~dark_part] = (28.0, 28.0, 28.0)
    rgb[edge & dark_part] = (175.0, 175.0, 175.0)
    return rgb.astype(np.uint8), depth, label


def _square_pad_crop(img: np.ndarray, box: tuple[int, int, int, int], bg: tuple[int, int, int],
                     mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray | None]:
    """Aspect-preserving square crop padded with `bg` and resized to `(DINO_SIZE, DINO_SIZE)`."""
    r0, c0, r1, c1 = box
    H, W = img.shape[:2]
    r0, c0 = max(0, int(r0)), max(0, int(c0))
    r1, c1 = min(H, int(r1)), min(W, int(c1))
    if r1 <= r0 or c1 <= c0:
        r0, c0, r1, c1 = 0, 0, H, W
    crop = img[r0:r1, c0:c1]
    ch, cw = crop.shape[:2]
    s = max(ch, cw, 16)
    sq = np.empty((s, s, 3), dtype=np.uint8)
    sq[:] = bg
    y0, x0 = (s - ch) // 2, (s - cw) // 2
    sq[y0:y0 + ch, x0:x0 + cw] = crop
    interp = cv2.INTER_AREA if s > DINO_SIZE else cv2.INTER_LINEAR
    out_img = cv2.resize(sq, (DINO_SIZE, DINO_SIZE), interpolation=interp)

    out_mask = None
    if mask is not None:
        mcrop = mask[r0:r1, c0:c1].astype(np.float32)
        msq = np.zeros((s, s), dtype=np.float32)
        msq[y0:y0 + ch, x0:x0 + cw] = mcrop
        # Downsample directly to the 16x16 DINOv2 patch grid
        out_mask = cv2.resize(msq, (DINO_GRID, DINO_GRID), interpolation=cv2.INTER_AREA).reshape(-1)
    return out_img, out_mask


def _bbox_of(mask: np.ndarray, pad: int = 12) -> tuple[int, int, int, int]:
    H, W = mask.shape[:2]
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return (0, 0, H, W)
    return (
        max(0, int(ys.min()) - pad),
        max(0, int(xs.min()) - pad),
        min(H, int(ys.max()) + 1 + pad),
        min(W, int(xs.max()) + 1 + pad),
    )


class DinoPerceptor:
    """Frozen DINOv2 ViT-S/14 visual similarity scorer on Apple Silicon MPS / CPU."""

    def __init__(self):
        import torch
        self.torch = torch
        self.device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.model = torch.hub.load("facebookresearch/dinov2", "dinov2_vits14", trust_repo=True, verbose=False)
        self.model.eval().to(self.device)
        self.mean = torch.tensor([0.485, 0.456, 0.406], device=self.device).view(1, 3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225], device=self.device).view(1, 3, 1, 1)

    def encode_crops(self, crops_rgb: Sequence[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        """Encode a list of `(224, 224, 3)` uint8 RGB crops -> `(patches (N,256,384), cls (N,384))` L2-normed."""
        torch = self.torch
        import torch.nn.functional as F
        if not crops_rgb:
            return np.zeros((0, DINO_GRID * DINO_GRID, 384), np.float32), np.zeros((0, 384), np.float32)
        arr = np.stack(crops_rgb, axis=0).astype(np.float32) / 255.0
        x = torch.from_numpy(arr).permute(0, 3, 1, 2).to(self.device)
        x = (x - self.mean) / self.std
        with torch.no_grad():
            feats = self.model.forward_features(x)
            pt = F.normalize(feats["x_norm_patchtokens"], dim=-1).cpu().numpy()
            cls = F.normalize(feats["x_norm_clstoken"], dim=-1).cpu().numpy()
        return pt, cls

    def score_renders(self, target_rgb: np.ndarray, target_fg: np.ndarray, bg: tuple[int, int, int],
                      cand_rgbs: Sequence[np.ndarray],
                      focus_mask: np.ndarray | None = None,
                      global_box: tuple[int, int, int, int] | None = None) -> np.ndarray:
        """Return perceptual similarity in `[-1, 1]` for each candidate render against `target_rgb`.

        Combines:
          - Foreground-weighted dense 16x16 DINOv2 patch cosine similarity on the whole-model crop.
          - If `focus_mask` is provided (e.g. union of newly placed parts across candidates), a 2x zoomed
            local crop around the changed/new bricks for sharp discrimination of small local flips/shifts!
        """
        if not cand_rgbs:
            return np.zeros(0, dtype=np.float64)
        gbox = global_box if global_box is not None else _bbox_of(target_fg, pad=12)
        t_crop, g_w = _square_pad_crop(target_rgb, gbox, bg, mask=target_fg)
        crops = [t_crop] + [_square_pad_crop(c, gbox, bg)[0] for c in cand_rgbs]

        has_local = focus_mask is not None and int(np.count_nonzero(focus_mask)) >= 16
        l_w = None
        if has_local:
            # Expand local box to at least 64px and 1.6x focus span so DINOv2 has surrounding context!
            r0, c0, r1, c1 = _bbox_of(focus_mask, pad=0)
            fh, fw = max(r1 - r0, 1), max(c1 - c0, 1)
            pad_h = max(18, int(0.45 * fh))
            pad_w = max(18, int(0.45 * fw))
            lbox = (r0 - pad_h, c0 - pad_w, r1 + pad_h, c1 + pad_w)
            # Only add local scale if it genuinely zooms in vs global box
            gh, gw = max(gbox[2] - gbox[0], 1), max(gbox[3] - gbox[1], 1)
            lh = min(target_rgb.shape[0], lbox[2]) - max(0, lbox[0])
            lw = min(target_rgb.shape[1], lbox[3]) - max(0, lbox[1])
            if max(lh, lw) < 0.85 * max(gh, gw):
                tl_crop, l_w = _square_pad_crop(target_rgb, lbox, bg, mask=focus_mask)
                crops.append(tl_crop)
                crops.extend(_square_pad_crop(c, lbox, bg)[0] for c in cand_rgbs)
            else:
                has_local = False

        pt, cls = self.encode_crops(crops)
        k = len(cand_rgbs)

        # Global weighted patch + CLS similarity
        gw_vec = (g_w + 0.15) if g_w is not None else np.ones(DINO_GRID * DINO_GRID, np.float32)
        gw_vec = gw_vec / max(float(gw_vec.sum()), 1e-6)
        g_patch = ((pt[0:1] * pt[1:1 + k]).sum(axis=-1) * gw_vec[None, :]).sum(axis=-1)
        g_cls = (cls[0:1] * cls[1:1 + k]).sum(axis=-1)
        score = 0.80 * g_patch + 0.20 * g_cls

        if has_local:
            off = 1 + k
            lw_vec = (l_w + 0.25) if l_w is not None else np.ones(DINO_GRID * DINO_GRID, np.float32)
            lw_vec = lw_vec / max(float(lw_vec.sum()), 1e-6)
            l_patch = ((pt[off:off + 1] * pt[off + 1:off + 1 + k]).sum(axis=-1) * lw_vec[None, :]).sum(axis=-1)
            l_cls = (cls[off:off + 1] * cls[off + 1:off + 1 + k]).sum(axis=-1)
            local_sc = 0.82 * l_patch + 0.18 * l_cls
            score = 0.45 * score + 0.55 * local_sc

        return score.astype(np.float64)

    def embed_page(self, rgb: np.ndarray, fg: np.ndarray, bg: tuple[int, int, int]) -> np.ndarray:
        """L2-normalized CLS embedding for a booklet step picture (for booklet-wide step-graph analysis)."""
        crop, _ = _square_pad_crop(rgb, _bbox_of(fg, pad=12), bg)
        _pt, cls = self.encode_crops([crop])
        return cls[0]


def perceptor() -> DinoPerceptor | None:
    """Return cached frozen DINOv2 perceptor, or None if disabled or unavailable."""
    global _SINGLETON, _LOAD_FAILED
    if not enabled() or _LOAD_FAILED:
        return None
    if _SINGLETON is None:
        try:
            _SINGLETON = DinoPerceptor()
        except Exception:
            _LOAD_FAILED = True
            return None
    return _SINGLETON


def score_candidate_layouts(lib, base: list, drawn_candidates: Sequence[list], picture, view: View) -> np.ndarray | None:
    """Score a batch of candidate new-part layouts (`drawn_candidates`) on `base` against `picture` under `view`.

    Returns `(K,)` float64 perceptual similarities in `[-1, 1]` (or None if DINOv2 unavailable).
    """
    perc = perceptor()
    if perc is None or not drawn_candidates:
        return None
    H, W = picture.rgb.shape[:2]
    bg = tuple(int(round(v)) for v in picture.background)
    n_base = len(base)
    renders = []
    focus = np.zeros((H, W), dtype=bool)
    for cand in drawn_candidates:
        full = list(base) + list(cand)
        rgb_r, _d, lab = render_npr_rgb(lib, full, view, (H, W), bg=bg)
        renders.append(rgb_r)
        if cand:
            focus |= (lab >= n_base)
    fg = picture.foreground & ~picture.arrows
    return perc.score_renders(picture.rgb, fg, bg, renders, focus_mask=focus if focus.any() else None)
