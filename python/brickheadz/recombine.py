"""Compose a figure from the procedural base plus learned headwear/hair patterns.

A pattern is expressed relative to its source head's top centre; here it is
rotated to face forward, optionally nudged vertically to seat cleanly, and
re-anchored on the generated head's top centre. Pieces are placed by explicit
matrix (they keep their exact relative poses, including SNOT rotations). Finally
a conservative repair drops only the pieces that still interpenetrate or end up
disconnected, so every emitted figure stays certifiable.
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np

from brickheadz import patterns as patterns_mod
from brickheadz.builder import Build, build_figure

# Real interpenetration means a large share of the smaller piece's volume is
# inside the other. A stud seating into an anti-stud, or a piece resting on the
# head (big x/z overlap, a few LDU of y), is far below this fraction.
OVERLAP_FRACTION = 0.3
# Vertical nudges (LDraw y; negative is up) tried to seat a transferred pattern.
OFFSETS = (0.0, -2.0, -4.0, -6.0, 2.0, -8.0, 4.0)


def _to4(r: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = r
    return m


def _decode(flat: list[float]) -> np.ndarray:
    return np.array(flat, dtype=float).reshape(4, 4).T


def _translation(p: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, 3] = p
    return m


def _front_rot(front) -> np.ndarray:
    """Rotation (about Y) that maps the pattern's facing onto -Z."""
    ang = {(0, 0, -1): 0, (0, 0, 1): 180, (1, 0, 0): 90, (-1, 0, 0): 270}[tuple(int(v) for v in front)]
    r = np.radians(ang)
    c, s = round(float(np.cos(r))), round(float(np.sin(r)))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=float)


def _aabb_of(lib, part: str, matrix: np.ndarray):
    tri = lib.triangles(part if part.endswith(".dat") else part + ".dat")
    if tri.size == 0:
        return None
    w = tri @ matrix[:3, :3].T + matrix[:3, 3]
    return w.min(0), w.max(0)


def _pattern_matrices(pattern: dict, frame: dict, dy: float):
    anchor_pos = np.asarray(frame["P"], dtype=float).copy()
    anchor_pos[1] += dy
    anchor = _translation(anchor_pos) @ _to4(_front_rot(pattern["front"]))
    return [(anchor @ _decode(pc["matrix"]), pc) for pc in pattern["pieces"]]


def _deep_overlap(a, b) -> bool:
    ov = np.minimum(a[1], b[1]) - np.maximum(a[0], b[0])
    if not (ov > 0).all():
        return False
    volume = float(np.prod(a[1] - a[0]))
    other = float(np.prod(b[1] - b[0]))
    return float(np.prod(ov)) > OVERLAP_FRACTION * min(volume, other)


def _touching(a, b, gap: float = 1.6) -> bool:
    ov = np.minimum(a[1], b[1]) - np.maximum(a[0], b[0])
    if not (ov > -gap).all():
        return False
    return all(ov[m] > 1.0 for m in range(3)) or any(
        ov[k] >= -gap and all(ov[m] > 1.0 for m in range(3) if m != k) for k in range(3)
    )


def _rigid(m: np.ndarray, tol: float = 1e-6) -> bool:
    r = m[:3, :3]
    return bool(np.allclose(r @ r.T, np.eye(3), atol=tol) and np.isclose(np.linalg.det(r), 1.0, atol=1e-4))


def _best_offset(lib, build: Build, pattern: dict, frame: dict) -> float:
    """Pick the vertical nudge that seats the pattern with least interpenetration."""
    solid = [bb for p in build.model.pieces if (bb := _aabb_of(lib, p.part, p.matrix)) is not None]
    best = None
    for dy in OFFSETS:
        boxes = [b for m, pc in _pattern_matrices(pattern, frame, dy) if (b := _aabb_of(lib, pc["part"], m)) is not None]
        deep = sum(1 for b in boxes if any(_deep_overlap(b, s) for s in solid))
        touch = sum(1 for b in boxes if any(_touching(b, s) for s in solid))
        score = (deep, -touch, abs(dy))
        if best is None or score < best[0]:
            best = (score, dy)
    return best[1] if best else 0.0


def place_pattern(b: Build, pattern: dict, frame: dict, role: str, dy: float = 0.0) -> list[int]:
    return [b.raw(pc["part"], pc["color"], m, role) for m, pc in _pattern_matrices(pattern, frame, dy)]


def repair_placed(lib, build: Build, placed: list[int]) -> int:
    """Keep only the placed pieces that are individually valid and connected."""
    boxes = {i: _aabb_of(lib, p.part, p.matrix) for i, p in enumerate(build.model.pieces)}
    boxes = {i: b for i, b in boxes.items() if b is not None}
    solid = [i for i in boxes if i not in placed]
    kept: list[int] = []
    drop: set[int] = set()
    for i in placed:
        if i not in boxes or not _rigid(build.model.pieces[i].matrix):
            drop.add(i)
            continue
        if any(_deep_overlap(boxes[i], boxes[j]) for j in solid + kept):
            drop.add(i)
            continue
        kept.append(i)
    members = solid + kept
    parent = {i: i for i in members}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a in range(len(members)):
        for b in range(a + 1, len(members)):
            i, j = members[a], members[b]
            if _touching(boxes[i], boxes[j]):
                ra, rb = find(i), find(j)
                if ra != rb:
                    parent[rb] = ra
    roots = {find(i) for i in solid}
    for i in kept:
        if find(i) not in roots:
            drop.add(i)
    if drop:
        build.model.pieces = [p for i, p in enumerate(build.model.pieces) if i not in drop]
    return len(drop)


def build_recombined(lib, spec, pats: dict, rng, use_hair: bool = True, use_face: bool = False) -> Build:
    """Procedural body/head/legs/base + a learned headwear/hair pattern on top."""
    base = replace(spec, hair="none" if use_hair else spec.hair, eyes="none" if use_face else spec.eyes)
    b = build_figure(lib, base)
    frame = b.head_frame
    if use_hair:
        pool = patterns_mod.candidates(pats, "hair", frame["w"], frame["d"])
        if pool:
            pattern = rng.choice(pool)
            placed = place_pattern(b, pattern, frame, "hair", _best_offset(lib, b, pattern, frame))
            repair_placed(lib, b, placed)
    if use_face:
        pool = patterns_mod.candidates(pats, "face", frame["w"], frame["d"])
        if pool:
            pattern = rng.choice(pool)
            # face details mount on the front studs; the vertical nudge would undo that
            placed = place_pattern(b, pattern, frame, "face", 0.0)
            repair_placed(lib, b, placed)
    return b
