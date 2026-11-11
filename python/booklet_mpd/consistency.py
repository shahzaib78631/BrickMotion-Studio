"""Label-free check that a step picture really shows the parts we think it shows."""
from __future__ import annotations

import numpy as np

from .viewfit import fit_view


def visible_iou(lib, parts, rgb: np.ndarray, size: int = 80) -> float:
    """Best silhouette IoU between the parts and the picture over a per-step camera
    (yaw 5-80, pitch 20-65) and all 24 cube orientations, hull search then exact refinement.
    Rules version 3; version 2 used a fixed 35/35 camera, version 1 vertical turns only."""
    return fit_view(lib, parts, rgb, size)["iou"]
