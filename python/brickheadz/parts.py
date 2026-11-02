"""Curated studs-up brick vocabulary, measured from the LDraw library.

Only the shapes the generator actually places are measured. Footprints and
heights come from the part's **body box** — the full AABB with each outward male
stud pulled back — so a side-stud brick is measured by its body, not its stud.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from assembly_model.ldraw import LDrawLibrary

LDU_STUD = 20.0
LDU_PLATE = 8.0
STUD_LEN = 4.0  # stud protrusion above a part's top face, LDU

# Part ids used to tile regions; footprints are measured (info) so orientation
# is never guessed wrong.
BRICKS = ["3001", "3002", "3003", "3010", "3004", "3005"]
PLATES = ["3020", "3021", "3022", "3710", "3023", "3024"]
TILES = ["87079", "2431", "3069b", "98138"]

HEAD_SNOT = "22885"  # Brick 1x2x1.667 with 4 studs on 1 side (5 plates tall)
BASE_PLATE = "3958"  # Plate 6 x 6
EYE = "4073"  # Plate 1 x 1 Round


@dataclass(frozen=True)
class PartInfo:
    part: str
    w: int
    d: int
    h: int  # plates
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]
    top_studs: bool
    side_studs: bool


_cache: dict[str, PartInfo] = {}


def description(lib: LDrawLibrary, part: str, depth: int = 0) -> str:
    """Human-readable part description; follows ``~Moved to`` alias stubs."""
    path = lib.find(part if part.endswith(".dat") else part + ".dat")
    if not path:
        return ""
    try:
        with open(path, errors="ignore") as f:
            line = f.readline().strip()
    except OSError:
        return ""
    text = line[1:].strip() if line.startswith("0") else line
    lowered = text.lower()
    if depth < 3 and lowered.startswith("~moved to"):
        target = text.split()[-1]
        resolved = description(lib, target, depth + 1)
        if resolved:
            return resolved
    return text


def info(lib: LDrawLibrary, part: str) -> PartInfo:
    key = part.lower().replace(".dat", "")
    if key in _cache:
        return _cache[key]
    name = key + ".dat"
    tri = lib.triangles(name)
    if tri.size == 0:
        raise KeyError(f"part not found in LDraw library: {part}")
    lo = np.array(tri.min(0))
    hi = np.array(tri.max(0))
    snaps = lib.snaps(name)
    # Body box = full box with every outward male stud pulled back by its
    # protrusion. Placement centres the BODY (as the studio's metrics do), not
    # the stud-inflated box: a side stud makes the AABB asymmetric, and centring
    # that would shift the body half a stud off the grid.
    body_lo, body_hi = lo.copy(), hi.copy()
    faces: set[tuple[int, int]] = set()
    for s in snaps:
        if s.gender != "M":
            continue
        axis = np.asarray(s.axis, dtype=float)
        if abs(float(np.linalg.norm(axis)) - 1.0) > 0.05:  # not a unit direction
            continue
        i = int(np.argmax(np.abs(axis)))
        if abs(axis[i]) < 0.9:
            continue
        faces.add((i, 1 if axis[i] > 0 else -1))
    top_studs = (1, -1) in faces
    side_studs = any(i in (0, 2) for i, _ in faces)
    for i, sign in faces:
        if sign < 0:
            body_lo[i] += STUD_LEN
        else:
            body_hi[i] -= STUD_LEN
    h = int(round((body_hi[1] - body_lo[1]) / LDU_PLATE))
    w = max(1, int(round((body_hi[0] - body_lo[0]) / LDU_STUD)))
    d = max(1, int(round((body_hi[2] - body_lo[2]) / LDU_STUD)))
    pi = PartInfo(key, w, d, max(1, h), tuple(float(v) for v in body_lo), tuple(float(v) for v in body_hi), top_studs, side_studs)
    _cache[key] = pi
    return pi
