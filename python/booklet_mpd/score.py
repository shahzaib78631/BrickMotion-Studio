"""Exact-pose scoring and calibration metrics for reconstructed booklets."""
from __future__ import annotations

import numpy as np

Part = tuple[str, int, np.ndarray]  # (LDraw id, colour, 4x4 matrix)


def _signature(lib, part: str, matrix: np.ndarray) -> np.ndarray:
    points = lib.triangles(part + ".dat") @ matrix[:3, :3].T + matrix[:3, 3]
    points = np.round(points, 3)
    points[np.abs(points) < 0.0005] = 0
    return np.unique(points, axis=0)


def exact_flags(lib, predicted: list[Part], expected: list[Part]) -> list[bool]:
    """Per predicted part: id, colour, translation (0.001 LDU) and rotated-vertex
    geometry match an unclaimed expected part. Rotation-equivalent poses count."""
    used: set[int] = set()
    flags: list[bool] = []
    for part, colour, matrix in predicted:
        found = None
        for i, (p, c, truth) in enumerate(expected):
            if i in used or p != part or c != colour:
                continue
            if not np.allclose(matrix[:3, 3], truth[:3, 3], atol=0.001):
                continue
            a, b = _signature(lib, part, matrix), _signature(lib, p, truth)
            if a.shape == b.shape and np.allclose(a, b, atol=0.001):
                found = i
                break
        if found is not None:
            used.add(found)
        flags.append(found is not None)
    return flags


def _fraction(num: int, den: int):
    return None if den == 0 else num / den


def calibration(rows: list[tuple[float, bool]], threshold: float) -> dict:
    """A row is (confidence, is_exact); flagged means confidence < threshold."""
    flagged = [e for c, e in rows if c < threshold]
    unflagged = [e for c, e in rows if c >= threshold]
    wrong = sum(1 for _, e in rows if not e)
    wrong_flagged = sum(1 for e in flagged if not e)
    return {
        "n": len(rows), "flagged": len(flagged), "unflagged": len(unflagged),
        "unflagged_exact": _fraction(sum(unflagged), len(unflagged)),
        "flagged_exact": _fraction(sum(flagged), len(flagged)),
        "flag_recall": _fraction(wrong_flagged, wrong),
    }


def reliability_bins(rows: list[tuple[float, bool]], bins: int = 10) -> list[dict]:
    out = []
    for k in range(bins):
        lo, hi = k / bins, (k + 1) / bins
        inside = [e for c, e in rows if lo <= c < hi or (k == bins - 1 and c == 1.0)]
        out.append({"lo": lo, "hi": hi, "n": len(inside), "exact_fraction": _fraction(sum(inside), len(inside))})
    return out
