"""Collision test for candidate poses against the model so far.

Exact: the editor's own collision world (`lab.oracle.Oracle`, triangle meshes with connector
tolerance, run in node). The model is loaded once per step (`set_model`), then each candidate is one
query. Without node the fallback is a shrunken bounding-box test, which rejects some legal poses
under overhangs and is reported as such (`exact` False).
"""
from __future__ import annotations

import numpy as np

from .render import world_triangles


class Collider:
    def __init__(self, lib, use_oracle: bool = True):
        self.lib = lib
        self.native = None
        self.oracle = None
        self.exact = False
        if use_oracle:
            from . import native_bridge
            self.native = native_bridge.engine()
            if self.native is not None:
                self.exact = True
            else:
                try:
                    from lab.oracle import Oracle
                    self.oracle = Oracle()
                    self.exact = True
                except Exception:
                    self.oracle = None
        self._key = None
        self._boxes: list = []
        self._cache: dict = {}

    def set_model(self, parts: list) -> None:
        key = tuple((p, tuple(np.round(np.asarray(m, float).ravel(), 3))) for p, _c, m in parts)
        if key == self._key:
            return
        self._key = key
        self._cache = {}
        if self.native is not None:
            self.native.set_model(parts)
        elif self.oracle is not None:
            self.oracle.reset()
            for p, _c, m in parts:
                self.oracle.add(p, np.asarray(m, float))
        else:
            self._boxes = [_box(self.lib, p, m) for p, _c, m in parts]

    def hits(self, part: str, matrix: np.ndarray) -> bool:
        k = (part, tuple(np.round(np.asarray(matrix, float).ravel(), 3)))
        if k not in self._cache:
            if self.native is not None:
                self._cache[k] = self.native.hits(part, np.asarray(matrix, float))
            elif self.oracle is not None:
                self._cache[k] = self.oracle.hits(part, np.asarray(matrix, float))
            else:
                lo, hi = _box(self.lib, part, matrix)
                self._cache[k] = any(np.all(np.minimum(hi, h) - np.maximum(lo, l) > 4.0) for l, h in self._boxes if l is not None)
        return self._cache[k]

    def mates(self, part: str, matrix: np.ndarray) -> tuple[int, float]:
        if self.native is not None:
            return self.native.mates(part, np.asarray(matrix, float))
        return (0, 0.0)

    def close(self) -> None:
        if self.oracle is not None:
            try:
                self.oracle.close()
            except Exception:
                pass
            self.oracle = None


def _box(lib, part, matrix):
    pts = world_triangles(lib, part, np.asarray(matrix, float)).reshape(-1, 3)
    if not len(pts):
        return None, None
    return pts.min(0), pts.max(0)
