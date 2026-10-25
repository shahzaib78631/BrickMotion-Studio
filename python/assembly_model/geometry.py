from __future__ import annotations

import numpy as np

LDU_STUD = 20.0
EPS = 1e-6


def transform_points(points: np.ndarray, mat: np.ndarray) -> np.ndarray:
    if points.size == 0:
        return points.reshape(0, 3)
    pts = points @ mat[:3, :3].T + mat[:3, 3]
    return pts


def aabb(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    return lo, hi


def swept_boxes(lo0: np.ndarray, hi0: np.ndarray, lo1: np.ndarray, hi1: np.ndarray, frames: int):
    """Sampled interpolation between two boxes (straight line sweep)."""
    for i in range(frames + 1):
        t = i / frames
        yield lo0 + (lo1 - lo0) * t, hi0 + (hi1 - hi0) * t


class BoxGrid:
    """Uniform grid over static obstacle boxes for fast swept queries."""

    def __init__(self, cell: float = 80.0):
        self.cell = cell
        self.cells: dict[tuple[int, int, int], list[int]] = {}
        self.boxes: list[tuple[np.ndarray, np.ndarray, int]] = []

    def add(self, lo: np.ndarray, hi: np.ndarray, payload: tuple[str, int]) -> int:
        idx = len(self.boxes)
        self.boxes.append((lo, hi, payload))
        ga = np.floor(lo / self.cell).astype(int)
        gb = np.floor(hi / self.cell).astype(int)
        for x in range(ga[0], gb[0] + 1):
            for y in range(ga[1], gb[1] + 1):
                for z in range(ga[2], gb[2] + 1):
                    self.cells.setdefault((x, y, z), []).append(idx)
        return idx

    def hits(self, lo: np.ndarray, hi: np.ndarray, exclude: "tuple[str, int] | list[tuple[str, int]] | None" = None,
             margin: float = 0.0):
        excl = None if exclude is None else (exclude if isinstance(exclude, list) else [exclude])
        get = self.cells.get
        ga = np.floor((lo - margin) / self.cell).astype(int)
        gb = np.floor((hi + margin) / self.cell).astype(int)
        seen: set[int] = set()
        out = []
        for x in range(ga[0], gb[0] + 1):
            for y in range(ga[1], gb[1] + 1):
                for z in range(ga[2], gb[2] + 1):
                    for idx in get((x, y, z), ()):
                        if idx in seen:
                            continue
                        seen.add(idx)
                        blo, bhi, payload = self.boxes[idx]
                        if excl is not None and payload in excl:
                            continue
                        if np.all(lo - margin < bhi + EPS) and np.all(blo < hi + margin + EPS):
                            out.append((payload, blo, bhi))
        return out
