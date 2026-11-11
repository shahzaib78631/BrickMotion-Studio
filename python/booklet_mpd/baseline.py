"""Baseline: run the current solver on real booklet pages with an oracle parts list.

Oracle = part ids and colours per step from the OMR (no poses). This isolates
placement error from parts-list reading, which is measured separately. Poses
from the OMR are used only afterwards, for scoring.
"""
from __future__ import annotations

from collections import Counter

from brickheadz.booklet_vision import reconstruct_sequence
from brickheadz.parts import info

from .score import exact_flags

BUDGET_KEYS = ("unsupported", "not_reached", "solver_failed", "placed_wrong", "placed_exact", "foundation")


def classify_step(lib, parts: list[tuple[str, int]]) -> str:
    """Whether `solve_additions` can even attempt this step."""
    if not parts or len(parts) > 2:
        return "unsupported:more than two additions" if parts else "unsupported:no additions"
    if len(parts) == 2 and parts[0] != parts[1]:
        return "unsupported:two different additions"
    if any(info(lib, p).h != 1 or info(lib, p).side_studs for p, _ in parts):
        return "unsupported:not a plate/tile"
    return "supported"


def error_budget(statuses: list[str]) -> dict:
    counts = Counter("unsupported" if s.startswith("unsupported") else s for s in statuses)
    total = len(statuses)
    return {k: (counts[k] / total if total else 0.0) for k in BUDGET_KEYS}


def _foundation(lib, parts):
    candidates = [pc for pc in parts if info(lib, pc[0]).top_studs and info(lib, pc[0]).h == 1]
    candidates.sort(key=lambda pc: info(lib, pc[0]).w * info(lib, pc[0]).d, reverse=True)
    area = lambda pc: info(lib, pc[0]).w * info(lib, pc[0]).d
    if not candidates:
        return None
    if len({pc for pc in candidates if area(pc) == area(candidates[0])}) > 1:
        return None
    return candidates[0]


def _empty(total):
    return {"steps_total": total, "steps_supported": 0, "steps_attempted": 0, "first_failure": None,
            "parts_predicted": 0, "parts_exact": 0, "per_part": [], "statuses": []}


def run_set(lib, palette, truth_steps, pictures, aligned) -> dict:
    n = len(truth_steps)
    out = _empty(n)
    mapping = {o: b for b, o in aligned}
    wanted = [[(p, c) for p, c, _m in step] for step in truth_steps]
    foundation = _foundation(lib, wanted[0]) if wanted else None
    if foundation is None:
        out["first_failure"] = {"step": 1, "message": "First-step foundation identity is ambiguous"}
        out["statuses"] = ["solver_failed"] + ["not_reached"] * (n - 1)
        return out
    additions = [list(w) for w in wanted]
    additions[0].remove(foundation)

    statuses = ["not_reached"] * n
    prefix: list[int] = []
    blocked = False
    for o in range(n):
        picture = pictures[mapping[o]] if o in mapping and mapping[o] < len(pictures) else None
        if o == 0 and not additions[0]:
            statuses[0] = "foundation"
            continue
        kind = "unsupported:no picture" if picture is None else classify_step(lib, additions[o])
        if kind != "supported":
            statuses[o] = kind
            blocked = True
            continue
        out["steps_supported"] += 1
        if not blocked:
            prefix.append(o)
    out["steps_supported"] += sum(1 for s in statuses if s == "foundation")

    def attempt(k):
        steps = [{"number": o + 1, "rgb": pictures[mapping[o]], "parts": additions[o]} for o in prefix[:k]]
        return reconstruct_sequence(lib, palette, steps, foundation)

    solved, failed_at, message = None, None, ""
    if prefix:
        try:
            solved = attempt(len(prefix))
        except Exception as error:
            message = f"{error}"
            lo, hi = 0, len(prefix)
            while hi - lo > 1:
                mid = (lo + hi) // 2
                try:
                    solved = attempt(mid)
                    lo = mid
                except Exception as e2:
                    hi, message = mid, f"{e2}"
            solved = attempt(lo) if lo else None
            failed_at = hi - 1
    done = len(prefix) if failed_at is None else failed_at
    out["steps_attempted"] = done + (1 if failed_at is not None else 0)
    if failed_at is not None:
        out["first_failure"] = {"step": prefix[failed_at] + 1, "message": message}
        statuses[prefix[failed_at]] = "solver_failed"
    if solved is not None:
        _built, groups, reports = solved
        for i in range(done):
            o = prefix[i]
            predicted = groups[i][1:] if i == 0 else groups[i]
            flags = exact_flags(lib, predicted, truth_steps[o])
            for (part, colour, _m), ok in zip(predicted, flags):
                out["per_part"].append({"step": o + 1, "id": part, "colour": colour, "exact": ok, "report": reports[i]})
            out["parts_predicted"] += len(predicted)
            out["parts_exact"] += sum(flags)
            statuses[o] = "placed_exact" if all(flags) else "placed_wrong"
    out["statuses"] = statuses
    return out
