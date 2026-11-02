"""Data contract for the BrickHeadz dataset artifacts.

Units are LDraw LDU (stud pitch 20, plate 8, brick 24). Matrices are serialized
column-major (16 numbers), matching ``assembly_model.schema`` and
``THREE.Matrix4.toArray()`` so the studio can read the same files. Semantic
fields (component labels, DNA) are an *added layer*; every piece always keeps
its original part, colour and matrix.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable

import numpy as np

RECORD_SCHEMA = "brickheadz.record.v1"
GRAMMAR_SCHEMA = "brickheadz.grammar.v1"
UNITS = "ldu"

_FIELDS = (
    "id",
    "name",
    "source",
    "frame",
    "bbox",
    "figures",
    "pieces",
    "components",
    "connections",
    "face",
    "dna",
    "warnings",
)


def matrix_to_json(m: Any) -> list[float]:
    """Row-major 4x4 -> column-major 16-float list (numpy/THREE convention)."""
    return [float(v) for v in np.round(np.asarray(m, dtype=float).T, 2).ravel()]


@dataclass
class ModelRecord:
    """One analysed BrickHeadz model (one MPD file)."""

    id: str
    name: str
    source: dict = field(default_factory=dict)
    frame: dict = field(default_factory=dict)
    bbox: dict = field(default_factory=dict)
    figures: list = field(default_factory=list)
    pieces: list = field(default_factory=list)
    components: list = field(default_factory=list)
    connections: list = field(default_factory=list)
    face: dict = field(default_factory=dict)
    dna: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"schema": RECORD_SCHEMA, "version": 1, "units": UNITS}
        for key in _FIELDS:
            out[key] = getattr(self, key)
        return out


def write_jsonl(records: Iterable[ModelRecord], path: str) -> int:
    n = 0
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r.to_json(), separators=(",", ":")) + "\n")
            n += 1
    return n


def read_jsonl(path: str) -> list[dict]:
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out
