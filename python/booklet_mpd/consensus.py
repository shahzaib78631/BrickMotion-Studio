"""One shared camera per booklet.

A booklet draws every step from the same viewing angle; between steps the model is turned
by multiples of 90 degrees about the vertical axis. Per step we compute the silhouette-IoU
surface over (yaw, pitch); the consensus is the (yaw0, pitch) maximising the sum over steps
of the best IoU among yaw0 + k*90. Pitch is searched only in (0, 90): the view (yaw+180,
-pitch) has the same orthographic silhouette as (yaw, pitch).
"""
from __future__ import annotations

import numpy as np

from .camera_fit import normalise, silhouette
from brickheadz.instruction_place import iou


def iou_surface(clouds, mask: np.ndarray, yaws, pitches, size: int = 80) -> np.ndarray:
    target = normalise(mask, size)
    surface = np.zeros((len(yaws), len(pitches)))
    for i, yaw in enumerate(yaws):
        for j, pitch in enumerate(pitches):
            surface[i, j] = iou(normalise(silhouette(clouds, yaw, pitch, size), size), target)
    return surface


def _quarter(yaws) -> int:
    yaws = list(yaws)
    step = yaws[1] - yaws[0] if len(yaws) > 1 else 0
    if step <= 0 or 90 % step or len(yaws) * step != 360:
        raise ValueError("The yaw grid must be uniform, cover 360 degrees and contain the 90-degree quarter turns")
    return 90 // step


def consensus_camera(surfaces: list[np.ndarray], yaws, pitches) -> dict:
    q = _quarter(yaws)
    n = len(yaws)
    best = (-1.0, 0, 0)
    for b in range(q):
        for j in range(len(pitches)):
            total = sum(max(s[(b + k * q) % n, j] for k in range(4)) for s in surfaces)
            if total > best[0]:
                best = (total, b, j)
    total, b, j = best
    steps = []
    for s in surfaces:
        values = [s[(b + k * q) % n, j] for k in range(4)]
        steps.append({"turn": int(np.argmax(values)), "iou": float(max(values))})
    return {"yaw": yaws[b], "pitch": pitches[j], "score": total / len(surfaces), "steps": steps}


def apply_consensus(surface: np.ndarray, yaws, pitches, camera: dict) -> dict:
    q = _quarter(yaws)
    n = len(yaws)
    b, j = list(yaws).index(camera["yaw"]), list(pitches).index(camera["pitch"])
    values = [surface[(b + k * q) % n, j] for k in range(4)]
    return {"turn": int(np.argmax(values)), "iou": float(max(values))}
