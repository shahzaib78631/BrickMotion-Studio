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


def flush_candidates(lib, part: str, base: list, max_base: int = 8) -> list[dict]:
    """Grid-aligned side-by-side flush poses for early steps where plates/bricks sit adjacent on the
    same level before later steps tie them together (e.g. step 1 pairs, 41605 step 3)."""
    if not base or len(base) > max_base:
        return []
    from .render import mesh, world_triangles
    t_local = mesh(lib, part).reshape(-1, 3)
    if not len(t_local):
        return []
    # Only generate flush poses for brick/plate-like parts aligned to the stud lattice
    out: list[dict] = []
    rots = []
    for deg in (0, 90):
        a = np.radians(deg)
        c, s = round(float(np.cos(a))), round(float(np.sin(a)))
        R = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
        v = t_local @ R.T
        lo, hi = v.min(0), v.max(0)
        sx, sz = hi[0] - lo[0], hi[2] - lo[2]
        if sx < 15.0 or sz < 15.0:
            continue
        rots.append((R, lo, hi))
    if not rots:
        return []
    for hi_idx, (hp, _hc, hm) in enumerate(base):
        hm = np.asarray(hm, float)
        if not np.allclose(hm[:3, 1], [0.0, 1.0, 0.0], atol=1e-2):
            continue
        hv = world_triangles(lib, hp, hm).reshape(-1, 3)
        if not len(hv):
            continue
        hlo, hhi = hv.min(0), hv.max(0)
        # Snap host bounds to nearest 10 LDU horizontally (stud half-pitch)
        hx0, hx1 = round(hlo[0] / 10.0) * 10.0, round(hhi[0] / 10.0) * 10.0
        hz0, hz1 = round(hlo[2] / 10.0) * 10.0, round(hhi[2] / 10.0) * 10.0
        hy_bot = round(hhi[1] / 2.0) * 2.0
        for R, lo, hi in rots:
            px0, px1 = round(lo[0] / 10.0) * 10.0, round(hi[0] / 10.0) * 10.0
            pz0, pz1 = round(lo[2] / 10.0) * 10.0, round(hi[2] / 10.0) * 10.0
            py_bot = round(hi[1] / 2.0) * 2.0
            ty = hy_bot - py_bot
            pw, pd = px1 - px0, pz1 - pz0
            # Flush along +X and -X edges
            for tx in (hx1 - px0, hx0 - px1):
                z_start = hz0 - pd + 20.0 - pz0
                z_end = hz1 - 20.0 - pz0
                for tz in np.arange(z_start, z_end + 0.1, 20.0):
                    m = np.eye(4)
                    m[:3, :3] = R
                    m[:3, 3] = [tx, ty, float(tz)]
                    out.append({"matrix": m, "host": hi_idx, "kind": "flush", "axis": np.array([0.0, -1.0, 0.0])})
            # Flush along +Z and -Z edges
            for tz in (hz1 - pz0, hz0 - pz1):
                x_start = hx0 - pw + 20.0 - px0
                x_end = hx1 - 20.0 - px0
                for tx in np.arange(x_start, x_end + 0.1, 20.0):
                    m = np.eye(4)
                    m[:3, :3] = R
                    m[:3, 3] = [float(tx), ty, tz]
                    out.append({"matrix": m, "host": hi_idx, "kind": "flush", "axis": np.array([0.0, -1.0, 0.0])})
    return out


def candidates(lib, part: str, base: list, cat=None) -> list[dict]:
    """All connection candidates (native C++ Shadow+Studio+BrickNet engine + BrickNet studs/joints) without duplicates."""
    from . import native_bridge
    from .joints import joint_candidates
    from .technic import technic_candidates

    out = stud_candidates(part, base, cat)
    out += joint_candidates(part, base, cat)
    eng = native_bridge.engine()
    if eng is not None:
        out += eng.candidates(part, base)
    else:
        out += technic_candidates(lib, part, base)
    out += flush_candidates(lib, part, base)
    return dedupe_poses(out)


def has_connectors(lib, part: str, cat=None) -> bool:
    from .technic import cylinder_snaps

    cat = cat or catalog()
    return bool(cat.connectors(part)) or bool(cylinder_snaps(lib, part))


def same_pose(a: np.ndarray, b: np.ndarray) -> bool:
    return _key(a) == _key(b)
