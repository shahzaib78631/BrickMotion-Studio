"""Label-free check that a step picture really shows the parts we think it shows."""
from __future__ import annotations

import numpy as np

from brickheadz.instruction_place import _rotations24, iou

from .camera_fit import _clouds, normalise, silhouette
from .stepimage import model_components

YAW, PITCH = 35, 35  # the booklets' shared view (see the consensus-camera benchmark)


_ORIENTATIONS = [np.asarray(r, float)[:3, :3] for r in _rotations24()]  # the 24 cube rotations


def visible_iou(lib, parts, rgb: np.ndarray, size: int = 80) -> float:
    """Best silhouette IoU between the parts (any of the 24 cube orientations, fixed booklet
    camera) and any candidate foreground component of the picture. Booklets turn models about
    any axis between steps (rules version 2; version 1 tried vertical turns only)."""
    clouds = _clouds(lib, parts)
    targets = [normalise(c, size) for c in model_components(rgb)]
    if not clouds or not targets:
        return 0.0
    return max(iou(normalise(silhouette([c @ R.T for c in clouds], YAW, PITCH, size), size), t)
               for R in _ORIENTATIONS for t in targets)
