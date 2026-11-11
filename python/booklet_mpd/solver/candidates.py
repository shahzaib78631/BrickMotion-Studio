"""Candidate poses for a new part: every way it can connect to the model built so far.

Studs, anti-studs, open studs, tubes and bar/clip contacts come from the BrickNet connector
catalogue (`brickheadz.connectors`); Technic pins, axles and holes come from LDCad cylinder snaps
(`technic_candidates`). A pose is kept once (translation to 0.5 LDU, rotation to 0.01). Collisions are
pruned later with the exact mesh oracle (only for the candidates that matter, it is the slow part).
"""
from __future__ import annotations

import numpy as np

from brickheadz.connectors import MALE, build_graph, catalog, dedupe_poses, free_connectors, snap_candidates

YAWS = (0, 90, 180, 270)


def _key(m: np.ndarray) -> tuple:
    return tuple(np.round(m[:3, 3] * 2).astype(int)) + tuple(np.round(m[:3, :3].ravel(), 2))


def stud_candidates(part: str, base: list, cat=None) -> list[dict]:
    """Poses joining one connector of `part` to a free connector of `base` [(id, colour, 4x4)]."""
    cat = cat or catalog()
    if not base:
        return []
    names = [p for p, _c, _m in base]
    matrices = [np.asarray(m, float) for _p, _c, m in base]
    g = build_graph(names, [c for _p, c, _m in base], matrices, cat)
    free = free_connectors(g, matrices, cat)
    out = snap_candidates(part, free, cat, yaws=YAWS)
    for c in out:
        c["kind"] = "stud"
        conn = cat.connectors(names[c["host"]])[c["host_conn"]]
        if conn.family == "stud":
            w = matrices[c["host"]] @ conn.frame
            axis = -w[:3, 1]
            c["axis"] = axis if conn.sub in MALE else -axis     # the side the new part comes from
    return out


def candidates(lib, part: str, base: list, cat=None) -> list[dict]:
    """All connection candidates (studs/clips, then Technic) without duplicates."""
    from .technic import technic_candidates

    out = stud_candidates(part, base, cat)
    out += technic_candidates(lib, part, base)
    return dedupe_poses(out)


def has_connectors(lib, part: str, cat=None) -> bool:
    from .technic import cylinder_snaps

    cat = cat or catalog()
    return bool(cat.connectors(part)) or bool(cylinder_snaps(lib, part))


def same_pose(a: np.ndarray, b: np.ndarray) -> bool:
    return _key(a) == _key(b)
