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


def _placement(line: str):
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


def build_steps(path: str) -> list[list[Part]]:
    files, root = _parse(path)
    if root is None:
        return []
    expanded: set[str] = set()

    def leaves(ref, colour, matrix, stack):
        if ref in stack:
            raise ValueError(f"Cyclic MPD reference: {' -> '.join((*stack, ref))}")
        if ref not in files:
            if not ref.endswith(".dat"):
                raise ValueError(f"Missing MPD submodel: {ref}")
            return [(ref[:-4], colour, matrix)]
        out: list[Part] = []
        for line in files[ref]:
            if line.startswith("1 "):
                child, child_colour, child_matrix = _placement(line)
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
                child, child_colour, child_matrix = _placement(line)
                c = colour if child_colour == 16 else child_colour
                m = matrix @ child_matrix
                if child in files and child not in expanded:
                    expanded.add(child)
                    out.extend(steps_of(child, c, m, (*stack, ref)))
                else:
                    group.extend(leaves(child, c, m, (*stack, ref)))
        if group:
            out.append(group)
        return out

    expanded.add(root)
    return steps_of(root, 16, np.eye(4), ())
