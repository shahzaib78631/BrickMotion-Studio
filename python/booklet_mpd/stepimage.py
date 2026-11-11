"""Isolate the main model in a booklet step picture.

Pictures hold the model on a flat background, often beside a pale-yellow sub-step panel
(numbered sub-builds), red arrows and a thin black connector line. The mask keeps the
model and any floating new part, and drops the background, panel contents and arrows.
"""
from __future__ import annotations

import cv2
import numpy as np


def _background(rgb: np.ndarray) -> np.ndarray:
    quantised = (rgb // 8).reshape(-1, 3)
    values, counts = np.unique(quantised, axis=0, return_counts=True)
    return values[counts.argmax()].astype(float) * 8 + 4


def _components(mask: np.ndarray):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    return count, labels, stats


def _foreground(rgb: np.ndarray, tolerance: float = 30.0, min_fraction: float = 0.0015) -> np.ndarray:
    h, w = rgb.shape[:2]
    pixels = rgb.astype(float)
    candidate = np.linalg.norm(pixels - _background(rgb), axis=-1) > tolerance

    r, g, b = pixels[..., 0], pixels[..., 1], pixels[..., 2]
    cream = (r > 225) & (g > 215) & (b > 170) & (b < 236) & (r - b > 15)
    count, _labels, stats = _components(cream)
    for i in range(1, count):
        x, y, bw, bh, area = stats[i]
        if area >= 0.01 * h * w:
            candidate[y:y + bh, x:x + bw] = False
    candidate &= ~cream

    # Arrows are thin red strokes; red parts are large blobs. Remove only what a kernel scaled
    # to the picture cannot fit inside.
    red = ((r > 150) & (g < 90) & (b < 110) & (r - g > 90)).astype(np.uint8)
    size = max(5, int(0.035 * min(h, w)) | 1)
    blobs = cv2.morphologyEx(red, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    arrows = cv2.dilate(red & ~blobs, np.ones((3, 3), np.uint8)).astype(bool)
    candidate &= ~arrows

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    opened = cv2.morphologyEx(candidate.astype(np.uint8), cv2.MORPH_OPEN, kernel).astype(bool)
    count, labels, stats = _components(opened)
    keep = np.zeros_like(opened)
    for i in range(1, count):
        if stats[i][4] >= min_fraction * h * w:
            keep |= labels == i
    # Opening removes thin lines (the connector) but also thin parts; give back what lies within
    # half a kernel of the kept body.
    return cv2.dilate(keep.astype(np.uint8), kernel).astype(bool) & candidate


def model_mask(rgb: np.ndarray, tolerance: float = 30.0, min_fraction: float = 0.0015) -> np.ndarray:
    return _foreground(rgb, tolerance, min_fraction)


def largest_component(mask: np.ndarray) -> np.ndarray:
    """The biggest connected piece of the mask (the built model, without a floating new part)."""
    count, labels, stats = _components(mask)
    if count <= 1:
        return np.zeros_like(mask, bool)
    return labels == 1 + int(stats[1:, 4].argmax())


def model_components(rgb: np.ndarray, tolerance: float = 30.0, max_components: int = 8) -> list[np.ndarray]:
    """Candidate foreground pieces (panel, model, floating part ...) as separate masks, largest
    first. Which one is the model is decided by comparing each with the rendered silhouette."""
    plain = _foreground(rgb, tolerance)
    count, labels, stats = _components(plain)
    order = sorted(range(1, count), key=lambda i: -stats[i][4])[:max_components]
    return [labels == i for i in order if stats[i][4] >= 0.0015 * plain.size]
