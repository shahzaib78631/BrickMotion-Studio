"""Flight choreography for the artifact `animation` block.

Turns certified corridors into a complete staged build animation: every piece
is packed on the ground beside the model, then flies a multi-leg route —
rise, cruise above the static world, descend to the corridor start — and the
studio-side insert travel finishes the placement.

Coordinates: LDraw native space, up = -y. The ground plane is the model's
lowest face (max y). Staged poses are pure translations of the final
placement, so every flight leg is a straight sweep checked against placed
pieces and the remaining staging field.

Trust contracts, mirroring the engine: snap (tier-0) corridors are engine-
trusted rather than swept, so the socket neighborhood legitimately contains
other pieces; a snap piece's final descent into the corridor start therefore
runs through a trusted stretch of the same radius (~clearance LDU), while
its rise/cruise legs stay swept. Approach legs keep the engine's contact
semantics: the piece's axis-shared joint mates are skipped and shallow box
overlaps (≤ 2.5 LDU on at least one axis, like `supported()`) are grazes,
not collisions. Drop tiers (1/2) certify every leg strictly. Hard blocking
only exists when a sweep with skips and grazes still fails — recorded
honestly as `route: false` and consumed as an uncertified unit.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .assembly import Assembly
from .geometry import BoxGrid
from .search import Result

# Flight pacing. The studio's targetSeconds scales the whole build uniformly,
# so these relative values decide proportion only.
FLIGHT_SPEED = 900.0   # LDU per baseline second along approach legs
INSERT_SPEED = 150.0   # the corridor's final travel is visibly slower
GAP_SECONDS = 0.12     # breather between two flights (strictly one flight at a time)
LEAD_SECONDS = 1.0     # a piece materialises on the floor this long before take-off
MARGIN = 6.0           # swept-AABB clearance margin for approach legs
FRAMES = 24
FLIGHT_CLEAR = 48.0    # cruise altitude keeps this much clear above the static world
STAGING_GAP = 8.0      # lateral gap between staged pieces (more than the sweep margin)
STAGING_PAD = 120.0    # space between the model footprint and the staging strip
ROW_WIDTH_MIN = 400.0  # smallest staging row width (20 studs)
GRAZE = 2.5            # tolerated box overlap on at least one axis (as in supported())

KIND = "flight-v1"


@dataclass
class AnimOptions:
    margin: float = MARGIN
    frames: int = FRAMES
    flight_speed: float = FLIGHT_SPEED
    insert_speed: float = INSERT_SPEED
    gap: float = GAP_SECONDS
    lead: float = LEAD_SECONDS
    clearance: float = FLIGHT_CLEAR
    graze: float = GRAZE


def _rounded(v: np.ndarray, places: int = 2) -> list[float]:
    return [round(float(x), places) for x in v]


def _pack_staging(keys: list[str], boxes: dict, ground: float) -> dict[str, np.ndarray]:
    """Shelf packing of every piece, in build order, on the ground behind the build."""
    fx0 = min(b[0][0] for b in boxes.values())
    fx1 = max(b[1][0] for b in boxes.values())
    fz1 = max(b[1][2] for b in boxes.values())
    row_width = max(fx1 - fx0, ROW_WIDTH_MIN)
    x_anchor = fx0
    z_bottom = fz1 + STAGING_PAD  # the strip grows away from the footprint (+z)

    offsets: dict[str, np.ndarray] = {}
    cursor_x = x_anchor
    row_depth = 0.0
    for key in keys:
        lo, hi = boxes[key]
        sx = max(hi[0] - lo[0], 1.0)
        sz = max(hi[2] - lo[2], 1.0)
        if cursor_x - x_anchor > 1e-9 and cursor_x + sx - x_anchor > row_width:
            z_bottom += row_depth + STAGING_GAP
            cursor_x = x_anchor
            row_depth = 0.0
        offsets[key] = np.array([cursor_x - lo[0], ground - hi[1], z_bottom - lo[2]])
        cursor_x += sx + STAGING_GAP
        row_depth = max(row_depth, sz)
    return offsets


def _sweep_leg(grid: BoxGrid, lo: np.ndarray, hi: np.ndarray, own: list, o_from: np.ndarray,
               o_to: np.ndarray, options: AnimOptions, skip: set) -> bool:
    """One straight swept leg, graze-aware: skipped payloads pass, and overlaps
    shallower than `graze` on at least one axis are treated as grazing contact."""
    for i in range(options.frames + 1):
        t = i / options.frames
        blo = lo + o_from + (o_to - o_from) * t
        bhi = hi + o_from + (o_to - o_from) * t
        margin = options.margin if i < options.frames else 0.0
        for payload, other_lo, other_hi in grid.hits(blo, bhi, exclude=own, margin=margin):
            if payload in skip:
                continue
            ov = np.minimum(bhi, other_hi) - np.maximum(blo, other_lo)
            if np.all(ov > options.graze):
                return False
    return True


def _mates(asm: Assembly, key: str, axis: np.ndarray) -> set:
    """Final-pose payloads of the piece's joint mates that share its insertion axis."""
    out: set = set()
    for j in asm.joints_by_child.get(key, ()):
        if abs(float(np.dot(np.asarray(j.axis, dtype=float), axis))) > 0.9:
            out.add((j.parent, 0))
    for j in asm.joints_by_parent.get(key, ()):
        if abs(float(np.dot(np.asarray(j.axis, dtype=float), axis))) > 0.9:
            out.add((j.child, 0))
    return out


def _corridor_band(boxes: dict, key: str, axis: np.ndarray, dist: float) -> set:
    """Payloads of pieces whose final boxes lie in the corridor travel band,
    i.e. inside the hull of the final and corridor-start (hover) poses. They
    are the socket's by-design neighbours, background to a snap insert."""
    lo, hi = boxes[key]
    hover = -axis * dist
    band_lo = np.minimum(lo + hover, lo)
    band_hi = np.maximum(hi + hover, hi)
    out: set = set()
    for other, (olo, ohi) in boxes.items():
        if other == key:
            continue
        if np.all(band_lo - 2.5 < ohi) and np.all(band_hi + 2.5 > olo):
            out.add((other, 0))
    return out


def build_animation(asm: Assembly, result: Result, options: AnimOptions = AnimOptions()) -> dict | None:
    """Returns the artifact `animation` block, or None when nothing can fly."""
    steps = [s for s in result.steps if s.pieces and s.insertion]
    keys = [s.pieces[0] for s in steps if s.pieces[0] in asm.boxes]
    if not keys:
        return None
    boxes = {k: asm.boxes[k] for k in keys}
    ground = float(max(b[1][1] for b in boxes.values()))
    floor = _pack_staging(keys, boxes, ground)
    matrix_of = {p.key: p.matrix for p in asm.pieces}

    placed: set[str] = set()

    def world_grid(pending: list[str]) -> BoxGrid:
        g = BoxGrid()
        for key in placed:
            g.add(*boxes[key], (key, 0))
        for key in pending:
            lo, hi = boxes[key]
            o = floor[key]
            g.add(lo + o, hi + o, (key, 1))
        return g

    raw: list[tuple[str, float, float, float, list[np.ndarray], bool]] = []
    cursor = options.lead
    for step in steps:
        key = step.pieces[0]
        if key not in boxes:
            cursor += options.gap
            continue
        lo, hi = boxes[key]
        axis = np.asarray(step.insertion.axis, dtype=float)
        norm = float(np.linalg.norm(axis))
        if norm < 1e-9 or not np.isfinite(norm):
            cursor += options.gap
            continue
        axis /= norm
        hover = -axis * float(step.insertion.distance)
        pending = [k for k in keys if k not in placed and k != key]
        grid = world_grid(pending)
        o_floor = floor[key]
        static_top = min((b[0][1] for b in grid.boxes), default=ground)
        skip = _mates(asm, key, axis)
        tier0 = step.insertion.priority == "0"
        if tier0:
            skip |= _corridor_band(boxes, key, axis, float(step.insertion.distance))

        trusted_last = tier0
        route = False
        for extra in (0.0, 80.0, 160.0, 240.0):
            y = static_top - options.clearance - extra - lo[1]
            o_rise = np.array([o_floor[0], y, o_floor[2]])
            o_cruise = np.array([hover[0], y, hover[2]])
            o_reach = o_floor
            cleared = True
            legs = [(o_rise, False), (o_cruise, False), (hover, trusted_last)]
            for nxt, trusted in legs:
                if not trusted and not _sweep_leg(grid, lo, hi, [(key, 0), (key, 1)],
                                                  o_reach, nxt, options, skip):
                    cleared = False
                    break
                o_reach = nxt
            if cleared:
                route = True
                break
        if not route:
            # The flight still happens, at the deepest cruise, flagged route: false
            # (the studio renders it as an uncertified unit).
            y = static_top - options.clearance - 240.0 - lo[1]
            o_rise = np.array([o_floor[0], y, o_floor[2]])
            o_cruise = np.array([hover[0], y, hover[2]])
            o_reach = hover

        path = [o_floor, o_rise, o_cruise, o_reach, hover, np.zeros(3)]
        path = [p for i, p in enumerate(path) if i == 0 or float(np.linalg.norm(p - path[i - 1])) > 1e-9]

        flight_len = (float(np.linalg.norm(o_rise - o_floor))
                      + float(np.linalg.norm(o_cruise - o_rise))
                      + float(np.linalg.norm(o_reach - o_cruise)))
        insert_len = float(np.linalg.norm(hover - o_reach)) + float(np.linalg.norm(hover))
        dur = max(0.05, flight_len / options.flight_speed + insert_len / options.insert_speed)
        raw.append((key, max(0.0, cursor - options.lead), cursor, cursor + dur, path, route))
        cursor = cursor + dur + options.gap
        placed.add(key)

    total = cursor - options.gap
    if total <= 0:
        return None
    pieces = []
    for key, appear, start, end, path, route in raw:
        pose = np.asarray(matrix_of[key], dtype=float).copy()
        pose[:3, 3] += floor[key]
        pieces.append({
            "key": key,
            "floor": [float(v) for v in np.round(pose.T, 2).ravel()],
            "path": [_rounded(p) for p in path],
            "appearF": round(appear / total, 4),
            "startF": round(start / total, 4),
            "durF": round((end - start) / total, 4),
            "route": route,
        })
    return {"kind": KIND, "pieces": pieces}
