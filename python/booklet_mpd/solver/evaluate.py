"""Scoring helpers for the solver benchmark (answer key used only here, never at inference).

* Ids: a predicted id counts as the answer key's id when it is the same physical part (same base
  number, or an identical LDraw triangle mesh): booklets and OMR files name aliases differently.
* Frame: a free-run model (or a first step) is built in its own frame, so before scoring it is moved
  by the rigid transform that best maps it onto the answer key (tried from each predicted/true pair
  of the same part and colour, rotations restricted to the 24 cube turns).
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np

from ..inventory_check import _plain, base_number, colour_aliases, geometry_equivalent
from ..metrics import chamfer_distance
from ..score import exact_flags

_GEQ: dict = {}
LDCONFIG = __import__("pathlib").Path(__file__).resolve().parents[3] / "public/ldraw/LDConfig.ldr"


@lru_cache(maxsize=1)
def _rubber() -> dict[int, int]:
    return colour_aliases(LDCONFIG)


def same_colour(a: int, b: int) -> bool:
    """Same printed colour: a rubber colour (Rubber_Black 256) counts as its plain one (Black 0)."""
    rubber = _rubber()
    return rubber.get(int(a), int(a)) == rubber.get(int(b), int(b))


def same_part(lib, a: str, b: str) -> bool:
    a, b = _plain(a), _plain(b)
    if a == b or base_number(a) == base_number(b):
        return True
    key = (id(lib), *sorted((a, b)))
    if key not in _GEQ:
        _GEQ[key] = geometry_equivalent(lib, a, b)
    return _GEQ[key]


def canonical(lib, predicted: list, truth: list) -> list:
    """Rename predicted ids to the answer key's id of the same physical part and colour."""
    names = {(p, c) for p, c, _m in truth}
    out = []
    for p, c, m in predicted:
        if (p, c) not in names:
            for tp, tc in names:
                if tc == c and same_part(lib, p, tp):
                    p = tp
                    break
        out.append((p, c, m))
    return out


def _is_cube_rotation(r: np.ndarray) -> bool:
    return np.allclose(np.abs(r).sum(0), 1, atol=1e-3) and np.allclose(np.abs(r).max(0), 1, atol=1e-3)


def aligned(lib, predicted: list, truth: list, max_tries: int = 60) -> tuple[list, int]:
    """(predicted moved onto the answer key's frame, exact count) for the best rigid alignment.

    Each anchor pair (a predicted part and an answer-key part of the same id and colour) proposes the
    cube turns that map the anchor onto its answer-key copy, including every turn under which the
    anchor's own geometry is unchanged (a square plate admits four frames, not one)."""
    from ..viewfit import ORIENTATIONS
    predicted = canonical(lib, predicted, truth)
    if not predicted or not truth:
        return predicted, 0
    best = (predicted, sum(exact_flags(lib, predicted, truth)))
    tries = 0
    seen: set = set()
    for i in range(min(6, len(predicted))):
        p, c, m = predicted[i]
        m = np.asarray(m, float)
        for tp, tc, tm in truth:
            if tp != p or tc != c:
                continue
            tm = np.asarray(tm, float)
            for sym in ORIENTATIONS:
                T = np.eye(4)
                T[:3, :3] = tm[:3, :3] @ sym @ np.linalg.inv(m[:3, :3])
                if not _is_cube_rotation(T[:3, :3]):
                    continue
                T[:3, :3] = np.round(T[:3, :3])
                T[:3, 3] = tm[:3, 3] - T[:3, :3] @ m[:3, 3]
                key = tuple(np.round(T, 2).ravel())
                if key in seen or not exact_flags(lib, [(p, c, T @ m)], [(tp, tc, tm)])[0]:
                    continue
                seen.add(key)
                moved = [(pp, cc, T @ np.asarray(mm, float)) for pp, cc, mm in predicted]
                n = sum(exact_flags(lib, moved, truth))
                if n > best[1]:
                    best = (moved, n)
                tries += 1
                if tries >= max_tries or best[1] == len(truth):
                    return best
    return best


def step_scores(lib, predicted: list, truth: list, frame_free: bool = False) -> dict:
    if frame_free:
        moved, exact = aligned(lib, predicted, truth)
    else:
        moved = canonical(lib, predicted, truth)
        exact = sum(exact_flags(lib, moved, truth)) if moved else 0
    return {"parts": len(truth), "predicted": len(predicted), "exact": int(exact),
            "all_exact": bool(len(truth) and exact == len(truth) and len(predicted) == len(truth))}


def model_scores(lib, predicted: list, truth: list) -> dict:
    moved, exact = aligned(lib, predicted, truth)
    flags = exact_flags(lib, moved, truth) if moved else []
    return {"parts": len(truth), "predicted": len(predicted), "exact": int(exact),
            "component_accuracy": exact / len(truth) if truth else 0.0,
            "model_accuracy": float(len(predicted) == len(truth) and exact == len(truth)),
            "chamfer": chamfer_distance(lib, moved, truth) if moved and truth else float("inf"),
            "flags": [bool(f) for f in flags]}
