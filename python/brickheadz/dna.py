"""Per-model DNA: a fixed-shape feature description of a BrickHeadz figure.

Combines the semantic decomposition (proportions per body part) with part
vocabulary, colour distribution, construction complexity and face layout. The
vector is intentionally explicit rather than a single opaque embedding so the
grammar report and the Phase-2 generator can read individual fields.
"""
from __future__ import annotations

import json
import math
import os
import re

import numpy as np

from assembly_model.geometry import BoxGrid
from brickheadz.geometry import PLATE, STUD

_COLOUR = re.compile(r"0\s+!COLOUR\s+(.+?)\s+CODE\s+(\d+)")


def load_catalog(path: str) -> dict[str, dict]:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        raw = json.load(f)
    return {str(e["id"]): e for e in raw}


def load_color_names(ldconfig: str) -> dict[int, str]:
    names: dict[int, str] = {}
    if not os.path.exists(ldconfig):
        return names
    for line in open(ldconfig, errors="ignore"):
        m = _COLOUR.match(line.strip())
        if m:
            names[int(m.group(2))] = m.group(1).strip()
    return names


def build_dna(analysis: dict, pieces, catalog: dict[str, dict]) -> dict:
    from brickheadz.dat import Piece  # local import to avoid cycle at module load

    comp = {}
    for c in analysis["components"]:
        if c["figure"] == 0 and c["label"] not in comp:
            comp[c["label"]] = c["dims"]

    total = analysis["bbox"].get("dims", {"wStuds": 0, "dStuds": 0, "hPlates": 0})
    head = comp.get("head", {"wStuds": 0, "dStuds": 0, "hPlates": 0})
    torso = comp.get("torso", {"wStuds": 0, "dStuds": 0, "hPlates": 0})
    legs = comp.get("legs", {"wStuds": 0, "dStuds": 0, "hPlates": 0})
    hair = comp.get("hair", {"wStuds": 0, "dStuds": 0, "hPlates": 0})
    arms = comp.get("arms", {"wStuds": 0, "dStuds": 0, "hPlates": 0})

    def ratio(a, b):
        return round(a / b, 3) if b else 0.0

    support = _support_stats(analysis)

    colors: dict[int, int] = {}
    parts: dict[str, int] = {}
    cats: dict[str, int] = {}
    snot = 0
    decorated = 0
    for p in pieces:
        colors[p.color] = colors.get(p.color, 0) + 1
        parts[p.base_part] = parts.get(p.base_part, 0) + 1
        cat = catalog.get(p.base_part, {}).get("category", "Unknown")
        cats[cat] = cats.get(cat, 0) + 1
        if p.decorated:
            decorated += 1
    for row in analysis["pieces"]:
        if row["snot"]:
            snot += 1

    n = max(1, len(pieces))
    return {
        "proportions": {
            "total": total,
            "head": head,
            "torso": torso,
            "legs": legs,
            "arms": arms,
            "hair": hair,
            "headHTorso": ratio(head["hPlates"], torso["hPlates"]),
            "headHTotal": ratio(head["hPlates"], total["hPlates"]),
            "torsoHTotal": ratio(torso["hPlates"], total["hPlates"]),
            "legsHTotal": ratio(legs["hPlates"], total["hPlates"]),
            "headWTorso": ratio(head["wStuds"], torso["wStuds"]),
        },
        "construction": {
            "pieces": len(pieces),
            "figures": len(analysis["figures"]),
            "components": len([c for c in analysis["components"] if c["figure"] == 0]),
            "connections": len(analysis["connections"]),
            "submodels": len({p.submodel for p in pieces}),
            "snotPieces": snot,
            "snotRatio": round(snot / n, 3),
            "decoratedPieces": decorated,
            "supportedRatio": support["supportedRatio"],
            "maxOverhangStuds": support["maxOverhangStuds"],
        },
        "color": {
            "palette": len(colors),
            "dominant": _top(colors, 5),
            "entropy": round(_entropy(colors.values()), 3),
        },
        "parts": {
            "vocabulary": len(parts),
            "top": _top(parts, 12),
            "categories": _top(cats, 12),
            "slopes": sum(v for k, v in cats.items() if "slope" in k.lower()),
            "tiles": sum(v for k, v in cats.items() if "tile" in k.lower()),
            "round": sum(v for k, v in cats.items() if "round" in k.lower()),
        },
        "face": dict(analysis.get("face", {})),
    }


def _support_stats(analysis: dict) -> dict:
    rows = analysis["pieces"]
    if not rows:
        return {"supportedRatio": 0.0, "maxOverhangStuds": 0.0}
    boxes = [(r["aabb"][0], r["aabb"][1]) for r in rows]
    grid = BoxGrid(cell=STUD)
    for i, (lo, hi) in enumerate(boxes):
        grid.add(np.array(lo), np.array(hi), (i, 0))
    supported = 0
    max_overhang = 0.0
    for i, (lo, hi) in enumerate(boxes):
        lo = np.array(lo)
        hi = np.array(hi)
        probe_lo = np.array([lo[0], lo[1] - 1.5, lo[2]])
        probe_hi = np.array([hi[0], lo[1] + 0.5, hi[2]])
        ok = False
        for payload, blo, bhi in grid.hits(probe_lo, probe_hi, exclude=(i, 0)):
            if abs(bhi[1] - lo[1]) <= 1.5 and min(hi[0], bhi[0]) - max(lo[0], blo[0]) > 2.0 and min(hi[2], bhi[2]) - max(lo[2], blo[2]) > 2.0:
                ok = True
                break
        if ok:
            supported += 1
        else:
            max_overhang = max(max_overhang, float(hi[1] - lo[1]) / PLATE)
    return {"supportedRatio": round(supported / len(rows), 3), "maxOverhangStuds": round(max_overhang, 2)}


def _top(d: dict, k: int) -> list[list]:
    return [[a, b] for a, b in sorted(d.items(), key=lambda kv: (-kv[1], str(kv[0])))[:k]]


def _entropy(counts) -> float:
    total = float(sum(counts))
    if total <= 0:
        return 0.0
    return -sum((c / total) * math.log(c / total) for c in counts if c > 0)
