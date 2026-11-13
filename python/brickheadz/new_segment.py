"""A deterministic segmentation of an instruction step image.

An instruction step draws the already-built model faded/grey and the *new* parts
of that step in full colour, over a flat pale background. Recovering "which pixels
are the new parts, and of which colour" is therefore a classification with no
learning:

1. **Background** — the image corners are background; a pixel is background when
   its CIELAB distance to the corner median is below a tolerance.
2. **New parts** — a non-background pixel is a new part when its chroma is above a
   threshold (built parts are desaturated) *and* its nearest LDraw palette colour
   is one of the step's new-part colours, within a distance tolerance. The nearest
   palette colour is the classification (an LDraw colour id).
3. **Connected components** of the new-part mask are the part instances ("blobs"),
   each labelled by its majority palette colour.

Everything is expressed with one distance (CIELAB, D65) and three thresholds, so
the result carries a scalar **residual** — the mean palette distance of the new
pixels — that a verifier can re-check.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from brickheadz.instruction_place import BACKGROUND, components

# D65 white point and the sRGB→XYZ matrix (IEC 61966-2-1).
_WHITE = np.array([0.95047, 1.0, 1.08883])
_M = np.array([[0.4124, 0.3576, 0.1805],
               [0.2126, 0.7152, 0.0722],
               [0.0193, 0.1192, 0.9505]])
_EPS = 216 / 24389
_KAPPA = 24389 / 27


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """(…,3) sRGB 0..255 → CIELAB (D65)."""
    c = np.asarray(rgb, float) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _M.T
    t = xyz / _WHITE
    f = np.where(t > _EPS, np.cbrt(t), (_KAPPA * t + 16) / 116)
    lab = np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)
    return lab


def _to_lab(rgb: np.ndarray) -> np.ndarray:
    arr = np.asarray(rgb, float)
    return srgb_to_lab(arr)  # Input contract is sRGB 0..255, including near-black images.


def chroma(lab: np.ndarray) -> np.ndarray:
    return np.sqrt(lab[..., 1] ** 2 + lab[..., 2] ** 2)


@dataclass
class Blob:
    color: int  # LDraw colour id (nearest palette colour of the majority of pixels)
    mask: np.ndarray  # bool HxW
    area: int
    centroid: tuple[float, float]  # (x, y) pixel centroid


@dataclass
class Segmentation:
    new_mask: np.ndarray
    built_mask: np.ndarray
    background: np.ndarray
    labels: np.ndarray  # int palette index per pixel; -1 for background
    blobs: list[Blob] = field(default_factory=list)
    residual: float = 0.0
    new_colours: list[int] = field(default_factory=list)


def nearest_palette(lab: np.ndarray, palette_lab: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Nearest palette row (index, distance) for every pixel, by CIELAB distance."""
    flat = lab.reshape(-1, 3)
    if len(palette_lab) == 0:
        raise ValueError("palette must contain at least one colour")
    # Avoid allocating an image-pixels × palette × RGB tensor for a full PDF
    # page. A 2MP image and the full LDraw palette otherwise need gigabytes.
    idx = np.empty(len(flat),dtype=np.int32)
    distance = np.empty(len(flat),dtype=float)
    chunk = max(1,262144//len(palette_lab))
    for start in range(0,len(flat),chunk):
        batch=flat[start:start+chunk]
        d2=((batch[:,None,:]-palette_lab[None,:,:])**2).sum(-1)
        best=np.argmin(d2,axis=1)
        idx[start:start+len(batch)]=best
        distance[start:start+len(batch)]=np.sqrt(d2[np.arange(len(batch)),best])
    return idx.reshape(lab.shape[:-1]),distance.reshape(lab.shape[:-1])



def segment(
    rgb: np.ndarray,
    palette: dict[int, tuple[int, int, int]],
    new_colours: list[int],
    *,
    prior: np.ndarray | None = None,
    change_tol: float = 26.0,
    bg: tuple[int, int, int] | None = None,
    bg_tol: float = 22.0,
    sat_min: float = 18.0,
    dist_tol: float = 34.0,
    min_area: int = 4,
) -> Segmentation:
    """Classify pixels and return the new-part blobs (largest first).

    ``prior`` is the previous step's image (built pieces only). A pixel that changed
    since then belongs to a new part even when its colour is low-chroma (grey on
    grey), so the change mask is OR-ed into the chroma test — this is what recovers
    grey new parts that a saturation rule alone misses.
    """
    arr = np.asarray(rgb, float)
    if arr.ndim != 3 or arr.shape[2] != 3 or not arr.shape[0] or not arr.shape[1]:
        raise ValueError("rgb must be a nonempty HxWx3 sRGB image")
    if prior is not None and np.asarray(prior).shape != arr.shape:
        raise ValueError("prior must be aligned to the current image and have the same shape")
    lab = _to_lab(arr)
    codes = sorted(palette)
    palette_lab = _to_lab(np.array([palette[c] for c in codes], float))

    if bg is None:
        corners = np.stack([arr[0, 0], arr[0, -1], arr[-1, 0], arr[-1, -1]])
        bg_ref = _to_lab(np.median(corners, 0))
    else:
        bg_ref = _to_lab(np.array(bg, float))
    background = np.linalg.norm(lab - bg_ref, axis=-1) < bg_tol

    idx, dist = nearest_palette(lab, palette_lab)
    want = set(int(c) for c in new_colours)
    is_wanted = np.zeros_like(background)
    for i, c in enumerate(codes):
        if c in want:
            is_wanted |= idx == i

    not_bg = ~background
    colour_ok = not_bg & is_wanted & (dist < dist_tol)
    new_mask = colour_ok & (chroma(lab) > sat_min)
    if prior is not None:
        changed = np.abs(arr - np.asarray(prior, float)).max(-1) > change_tol
        new_mask = new_mask | (colour_ok & changed)
    built_mask = not_bg & ~new_mask

    blobs: list[Blob] = []
    for comp in components(new_mask):
        area = int(comp.sum())
        if area < min_area:
            continue
        ys, xs = np.where(comp)
        # majority palette colour over the blob's pixels
        vals, counts = np.unique(idx[ys, xs], return_counts=True)
        color = int(codes[int(vals[int(np.argmax(counts))])]) if len(vals) else -1
        blobs.append(Blob(color=color, mask=comp, area=area, centroid=(float(xs.mean()), float(ys.mean()))))

    residual = float(dist[new_mask].mean()) if new_mask.any() else 0.0
    labels = np.where(background, -1, np.array(codes, int)[idx])
    return Segmentation(
        new_mask=new_mask,
        built_mask=built_mask,
        background=background,
        labels=labels,
        blobs=blobs,
        residual=residual,
        new_colours=[int(c) for c in new_colours],
    )
