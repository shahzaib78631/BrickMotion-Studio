"""Render-and-match refinement (Phase 6 groundwork).

With one photo and no MPD, pick the discrete construction choices that best match
the photo. This is optimisation against a coarse render, not learned generation:
each candidate model is rasterised from the front (projecting piece boxes to the
photo's plane with their colours) and scored by silhouette overlap and colour
agreement against the image. The best candidate is emitted.

Deliberately coarse and offline — a real renderer can replace ``render_front``
without changing the search.
"""
from __future__ import annotations

import random

import numpy as np

from brickheadz.builder import Build
from brickheadz.image_spec import foreground_mask, ldconfig_rgb, load_pixels
from brickheadz.inventory import Inventory
from brickheadz.recombine import _aabb_of

SIZE = 40  # normalised comparison grid (cells per side)


def render_front(lib, build: Build, rgb: dict[int, tuple[int, int, int]], cell: float = 4.0):
    """Coarse front-view raster: project each piece's box (x, y), back-to-front."""
    boxes = []
    for p in build.model.pieces:
        bb = _aabb_of(lib, p.part, p.matrix)
        if bb is not None:
            boxes.append((bb, p.color, float(p.matrix[2, 3])))
    if not boxes:
        return None, None
    xlo = min(b[0][0] for b, _, _ in boxes)
    xhi = max(b[1][0] for b, _, _ in boxes)
    ylo = min(b[0][1] for b, _, _ in boxes)
    yhi = max(b[1][1] for b, _, _ in boxes)
    w = max(1, int(round((xhi - xlo) / cell)) + 1)
    h = max(1, int(round((yhi - ylo) / cell)) + 1)
    img = np.full((h, w, 3), 0.0)
    mask = np.zeros((h, w), dtype=bool)
    for bb, color, _z in sorted(boxes, key=lambda t: -t[2]):  # back (+z) first
        c = rgb.get(color, (128, 128, 128))
        x0 = max(0, int((bb[0][0] - xlo) / cell))
        x1 = min(w, int((bb[1][0] - xlo) / cell) + 1)
        y0 = max(0, int((bb[0][1] - ylo) / cell))
        y1 = min(h, int((bb[1][1] - ylo) / cell) + 1)
        img[y0:y1, x0:x1] = c
        mask[y0:y1, x0:x1] = True
    return img, mask


def _resize(img: np.ndarray, mask: np.ndarray, size: int):
    ys, xs = np.where(mask)
    if ys.size == 0:
        return np.zeros((size, size, 3)), np.zeros((size, size), dtype=bool)
    crop = img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    cmask = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape[:2]
    # Nearest-neighbour resample across the WHOLE crop to size×size.
    yi = np.minimum(h - 1, np.arange(size) * h // size)
    xi = np.minimum(w - 1, np.arange(size) * w // size)
    return crop[yi][:, xi], cmask[yi][:, xi]


def _quantise(img: np.ndarray, palette_rgb: np.ndarray) -> np.ndarray:
    """Nearest palette index per pixel (vectorised over a small palette)."""
    flat = img.reshape(-1, 3).astype(float)
    dist = ((flat[:, None, :] - palette_rgb[None, :, :]) ** 2).sum(axis=2)
    return dist.argmin(axis=1).reshape(img.shape[:2])


def _palette_arrays(palette: list[int], rgb: dict[int, tuple[int, int, int]]):
    codes = [c for c in palette if c in rgb]
    return codes, np.array([rgb[c] for c in codes], dtype=float) if codes else np.zeros((0, 3))


def score(target_img, target_mask, model_img, model_mask, palette: list[int], rgb: dict) -> float:
    """Lower is better: silhouette mismatch + colour disagreement."""
    if model_img is None or target_mask.sum() == 0:
        return 10.0
    t_img, t_mask = _resize(target_img, target_mask, SIZE)
    m_img, m_mask = _resize(model_img, model_mask, SIZE)
    inter = t_mask & m_mask
    union = t_mask | m_mask
    iou = float(inter.sum()) / max(1, int(union.sum()))
    if inter.sum() == 0:
        return 2.0
    codes, pal = _palette_arrays(palette, rgb)
    if len(codes) == 0:
        return 1.0 - iou
    a = _quantise(t_img, pal)
    b = _quantise(m_img, pal)
    agree = float((a[inter] == b[inter]).mean())
    return (1.0 - iou) + 0.5 * (1.0 - agree)


def _search_specs(spec):
    """Discrete head/body proportion variants to search (deduplicated)."""
    seen = set()
    for courses in (spec.head_courses, 3, 4):
        for body_h in (spec.body_h, 12, 15):
            key = (courses, body_h)
            if key in seen:
                continue
            seen.add(key)
            yield spec.__class__(**{**spec.to_dict(), "head_courses": courses, "body_h": body_h})


def fit(lib, spec, inv: Inventory, pats: dict | None, image: str, ldconfig: str, catalog=None, rng=None):
    """Search discrete head/body choices and headwear for the best match to the photo."""
    from brickheadz.constrained import build_constrained

    rng = rng or random.Random(0)
    rgb = ldconfig_rgb(ldconfig)
    px = load_pixels(image)
    tmask = foreground_mask(px)
    palette = inv.palette()

    usable = []
    if pats:
        from brickheadz.constrained import usable_patterns

        usable = usable_patterns(pats, inv).get("hair", [])
    variants = list(_search_specs(spec))
    patterns: list = [None] + usable  # None = procedural/no learned headwear
    best = None
    built = 0
    for variant in variants:
        for pattern in patterns:
            try:
                b, report = build_constrained(lib, variant, inv, pats, random.Random(0), catalog, pattern=pattern)
            except Exception:
                continue
            built += 1
            img, mask = render_front(lib, b, rgb)
            cost = score(px, tmask, img, mask, palette, rgb)
            if best is None or cost < best[0]:
                best = (cost, pattern, b, report)
    return best, {"candidates": built, "specVariants": len(variants), "patterns": len(patterns), "palette": palette}
