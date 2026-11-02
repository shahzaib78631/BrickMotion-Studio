"""World-space geometry helpers for placed pieces (LDU, y-down native)."""
from __future__ import annotations

import numpy as np

from assembly_model.ldraw import LDrawLibrary
from brickheadz.dat import Piece

STUD = 20.0
PLATE = 8.0
BRICK = 24.0
UP = np.array([0.0, 1.0, 0.0])


def geom_part(lib: LDrawLibrary, piece: Piece) -> str:
    """Library part used for geometry/connectors (decorated tiles fall back to base)."""
    for cand in (piece.base_part, piece.base_part + ".dat", piece.part):
        if lib.find(cand) is not None:
            return cand
    return piece.part


def world_mesh(lib: LDrawLibrary, piece: Piece) -> np.ndarray:
    tri = lib.triangles(geom_part(lib, piece))
    if tri.size == 0:
        return tri.reshape(0, 3)
    m = piece.matrix
    return tri @ m[:3, :3].T + m[:3, 3]


def piece_aabb(lib: LDrawLibrary, piece: Piece):
    tri = world_mesh(lib, piece)
    if tri.size == 0:
        return None
    return tri.min(0), tri.max(0)


def world_snaps(lib: LDrawLibrary, piece: Piece) -> list[tuple]:
    """[(Snap, world_pos(3), world_axis(3))] for one placed piece."""
    snaps = lib.snaps(geom_part(lib, piece))
    if not snaps:
        return []
    r, t = piece.matrix[:3, :3], piece.matrix[:3, 3]
    out = []
    for s in snaps:
        axis = r @ np.array(s.axis, dtype=float)
        n = float(np.linalg.norm(axis))
        if n > 1e-6:
            axis = axis / n
        out.append((s, r @ np.array(s.pos, dtype=float) + t, axis))
    return out


def to_figure(aabb_ldraw) -> tuple[np.ndarray, np.ndarray]:
    """LDraw (y-down) AABB -> figure space (y-up)."""
    lo, hi = aabb_ldraw
    return np.array([lo[0], -hi[1], lo[2]]), np.array([hi[0], -lo[1], hi[2]])
