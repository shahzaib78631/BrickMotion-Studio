"""Label-free check that a step picture really shows the parts we think it shows."""
from __future__ import annotations

import numpy as np

from brickheadz.instruction_place import iou

from .camera_fit import _clouds, normalise, silhouette
from .stepimage import model_components

YAW, PITCH = 35, 35  # the booklets' shared view (see the consensus-camera benchmark)


def _turn(k: int) -> np.ndarray:
    c, s = [(1, 0), (0, 1), (-1, 0), (0, -1)][k]
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], float)


def visible_iou(lib, parts, rgb: np.ndarray, size: int = 80) -> float:
    """Best silhouette IoU between the parts (any quarter turn about the vertical axis, fixed
    booklet camera) and any candidate foreground component of the picture."""
    clouds = _clouds(lib, parts)
    targets = [normalise(c, size) for c in model_components(rgb)]
    if not clouds or not targets:
        return 0.0
    return max(iou(normalise(silhouette([c @ _turn(k).T for c in clouds], YAW, PITCH, size), size), t)
               for k in range(4) for t in targets)
