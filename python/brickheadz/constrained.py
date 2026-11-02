"""Inventory-constrained generation (Phase 5).

Build a BrickHeadz using only the shapes present in a parts inventory and
colours from its palette, so the result is buildable from the pieces on hand.
The fill vocabulary is bucketed by measured height, so any solid shape of the
right height — bricks, plates, slopes, curved slopes — can serve as structure,
not just plain bricks. This lets slope-heavy inventories build full-size.
"""
from __future__ import annotations

import os
import random
from collections import Counter
from dataclasses import replace

from brickheadz import patterns as patterns_mod
from brickheadz.builder import Build, build_figure
from brickheadz.dna import load_catalog
from brickheadz.inventory import Inventory, InventoryShortfall
from brickheadz.parts import BASE_PLATE, HEAD_SNOT, description, info

DEFAULT_CATALOG = os.path.join("..", "public", "data", "catalog.json")

# Solid rectangular-ish shapes may serve as structural fill; round/wheel/technic
# motion parts may not (they leave gaps or have no flat top).
_SOLID = ("brick", "plate", "slope", "wedge", "curved", "tile")
_REJECT = (
    "round", "dish", "cone", "bar ", "axle", "pin", "connector", "hinge", "clip",
    "sticker", "liftarm", "gear", "wheel", "tyre", "tire", "technic bush",
)


def _is_fill(name: str) -> bool:
    n = name.lower()
    return any(w in n for w in _SOLID) and not any(w in n for w in _REJECT)


def fill_vocab(lib, inv: Inventory, catalog: dict) -> tuple[dict[int, list[str]], list[str]]:
    """Height-bucketed fill parts and the smooth tile list, all from the inventory."""
    fill: dict[int, list[str]] = {}
    tiles: list[str] = []
    for part in inv.parts:
        name = catalog.get(part, {}).get("name") or description(lib, part)
        if not _is_fill(name):
            continue
        try:
            pi = info(lib, part)
        except KeyError:
            continue
        if pi.h not in (1, 2, 3):
            continue
        fill.setdefault(pi.h, []).append(part)
        if pi.h == 1 and "tile" in name.lower():
            tiles.append(part)
    if not fill.get(1):
        raise ValueError("inventory has no 1-plate fill parts to build with")
    return fill, (tiles or fill[1])


def _color(rng: random.Random, palette: list[int], fallback: int) -> int:
    return rng.choice(palette) if palette else fallback


def constrained_spec(spec, inv: Inventory, rng: random.Random):
    palette = inv.palette()
    return replace(
        spec,
        color_head=_color(rng, palette, spec.color_head),
        color_body=_color(rng, palette, spec.color_body),
        color_leg=_color(rng, palette, spec.color_leg),
        color_hair=_color(rng, palette, spec.color_hair),
        color_eye=_color(rng, palette, spec.color_eye),
        color_base=_color(rng, palette, spec.color_base),
        color_accent=_color(rng, palette, spec.color_accent),
    )


def usable_patterns(pats: dict, inv: Inventory) -> dict:
    """Keep only patterns whose every piece shape is in the inventory."""
    return {role: [p for p in items if all(inv.has(piece["part"]) for piece in p["pieces"])] for role, items in pats.items()}


def _variants(spec):
    """Progressively smaller figures, tried until the inventory can build one."""
    seen = set()
    for courses in (spec.head_courses, 2, 1):
        for body_h in (spec.body_h, 9, 6, 3):
            for leg in (spec.leg_h, 0):
                for base in (spec.base, False):
                    key = (courses, body_h, leg, base)
                    if key in seen:
                        continue
                    seen.add(key)
                    yield replace(spec, head_courses=courses, body_h=body_h, leg_h=leg, base=base)


def build_constrained(lib, spec, inv: Inventory, pats: dict | None = None, rng: random.Random | None = None, catalog: dict | None = None, pattern: dict | None = None) -> tuple[Build, dict]:
    rng = rng or random.Random(spec.seed)
    catalog = catalog if catalog is not None else load_catalog(DEFAULT_CATALOG)
    resolved = constrained_spec(spec, inv, rng)
    fill, tiles = fill_vocab(lib, inv, catalog)
    head_snot = HEAD_SNOT if inv.has(HEAD_SNOT) else None
    base_plate = BASE_PLATE if inv.has(BASE_PLATE) else None
    pattern_pool = patterns_mod.candidates(usable_patterns(pats, inv), "hair", spec.head, spec.head) if pats else []

    build: Build | None = None
    for variant in _variants(resolved):
        try:
            candidate = build_figure(lib, variant, inventory=inv, fill=fill, tiles=tiles, head_snot=head_snot, base_plate=base_plate)
        except (InventoryShortfall, ValueError):
            continue
        build = candidate
        resolved = variant
        break
    if build is None:
        raise ValueError("inventory is too small to build even a minimal BrickHeadz")

    b = build
    if pattern_pool:
        from brickheadz.recombine import _best_offset, place_pattern, repair_placed

        chosen = pattern if pattern is not None and pattern in pattern_pool else rng.choice(pattern_pool)
        placed = place_pattern(b, chosen, b.head_frame, "hair", _best_offset(lib, b, chosen, b.head_frame))
        repair_placed(lib, b, placed)
    used = Counter(p.part for p in b.model.pieces)
    over = {p: (n, inv.parts.get(p, 0)) for p, n in used.items() if n > inv.parts.get(p, 0)}
    report = {
        "pieces": len(b.model.pieces),
        "shapesUsed": len(used),
        "inventoryShapes": len(inv.parts),
        "fillHeights": sorted(fill),
        "overBudget": over,
        "withinInventory": not over,
        "headSnot": head_snot is not None,
        "spec": resolved.to_dict(),
    }
    return b, report
