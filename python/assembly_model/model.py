"""Model loading: flatten .mpd/.ldr authored files into placed piece records.

Only type-1 references into the model's OWN sections are recursed (submodels);
references to anything else are treated as library part instances, which keeps
stud primitives and part-internal geometry out of the piece list.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from .ldraw import matrix_from_type1


@dataclass
class Piece:
    key: str
    part: str
    color: int
    matrix: np.ndarray
    submodel: str | None = None


@dataclass
class Model:
    name: str
    pieces: list[Piece]
    skipped_lines: int = 0


def load_model(path: str) -> Model:
    files = _sections(path)
    main = files["!order"][0]
    pieces: list[Piece] = []
    counters = {"n": 0, "skipped": 0}
    _walk(files, main.lower(), np.eye(4), main, pieces, counters)
    pieces.sort(key=lambda p: int(p.key.split("/")[-1]))
    return Model(name=os.path.basename(path), pieces=pieces, skipped_lines=counters["skipped"])


def _sections(path: str) -> dict[str, list[str]]:
    text = open(path, errors="ignore").read()
    files: dict[str, list[str]] = {"!order": []}
    cur: str | None = None
    for line in text.splitlines():
        if line.startswith("0 FILE") and len(line.split("0 FILE", 1)[1].strip()) > 0:
            cur = line.split("0 FILE", 1)[1].strip().lower()
            if cur not in files:
                files["!order"].append(cur)
            files[cur] = []
        else:
            if cur is None:
                cur = "!inline"
                files["!order"].insert(0, cur)
                files[cur] = []
            files[cur].append(line)
    return files


def _walk(files, name: str, parent: np.ndarray, submodel: str, out: list[Piece], counters) -> None:
    lines = files.get(name)
    if lines is None:
        return
    for line in lines:
        if not line or line[0] == "0":
            continue
        toks = line.split()
        if toks[0] == "1" and len(toks) >= 15:
            try:
                color = int(toks[1])
            except ValueError:
                color = 0
            mat = matrix_from_type1(toks)
            ref = toks[14].lower() if len(toks) == 15 else " ".join(toks[14:]).lower()
            world = parent @ mat
            if ref in files:
                _walk(files, ref, world, ref, out, counters)
            else:
                out.append(Piece(key=f"{submodel}/{counters['n']}", part=ref, color=color, matrix=world, submodel=submodel))
                counters["n"] += 1
        elif toks[0] in ("3", "4"):
            counters["skipped"] += 1
