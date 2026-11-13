"""The booklet-camera page's camera (src/dev/bookletCameraMath.ts), ported exactly.

A camera looks at the model centre from (yaw, pitch), rolled, with a scale in pixels per LDU at the centre's
depth and the centre's image position (cx, cy); pixel origin top-left; LDraw -Y is up. `eye` > 0 is a perspective
eye at that distance in LDU (the page's persp = eye / radius), 0 is orthographic. A turned-over model is rotated
180 degrees about LDraw X (points and centre) before projection, as the page does with scene.rotation.x = PI.

Checked against the TypeScript camera in tests/test_coordnet_camera.py (fixture from
scripts/coordnet-camera-fixture.ts).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

TURN = np.diag([1.0, -1.0, -1.0])


@dataclass(frozen=True)
class BookletCamera:
    yaw: float
    pitch: float
    roll: float
    scale: float          # px per LDU (at the centre's depth for perspective)
    cx: float
    cy: float
    eye: float = 0.0      # LDU; 0 = orthographic
    up: int = 1
    turned: bool = False

    def with_(self, **kw) -> "BookletCamera":
        return replace(self, **kw)


def basis(cam: BookletCamera) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(right, up, back) unit vectors of the camera in world space (three.js lookAt + rotateZ(roll))."""
    y, p = math.radians(cam.yaw), math.radians(cam.pitch)
    back = np.array([math.cos(p) * math.sin(y), -math.sin(p), math.cos(p) * math.cos(y)])   # centre -> eye
    upv = np.array([0.0, -float(cam.up), 0.0])
    x = np.cross(upv, back)
    n = np.linalg.norm(x)
    x = x / n if n > 1e-12 else np.array([1.0, 0.0, 0.0])
    yv = np.cross(back, x)
    r = math.radians(cam.roll)
    return math.cos(r) * x + math.sin(r) * yv, -math.sin(r) * x + math.cos(r) * yv, back


def to_view(cam: BookletCamera, centre: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """World points -> camera-frame (x right, y up, d = distance in front of the eye plane through the centre's
    perspective eye; for orthographic d is depth relative to the centre)."""
    pts = np.asarray(pts, float)
    c = np.asarray(centre, float)
    if cam.turned:
        pts, c = pts @ TURN.T, TURN @ c
    rx, uy, back = basis(cam)
    rel = pts - c
    return np.stack([rel @ rx, rel @ uy, rel @ back], -1)


def project(cam: BookletCamera, centre, pts) -> tuple[np.ndarray, np.ndarray]:
    """(uv [N,2] pixels, depth [N] in LDU from the eye along the view axis; larger = farther)."""
    v = to_view(cam, centre, pts)
    if cam.eye > 0:
        depth = cam.eye - v[..., 2]
        k = cam.eye / depth
    else:
        depth = -v[..., 2]
        k = 1.0
    uv = np.stack([cam.cx + cam.scale * k * v[..., 0], cam.cy - cam.scale * k * v[..., 1]], -1)
    return uv, depth


def unproject(cam: BookletCamera, centre, uv, depth) -> np.ndarray:
    """Inverse of `project` (pixels + depth -> world points)."""
    uv = np.asarray(uv, float)
    depth = np.asarray(depth, float)
    if cam.eye > 0:
        k = cam.eye / depth
        vz = cam.eye - depth
    else:
        k = 1.0
        vz = -depth
    vx = (uv[..., 0] - cam.cx) / (cam.scale * k)
    vy = -(uv[..., 1] - cam.cy) / (cam.scale * k)
    rx, uy, back = basis(cam)
    c = np.asarray(centre, float)
    if cam.turned:
        c = TURN @ c
    w = c + vx[..., None] * rx + vy[..., None] * uy + vz[..., None] * back
    return w @ TURN.T if cam.turned else w        # TURN is its own inverse


def raster_scale(reference_scale: float, reference_pts: float | None, pts: float | None) -> float:
    """Same printed scale for pictures rasterised at a different points-per-pixel (rasterScale in the page)."""
    return reference_scale * reference_pts / pts if reference_pts and pts else reference_scale


def model_centre(boxes_min: np.ndarray, boxes_max: np.ndarray) -> np.ndarray:
    """Centre of the union of part bounding boxes (the page's box.getCenter over all meshes)."""
    return (np.min(boxes_min, 0) + np.max(boxes_max, 0)) / 2
