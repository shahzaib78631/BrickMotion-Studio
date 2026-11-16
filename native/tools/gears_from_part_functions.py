#!/usr/bin/env python3
"""Writes native/data/gears.json: the measured gear teeth of every part that has any.

Source: public/data/part-functions.json, measured from the LDraw part meshes by
scripts/measure-part-functions.ts. Run from the repository root:

    python3 native/tools/gears_from_part_functions.py
"""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
src = json.loads((root / "public/data/part-functions.json").read_text())
parts = {name: row["teeth"] for name, row in sorted(src["parts"].items()) if row.get("teeth")}
out = {
    "format": "brickmotion-gears",
    "version": 1,
    "source": "public/data/part-functions.json (" + src["library"] + "), measured from part meshes",
    "parts": parts,
}
(root / "native/data/gears.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(len(parts), "parts with teeth")
