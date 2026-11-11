"""Quality gate for the step-picture mask: abstain when the picture is not usable.

Rules (fixed before any split was measured):
  the model image must be found in the PDF; the largest foreground component must cover
  4% to 97% of the picture; its solidity (area / convex-hull area) must be at least 0.5.
"""
from __future__ import annotations

import cv2
import numpy as np

from .stepimage import model_components

MIN_AREA, MAX_AREA, MIN_SOLIDITY = 0.04, 0.97, 0.5


def mask_quality(rgb: np.ndarray | None) -> dict:
    if rgb is None:
        return {"passed": False, "reasons": ["model image not found in the PDF"], "area_fraction": None, "solidity": None}
    comps = model_components(rgb)
    if not comps:
        return {"passed": False, "reasons": ["no foreground"], "area_fraction": 0.0, "solidity": None}
    main = comps[0]
    area = float(main.sum())
    fraction = area / main.size
    contours, _ = cv2.findContours(main.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = cv2.convexHull(np.vstack(contours))
    solidity = area / max(1.0, cv2.contourArea(hull))
    reasons = []
    if fraction < MIN_AREA:
        reasons.append(f"foreground too small ({fraction:.1%})")
    if fraction > MAX_AREA:
        reasons.append(f"foreground too large ({fraction:.1%})")
    if solidity < MIN_SOLIDITY:
        reasons.append(f"solidity {solidity:.2f} < {MIN_SOLIDITY}")
    return {"passed": not reasons, "reasons": reasons, "area_fraction": fraction, "solidity": solidity}
