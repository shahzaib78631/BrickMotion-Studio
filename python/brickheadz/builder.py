"""Procedural BrickHeadz construction on a stud/plate grid.

Places real bricks on an integer grid (x/z in studs, y in plates, +y up) using the
same placement convention as the studio's plan format, plus SNOT pieces placed by
explicit matrix. The figure follows the grammar learned in Phase 1: a wide
side-stud-brick head, a smaller brick body, short legs/feet, an optional 6x6
stand, a mounted face and a topped-off hair style.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from assembly_model.ldraw import LDrawLibrary
from brickheadz.parts import BASE_PLATE, BRICKS, EYE, HEAD_SNOT, PLATES, STUD_LEN, TILES, PartInfo, info
from brickheadz.inventory import InventoryShortfall


@dataclass
class Placed:
    part: str  # no extension
    color: int
    matrix: np.ndarray  # 4x4, part -> model (LDU)
    role: str = ""
    grid: tuple[int, int, int, int] | None = None  # (x, y, z, rot) when axis-aligned about Y
    raw: bool = False  # side-stud parts: the studio's grid convention shifts their body


@dataclass
class Model:
    name: str
    pieces: list[Placed] = field(default_factory=list)


def rot_matrix(rot: int) -> np.ndarray:
    r = np.radians(rot)
    c, s = round(float(np.cos(r))), round(float(np.sin(r)))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=float)


def _rotate_box(lo, hi, r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    pts = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    q = pts @ r.T
    return q.min(0), q.max(0)


def _grid_matrix(pi: PartInfo, x: float, y: float, z: float, rot: int) -> tuple[np.ndarray, int, int]:
    r = rot_matrix(rot)
    rb_lo, rb_hi = _rotate_box(pi.lo, pi.hi, r)
    fw = max(1, int(round((rb_hi[0] - rb_lo[0]) / 20.0)))
    fd = max(1, int(round((rb_hi[2] - rb_lo[2]) / 20.0)))
    pos = np.array(
        [
            (x + fw / 2) * 20 - (rb_lo[0] + rb_hi[0]) / 2,
            -y * 8 - rb_hi[1],
            (z + fd / 2) * 20 - (rb_lo[2] + rb_hi[2]) / 2,
        ]
    )
    m = np.eye(4)
    m[:3, :3] = r
    m[:3, 3] = pos
    return m, fw, fd


# rotations that map a part's local "up" (0,-1,0) onto each outward face normal
_FACES = {
    (0, 0, -1): np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float),  # Rx(90)
    (0, 0, 1): np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float),  # Rx(-90)
    (-1, 0, 0): np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], dtype=float),  # Rz(-90)
    (1, 0, 0): np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], dtype=float),  # Rz(90)
}


class Build:
    """Accumulates pieces and enforces non-overlap on the plate-cell grid."""

    def __init__(self, lib: LDrawLibrary, name: str, inventory=None, fill=None, tiles=None, head_snot=HEAD_SNOT, base_plate=BASE_PLATE):
        self.lib = lib
        self.model = Model(name)
        self.cells: dict[tuple[int, int, int], int] = {}
        self.head_frame: dict | None = None
        # When set, shape counts are consumed and exhausted parts are refused.
        self.inventory = inventory
        self.budget = dict(inventory.parts) if inventory is not None else None
        # Fill vocabulary bucketed by height in plates (bricks, plates, slopes,
        # curved slopes…), so any solid shape of the right height can serve.
        self.fill = fill or {1: PLATES, 3: BRICKS}
        self.tiles = tiles or TILES
        # None disables the SNOT head shell (no suitable side-stud bricks on hand).
        self.head_snot = head_snot
        # None fills a 6x6 stand from plates instead of a dedicated base plate.
        self.base_plate = base_plate

    def _budget_take(self, part: str, skip_if_missing: bool = False) -> bool:
        part = part.replace(".dat", "")
        if self.budget is None:
            return True
        if self.budget.get(part, 0) <= 0:
            if skip_if_missing:
                return False
            raise InventoryShortfall(part)
        self.budget[part] -= 1
        return True

    def studs_up(self, part: str, color: int, x: int, y: int, z: int, rot: int = 0, role: str = "") -> int:
        pi = info(self.lib, part)
        m, fw, fd = _grid_matrix(pi, x, y, z, rot)
        self._budget_take(part)
        for cx in range(x, x + fw):
            for cz in range(z, z + fd):
                for cy in range(y, y + pi.h):
                    cell = (cx, cz, cy)
                    if cell in self.cells:
                        raise ValueError(f"cell {cell} already occupied (placing {part} at {x},{y},{z})")
                    self.cells[cell] = len(self.model.pieces)
        self.model.pieces.append(Placed(part, color, m, role, (x, y, z, rot), pi.side_studs))
        return len(self.model.pieces) - 1

    def mounted(self, part: str, color: int, stud: np.ndarray, normal, role: str = "") -> int:
        """Place a piece on a sideways stud: its contact face flush on the stud tip."""
        if not self._budget_take(part, skip_if_missing=True):
            return -1
        pi = info(self.lib, part)
        r = _FACES[normal]
        rb_lo, rb_hi = _rotate_box(pi.lo, pi.hi, r)
        axis = 0 if normal[0] else (1 if normal[1] else 2)
        thickness = rb_hi[axis] - rb_lo[axis]
        center = stud + np.array(normal) * (STUD_LEN + thickness / 2.0)
        local_center = (np.array(pi.lo) + np.array(pi.hi)) / 2.0
        m = np.eye(4)
        m[:3, :3] = r
        m[:3, 3] = center - r @ local_center
        self.model.pieces.append(Placed(part, color, m, role, None, True))
        return len(self.model.pieces) - 1

    def raw(self, part: str, color: int, matrix: np.ndarray, role: str = "") -> int:
        """Place a piece from an explicit matrix (learned patterns, side builds)."""
        if not self._budget_take(part, skip_if_missing=True):
            return -1
        self.model.pieces.append(Placed(part, color, np.asarray(matrix, dtype=float), role, None, True))
        return len(self.model.pieces) - 1


def _tile(lib: LDrawLibrary, w: int, d: int, parts, budget=None) -> list[tuple[str, int, int, int]]:
    """Greedy tiling of a w×d stud rectangle. Returns (part, dx, dz, rot).

    When a shape budget is given, a shape is only used while it still has pieces
    left (accounting for the shapes already planned in this call).
    """
    grid = [[False] * d for _ in range(w)]
    out: list[tuple[str, int, int, int]] = []
    planned: dict[str, int] = {}
    order = sorted(parts, key=lambda p: -(info(lib, p).w * info(lib, p).d))
    for i in range(w):
        for j in range(d):
            if grid[i][j]:
                continue
            placed = False
            for part in order:
                if budget is not None and budget.get(part, 0) - planned.get(part, 0) <= 0:
                    continue
                pi = info(lib, part)
                cands = [(pi.w, pi.d, 0)] if pi.w == pi.d else [(pi.w, pi.d, 0), (pi.d, pi.w, 90)]
                for ow, od, rot in cands:
                    if i + ow <= w and j + od <= d and all(not grid[a][b] for a in range(i, i + ow) for b in range(j, j + od)):
                        for a in range(i, i + ow):
                            for b in range(j, j + od):
                                grid[a][b] = True
                        out.append((part, i, j, rot))
                        planned[part] = planned.get(part, 0) + 1
                        placed = True
                        break
                if placed:
                    break
            if not placed:
                raise ValueError(f"cannot tile {w}x{d} rectangle (inventory exhausted)")
    return out


def _course_heights(h: int, heights) -> list[int]:
    """Decompose a target height into courses from the available part heights."""
    avail = sorted({int(x) for x in heights if x > 0}, reverse=True)
    out: list[int] = []
    left = h
    while left > 0:
        pick = next((x for x in avail if x <= left), None)
        if pick is None:
            raise ValueError(f"cannot build a {h}-plate course from heights {avail}")
        out.append(pick)
        left -= pick
    return out


def fill_box(b: Build, x: int, z: int, w: int, d: int, y: int, h: int, color, role: str) -> None:
    """Fill a rectangular region, choosing each course by what can actually tile.

    Tries the tallest available part height first and falls back to shorter ones
    when the inventory can't cover the rectangle at that height, so a set with
    plenty of 2-plate slopes and 1-plate plates still fills a tall body.
    """
    cy = y
    left = h
    while left > 0:
        chosen = None
        for ch in sorted(b.fill, reverse=True):
            if ch > left:
                continue
            try:
                plan = _tile(b.lib, w, d, b.fill[ch], b.budget)
            except ValueError:
                continue  # not enough pieces of this height left: try shorter
            chosen = (ch, plan)
            break
        if chosen is None:
            raise ValueError(f"cannot fill {w}x{d} region with {left} plates left")
        ch, plan = chosen
        for part, dx, dz, rot in plan:
            b.studs_up(part, color, x + dx, cy, z + dz, rot, role)
        cy += ch
        left -= ch


def fill_plate(b: Build, x: int, z: int, w: int, d: int, y: int, color, role: str, tiles: bool = False) -> None:
    parts = b.tiles if tiles else b.fill.get(1, PLATES)
    for part, dx, dz, rot in _tile(b.lib, w, d, parts, b.budget):
        b.studs_up(part, color, x + dx, y, z + dz, rot, role)


def _ring(b: Build, x: int, z: int, w: int, d: int, y: int, color: int, face_color: int) -> None:
    """One course of the head shell; the front face may use a different colour."""
    part = b.head_snot
    for fx in range(x, x + w, 2):
        b.studs_up(part, face_color, fx, y, z, 0, "head")  # front (-z)
        b.studs_up(part, color, fx, y, z + d - 1, 180, "head")  # back (+z)
    for fz in range(z + 1, z + d - 1, 2):
        b.studs_up(part, color, x, y, fz, 90, "head")  # left (-x)
        b.studs_up(part, color, x + w - 1, y, fz, 270, "head")  # right (+x)


def build_head(b: Build, x: int, z: int, w: int, d: int, y: int, courses: int, spec) -> int:
    """Head = bottom plate + N courses + top plate. Returns the top plate index."""
    fill_plate(b, x, z, w, d, y, spec.color_accent, "head_cap")
    cy = y + 1
    if b.head_snot is not None:
        course_h = info(b.lib, b.head_snot).h
        face_color = spec.color_face if getattr(spec, "color_face", -1) >= 0 else spec.color_head
        for _ in range(courses):
            _ring(b, x, z, w, d, cy, spec.color_head, face_color)
            fill_box(b, x + 1, z + 1, w - 2, d - 2, cy, course_h, spec.color_head, "head_core")
            cy += course_h
    else:
        # no side-stud bricks on hand: a plain studs-up head block, same height
        fill_box(b, x, z, w, d, cy, courses * 5, spec.color_head, "head_core")
        cy += courses * 5
    # studs on top so headwear/hair attaches (and matches real BrickHeadz caps)
    fill_plate(b, x, z, w, d, cy, spec.color_accent, "head_cap")
    return cy + 1


def mount_eyes(b: Build, hx: int, w: int, hz: int, course_bottom: int, spec) -> None:
    """Two round eyes on the upper front SNOT studs of a head course.

    Front face plane is LDU z = hz*20; studs sit 4 LDU proud of it and at
    half-stud x offsets. Cells are chosen symmetric about the head centre.
    """
    left = hx + w // 2 - 2
    right = hx + w // 2 + 1
    y_stud = -8 * course_bottom - 30  # upper stud (local y=10) of a 22885 course
    for cell in (left, right):
        stud = np.array([cell * 20 + 10.0, float(y_stud), hz * 20.0])
        b.mounted(EYE, spec.color_eye, stud, (0, 0, -1), "face")


def _one_by_one(b: Build, height: int) -> str | None:
    """An available 1x1 part of the given plate height (for per-cell front colour)."""
    for part in b.fill.get(height, []):
        pi = info(b.lib, part)
        if pi.w == 1 and pi.d == 1 and (b.inventory is None or b.inventory.has(part)):
            return part
    return None


def _fill_torso_front(b: Build, cx: int, cz: int, Bd: int, y: int, h: int, spec, center: int, width: int) -> None:
    """Torso whose front (1-stud-deep) row is tiled with 1x1 pieces for a colour stripe."""
    start = (Bd - width) // 2
    centre_cols = set(range(start, start + width))
    cy = y
    for ch in _course_heights(h, b.fill.keys()):
        one = _one_by_one(b, ch)
        if one is None:
            fill_box(b, cx, cz, Bd, Bd, cy, ch, spec.color_body, "torso")
        else:
            for x in range(Bd):
                col = center if x in centre_cols else spec.color_body
                b.studs_up(one, col, cx + x, cy, cz, 0, "torso")
            if Bd > 1:
                fill_box(b, cx, cz + 1, Bd, Bd - 1, cy, ch, spec.color_body, "torso")
        cy += ch


def _build_torso(b: Build, cx: int, cz: int, Bd: int, y: int, spec) -> int:
    """Torso, with thin accent bands and an optional centre front stripe."""
    belt = getattr(spec, "trim_belt", -1)
    collar = getattr(spec, "trim_collar", -1)
    center = getattr(spec, "trim_center", -1)
    width = getattr(spec, "trim_center_width", 2)
    by, remaining = y, spec.body_h
    if belt >= 0 and remaining >= 2:
        fill_plate(b, cx, cz, Bd, Bd, by, belt, "torso")
        by += 1
        remaining -= 1
    collar_y = None
    if collar >= 0 and remaining >= 2:
        collar_y = by + remaining - 1
        remaining -= 1
    if center >= 0 and remaining >= 1:
        _fill_torso_front(b, cx, cz, Bd, by, remaining, spec, center, width)
    else:
        fill_box(b, cx, cz, Bd, Bd, by, remaining, spec.color_body, "torso")
    if collar_y is not None:
        fill_plate(b, cx, cz, Bd, Bd, collar_y, collar, "torso")
    return y + spec.body_h


def _mount_clip(b: Build, hx: int, Hw: int, hz: int, head_ground: int, courses: int, color: int) -> None:
    """A small 1x1 round tile mounted on the head's front-top stud as a hair clip."""
    top_course = head_ground + 1 + (courses - 1) * 5
    cell = hx + Hw - 1
    stud = np.array([cell * 20 + 10.0, -8 * top_course - 30, hz * 20.0])
    b.mounted("98138", color, stud, (0, 0, -1), "hair")


def _mount_arms(b: Build, cx: int, cz: int, Bd: int, body_start: int, body_top: int, color: int) -> None:
    """A 1x1 plate on each side at shoulder height (a hand / claws / arm nub)."""
    y = max(body_start, body_top - 3)
    z = cz + Bd // 2 - 1
    for x in (cx - 1, cx + Bd):
        try:
            b.studs_up("3024", color, x, y, z, 0, "arm")
        except (InventoryShortfall, ValueError):
            pass


def _mount_cape(b: Build, cx: int, cz: int, Bd: int, body_start: int, body_top: int, color: int) -> None:
    """A thin plate wall one stud behind the torso, from the belt to the shoulders."""
    z = cz + Bd
    for yy in range(body_start, body_top):
        for xx in range(cx, cx + Bd - 1, 2):
            try:
                b.studs_up("3023", color, xx, yy, z, 0, "cape")
            except (InventoryShortfall, ValueError):
                pass


def build_figure(lib: LDrawLibrary, spec, inventory=None, fill=None, tiles=None, head_snot=HEAD_SNOT, base_plate=BASE_PLATE) -> Build:
    b = Build(lib, spec.name, inventory=inventory, fill=fill, tiles=tiles, head_snot=head_snot, base_plate=base_plate)
    Hw, Bd = spec.head, spec.body
    ground = 0
    if spec.base:
        bw, bd = 6, 6
        bx, bz = -(bw // 2), -(bd // 2)
        if b.base_plate:
            b.studs_up(b.base_plate, spec.color_base, bx, 0, bz, 0, "base")
        else:
            fill_plate(b, bx, bz, bw, bd, 0, spec.color_base, "base")
        ground = 1
    cx = -(Bd // 2)
    cz = -(Bd // 2)
    if spec.leg_h:
        lz = cz + (Bd - 2) // 2
        for lx in (cx, cx + Bd - 2):
            fill_box(b, lx, lz, 2, 2, ground, spec.leg_h, spec.color_leg, "legs")
        ground += spec.leg_h
    body_start = ground
    ground = _build_torso(b, cx, cz, Bd, ground, spec)
    body_top = ground
    if getattr(spec, "trim_arm", -1) >= 0:
        _mount_arms(b, cx, cz, Bd, body_start, body_top, spec.trim_arm)
    if getattr(spec, "prop_cape", -1) >= 0:
        _mount_cape(b, cx, cz, Bd, body_start, body_top, spec.prop_cape)
    hx = hz = -(Hw // 2)
    head_ground = ground
    top = build_head(b, hx, hz, Hw, Hw, ground, spec.head_courses, spec)
    b.head_frame = {
        # The anchor is the head's geometric TOP (the cap plate's stud tips), to
        # match how corpus patterns are measured (they include studs).
        "P": np.array([(hx + Hw / 2) * 20, -(top * 8) - STUD_LEN, (hz + Hw / 2) * 20], dtype=float),
        "w": Hw,
        "d": Hw,
        "front": [0, 0, -1],
    }
    if b.head_snot is not None and spec.eyes != "none" and spec.head_courses >= 1:
        mount_eyes(b, hx, Hw, hz, ground + 1, spec)
    if getattr(spec, "trim_clip", -1) >= 0 and b.head_snot is not None and spec.head_courses >= 1:
        _mount_clip(b, hx, Hw, hz, head_ground, spec.head_courses, spec.trim_clip)
    if spec.hair == "flat":
        fill_plate(b, hx, hz, Hw, Hw, top, spec.color_hair, "hair", tiles=True)
    elif spec.hair == "cap":
        fill_box(b, hx + 1, hz + 1, Hw - 2, Hw - 2, top, 1, spec.color_hair, "hair")
        fill_plate(b, hx, hz, Hw, Hw, top + 1, spec.color_hair, "hair", tiles=True)
    return b
