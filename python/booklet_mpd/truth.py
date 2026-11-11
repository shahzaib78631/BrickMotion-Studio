"""Answer-key steps from an OMR/MPD, expanded in booklet build order.

`brickheadz.reconstruct.steps_from_omr` reads only the root file's STEP lines and
lumps every submodel's parts into the step that first references it. Real OMRs keep
most STEP lines inside submodel files, so that loader hides the build sequence.
Here a submodel's own steps are emitted where it is first referenced (before the
parent step that attaches it); later instances add their leaves to the parent step.
"""
from __future__ import annotations

import numpy as np

Part = tuple[str, int, np.ndarray]


def _name(value: str) -> str:
    return value.strip().replace("\\", "/").lower()


def _placement(line: str):  # raises ValueError on a malformed line
    fields = line.split(maxsplit=14)
    if len(fields) != 15:
        raise ValueError(f"Malformed LDraw placement: {line[:100]}")
    values = np.array([float(v) for v in fields[2:14]])
    if not np.isfinite(values).all():
        raise ValueError("Non-finite LDraw placement")
    matrix = np.eye(4)
    matrix[:3, 3] = values[:3]
    matrix[:3, :3] = values[3:].reshape(3, 3)
    return _name(fields[14]), int(fields[1]), matrix


def _parse(path: str) -> tuple[dict[str, list[str]], str | None]:
    files: dict[str, list[str]] = {}
    current = root = None
    with open(path, errors="strict") as source:
        for line in source:
            line = line.strip()
            if line.upper().startswith("0 FILE "):
                current = _name(line[7:])
                if current in files:
                    raise ValueError(f"Duplicate MPD definition: {current}")
                files[current] = []
                root = root or current
            elif line.upper() == "0 NOFILE":
                current = None
            elif current is not None:
                files[current].append(line)
    return files, root


def _flexible_chains(files: dict[str, list[str]], root: str) -> set[str]:
    """Submodels that model one flexible part (flex axle, hose, cable) as many tiny
    segments: no STEP lines, at least 12 placements, at most 3 distinct part names."""
    found = set()
    for name, lines in files.items():
        if name == root or name.endswith(".dat") or any(l.upper() == "0 STEP" or l.upper().startswith("0 ROTSTEP ") for l in lines):
            continue
        refs = [l.split(maxsplit=14)[14] for l in lines if l.startswith("1 ") and len(l.split(maxsplit=14)) == 15]
        if len(refs) >= 12 and len({_name(r) for r in refs}) <= 3:
            found.add(name)
    return found


def build_steps(path: str, *, expand_submodels: bool = True, warnings: list[str] | None = None) -> list[list[Part]]:
    """Strict unless `warnings` is given: then malformed placement lines are skipped and described there."""
    files, root = _parse(path)
    if root is None:
        return []
    expanded: set[str] = set()

    def placement(line):
        try:
            return _placement(line)
        except ValueError as error:
            if warnings is None:
                raise
            warnings.append(str(error))
            return None

    chains = _flexible_chains(files, root)

    def leaves(ref, colour, matrix, stack):
        if ref in stack:
            raise ValueError(f"Cyclic MPD reference: {' -> '.join((*stack, ref))}")
        if ref in chains:
            return [(ref.removesuffix(".ldr"), colour, matrix)]
        if ref.endswith(".dat") or ref not in files:  # embedded part definitions are one part
            if not ref.endswith(".dat"):
                raise ValueError(f"Missing MPD submodel: {ref}")
            return [(ref[:-4], colour, matrix)]
        out: list[Part] = []
        for line in files[ref]:
            if line.startswith("1 "):
                placed = placement(line)
                if placed is None:
                    continue
                child, child_colour, child_matrix = placed
                out.extend(leaves(child, colour if child_colour == 16 else child_colour, matrix @ child_matrix, (*stack, ref)))
        return out

    def steps_of(ref, colour, matrix, stack):
        if ref in stack:
            raise ValueError(f"Cyclic MPD reference: {' -> '.join((*stack, ref))}")
        out: list[list[Part]] = []
        group: list[Part] = []
        for line in files[ref]:
            upper = line.upper()
            if upper == "0 STEP" or upper.startswith("0 ROTSTEP "):
                if group:
                    out.append(group)
                group = []
            elif line.startswith("1 "):
                placed = placement(line)
                if placed is None:
                    continue
                child, child_colour, child_matrix = placed
                c = colour if child_colour == 16 else child_colour
                m = matrix @ child_matrix
                if expand_submodels and child in files and not child.endswith(".dat") and child not in chains and child not in expanded:
                    expanded.add(child)
                    out.extend(steps_of(child, c, m, (*stack, ref)))
                else:
                    group.extend(leaves(child, c, m, (*stack, ref)))
        if group:
            out.append(group)
        return out

    expanded.add(root)
    return steps_of(root, 16, np.eye(4), ())
