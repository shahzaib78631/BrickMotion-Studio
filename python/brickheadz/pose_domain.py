"""The finite, physically-pruned set of candidate poses for one part.

The placement of a part is discrete: a grid cell ``(x, z)``, an orientation ``R``
(one of the cube rotations; ``R`` about Y for studs-up parts), and a height ``y``.
Two structural facts prune it hard:

1. **Support** — the build is bottom-up, so a part rests on the surface under its
   footprint: ``y = support(H, footprint)`` for the current height field ``H``.
   A same-step neighbour can also be the support, so a few extra plate offsets are
   offered and the exact support rule is enforced later, in the solver.
2. **Projection** — orthographic projection is affine, so for a fixed ``(R, y)``
   the ``(x, z)`` that lands the part's centroid on a target pixel is solved in
   closed form (``solve_xz``). The blob's centroid gives the target; a small
   integer window around it is enumerated so the optimum is not missed.

Every returned candidate is non-overlapping with the already-placed set and is
scored by how much of its silhouette lands on the step's *new* pixels (``on_new``)
and by silhouette IoU against its own colour's pixels (``iou``). The true pose of
a clean step scores ``on_new ≈ 1``.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from brickheadz.geometric_solver import STUDS_UP_ROTS, support_at
from brickheadz.instruction_place import (
    CUBE_ROTATIONS,
    Camera,
    cells_of,
    fill_polygon,
    grid_matrix,
    plane_hull,
    solve_xz,
    world_points,
)
from brickheadz.parts import body_aabb, info


def grid_pose(lib, part: str, matrix: np.ndarray):
    """The (x, y, z, R) of an LDraw placement, or ``None`` if it is off the grid.

    The inverse of :func:`grid_matrix`: recover the cube rotation, the rotated body
    footprint, and the stud/plate offsets. Used to bring a real model (an OMR) into
    the solver's own frame so the two can be compared exactly.
    """
    m = np.asarray(matrix, float)
    r = m[:3, :3]
    rot = next((c for c in CUBE_ROTATIONS if np.allclose(c, r, atol=1e-3)), None)
    if rot is None:
        return None
    pi = info(lib, part)
    pts = np.array([[a, b, c] for a in (pi.lo[0], pi.hi[0]) for b in (pi.lo[1], pi.hi[1]) for c in (pi.lo[2], pi.hi[2])])
    q = pts @ rot.T
    lo, hi = q.min(0), q.max(0)
    fw = max(1, round((hi[0] - lo[0]) / 20.0))
    fd = max(1, round((hi[2] - lo[2]) / 20.0))
    pos = m[:3, 3]
    snap = lambda v: int(np.floor(v + 0.5))  # deterministic, so every piece shares one offset
    x = snap((pos[0] + (lo[0] + hi[0]) / 2) / 20 - fw / 2)
    z = snap((pos[2] + (lo[2] + hi[2]) / 2) / 20 - fd / 2)
    y = snap(-(pos[1] + hi[1]) / 8)
    # the body box pulls the top stud back, so a real LDraw part sits half a plate
    # lower; rounding snaps it back. Verify by rebuilding and compare positions.
    mm, _fw, _fd = grid_matrix(lib, part, x, y, z, rot)
    if np.abs(mm[:3, 3] - pos).max() > 6.0:
        return None
    return int(x), int(y), int(z), rot




@dataclass(frozen=True)
class Pose:
    part: str
    x: int
    y: int
    z: int
    R: tuple  # 9 floats, row-major
    matrix: np.ndarray  # 4×4 part→model (LDU)
    cells: tuple  # occupied plate cells (cx, cz, cy), cy up
    iou: float  # silhouette IoU vs this colour's new pixels
    on_new: float  # fraction of the silhouette landing on new-part pixels
    aabb: tuple | None = None  # (min[3], max[3]) world bounds in LDU, for contact support
    blob: int = -1  # index of the new-part blob this silhouette overlaps most (-1 if none)


def _rot_tuple(r: np.ndarray) -> tuple:
    return tuple(float(v) for v in np.asarray(r, float).reshape(9))


def silhouette(lib, part: str, matrix: np.ndarray, cam: Camera, size: int) -> np.ndarray:
    u, v, _ = cam.project(world_points(lib, part, matrix))
    m = np.zeros((size, size), bool)
    fill_polygon(m, plane_hull(np.stack([u, v], 1)))
    return m


def _targets(seg, colour: int) -> list[tuple[float, float]]:
    tgt = [b.centroid for b in seg.blobs if b.color == colour]
    px = seg.new_mask & (seg.labels == colour)
    if px.any():
        ys, xs = np.where(px)
        tgt.append((float(xs.mean()), float(ys.mean())))
    return tgt


def candidates(
    lib,
    part: str,
    colour: int,
    seg,
    cam: Camera,
    size: int,
    occupied: set,
    H: dict,
    *,
    rots=None,
    spread: int = 3,
    y_extra: tuple[int, ...] = (),
    min_on_new: float = 0.35,
    height_levels: tuple[int, ...] | None = None,
) -> list[Pose]:
    """Candidate poses, best ``on_new``/IoU first. ``occupied``/``H`` are the built state."""
    rots = list(STUDS_UP_ROTS if rots is None else rots)
    colour_px = seg.new_mask & (seg.labels == colour)
    targets = _targets(seg, colour)
    if not targets:
        return []

    seen: set = set()
    out: list[Pose] = []
    # Only exposed top cells are potential support elevations. Interior cells
    # of a tall brick cannot support a new part and needlessly multiplied search.
    bases = {0,*H.values(),*(cy+1 for cx,cz,cy in occupied if (cx,cz,cy+1) not in occupied)}
    levels = sorted(set(height_levels) if height_levels is not None else
                    {base+e for base in bases for e in (0,*y_extra)})
    for R in rots:
        rk = _rot_tuple(R)
        for tgt in targets:
            # Enumerate support elevations before solving projection. The old
            # fixed point could converge to the floor and never visit the true
            # elevated pose. Lower surfaces below a bridge are retained from cells.
            for yy in levels:
                sxz = solve_xz(lib, part, cam, tgt, yy, R)
                if sxz is None or not np.isfinite(sxz).all():
                    continue
                x, z = int(round(sxz[0])), int(round(sxz[1]))
                for dx in range(-spread, spread + 1):
                    for dz in range(-spread, spread + 1):
                        xx, zz = x+dx, z+dz
                        key = (xx, yy, zz, rk)
                        if key in seen:
                            continue
                        seen.add(key)
                        m, cells = cells_of(lib, part, xx, yy, zz, R)
                        if any(c in occupied for c in cells):
                            continue
                        sil = silhouette(lib, part, m, cam, size)
                        area = int(sil.sum())
                        if area == 0:
                            continue
                        on_new = float((sil & seg.new_mask).sum()) / area
                        if on_new < min_on_new:
                            continue
                        inter = float((sil & colour_px).sum())
                        union = float((sil | colour_px).sum())
                        iou_colour = inter / union if union else 0.0
                        aabb = body_aabb(lib, part, m)
                        # shape tie-breaker: overlap with the single best blob, so a pose that
                        # straddles two merged same-colour pieces scores below one that matches a shape
                        blob, best_ov, blob_mask = -1, 0, None
                        for bi, b in enumerate(seg.blobs):
                            if b.color != colour:
                                continue
                            ov = int((sil & b.mask).sum())
                            if ov > best_ov:
                                blob, best_ov, blob_mask = bi, ov, b.mask
                        iou = iou_colour
                        if blob_mask is not None:
                            bu = float((sil | blob_mask).sum())
                            iou = max(iou_colour, float((sil & blob_mask).sum()) / bu if bu else 0.0)
                        out.append(Pose(part, xx, yy, zz, rk, m, tuple(cells), iou, on_new, aabb, blob))
    out.sort(key=lambda p: (-(p.on_new+p.iou), -p.on_new))
    return out


def stack_offsets(lib, parts):
    """All subset height sums for simultaneous studs-up additions.

    A step adding three plates can place the last at +2 plates; enumerating only
    the distinct individual part heights omitted such same-step stack poses.
    """
    offsets={0}
    for part,_colour in parts:
        height=info(lib,part).h
        offsets |= {value+height for value in offsets}
    return tuple(sorted(offsets))
