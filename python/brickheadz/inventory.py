"""A parts inventory the generator must build from (Phase 5).

Reads the Rebrickable parts export the instructions pipeline already produces
(``[{"part": "3001", "color": 4, "quantity": 2, "spare": false}, ...]``) as well
as simple ``{part: qty}`` JSON and ``part,color,quantity`` CSV/lines. Shape counts
are enforced so a generated model is buildable from the pieces on hand; colours
are restricted to the colours present.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field


class InventoryShortfall(RuntimeError):
    def __init__(self, part: str):
        super().__init__(f"inventory has no remaining {part}")
        self.part = part


@dataclass
class Inventory:
    parts: dict[str, int] = field(default_factory=dict)  # shape id -> quantity
    colors: dict[int, int] = field(default_factory=dict)  # colour code -> quantity
    entries: int = 0

    def has(self, part: str, n: int = 1) -> bool:
        return self.parts.get(part.replace(".dat", ""), 0) >= n

    def take(self, part: str) -> bool:
        key = part.replace(".dat", "")
        if self.parts.get(key, 0) <= 0:
            return False
        self.parts[key] -= 1
        return True

    def palette(self) -> list[int]:
        return [c for c, n in sorted(self.colors.items(), key=lambda kv: (-kv[1], kv[0])) if n > 0]

    def available(self, parts) -> list[str]:
        return [p for p in parts if self.has(p)]


def _add(inv: Inventory, part: str, color, qty: int, spare: bool) -> None:
    if spare or qty <= 0:
        return
    key = str(part).replace(".dat", "").strip()
    if not key:
        return
    inv.parts[key] = inv.parts.get(key, 0) + qty
    if color is not None:
        try:
            code = int(color)
        except (TypeError, ValueError):
            code = None
        if code is not None:
            inv.colors[code] = inv.colors.get(code, 0) + qty
    inv.entries += 1


def load(path: str) -> Inventory:
    inv = Inventory()
    with open(path) as f:
        text = f.read()
    stripped = text.lstrip()
    if path.lower().endswith(".json") or stripped[:1] in "[{":
        data = json.loads(text)
        _load_json(inv, data)
    else:
        _load_rows(inv, csv.reader(text.splitlines()))
    return inv


def _load_json(inv: Inventory, data) -> None:
    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            part = row.get("ldrawPart") or row.get("part") or row.get("id")
            _add(inv, part, row.get("color"), int(row.get("quantity", row.get("qty", 1)) or 0), bool(row.get("spare")))
        return
    if isinstance(data, dict):
        # {part: qty} or {part: {color: qty}}
        for part, value in data.items():
            if isinstance(value, dict):
                for color, qty in value.items():
                    _add(inv, part, color, int(qty or 0), False)
            else:
                _add(inv, part, None, int(value or 0), False)
        return


def _load_rows(inv: Inventory, rows) -> None:
    for row in rows:
        row = [c.strip() for c in row if c.strip() != ""]
        if not row or row[0].lower() in ("part", "part_num", "id"):
            continue
        part = row[0]
        color = row[1] if len(row) > 1 else None
        qty = row[2] if len(row) > 2 else "1"
        try:
            quantity = int(float(qty))
        except ValueError:
            quantity = 1
        _add(inv, part, color, quantity, False)


def summarize(inv: Inventory) -> dict:
    return {"shapes": len(inv.parts), "colors": len(inv.colors), "pieces": sum(inv.parts.values())}
