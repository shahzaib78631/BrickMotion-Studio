"""Closed-form axonometric camera recovery for instruction images.

An instruction drawing uses an orthographic (axonometric) camera. With LDraw axes
(x right, y down, z front) and ``R = Rx(pitch) · Ry(yaw)`` (the model used by
``instruction_place.Camera``), a world point ``p`` (LDU) projects to

    u = s·(R·p)_x + ox
    v = s·(R·p)_y + oy

which is **affine** in ``p``:

    (u, v) = A·p + o,      A = [ s·R[0] ; s·R[1] ]   (2×3),   o = (ox, oy).

Two consequences make the camera *mathematically* recoverable, not fitted by
search:

1. The eight numbers ``(A, o)`` are linear in the data, so ≥4 non-degenerate
   model→pixel correspondences give them by linear least squares in closed form
   (``solve_affine``).
2. The **columns of A are the images of the world unit axes** (``projected_axes``):
   ``A[:,0]`` is where +x goes, etc. With the stud pitch known (20 LDU), a single
   detected lattice vector along a world axis pins that column; the three of them
   give A directly (``affine_from_axes``) with no correspondences at all.

``(A, o)`` factor back into the five camera parameters exactly: the rows of A are
``s·R[0]`` and ``s·R[1]``, so ``s`` is their common length and the third row of R
is their cross product. ``recover_camera`` returns the camera plus a
``CameraCertificate`` recording the pixel residual and the orthonormality defect
of the recovered rotation — the quantity a verifier re-checks.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from brickheadz.instruction_place import Camera


@dataclass(frozen=True)
class CameraCertificate:
    """What an independent verifier re-checks about a recovered camera."""

    residual: float  # max |A·p + o − uv| over the correspondences (pixels)
    rms: float  # root-mean-square of the same
    orthonormality: float  # max |R·Rᵀ − I| (0 for an exact rotation)
    scale: float  # LDU→pixel scale
    n_points: int
    rank: int  # rank of the 2N×8 design matrix (8 = well posed)
    ok: bool  # residual small, rotation orthonormal, and rank full


# --------------------------------------------------------------- forward -----


def project_basis(cam: Camera) -> np.ndarray:
    """The 2×3 affine part A with ``(u, v) = A·p + o`` (columns = projected axes)."""
    r = cam.r
    return np.array([[cam.scale * r[0, 0], cam.scale * r[0, 1], cam.scale * r[0, 2]],
                     [cam.screen_y * cam.scale * r[1, 0], cam.screen_y * cam.scale * r[1, 1], cam.screen_y * cam.scale * r[1, 2]]])


def project_offset(cam: Camera) -> np.ndarray:
    return np.array([cam.ox, cam.oy], float)


def projected_axes(cam: Camera) -> np.ndarray:
    """The image vectors of the world unit axes +x, +y, +z (columns of A)."""
    return project_basis(cam)


def apply_affine(a: np.ndarray, o: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """``A·p + o`` for an (N,3) point set → (N,2)."""
    pts = np.asarray(pts, float).reshape(-1, 3)
    return pts @ np.asarray(a, float).T + np.asarray(o, float)


# -------------------------------------------------------------- recover -----


def affine_from_axes(axes: np.ndarray) -> np.ndarray:
    """A from the three projected world-axis vectors (3×2: +x, +y, +z images)."""
    axes = np.asarray(axes, float).reshape(3, 2)
    return np.ascontiguousarray(axes.T)  # columns are the axes → A is 2×3


def solve_affine(pts: np.ndarray, uvs: np.ndarray) -> tuple[np.ndarray, np.ndarray, int, np.ndarray]:
    """Least-squares solve of ``uv = A·p + o`` for (A, o), plus (rank, residual rows)."""
    pts = np.asarray(pts, float).reshape(-1, 3)
    uvs = np.asarray(uvs, float).reshape(-1, 2)
    n = len(pts)
    if n < 4:
        raise ValueError("need at least 4 non-degenerate correspondences")
    m = np.zeros((2 * n, 8))
    b = np.empty(2 * n)
    m[0::2, 0:3] = pts
    m[0::2, 3] = 1.0
    m[1::2, 4:7] = pts
    m[1::2, 7] = 1.0
    b[0::2] = uvs[:, 0]
    b[1::2] = uvs[:, 1]
    theta, _res, rank, _sv = np.linalg.lstsq(m, b, rcond=None)
    a = np.array([theta[0:3], theta[4:7]])
    o = np.array([theta[3], theta[7]])
    return a, o, int(rank), m @ theta - b


def _factor(a: np.ndarray, screen_y: int = 1) -> tuple[float, np.ndarray, float]:
    """Factor A = [s·R[0] ; s·R[1]] into a scale, a rotation, and its raw defect.

    The rows of A are the first two rows of ``s·R``; the third is their cross
    product. With noisy data that cross product is not quite unit, so the raw
    defect ``max|R·Rᵀ − I|`` measures how close the affine fit is to a true
    axonometric camera; the returned rotation is the nearest orthonormal one
    (polar decomposition), so the camera itself is always consistent.
    """
    r0 = a[0] / max(1e-12, float(np.linalg.norm(a[0])))
    r1 = screen_y*a[1] / max(1e-12, float(np.linalg.norm(a[1])))
    s = 0.5 * (float(np.linalg.norm(a[0])) + float(np.linalg.norm(a[1])))
    raw = np.stack([r0, r1, np.cross(r0, r1)])
    defect = float(np.abs(raw @ raw.T - np.eye(3)).max())
    u, _sv, vt = np.linalg.svd(raw)
    fix = np.diag([1.0, 1.0, float(np.sign(np.linalg.det(u @ vt)) or 1.0)])
    return s, u @ fix @ vt, defect


def camera_from_affine(a: np.ndarray, o: np.ndarray, *, screen_y: int = 1) -> tuple[Camera, np.ndarray, float]:
    """(camera, rotation, raw orthonormality defect) from (A, o)."""
    s, r, defect = _factor(a,screen_y)
    yaw = float(np.degrees(np.arctan2(r[0, 2], r[0, 0])))
    pitch = float(np.degrees(np.arctan2(r[2, 1], r[1, 1])))
    return Camera(yaw=yaw, pitch=pitch, scale=s, ox=float(o[0]), oy=float(o[1]),screen_y=screen_y), r, defect


def recover_camera(
    pts: np.ndarray, uvs: np.ndarray, *, residual_tol: float = 0.5, ortho_tol: float = 0.02, screen_y: int = 1
) -> tuple[Camera, CameraCertificate]:
    """Recover the camera from model→pixel correspondences, with a certificate.

    ``pts`` are LDU world points, ``uvs`` their pixel positions. The solve is
    linear; the certificate records how well the data is explained and how close
    the affine fit is to a real orthographic rotation (the model's structural
    assumption).
    """
    a, o, rank, err = solve_affine(pts, uvs)
    cam, _r, ortho = camera_from_affine(a, o, screen_y=screen_y)
    # The affine fit can include roll or anisotropic scale which Camera cannot
    # express. Certify the returned camera's projection, not just the unconstrained
    # eight-parameter affine solution.
    u,v,_depth = cam.project(pts)
    err = np.stack([u,v],axis=1)-np.asarray(uvs,float).reshape(-1,2)
    residual = float(np.abs(err).max())
    rms = float(np.sqrt(np.mean(err ** 2)))
    cert = CameraCertificate(
        residual=residual,
        rms=rms,
        orthonormality=ortho,
        scale=cam.scale,
        n_points=len(np.asarray(pts).reshape(-1, 3)),
        rank=rank,
        ok=bool(rank >= 8 and ortho <= ortho_tol and residual <= residual_tol),
    )
    return cam, cert
