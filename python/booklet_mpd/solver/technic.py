"""Technic connection candidates from LDCad cylinder snaps (pins, axles, pin and axle holes).

Only "technic" snaps take part (studs and anti-studs are the stud catalogue's job):
  male:   a cylinder with an axle section ('A') or a round section at least 16 LDU long (pins, axles);
  female: a cylinder with an axle section or a radius-8 collar section (beam / brick holes).
A pair is aligned axis to axis (both directions), turned about the axis by quarter turns, and slid
along it in half-stud steps, using cylinder mid-points. The many infeasible results are pruned by
the collision oracle and the picture; this module only enumerates.
"""
from __future__ import annotations

import numpy as np

SLIDES = (-20.0, -10.0, 0.0, 10.0, 20.0)
TURNS = (0, 90, 180, 270)
MAX_PER_PART = 6000

_SNAPS: dict = {}


def _shapes(snap) -> set[str]:
    return {s[0].strip("_").upper()[:1] for s in snap.sections}


def _is_male_technic(s) -> bool:
    if s.kind != "cyl" or s.gender != "M":
        return False
    return "A" in _shapes(s) or (s.length >= 16 and any(sec[1] in (6.0, 8.0) for sec in s.sections))


def _is_female_technic(s) -> bool:
    if s.kind != "cyl" or s.gender != "F":
        return False
    return "A" in _shapes(s) or any(sec[0].strip("_").upper().startswith("R") and sec[1] == 8.0 for sec in s.sections)


def cylinder_snaps(lib, part: str) -> list[tuple[str, np.ndarray, np.ndarray, bool]]:
    """[(gender, mid-point, unit axis, axle_shaped)] of the part's technic snaps (part space)."""
    key = (id(lib), part)
    if key not in _SNAPS:
        out = []
        try:
            snaps = lib.snaps((part if part.endswith(".dat") else part + ".dat").lower())
        except Exception:
            snaps = ()
        for s in snaps:
            male, female = _is_male_technic(s), _is_female_technic(s)
            if not (male or female):
                continue
            axis = np.array(s.axis, float)
            n = np.linalg.norm(axis)
            if not n:
                continue
            axis /= n
            pos = np.array(s.pos, float)
            mid = pos if s.center else pos + axis * s.length / 2.0
            out.append(("M" if male else "F", mid, axis, "A" in _shapes(s)))
        _SNAPS[key] = out
    return _SNAPS[key]


def _align(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """A rotation taking unit vector a onto unit vector b (axis-aligned inputs give cube rotations)."""
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        if c > 0:
            return np.eye(3)
        perp = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        perp = perp - a * (perp @ a)
        perp /= np.linalg.norm(perp)
        return 2 * np.outer(perp, perp) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def _about(axis: np.ndarray, degrees: float) -> np.ndarray:
    t = np.radians(degrees)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(t) * k + (1 - np.cos(t)) * k @ k


def technic_candidates(lib, part: str, base: list) -> list[dict]:
    mine = cylinder_snaps(lib, part)
    if not mine or not base:
        return []
    hosts = []
    for i, (p, _c, m) in enumerate(base):
        m = np.asarray(m, float)
        for gender, mid, axis, axle in cylinder_snaps(lib, p):
            hosts.append((i, gender, m[:3, :3] @ mid + m[:3, 3], m[:3, :3] @ axis, axle))
    out, seen = [], set()
    for g_mine, mid, axis, axle_mine in mine:
        for host, g_host, hmid, haxis, axle_host in hosts:
            if g_mine == g_host:
                continue
            for flip in (1.0, -1.0):
                r0 = _align(axis, flip * haxis)
                for turn in TURNS:
                    R = _about(haxis, turn) @ r0
                    R = np.round(R, 6)
                    for slide in SLIDES:
                        t = hmid + slide * haxis - R @ mid
                        m = np.eye(4)
                        m[:3, :3], m[:3, 3] = R, t
                        key = tuple(np.round(t * 2).astype(int)) + tuple(np.round(R.ravel(), 2))
                        if key in seen:
                            continue
                        seen.add(key)
                        out.append({"matrix": m, "host": host, "kind": "technic", "slide": slide, "axis": haxis, "bidirectional": True})
                        if len(out) >= MAX_PER_PART:
                            return out
    return out
