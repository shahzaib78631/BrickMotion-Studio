"""Candidate coverage on the answer keys (SCORING ONLY): for every part a booklet step adds, is its true
pose among the candidates the solver enumerates? The base is the model before the step plus the
step's other parts (in place, as the truth has them), so this is the ceiling on teacher-forced accuracy.
A miss is reported by kind: no stud connection to anything ("loose", e.g. a plate laid flush beside
the model and tied in by later steps), sub-model steps without a base, or connected but not enumerated.

    python -m booklet_mpd.solver.coverage 40353 41605 ...      (no sets: every train set)
"""
from __future__ import annotations

import json
import sys
from collections import Counter

import numpy as np

from ..score import exact_flags
from .candidates import candidates
from .dataset import ROOT, cases, grades


TOL = 0.1     # LDU: answer keys store about two decimals (angled beams)


def covered(lib, part, colour, truth, model) -> bool:
    for c in candidates(lib, part, model):
        m = c["matrix"]
        if np.linalg.norm(m[:3, 3] - truth[:3, 3]) > 40:
            continue
        if exact_flags(lib, [(part, colour, m)], [(part, colour, truth)], atol=TOL)[0]:
            return True
    return False


def touches(lib, part, truth, model, tol: float = 0.6) -> bool:
    """Whether the part's box meets any model part's box (it sits against something)."""
    from .place import world_triangles
    a = world_triangles(lib, part, truth).reshape(-1, 3)
    if not len(a):
        return False
    lo, hi = a.min(0) - tol, a.max(0) + tol
    for p, _c, m in model:
        b = world_triangles(lib, p, m).reshape(-1, 3)
        if len(b) and np.all(b.max(0) >= lo) and np.all(b.min(0) <= hi):
            return True
    return False


def audit(lib, set_number: str) -> dict:
    kinds, misses = Counter(), []
    for case in cases(set_number, with_images=False):
        base = case.visible if case.visible else []
        for k, (p, c, m) in enumerate(case.added):
            others = [x for j, x in enumerate(case.added) if j != k]
            model = base + others
            if not model:
                kinds["first part"] += 1
                continue
            if covered(lib, p, c, m, model):
                kinds["covered"] += 1
                continue
            kind = "sub-model, no base" if not case.visible else ("touching, not enumerated" if touches(lib, p, m, model) else "loose")
            kinds[kind] += 1
            misses.append({"step": case.step_number, "part": p, "kind": kind, "at": np.round(m[:3, 3], 1).tolist()})
    return {"set": set_number, "kinds": dict(kinds), "misses": misses}


def main(argv: list[str]) -> None:
    from assembly_model.ldraw import load_library
    from ..protocol import tuning_sets
    lib = load_library(str(ROOT / "public/ldraw"))
    sets = argv or sorted(tuning_sets(grades()))
    total = Counter()
    out = []
    for s in sets:
        try:
            r = audit(lib, s)
        except Exception as e:      # a set whose extract or key is missing
            print(s, "skipped:", e, flush=True)
            continue
        out.append(r)
        total.update(r["kinds"])
        n = sum(r["kinds"].values())
        print(s, f"covered {r['kinds'].get('covered', 0)}/{n}", dict(r["kinds"]), flush=True)
    n = sum(total.values())
    print("ALL", f"covered {total['covered']}/{n} ({total['covered'] / max(n, 1):.1%})", dict(total))
    path = ROOT / ".cache/booklet-mpd/solver/coverage.json"
    path.write_text(json.dumps({"total": dict(total), "sets": out}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
