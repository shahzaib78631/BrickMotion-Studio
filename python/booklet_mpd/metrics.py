"""Metrics comparable with the MEPNet paper: component-wise pose accuracy, whole-model
accuracy and Chamfer distance (in LDU)."""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from brickheadz.instruction_place import part_vertices

from .score import exact_flags


def component_accuracy(lib, predicted, truth) -> float:
    """Share of true parts reproduced exactly (id, colour, pose up to symmetry); a missing part is a miss."""
    if not truth:
        return 1.0 if not predicted else 0.0
    return sum(exact_flags(lib, predicted, truth)) / len(truth)


def model_accuracy(lib, predicted, truth) -> float:
    return 1.0 if len(predicted) == len(truth) and all(exact_flags(lib, predicted, truth)) else 0.0


def _points(lib, parts) -> np.ndarray:
    clouds = []
    for part, _colour, matrix in parts:
        v = part_vertices(lib, part)
        if len(v):
            clouds.append(v @ matrix[:3, :3].T + matrix[:3, 3])
    return np.unique(np.round(np.concatenate(clouds), 3), axis=0) if clouds else np.zeros((0, 3))


def chamfer_distance(lib, predicted, truth) -> float:
    """Symmetric Chamfer distance between the two models' vertex sets."""
    a, b = _points(lib, predicted), _points(lib, truth)
    if not len(a) and not len(b):
        return 0.0
    if not len(a) or not len(b):
        return float("inf")
    return float(cKDTree(b).query(a)[0].mean() + cKDTree(a).query(b)[0].mean())
