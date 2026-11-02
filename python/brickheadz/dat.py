"""MPD loader for BrickHeadz models.

The OMR BrickHeadz files mix two kinds of embedded sections:

* ``.ldr`` sections are submodels and must be recursed.
* ``.dat`` sections are embedded decorated parts (and their ``sXX`` subparts)
  and must stay atomic, or part/colour fidelity is destroyed.

This mirrors the app's own rule in ``src/io/ldrawImport.ts`` and deliberately
differs from ``assembly_model.model.load_model``, which recurses into every
section reference. Sections are resolved from the whole-file map first, because
the OMR files use forward references.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from assembly_model.ldraw import matrix_from_type1

_EXT = re.compile(r"\.(dat|ldr)$", re.IGNORECASE)
_NAME = re.compile(r"^([0-9]+)([a-z]?)")


@dataclass(frozen=True)
class Piece:
    key: str
    part: str  # raw reference name, lower-cased (may be an embedded part)
    base_part: str  # underlying library part id
    color: int
    matrix: np.ndarray  # 4x4, part -> model, row-major (assembly_model convention)
    submodel: str
    decorated: bool


def parse_part_name(name: str) -> tuple[str, bool]:
    """Reference name -> (library base id, decorated?).

    LDraw print/pattern variants are ``<base>p<code>``, while part variants use a
    single trailing letter (``3069b``). So ``41585-1 - 87079pz0.dat`` ->
    ``("87079", True)``, ``3068bpz0`` -> ``("3068b", True)``, and ``3069b.dat``
    -> ``("3069b", False)``.
    """
    n = name.strip().lower().replace("\\", "/").rsplit("/", 1)[-1]
    if " - " in n:  # OMR embedded-part prefix "<set> - <part>"
        n = n.split(" - ", 1)[1]
    n = _EXT.sub("", n)
    m = _NAME.match(n)
    if not m:
        return n, False
    digits, letter = m.group(1), m.group(2)
    rest = n[len(digits) + len(letter):]
    if letter == "p" and rest:  # "<base>p<code>"
        return digits, True
    return digits + letter, rest.startswith("p") and len(rest) > 1


def split_sections(path: str) -> dict[str, list[str]]:
    """``0 FILE`` section splitter (``!order`` holds definition order)."""
    files: dict[str, list[str]] = {"!order": []}
    cur: str | None = None
    with open(path, errors="ignore") as f:
        for line in f.read().splitlines():
            if line.startswith("0 FILE") and line.split("0 FILE", 1)[1].strip():
                cur = line.split("0 FILE", 1)[1].strip().lower()
                if cur not in files:
                    files["!order"].append(cur)
                files.setdefault(cur, [])
            else:
                if cur is None:
                    cur = "!inline"
                    files["!order"].insert(0, cur)
                    files.setdefault(cur, [])
                files[cur].append(line)
    return files


def _ref_name(toks: list[str]) -> str:
    ref = toks[14] if len(toks) == 15 else " ".join(toks[14:])
    return ref.strip().lower()


def _color(tok: str) -> int:
    try:
        return int(tok)
    except ValueError:
        return 16


def load_pieces(path: str) -> list[Piece]:
    """Flatten an MPD into placed pieces with world matrices and semantics tags."""
    files = split_sections(path)
    if not files["!order"]:
        return []
    main = files["!order"][0]
    out: list[Piece] = []
    counter = [0]
    _walk(files, main, np.eye(4), main, out, counter)
    return out


def _walk(files, name, parent, submodel, out, counter) -> None:
    lines = files.get(name)
    if lines is None:
        return
    for line in lines:
        if not line or line[0] == "0":
            continue
        toks = line.split()
        if toks[0] != "1" or len(toks) < 15:
            continue
        try:
            mat = matrix_from_type1(toks)
        except Exception:
            continue
        ref = _ref_name(toks)
        world = parent @ mat
        embedded_dat = ref.endswith(".dat")
        if ref in files and not embedded_dat:
            _walk(files, ref, world, ref, out, counter)
            continue
        base, decorated = parse_part_name(ref)
        out.append(
            Piece(
                key=f"{submodel}/{counter[0]}",
                part=ref,
                base_part=base,
                color=_color(toks[1]),
                matrix=world,
                submodel=submodel,
                decorated=decorated,
            )
        )
        counter[0] += 1
