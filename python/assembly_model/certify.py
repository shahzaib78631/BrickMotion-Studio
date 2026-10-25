"""Certified-corridor experiments: Axis-sampled swept-AABB clearance tests."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geometry import BoxGrid


@dataclass
class CorridorResult:
    clear: bool
    frames: int
    margin: float
    blockers: list[str]


def swept_corridor(
    grid: BoxGrid,
    piece_id: "tuple[str, int] | list[tuple[str, int]] | None",
    lo_start: np.ndarray,
    hi_start: np.ndarray,
    lo_end: np.ndarray,
    hi_end: np.ndarray,
    frames: int = 48,
    margin: float = 2.0,
    allow_final: "set[tuple[str, int]] | None" = None,
    forgive_after: float = 1.0,
    forgive: set | None = None,
    skip: "set[tuple[str, int]] | None" = None,
) -> CorridorResult:
    """Swept-AABB corridor test with three contact phases.

    Mid-path (margin): any placed box inside the swept volume blocks.
    Final frame (margin=0): mating pieces excluded via allow_final (studs
    touch their sockets flush).
    Socket forgiveness (forgive_after < 1): socket mates also stop blocking
    during the final plunge phase, because their boxes legitimately
    interpenetrate when sockets close.
    `skip` payloads are exempt everywhere (a flying piece's joint mates).
    """
    allow_final = allow_final or set()
    forgive = forgive or set()
    skip = skip or set()
    blockers: list[str] = []
    for i in range(frames + 1):
        t = i / frames
        lo = lo_start + (lo_end - lo_start) * t
        hi = hi_start + (hi_end - hi_start) * t
        socket_forgiven = t >= forgive_after and bool(forgive)
        if socket_forgiven:
            blockers = list(forgive)
            continue
        m = margin if i != frames else 0.0
        for payload, blo, _bhi in grid.hits(lo, hi, exclude=piece_id, margin=m if m > 0 else 0.0):
            if payload in skip:
                continue
            if i == frames:
                if payload in allow_final:
                    continue
                blockers.append(f"{payload[0]}@final")
                return CorridorResult(False, frames, margin, blockers)
            blockers.append(payload[0])
            return CorridorResult(False, frames, margin, blockers)
    return CorridorResult(True, frames, margin, blockers)


def contact_area(lo1: np.ndarray, hi1: np.ndarray, lo2: np.ndarray, hi2: np.ndarray, tol: float = 1.5) -> float:
    """Largest face-contact cross-section between two boxes (LDraw native space, up = -y)."""
    best = 0.0
    for k in range(3):
        i, j = [a for a in range(3) if a != k]
        sep = max(lo1[k] - hi2[k], lo2[k] - hi1[k])
        if abs(sep) > tol:
            continue
        o1 = min(hi1[i], hi2[i]) - max(lo1[i], lo2[i])
        o2 = min(hi1[j], hi2[j]) - max(lo1[j], lo2[j])
        if o1 <= 1.0 or o2 <= 1.0:
            continue
        best = max(best, o1 * o2)
    return best


def axis_value(v: np.ndarray, axis: int) -> float:
    return float(v[axis])
