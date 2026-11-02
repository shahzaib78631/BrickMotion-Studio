"""Image -> character spec (Phase 6 groundwork).

From a single front photo plus a parts inventory, derive a BrickHeadz spec:
the dominant colours per vertical region (hair / face / body / legs / base),
mapped to the nearest LDraw colour that is actually in the inventory, plus a
proportion guess. Richer features that need vision (hair style, face expression,
props) are carried through a ``hints`` dict.

No ML and no new dependency: the image is decoded with PyMuPDF (already used by
the instructions pipeline) and analysed with NumPy.
"""
from __future__ import annotations

import json
import re
from dataclasses import replace

import numpy as np

from brickheadz.inventory import Inventory
from brickheadz.spec import Spec

_COLOUR = re.compile(r"0\s+!COLOUR\s+(.+?)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9a-fA-F]{6})")


def ldconfig_rgb(path: str) -> dict[int, tuple[int, int, int]]:
    out: dict[int, tuple[int, int, int]] = {}
    try:
        text = open(path, errors="ignore").read()
    except OSError:
        return out
    for line in text.splitlines():
        m = _COLOUR.match(line.strip())
        if m:
            hexv = m.group(3)
            out[int(m.group(2))] = (int(hexv[0:2], 16), int(hexv[2:4], 16), int(hexv[4:6], 16))
    return out


def load_pixels(path: str) -> np.ndarray:
    import pymupdf

    pix = pymupdf.Pixmap(path)
    if pix.n == 1:  # grayscale
        rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 1)
        return np.repeat(rgb, 3, axis=2)
    if pix.n == 4:  # RGBA
        rgba = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 4)
        return rgba[:, :, :3].copy()
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3].copy()


def foreground_mask(px: np.ndarray, threshold: float = 42.0) -> np.ndarray:
    """Mask the subject: pixels unlike the border/background colour."""
    border = np.concatenate([px[0], px[-1], px[:, 0], px[:, -1]])
    bg = np.median(border, axis=0)
    return np.linalg.norm(px.astype(float) - bg, axis=2) > threshold


def _median_colour(px: np.ndarray, mask: np.ndarray) -> tuple[int, int, int] | None:
    pixels = px[mask]
    if pixels.size == 0:
        return None
    return tuple(int(v) for v in np.median(pixels, axis=0))


def region_colours(px: np.ndarray, mask: np.ndarray, bands: int = 6) -> list[tuple[int, int, int] | None]:
    ys, xs = np.where(mask)
    if ys.size == 0:
        return [None] * bands
    y0, y1 = ys.min(), ys.max() + 1
    x0, x1 = xs.min(), xs.max() + 1
    out = []
    for b in range(bands):
        lo = y0 + (y1 - y0) * b // bands
        hi = y0 + (y1 - y0) * (b + 1) // bands
        band = np.zeros_like(mask)
        band[lo:hi, x0:x1] = mask[lo:hi, x0:x1]
        out.append(_median_colour(px, band))
    return out


def _nearest(rgb: tuple[int, int, int] | None, palette: list[int], table: dict[int, tuple[int, int, int]], fallback: int) -> int:
    if rgb is None:
        return fallback
    candidates = [c for c in palette if c in table]
    if not candidates:
        return fallback
    target = np.array(rgb, dtype=float)
    return min(candidates, key=lambda c: float(np.linalg.norm(np.array(table[c], dtype=float) - target)))


def spec_from_image(image: str, inventory: Inventory, ldconfig: str, hints: dict | None = None) -> Spec:
    px = load_pixels(image)
    mask = foreground_mask(px)
    palette = inventory.palette()
    table = ldconfig_rgb(ldconfig)
    bands = region_colours(px, mask, 6)
    # bands top→bottom: hair, head×2, body×2, legs
    hair = _nearest(bands[0], palette, table, 0)
    head = _nearest(bands[1] or bands[2], palette, table, 14)
    body = _nearest(bands[3] or bands[4], palette, table, 4)
    leg = _nearest(bands[5] or bands[4], palette, table, body)
    base = _nearest(bands[5], palette, table, 0)

    ys, xs = np.where(mask)
    aspect = float((ys.max() - ys.min() + 1) / max(1, xs.max() - xs.min() + 1)) if ys.size else 2.0
    spec = Spec(
        name="FromImage",
        color_hair=hair,
        color_head=head,
        color_body=body,
        color_leg=leg,
        color_base=base,
        color_accent=head,
        head_courses=3 if aspect < 3.0 else 4,
    )
    if hints:
        fields = set(Spec.__dataclass_fields__)  # type: ignore[attr-defined]
        spec = replace(spec, **{k: v for k, v in hints.items() if k in fields})
    return spec


def write_spec(spec: Spec, path: str) -> dict:
    data = spec.to_dict()
    with open(path, "w") as f:
        json.dump(data, f, indent=1)
    return data
