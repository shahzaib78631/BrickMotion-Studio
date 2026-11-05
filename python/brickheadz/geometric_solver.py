"""A geometry-first solver for instruction step images (no learning).

Three structural facts drive it, and they replace the big search + learned ranker:

1. **Bottom-up build.** The model grows upward, so a new part's `y` is not free —
   it rests on the support surface under its footprint. We keep a height field
   `H[(x,z)] = top occupied plate` and set `y = support(H, footprint)`.
2. **Projective anchoring.** Orthographic projection is affine, so for a fixed
   orientation `R` and height `y` the grid `(x, z)` that lands the part's centroid
   on a pixel is solved in closed form. Combined with (1) this is a fixed point:
   solve `(x,z)`, read the support, re-solve, converge.
3. **Shape separates instances.** Each part × orientation projects to a
   characteristic silhouette; normalising that and matching against the colour
   mask's connected components assigns parts to blobs by *shape* (a 2×4 ≠ a 1×2),
   not by area or colour alone.

The result is a handful of candidates per part instead of tens of thousands, each
already physically valid (on support, non-overlapping).
"""
from __future__ import annotations

import numpy as np

from brickheadz.builder import rot_matrix
from brickheadz.instruction_place import (
    CUBE_ROTATIONS,
    Camera,
    colour_mask,
    components,
    fill_polygon,
    grid_matrix,
    plane_hull,
    solve_xz,
    world_points,
)
from brickheadz.parts import info

# Physically valid studs-up orientations (the part presents studs to the world
# "up" axis). Removing the other 20 cube rotations kills the silhouette flip
# ambiguity where a plate looks identical upside-down.
STUDS_UP_ROTS = [rot_matrix(0), rot_matrix(90), rot_matrix(180), rot_matrix(270)]


def heights_update(H: dict, cells):
    for cx, cz, cy in cells:
        if cy + 1 > H.get((cx, cz), 0):
            H[(cx, cz)] = cy + 1


def support_at(H: dict, footprint) -> int:
    return max((H.get(c, 0) for c in footprint), default=0)


def _extent(lib, part, x, y, z, R):
    m, fw, fd = grid_matrix(lib, part, x, y, z, R)
    foot = [(cx, cz) for cx in range(x, x + fw) for cz in range(z, z + fd)]
    cells = [(cx, cz, cy) for cx, cz in foot for cy in range(y, y + info(lib, part).h)]
    return m, foot, cells


def _iou_at(lib, part, cam, size, mask, occupied, x, y, z, R):
    m, _foot, cells = _extent(lib, part, x, y, z, R)
    if any(c in occupied for c in cells):
        return None
    u, v, _ = cam.project(world_points(lib, part, m))
    mk = np.zeros((size, size), bool)
    fill_polygon(mk, plane_hull(np.stack([u, v], 1)))
    inter = int((mk & mask).sum())
    iou = inter / max(1, int((mk | mask).sum()))
    return iou, (x, y, z, tuple(map(tuple, R))), m, cells, mk


def candidate(lib, part, R, target, cam, size, H, mask, occupied, max_iter=5, refine=True):
    """Self-consistent placement: solve (x,z), read support, re-solve, refine.

    The pixel centroid of a rendered silhouette differs from the projected vertex
    centroid by up to ~1 stud, so a ±1 local refinement snaps onto the grid.
    """
    y = 0
    x = z = 0
    for _ in range(max_iter):
        sxz = solve_xz(lib, part, cam, target, y, R)
        if sxz is None:
            return None
        x, z = int(round(sxz[0])), int(round(sxz[1]))
        if abs(x) > 16 or abs(z) > 16:
            return None
        _m, foot, _c = _extent(lib, part, x, y, z, R)
        y2 = support_at(H, foot)
        if y2 == y:
            break
        y = y2
    offsets = [(-1, 0, 1), (-1, 0, 1)] if refine else [(0,), (0,)]
    best = None
    for dx in offsets[0]:
        for dz in offsets[1]:
            res = _iou_at(lib, part, cam, size, mask, occupied, x + dx, y, z + dz, R)
            if res is not None and (best is None or res[0] > best[0]):
                best = res
    return best


def best_for(lib, part, comp, cam, size, mask, occupied, H, rots=None):
    ys, xs = np.where(comp)
    if not len(xs):
        return None
    target = (float(xs.mean()), float(ys.mean()))
    best = (0.0, None)
    for R in (rots if rots is not None else STUDS_UP_ROTS):
        res = candidate(lib, part, R, target, cam, size, H, mask, occupied)
        if res and res[0] > best[0]:
            best = (res[0], res)
    return best[1]


def _corners(lib, part, m):
    lo, hi = np.array(info(lib, part).lo), np.array(info(lib, part).hi)
    pts = np.array([[a, b, c] for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])])
    return pts @ m[:3, :3].T + m[:3, 3]


def _hausdorff(a, b):
    d = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=2)
    return float(max(d.min(1).max(), d.min(0).max()))


def score_against_truth(lib, rec, truth, tol=6.0):
    """Compare reconstructions to the OMR *up to a global translation*.

    The OMR has its own absolute origin, so raw matrices never match across
    frames; align by centroid translation. Matching is by **body-box corner
    sets** (Hausdorff), so a symmetric part placed with any equivalent matrix
    still counts. Returns (ok, miss, fail).
    """
    rec_ok = [r for r in rec if r[3] is not None]
    fail = sum(1 for r in rec if r[3] is None)
    if not rec_ok:
        return 0, 0, fail + len(truth)
    t_cent = np.mean([t[2][:3, 3] for t in truth], 0)
    r_cent = np.mean([r[3][:3, 3] for r in rec_ok], 0)
    T = t_cent - r_cent
    used = set()
    ok = 0
    for part, color, _key, m, _score in rec_ok:
        rc = _corners(lib, part, m) + T
        best = None
        for i, (tp, tc, tm) in enumerate(truth):
            if i in used or tp != part:
                continue
            d = _hausdorff(rc, _corners(lib, tp, tm))
            if best is None or d < best[0]:
                best = (d, i)
        if best is None or best[0] >= tol:
            fail += 1
            continue
        used.add(best[1])
        ok += 1
    return ok, 0, fail



def solve_step(lib, parts, cam, size, rgb, palette, occupied, H, min_score=0.05):
    """parts: [(part, colour)]. Returns [(part, colour, key, matrix, score)]."""
    masks = {c: colour_mask(rgb, palette[c]) for _, c in parts}
    comps = []
    for c, cm in masks.items():
        for comp in components(cm):
            comps.append((c, comp))
    pairs = []
    for pi, (part, color) in enumerate(parts):
        for ci, (ccol, comp) in enumerate(comps):
            if ccol != color:
                continue
            res = best_for(lib, part, comp, cam, size, masks[color], occupied, H)
            if res is not None and res[0] >= min_score:
                pairs.append((res[0], pi, ci, res))
    pairs.sort(key=lambda t: -t[0])
    used_p, used_c, out = set(), set(), []
    for score, pi, ci, _res in pairs:
        if pi in used_p or ci in used_c:
            continue
        used_p.add(pi); used_c.add(ci)
        res2 = best_for(lib, parts[pi][0], comps[ci][1], cam, size, masks[parts[pi][1]], occupied, H)
        _s, key, m, cells, _mk = res2
        occupied.update(cells); heights_update(H, cells)
        out.append((parts[pi][0], parts[pi][1], key, m, score))
    # parts whose shape matched no component: place against the whole colour mask
    for pi, (part, color) in enumerate(parts):
        if pi in used_p:
            continue
        res = best_for(lib, part, masks[color], cam, size, masks[color], occupied, H)
        if res is None:
            out.append((part, color, None, None, 0.0))
            continue
        _s, key, m, cells, _mk = res
        occupied.update(cells); heights_update(H, cells)
        out.append((part, color, key, m, _s))
    return out
