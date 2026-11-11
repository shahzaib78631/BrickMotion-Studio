"""Fit the booklet camera angle to a step picture from the (known) model so far.

Teacher-forced: the model's parts are given, so only the viewing angle is unknown. The
search maximises silhouette IoU between the rendered model and the picture's model mask,
both normalised to their own bounding boxes (scale and offset drop out).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

import cv2

from brickheadz.instruction_place import Camera, iou, part_vertices, rotation


def normalise(mask: np.ndarray, size: int) -> np.ndarray:
    """Crop to the bounding box, scale uniformly (aspect ratio kept) and centre in size x size."""
    ys, xs = np.where(mask)
    out = np.zeros((size, size), bool)
    if not ys.size:
        return out
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8)
    scale = (size - 2) / max(crop.shape)
    h, w = max(1, round(crop.shape[0] * scale)), max(1, round(crop.shape[1] * scale))
    resized = cv2.resize(crop, (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
    top, left = (size - h) // 2, (size - w) // 2
    out[top:top + h, left:left + w] = resized
    return out


@dataclass
class P:
    base_part: str
    matrix: np.ndarray
    color: int


def pieces_from(parts) -> list[P]:
    return [P(base_part=part, matrix=matrix, color=colour) for part, colour, matrix in parts]


def _clouds(lib, parts) -> list[np.ndarray]:
    """World-space vertices per part, de-duplicated (triangle lists repeat each vertex)."""
    clouds = []
    for part, _colour, matrix in parts:
        v = part_vertices(lib, part)
        if len(v):
            clouds.append(np.unique(np.round(v @ matrix[:3, :3].T + matrix[:3, 3], 2), axis=0))
    return clouds


def silhouette(clouds: list[np.ndarray], yaw: float, pitch: float, size: int) -> np.ndarray:
    """Union of per-part convex hulls seen from (yaw, pitch), fitted into size x size."""
    rot = rotation(yaw, pitch)
    projected = [(c @ rot.T)[:, :2] for c in clouds]
    allp = np.concatenate(projected)
    lo, hi = allp.min(0), allp.max(0)
    scale = (size - 12) / (max(hi - lo) or 1.0)
    mask = np.zeros((size, size), np.uint8)
    for p in projected:
        pts = ((p - lo) * scale + 6).astype(np.float32)
        hull = cv2.convexHull(pts)
        cv2.fillConvexPoly(mask, hull.astype(np.int32), 1)
    return mask.astype(bool)


_POLYGONS: dict = {}


def _polygons(lib, part: str):
    """(vertices, polygon lengths) of a part: LDraw triangles and quads, kept separate."""
    key = (id(lib), part)
    if key not in _POLYGONS:
        chunks = lib._tri_walk((part if part.endswith(".dat") else part + ".dat").lower(), np.eye(4))
        verts = np.concatenate(chunks) if chunks else np.zeros((0, 3))
        _POLYGONS[key] = (verts, np.array([len(c) for c in chunks], int))
    return _POLYGONS[key]


def exact_silhouette(lib, parts, orientation: np.ndarray, yaw: float, pitch: float, size: int) -> np.ndarray:
    """Silhouette from the parts' actual polygons (no convex hulls), so concave parts keep
    their notches. `orientation` is a 3x3 rotation applied to the whole model first; the
    framing (scale and offset) uses the same rule as `silhouette`."""
    rot = rotation(yaw, pitch)
    projected = []
    for part, _colour, matrix in parts:
        verts, lengths = _polygons(lib, part)
        if len(verts):
            world = (verts @ matrix[:3, :3].T + matrix[:3, 3]) @ orientation.T
            projected.append(((world @ rot.T)[:, :2], lengths))
    mask = np.zeros((size, size), np.uint8)
    if not projected:
        return mask.astype(bool)
    allp = np.concatenate([p for p, _ in projected])
    lo, hi = allp.min(0), allp.max(0)
    scale = (size - 12) / (max(hi - lo) or 1.0)
    polygons = []
    for p, lengths in projected:
        pts = ((p - lo) * scale + 6).astype(np.int32)
        polygons.extend(np.split(pts, np.cumsum(lengths)[:-1]))
    # fillPoly would XOR overlapping polygons (front and back faces cancel); fill each one alone
    for polygon in polygons:
        cv2.fillConvexPoly(mask, polygon, 1)
    return mask.astype(bool)


def fit_camera_to_mask(lib, parts, mask: np.ndarray, yaws=range(-180, 180, 15), pitches=range(-60, 61, 10),
                       size: int = 96, refine: bool = True) -> dict:
    clouds = _clouds(lib, parts)
    target = normalise(mask, size)

    def score(yaw: float, pitch: float) -> float:
        return iou(normalise(silhouette(clouds, yaw, pitch, size), size), target)

    best = {"iou": -1.0, "yaw": 0.0, "pitch": 0.0}
    for yaw in yaws:
        for pitch in pitches:
            value = score(yaw, pitch)
            if value > best["iou"]:
                best = {"iou": value, "yaw": float(yaw), "pitch": float(pitch)}
    if refine:
        step = 4.0
        while step >= 1.0:
            centre = dict(best)
            for dy in (-step, 0.0, step):
                for dp in (-step, 0.0, step):
                    value = score(centre["yaw"] + dy, centre["pitch"] + dp)
                    if value > best["iou"]:
                        best = {"iou": value, "yaw": centre["yaw"] + dy, "pitch": centre["pitch"] + dp}
            step /= 2
    return best
