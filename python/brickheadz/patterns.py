"""Learn reusable headwear/hair sub-assembly patterns from the corpus (Phase 4).

Each corpus model's hair/headwear is captured in a canonical, head-local frame:
the origin sits at the **centre of the head's top face**, so a pattern can be
lifted from its source model and dropped onto any generated head of the same
footprint. Pieces keep their exact relative matrices (including SNOT
rotations), so curved slopes and side strands transfer verbatim. The source
model's facing is recorded so the pattern can be rotated to face forward.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np

from brickheadz.schema import matrix_to_json

ROLES = ("hair", "face")


@dataclass
class Pattern:
    role: str
    head_w: int
    head_d: int
    front: list[int]
    source: str
    matrix: list[list[float]]  # per piece: relative 4x4, column-major 16
    part: list[str] = field(default_factory=list)
    color: list[int] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "role": self.role,
            "headW": self.head_w,
            "headD": self.head_d,
            "front": self.front,
            "source": self.source,
            "pieces": [{"part": p, "color": c, "matrix": m} for p, c, m in zip(self.part, self.color, self.matrix)],
        }


def _decode(m: list[float]) -> np.ndarray:
    """Column-major 16-float -> row-major 4x4."""
    return np.array(m, dtype=float).reshape(4, 4).T


def _head_frame(record: dict):
    comps = {c["label"]: c for c in record["components"] if c["figure"] == 0}
    head = comps.get("head")
    if not head:
        return None
    (x0, y0, z0), (x1, y1, z1) = head["bbox"]["ldu"]  # figure space, y-up
    # Lateral anchor = the structural head cube (the 22885 side-stud-brick shell),
    # not the decorated head region, whose bbox is skewed by protruding face parts.
    shell = [p for p in record["pieces"] if p.get("figure") == 0 and p.get("component") == "head" and p.get("basePart") == "22885" and p.get("aabb")]
    if shell:
        cx = (min(p["aabb"][0][0] for p in shell) + max(p["aabb"][1][0] for p in shell)) / 2
        cz = (min(p["aabb"][0][2] for p in shell) + max(p["aabb"][1][2] for p in shell)) / 2
    else:
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    # The size key is the true head FOOTPRINT (the side-stud-brick cube).
    cube = (record["figures"][0].get("headCube") if record["figures"] else None) or {}
    w = int(round(cube.get("wStuds", (x1 - x0) / 20)))
    d = int(round(cube.get("dStuds", (z1 - z0) / 20)))
    return {
        "P": np.array([cx, -y1, cz], dtype=float),  # LDraw space (y-down); -y1 = head top
        "w": w,
        "d": d,
    }


def extract(records: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {r: [] for r in ROLES}
    for rec in records:
        frame = _head_frame(rec)
        if not frame:
            continue
        by_role: dict[str, list[dict]] = {r: [] for r in ROLES}
        for p in rec["pieces"]:
            if p.get("figure") == 0 and p.get("component") in ROLES and p.get("matrix"):
                by_role[p["component"]].append(p)
        for role, pieces in by_role.items():
            if not pieces:
                continue
            rel = []
            for p in pieces:
                m = _decode(p["matrix"])
                m[:3, 3] -= frame["P"]
                rel.append(m)
            out[role].append(
                Pattern(
                    role=role,
                    head_w=frame["w"],
                    head_d=frame["d"],
                    front=rec["frame"]["front"],
                    source=rec["id"],
                    matrix=[matrix_to_json(m) for m in rel],
                    part=[p["basePart"] for p in pieces],
                    color=[p["color"] for p in pieces],
                ).to_json()
            )
    return out


def write(patterns: dict, path: str) -> dict:
    with open(path, "w") as f:
        json.dump(patterns, f, indent=1)
    return summarize(patterns)


def read(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def summarize(patterns: dict) -> dict:
    out = {}
    for role, items in patterns.items():
        by_size: dict[str, int] = {}
        for p in items:
            by_size[f"{p['headW']}x{p['headD']}"] = by_size.get(f"{p['headW']}x{p['headD']}", 0) + 1
        out[role] = {"count": len(items), "bySize": by_size}
    return out


def candidates(patterns: dict, role: str, head_w: int, head_d: int) -> list[dict]:
    return [p for p in patterns.get(role, []) if p["headW"] == head_w and p["headD"] == head_d]
