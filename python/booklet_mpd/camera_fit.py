"""Fit the booklet camera angle to a step picture from the (known) model so far.

Teacher-forced: the model's parts are given, so only the viewing angle is unknown. The
search maximises silhouette IoU between the rendered model and the picture's model mask,
both normalised to their own bounding boxes (scale and offset drop out).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

import cv2

from brickheadz.instruction_place import Camera, iou, render


def normalise(mask: np.ndarray, size: int) -> np.ndarray:
    """Crop to the bounding box, scale uniformly (aspect ratio kept) and centre in size x size."""
    ys, xs = np.where(mask)
    out = np.zeros((size, size), bool)
    if not ys.size:
        return out
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8)
    scale = (size - 2) / max(crop.shape)
    h, w = max(1, round(crop.shape[0] * scale)), max(1, round(crop.shape[1] * scale))
    resized = cv2.resize(crop, (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
    top, left = (size - h) // 2, (size - w) // 2
    out[top:top + h, left:left + w] = resized
    return out


@dataclass
class P:
    base_part: str
    matrix: np.ndarray
    color: int


def pieces_from(parts) -> list[P]:
    return [P(base_part=part, matrix=matrix, color=colour) for part, colour, matrix in parts]


def fit_camera_to_mask(lib, parts, mask: np.ndarray, yaws=range(-180, 180, 15), pitches=range(-60, 61, 10),
                       size: int = 96, refine: bool = True) -> dict:
    pieces = pieces_from(parts)
    target = normalise(mask, size)

    def score(yaw: float, pitch: float) -> float:
        rendered, _, _ = render(lib, pieces, Camera(yaw, pitch), size)
        return iou(normalise(rendered, size), target)

    best = {"iou": -1.0, "yaw": 0.0, "pitch": 0.0}
    for yaw in yaws:
        for pitch in pitches:
            value = score(yaw, pitch)
            if value > best["iou"]:
                best = {"iou": value, "yaw": float(yaw), "pitch": float(pitch)}
    if refine:
        step = 4.0
        while step >= 1.0:
            centre = dict(best)
            for dy in (-step, 0.0, step):
                for dp in (-step, 0.0, step):
                    value = score(centre["yaw"] + dy, centre["pitch"] + dp)
                    if value > best["iou"]:
                        best = {"iou": value, "yaw": centre["yaw"] + dy, "pitch": centre["pitch"] + dp}
            step /= 2
    return best
