"""Assembly graph: world snap joints (LDCad shadow), contact adjacency, supports."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .certify import contact_area
from .geometry import BoxGrid, aabb
from .ldraw import LDrawLibrary, Snap
from .model import Piece


@dataclass
class Joint:
    parent: str
    child: str
    kind: str
    axis: tuple[float, float, float]
    confidence: str
    point: tuple[float, float, float] = (0.0, 0.0, 0.0)


@dataclass
class Assembly:
    lib: LDrawLibrary
    pieces: list[Piece]
    boxes: dict[str, tuple[np.ndarray, np.ndarray]]
    joints: list[Joint] = field(default_factory=list)
    min_y: float = 0.0
    ground_y: float = 0.0
    joints_by_child: dict = field(default_factory=dict)
    joints_by_parent: dict = field(default_factory=dict)

    @property
    def by_key(self) -> dict[str, Piece]:
        return {p.key: p for p in self.pieces}


def build_assembly(lib: LDrawLibrary, pieces: list[Piece]) -> Assembly:
    from .geometry import BoxGrid

    boxes: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for p in pieces:
        tri = lib.triangles(p.part)
        if tri.size == 0:
            continue
        world = tri @ p.matrix[:3, :3].T + p.matrix[:3, 3]
        boxes[p.key] = (world.min(0).round(2), world.max(0).round(2))
    asm = Assembly(lib=lib, pieces=[p for p in pieces if p.key in boxes], boxes=boxes)
    asm.min_y = float(min(b[0][1] for b in boxes.values()))
    asm.ground_y = float(max(b[1][1] for b in boxes.values()))
    asm.joints = _joints(asm) + _contacts(asm)
    for j in asm.joints:
        asm.joints_by_child.setdefault(j.child, []).append(j)
        asm.joints_by_parent.setdefault(j.parent, []).append(j)
    return asm


def _neighbor_pairs(boxes: dict[str, tuple[np.ndarray, np.ndarray]], margin: float = 40.0) -> list[tuple[str, str]]:
    grid = BoxGrid(cell=120.0)
    keys = list(boxes)
    for i, k in enumerate(keys):
        grid.add(*boxes[k], (k, i))
    out: set[tuple[str, str]] = set()
    for i, k in enumerate(keys):
        lo, hi = boxes[k]
        for payload, _blo, _bhi in grid.hits(lo - margin, hi + margin, exclude=(k, i)):
            other = payload[0]
            pair = (k, other) if k < other else (other, k)
            out.add(pair)
    return sorted(out)


def _world_snaps(asm: Assembly) -> dict[str, list[tuple[Snap, np.ndarray, np.ndarray]]]:
    out: dict[str, list[tuple[Snap, np.ndarray, np.ndarray]]] = {}
    for p in asm.pieces:
        snaps = asm.lib.snaps(p.part)
        if not snaps:
            continue
        r = p.matrix[:3, :3]
        t = p.matrix[:3, 3]
        rows = []
        for s in snaps:
            axis = _unit(r @ np.array(s.axis))
            pos = r @ np.array(s.pos) + t
            rows.append((s, pos, axis))
        out[p.key] = rows
    return out


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if n < 0.1:
        return np.array([0.0, -1.0, 0.0])
    if abs(n - 1.0) > 0.05:
        idx = int(np.argmax(np.abs(v)))
        card = np.zeros(3)
        card[idx] = np.sign(v[idx])
        return card
    return v


def _joints(asm: Assembly) -> list[Joint]:
    """Order joints from LDCad shadow snaps plus implied sockets.

    Joints are emitted in both orientations (either side may travel); corridor
    certification picks the direction that is actually buildable. Spatial
    buckets keep the M/F and implied-socket passes subquadratic on big models.
    """
    snaps = _world_snaps(asm)
    joint: list[Joint] = []
    keys = list(snaps)
    card = lambda v: tuple(_snap_axis(np.asarray(v)))
    # spatial buckets for female snaps (cell 8 LDU; mates sit within ~6 LDU)
    buckets: dict[tuple, list[tuple[str, Snap, np.ndarray, np.ndarray]]] = {}
    for bkey in keys:
        for sb, pb, xb in snaps[bkey]:
            if sb.gender != "F":
                continue
            cell = tuple(int(v) for v in np.floor(pb / 8.0))
            buckets.setdefault(cell, []).append((bkey, sb, pb, xb))
    # pass 1: explicit male <-> female shadow matches
    for a in keys:
        for sa, pa, xa in snaps[a]:
            if sa.gender != "M":
                continue
            bucket = tuple(int(v) for v in np.floor(pa / 8.0))
            cands = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        cands.extend(buckets.get((bucket[0] + dx, bucket[1] + dy, bucket[2] + dz), ()))
            best: tuple[float, str] | None = None
            seen: set[str] = set()
            for bkey, sb, pb, xb in cands:
                if bkey == a or bkey in seen:
                    continue
                seen.add(bkey)
                gap = float(np.linalg.norm(pa - pb))
                if gap > 6.0 or float(abs(xa @ xb)) < 0.9:
                    continue
                if best is None or gap < best[0]:
                    best = (gap, bkey)
            if best is None:
                continue
            joint.append(Joint(parent=best[1], child=a, kind=sa.kind, axis=card(xa), confidence="snap", point=tuple(np.round(pa, 1))))
            joint.append(Joint(parent=a, child=best[1], kind=sa.kind, axis=card(-xa), confidence="snap-rev", point=tuple(np.round(pa, 1))))
    # pass 2: implied sockets — a male seek whose receiver face is another piece's plane
    paired = {(j.parent, j.child) for j in joint}
    bgrid = BoxGrid(cell=60.0)
    for i, k in enumerate(asm.boxes):
        bgrid.add(*asm.boxes[k], (k, i))
    for a in keys:
        for sa, pa, xa in snaps[a]:
            if sa.gender != "M" or abs(xa[1]) < 0.9:
                continue
            near: set[str] = set()
            lo_q, hi_q = pa - np.array([9.0, 9.0, 9.0]), pa + np.array([9.0, 9.0, 9.0])
            for payload, _blo, _bhi in bgrid.hits(lo_q, hi_q):
                near.add(payload[0])
            for b in sorted(near):
                if b == a or (a, b) in paired or (b, a) in paired:
                    continue
                lb, hb = asm.boxes.get(b, (None, None))
                if lb is None:
                    continue
                face = lb[1] if xa[1] < 0 else hb[1]
                if abs(pa[1] - face) > 6.0:
                    continue
                if not (lb[0] - 4 <= pa[0] <= hb[0] + 4 and lb[2] - 4 <= pa[2] <= hb[2] + 4):
                    continue
                joint.append(Joint(parent=a, child=b, kind="socket", axis=(0.0, -1.0, 0.0), confidence="implied", point=tuple(np.round(pa, 1))))
                joint.append(Joint(parent=b, child=a, kind="socket", axis=(0.0, 1.0, 0.0), confidence="implied-rev", point=tuple(np.round(pa, 1))))

    # pass 3: deep interlocks (minifig arm/torso style) with no snap or face signal
    for a, b in _neighbor_pairs(asm.boxes, margin=0.0):
        if (a, b) in paired or (b, a) in paired:
            continue
        la, ha = asm.boxes.get(a, (None, None))
        lb, hb = asm.boxes.get(b, (None, None))
        if la is None or lb is None:
            continue
        ov = np.minimum(ha, hb) - np.maximum(la, lb)
        if (ov <= 0).any():
            continue
        k = int(np.argmin(ov))
        axis = np.zeros(3)
        axis[k] = 1.0
        for axis_v, conf in ((axis, "interlock"), (-axis, "interlock-rev")):
            joint.append(Joint(parent=a, child=b, kind="interlock", axis=card(axis_v), confidence=conf))
    out: list[Joint] = []
    seen: set[tuple] = set()
    for j in joint:
        mark = (j.parent, j.child, card(j.axis))
        if j.parent == j.child or mark in seen:
            continue
        seen.add(mark)
        out.append(j)
    return out


def _snap_axis(v: np.ndarray) -> np.ndarray:
    idx = int(np.argmax(np.abs(v)))
    out = np.zeros(3)
    out[idx] = float(np.sign(v[idx]) or 1.0)
    return out


def _contacts(asm: Assembly) -> list[Joint]:
    """Face contact where child bottom (max y) meets parent top (min y), up = -y."""
    out: list[Joint] = []
    existing = {(j.parent, j.child) for j in asm.joints}
    for a, b in _neighbor_pairs(asm.boxes, margin=4.0):
        la, ha = asm.boxes[a]
        lb, hb = asm.boxes[b]
        if contact_area(la, ha, lb, hb, tol=1.5) <= 0:
            continue
        if abs(ha[1] - lb[0]) < 1.5:
            child, parent = a, b
        elif abs(hb[1] - la[0]) < 1.5:
            child, parent = b, a
        else:
            continue
        if (parent, child) in existing or (child, parent) in existing:
            continue
        existing.add((parent, child))
        out.append(Joint(parent=parent, child=child, kind="face", axis=(0.0, -1.0, 0.0), confidence="contact"))
    return out


def supported(asm: Assembly, key: str, placed: set[str]) -> bool:
    lo, hi = asm.boxes[key]
    if abs(hi[1] - asm.ground_y) < 2.5:
        return True
    for j in asm.joints_by_child.get(key, ()):
        if j.parent in placed:
            return True
    for j in asm.joints_by_parent.get(key, ()):
        if j.child in placed:
            return True
    for other in placed:
        if other == key or other not in asm.boxes:
            continue
        olo, ohi = asm.boxes[other]
        if abs(float(olo[1]) - float(hi[1])) < 1.6:
            ox = min(hi[0], ohi[0]) - max(lo[0], olo[0])
            oz = min(hi[2], ohi[2]) - max(lo[2], olo[2])
            if ox > 4.0 and oz > 4.0:
                return True
    return False
