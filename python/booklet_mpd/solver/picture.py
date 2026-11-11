"""Step picture evidence: foreground, arrows, and per-pixel colour classes.

Booklet renders shade each face (top lighter, sides darker) and outline parts in black, so a
pixel is compared with a palette colour up to a brightness factor (clamped), and dark outline
pixels are left unclassified unless the palette itself holds a dark colour that explains them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from ..stepimage import _background, _foreground

LDCONFIG = Path(__file__).resolve().parents[3] / "public/ldraw/LDConfig.ldr"
_COLOUR = re.compile(r"!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})")
UNKNOWN = -2
INK = 45
WORKING_PX_PER_LDU = 1.1
BACKGROUND = -1


@lru_cache(maxsize=1)
def ldraw_colours() -> dict[int, tuple[int, int, int]]:
    out = {}
    for line in LDCONFIG.read_text(errors="ignore").splitlines():
        m = _COLOUR.search(line)
        if m:
            h = m.group(3)
            out[int(m.group(2))] = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return out


def colour_rgb(code: int) -> tuple[int, int, int]:
    return ldraw_colours().get(code, (128, 128, 128))


def arrow_mask(rgb: np.ndarray) -> np.ndarray:
    """Thin red strokes (assembly arrows), same rule as stepimage: red minus its opening."""
    h, w = rgb.shape[:2]
    p = rgb.astype(float)
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    red = ((r > 150) & (g < 90) & (b < 110) & (r - g > 90)).astype(np.uint8)
    size = max(5, int(0.035 * min(h, w)) | 1)
    blobs = cv2.morphologyEx(red, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    return cv2.dilate(red & ~blobs, np.ones((3, 3), np.uint8)).astype(bool)


def colour_distance(rgb: np.ndarray, colours: np.ndarray, lo: float = 0.8, hi: float = 1.15) -> np.ndarray:
    """(H, W, K) distance of each pixel to each colour up to a clamped brightness factor."""
    p = rgb.reshape(-1, 1, 3).astype(float)
    c = np.asarray(colours, float).reshape(1, -1, 3)
    alpha = np.clip((p * c).sum(-1) / np.maximum((c * c).sum(-1), 1.0), lo, hi)
    d = np.linalg.norm(p - alpha[..., None] * c, axis=-1)
    return d.reshape(rgb.shape[:2] + (len(colours),))


@dataclass
class Picture:
    rgb: np.ndarray
    pts_per_px: float | None
    background: np.ndarray        # rgb
    foreground: np.ndarray        # bool
    arrows: np.ndarray            # bool

    factor: float = 1.0           # working pixels per source pixel

    @classmethod
    def from_rgb(cls, rgb: np.ndarray, pts_per_px: float | None = None, px_per_ldu: float | None = None,
                 target: float = WORKING_PX_PER_LDU) -> "Picture":
        """Resample so one LDU is about `target` pixels when the expected scale is known (speed;
        a stud stays ~13 px wide). Masks are computed at source resolution, then resampled."""
        factor = 1.0
        if px_per_ldu and px_per_ldu > target * 1.15:
            factor = target / px_per_ldu
        fg, arrows = _foreground(rgb), arrow_mask(rgb)
        if factor != 1.0:
            size = (max(1, round(rgb.shape[1] * factor)), max(1, round(rgb.shape[0] * factor)))
            rgb = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA)
            fg = cv2.resize(fg.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST).astype(bool)
            arrows = cv2.resize(arrows.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST).astype(bool)
            pts_per_px = pts_per_px / factor if pts_per_px else pts_per_px
        return cls(rgb, pts_per_px, _background(rgb), fg, arrows, factor)

    def classes(self, codes: list[int], tol: float = 70.0) -> np.ndarray:
        """Per pixel: index into `codes`, BACKGROUND, or UNKNOWN (outline, arrow, unexplained)."""
        colours = np.array([colour_rgb(c) for c in codes] + [tuple(self.background)], float)
        d = colour_distance(self.rgb, colours)
        # the background is flat: do not let the brightness factor explain shaded parts with it
        d[..., -1] = np.linalg.norm(self.rgb.astype(float) - self.background, axis=-1) * 1.5
        best = d.argmin(-1)
        out = np.where(best == len(codes), BACKGROUND, best)
        out[d.min(-1) > tol] = UNKNOWN
        out[self.arrows] = UNKNOWN
        out[self.rgb.max(-1) < INK] = UNKNOWN       # outlines and stud shading are near-black ink
        out[~self.foreground & (out != BACKGROUND)] = BACKGROUND
        return out
