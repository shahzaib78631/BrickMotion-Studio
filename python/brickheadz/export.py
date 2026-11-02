"""Export a generated BrickHeadz model as LDraw MPD or a studio plan JSON."""
from __future__ import annotations

import json

import numpy as np

from brickheadz.builder import Model


def _fmt(n: float) -> str:
    r = round(float(n), 4)
    return "0" if r == 0 else f"{r:g}"


def normalize(model: Model) -> Model:
    """Shift grid pieces so the footprint's min x/z is 0 (friendly plan coords)."""
    xs = [p.grid[0] for p in model.pieces if p.grid]
    zs = [p.grid[2] for p in model.pieces if p.grid]
    if not xs or not zs:
        return model
    dx, dz = min(xs), min(zs)
    for p in model.pieces:
        p.matrix = p.matrix.copy()
        p.matrix[:3, 3] += np.array([-dx * 20.0, 0.0, -dz * 20.0])
        if p.grid:
            x, y, z, rot = p.grid
            p.grid = (x - dx, y, z - dz, rot)
    return model


def to_mpd(model: Model, description: str = "") -> str:
    lines = [
        f"0 FILE {model.name}.ldr",
        f"0 {description or model.name}",
        f"0 Name: {model.name}.ldr",
        "0 Author: BrickMotion Studio (BrickHeadz generator)",
        "0 !THEME Brickheadz",
        "",
    ]
    for p in model.pieces:
        m = p.matrix[:3, :3].ravel()
        x, y, z = p.matrix[:3, 3]
        nums = " ".join(_fmt(v) for v in (x, y, z, *m))
        lines.append(f"1 {p.color} {nums} {p.part}.dat")
        lines.append("0 STEP")
    lines.append("0 NOFILE")
    return "\n".join(lines) + "\n"


def _with_role(item: dict, role: str) -> dict:
    if role == "hair":
        item["assembly"] = {"role": "headwear"}
    elif role == "face":
        item["assembly"] = {"role": "generic"}
    return item


def to_plan(model: Model, description: str = "") -> dict:
    steps = []
    chunk: list[dict] = []
    for p in model.pieces:
        if p.grid is not None and not p.raw:
            x, y, z, rot = p.grid
            item = {"part": p.part, "color": p.color, "x": x, "y": y, "z": z, "rot": rot}
        else:
            m = p.matrix[:3, :3].astype(int).ravel().tolist()
            pos = [round(float(v), 3) for v in p.matrix[:3, 3]]
            item = {"part": p.part, "color": p.color, "ldu": pos, "matrix": m}
        chunk.append(_with_role(item, p.role))
        if len(chunk) == 5:
            steps.append({"pieces": chunk})
            chunk = []
    if chunk:
        steps.append({"pieces": chunk})
    return {"format": "brickmotion-plan", "version": 1, "name": model.name, "description": description or model.name, "steps": steps}


def write_mpd(model: Model, path: str, description: str = "") -> None:
    with open(path, "w") as f:
        f.write(to_mpd(model, description))


def write_plan(model: Model, path: str, description: str = "") -> None:
    with open(path, "w") as f:
        json.dump(to_plan(model, description), f, indent=1)
