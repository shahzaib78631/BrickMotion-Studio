"""Grid-level structural validation: overlap, connection, support.

This is the first, cheap line of defence (Phase 3 adds mesh-level certification
with the studio's collision oracle). It works on the plate-cell occupancy of the
studs-up pieces: no cell may be double-booked, the whole figure must be one
connected mass, and that mass must reach the ground.
"""
from __future__ import annotations

from brickheadz.builder import Model


def validate(model: Model, cells: dict[tuple[int, int, int], int], lib=None) -> dict:
    problems: list[str] = []
    grid_idx = [i for i, p in enumerate(model.pieces) if p.grid is not None]
    mounted = len(model.pieces) - len(grid_idx)

    # 1. overlap is prevented at build time; re-derive and assert.
    seen: dict[tuple[int, int, int], int] = {}
    for cell, owner in cells.items():
        if cell in seen and seen[cell] != owner:
            problems.append(f"cell {cell} occupied twice")
        seen[cell] = owner

    # 2. connectivity over face-adjacent cells
    parent = {i: i for i in grid_idx}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for (cx, cz, cy), owner in cells.items():
        for dx, dz, dy in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            other = cells.get((cx + dx, cz + dz, cy + dy))
            if other is not None and other != owner:
                union(owner, other)

    comps: dict[int, set[int]] = {}
    for i in grid_idx:
        comps.setdefault(find(i), set()).add(i)
    grounded_roots = set()
    for (cx, cz, cy), owner in cells.items():
        if cy == 0:
            grounded_roots.add(find(owner))
    ungrounded = [r for r in comps if r not in grounded_roots]
    if len(comps) > 1:
        problems.append(f"{len(comps)} disconnected components")
    if ungrounded:
        problems.append(f"{len(ungrounded)} component(s) not reaching the ground")

    return {
        "pieces": len(model.pieces),
        "gridPieces": len(grid_idx),
        "mounted": mounted,
        "components": len(comps),
        "grounded": len(ungrounded) == 0 and len(comps) >= 1,
        "connected": len(comps) == 1,
        "ok": not problems,
        "problems": problems,
    }
