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


def model_mask(rgb: np.ndarray, tolerance: float = 30.0, min_fraction: float = 0.0015) -> np.ndarray:
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

    red = (r > 150) & (g < 90) & (b < 110) & (r - g > 90)
    candidate &= ~cv2.dilate(red.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)

    opened = cv2.morphologyEx(candidate.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))).astype(bool)
    count, labels, stats = _components(opened)
    keep = np.zeros_like(opened)
    for i in range(1, count):
        if stats[i][4] >= min_fraction * h * w:
            keep |= labels == i
    return keep
