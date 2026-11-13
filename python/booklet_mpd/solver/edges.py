"""Line-drawing evidence: LDraw edge lines (type 2) rendered with occlusion vs the picture's ink.

Booklet renders outline every part and its features (stud rims, tube circles, slope creases) in dark
ink. LDraw parts carry those lines explicitly as type-2 lines, so the rendered visible edges of a
hypothesis can be compared with the picture's ink. This is the evidence that sees a tan plate on a
tan plate (no colour change) and the difference between studs and tubes (a model seen upside down).
"""
from __future__ import annotations

import os

import cv2
import numpy as np

_EDGES: dict = {}
_FILES: dict = {}
DEPTH_TOL = 3.0       # LDU: an edge point this close behind the visible surface is on it
NEAR_INK = 1.6        # px


def _parse(path: str):
    if path not in _FILES:
        lines, refs = [], []
        for raw in open(path, errors="ignore").read().splitlines():
            t = raw.split()
            if not t:
                continue
            if t[0] == "2" and len(t) >= 8:
                try:
                    lines.append(np.array([float(v) for v in t[2:8]]).reshape(2, 3))
                except ValueError:
                    pass
            elif t[0] == "1" and len(t) >= 15:
                try:
                    x, y, z, a, b, c, d, e, f, g, h, i = (float(v) for v in t[2:14])
                except ValueError:
                    continue
                m = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1.0]])
                refs.append((" ".join(t[14:]).lower(), m))
        _FILES[path] = (lines, refs)
    return _FILES[path]


def _walk(lib, name: str, mat: np.ndarray, depth: int, out: list) -> None:
    if depth > 16:
        return
    path = lib.find(name)
    if path is None:
        return
    lines, refs = _parse(path)
    for seg in lines:
        out.append(seg @ mat[:3, :3].T + mat[:3, 3])
    for ref, sub in refs:
        _walk(lib, ref, mat @ sub, depth + 1, out)


def part_edges(lib, part: str) -> np.ndarray:
    """(E, 2, 3) edge segments in part space."""
    key = (id(lib), part)
    if key not in _EDGES:
        out: list = []
        _walk(lib, (part if part.endswith(".dat") else part + ".dat").lower(), np.eye(4), 0, out)
        _EDGES[key] = np.array(out, float).reshape(-1, 2, 3)
    return _EDGES[key]


def sample_segments(seg_uvd: np.ndarray, spacing: float = 0.7) -> np.ndarray:
    """Points (N, 3) of (u, v, depth) along screen-space segments, about `spacing` px apart."""
    if not len(seg_uvd):
        return np.zeros((0, 3))
    a, b = seg_uvd[:, 0], seg_uvd[:, 1]
    n = np.maximum(1, np.ceil(np.linalg.norm(b[:, :2] - a[:, :2], axis=1) / spacing).astype(int))
    idx = np.repeat(np.arange(len(seg_uvd)), n + 1)
    t = (np.arange(len(idx)) - np.repeat(np.cumsum(n + 1) - (n + 1), n + 1)) / np.repeat(n, n + 1)
    return a[idx] + (b[idx] - a[idx]) * t[:, None]


def visible_points(points: np.ndarray, depth: np.ndarray) -> np.ndarray:
    """Integer pixel coordinates (row, col) of the points not hidden behind `depth`."""
    if not len(points):
        return np.zeros((0, 2), int)
    cols = np.round(points[:, 0]).astype(int)
    rows = np.round(points[:, 1]).astype(int)
    h, w = depth.shape
    inside = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)
    rows, cols, d = rows[inside], cols[inside], points[inside, 2]
    keep = d <= depth[rows, cols] + DEPTH_TOL
    return np.unique(np.stack([rows[keep], cols[keep]], 1), axis=0)


INK = os.environ.get("BOOKLET_SOLVER_INK", "value")   # A/B on 4 sets: value 229 vs grey 222 exact parts


def ink(rgb: np.ndarray) -> np.ndarray:
    """Dark line pixels. "grey": very dark, or clearly darker than their 7x7 surroundings (black-hat).
    That rule reads booklet red as ink (grey about 76, shaded red under 60; and every red feature narrower
    than 7 px), so on red parts every drawn edge looked confirmed. "value": brightness is the largest
    channel (red is bright, ink is dark in every channel); dark, or darker than the 5x5 surroundings and
    not bright."""
    if INK == "value":
        v = rgb.max(2).astype(np.uint8)
        hat = cv2.morphologyEx(v, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        return (v < 70) | ((hat > 40) & (v < 150))
    grey = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    hat = cv2.morphologyEx(grey, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    return (grey < 60) | (hat > 35)


def ink_distance(rgb: np.ndarray) -> np.ndarray:
    k = ink(rgb)
    return cv2.distanceTransform((~k).astype(np.uint8), cv2.DIST_L2, 3)
