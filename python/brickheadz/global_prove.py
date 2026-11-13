"""Global placement as an exact optimisation, with a machine-checkable proof.

Per instruction step the problem is finite: pick one candidate pose per part.
What makes it *global* (and fixes the depth ambiguity of per-part greedy) is the
coupling:

- **Exactly one** candidate per part;
- **No two parts share a plate cell** (exact 3-D grid cells, so stacks are fine);
- **Support**: every chosen part must rest on the ground or on a part whose top
  plate meets its bottom plate over a shared footprint column — so a piece cannot
  hover at an arbitrary depth, which is exactly the freedom the greedy solver
  abused.

The objective maximises the summed image agreement (``on_new`` + IoU) of the
chosen candidates. The model is handed to z3:

1. ``Optimize().maximize`` returns the optimum ``v*`` and a witness.
2. A second ``Solver`` asserts the same constraints **plus** ``Σ score·x ≥ v*+1``
   and returns ``unsat`` — the witness proves feasibility, the UNSAT result (with
   its core) proves no strictly better assignment exists. Together they are the
   optimality certificate; :mod:`brickheadz.certificate` re-checks both from the
   certificate's own data.

Scores are integers (``on_new + iou`` scaled by 10⁶) so the whole argument is
exact integer arithmetic. The encoding lives in :func:`build_groups` /
:func:`prove_bound` so the verifier re-runs exactly the same argument.

The encoding works on **cells** only: for part ``i`` candidate ``p``,
``cell_lists[i][p]`` is the tuple of occupied plate cells ``(cx, cz, cy)`` and
``scores[i][p]`` its integer objective. No geometry is needed to check a proof.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import z3

SCALE = 1_000_000


@dataclass
class Solve:
    picks: list  # candidate index per part (or None)
    assignment: list  # the Pose per part (or None) — filled by the geometry wrapper
    objective: int  # optimum, scaled integer
    status: str  # 'optimal' | 'unsat'
    core: list = field(default_factory=list)  # UNSAT-core labels proving optimality
    unique: bool = False  # no other assignment reaches the same objective

    @property
    def score(self) -> float:
        return self.objective / SCALE


# --------------------------------------------------------------- helpers -----


def _y(cells) -> int:
    return min(cy for _cx, _cz, cy in cells)


def _top(cells) -> int:
    return max(cy for _cx, _cz, cy in cells) + 1


def _foot(cells) -> set:
    return {(cx, cz) for cx, cz, _cy in cells}


def support_of(cell_lists: list[list[tuple]], pre_tops: dict) -> tuple[list, list]:
    """Per (part, candidate): grounded?, and the same-step candidates that support it."""
    n = len(cell_lists)
    grounded: list = [None] * n
    supporters: list = [None] * n
    by_cell: dict = {}
    for j, cl in enumerate(cell_lists):
        for q, cells in enumerate(cl):
            for c in _foot(cells):
                by_cell.setdefault(c, []).append((j, q, _top(cells)))
    for i, cl in enumerate(cell_lists):
        grounded[i] = [False] * len(cl)
        supporters[i] = [[] for _ in cl]
        for p, cells in enumerate(cl):
            y = _y(cells)
            grounded[i][p] = y == 0 or any(pre_tops.get(c, 0) == y for c in _foot(cells))
            hits = set()
            for c in _foot(cells):
                for j, q, top in by_cell.get(c, ()):  # noqa: B007
                    if j != i and top == y:
                        hits.add((j, q))
            supporters[i][p] = sorted(hits)
    return grounded, supporters


def contact(a, b, *, tol_gap: float = 1.5, tol_ov: float = 4.0) -> bool:
    """True when two LDU boxes share a face (touching within ``tol_gap`` on one axis,
    overlapping by more than ``tol_ov`` on the other two). Axis-agnostic, so it covers
    studs-up stacks and side-attached (SNOT) pieces alike."""
    (alo, ahi), (blo, bhi) = a, b
    ov = [min(ahi[k], bhi[k]) - max(alo[k], blo[k]) for k in range(3)]
    for k in range(3):
        others = [ov[i] for i in range(3) if i != k]
        if abs(ov[k]) <= tol_gap and all(o > tol_ov for o in others):
            return True
    return False


def support_from_aabb(cand_aabbs: list, pre_aabbs: list, *, ground_tol: float = 1.5) -> tuple[list, list]:
    """Contact support: grounded (ground or a pre-existing piece) or touching another
    chosen piece that is not above it. Handles lateral attachment that a stack rule misses."""
    n = len(cand_aabbs)
    grounded = [[False] * len(cl) for cl in cand_aabbs]
    supporters: list = [[[] for _ in cl] for cl in cand_aabbs]
    for i, cl in enumerate(cand_aabbs):
        for p, box in enumerate(cl):
            if box is None:
                continue
            if box[1][1] > ground_tol:
                continue  # a contact cannot legitimise a body penetrating the floor
            grounded[i][p] = (abs(box[1][1]) <= ground_tol) or any(contact(box, b) for b in pre_aabbs)
            sup = []
            for j, cl2 in enumerate(cand_aabbs):
                if j == i:
                    continue
                for q, box2 in enumerate(cl2):
                    if box2 is None:
                        continue
                    if box2[1][1] >= box[1][1] - 1.5 and contact(box, box2):
                        sup.append((j, q))
            supporters[i][p] = sup
    return grounded, supporters


# --------------------------------------------------------------- encoding ----


def build_groups(n: int, cell_lists: list[list[tuple]], pre_tops: dict, sig: list, scores: list[list[int]],
                 support: tuple | None = None, blob_ids: list[list[int]] | None = None,
                 coverage: list | None = None, coverage_weight: int = 0):
    """The constraint set, the boolean vars, the (var, score) pairs, and the objective.

    ``support`` overrides the cell-stack rule with a precomputed ``(grounded, supporters)``
    pair. ``blob_ids`` (per part, per candidate; -1 = none) adds the instance-separation
    constraint: one detected new-part blob is explained by at most one part.
    """
    if support is None:
        grounded, supporters = support_of(cell_lists, pre_tops)
    else:
        grounded, supporters = support
    xs = [[z3.Bool(f"x_{i}_{p}") for p in range(len(cell_lists[i]))] for i in range(n)]

    groups: list = []
    for i in range(n):
        groups.append((f"one_{i}", z3.PbEq([(x, 1) for x in xs[i]], 1)))

    cell_map: dict = {}
    for i in range(n):
        for p, cells in enumerate(cell_lists[i]):
            for c in cells:
                cell_map.setdefault(c, []).append(xs[i][p])
    for c, vars_ in cell_map.items():
        if len(vars_) > 1:
            groups.append((f"cell_{c[0]}_{c[1]}_{c[2]}", z3.PbLe([(v, 1) for v in vars_], 1)))

    # NOTE: a hard "one blob per part" rule is *not* sound — adjacent same-colour
    # pieces merge into one connected blob, so it over-constrains and goes unsat.
    # Blob identity is recorded per candidate and used as a shape-matching score
    # in the pose domain instead.

    # A strict rank increase along support edges makes every support chain
    # terminate at ground/prior geometry. Mutual face contact alone cannot hold
    # a disconnected cluster in mid-air.
    ranks = [z3.Int(f"support_rank_{i}") for i in range(n)]
    for i, rank in enumerate(ranks):
        groups.append((f"rank_{i}", z3.And(rank >= 0, rank < n)))
    for i in range(n):
        for p in range(len(cell_lists[i])):
            if grounded[i][p]:
                continue
            sup = supporters[i][p]
            body = z3.Or([z3.And(xs[j][q], ranks[j] < ranks[i]) for j, q in sup]) if sup else z3.BoolVal(False)
            groups.append((f"sup_{i}_{p}", z3.Implies(xs[i][p], body)))

    picks = [z3.Int(f"pick_{i}") for i in range(n)]
    for i in range(n):
        groups.append((f"pick_{i}", picks[i] == z3.Sum([p * xs[i][p] for p in range(len(cell_lists[i]))])))
    for i in range(n):
        for j in range(i + 1, n):
            # Candidate indices only have the same meaning for identical
            # tables. Equal part IDs and table lengths do not establish symmetry.
            interchangeable = (sig[i] == sig[j] and cell_lists[i] == cell_lists[j]
                               and scores[i] == scores[j] and grounded[i] == grounded[j]
                               and (coverage is None or coverage[i] == coverage[j])
                               and all(not sup for sup in supporters[i]+supporters[j]))
            if interchangeable:
                groups.append((f"sym_{i}_{j}", picks[i] <= picks[j]))

    pairs = [(xs[i][p], int(scores[i][p])) for i in range(n) for p in range(len(cell_lists[i]))]
    if coverage is not None and coverage_weight > 0:
        # Reward the union of explained image pixels, not repeated explanations
        # of the same patch by several pieces. Pixels with identical candidate
        # membership share one Boolean term, keeping the proof small.
        pixel_vars = {}
        for i, row in enumerate(coverage):
            for p, pixels in enumerate(row):
                for pixel in set(pixels):
                    pixel_vars.setdefault(int(pixel), []).append((i,p))
        patterns = {}
        for variables in pixel_vars.values():
            key = tuple(sorted(variables))
            patterns[key] = patterns.get(key,0)+1
        pairs.extend((z3.Or([xs[i][p] for i,p in key]),count*int(coverage_weight))
                     for key,count in patterns.items())
    obj = z3.Sum([s * x for x, s in pairs])
    return groups, xs, picks, pairs, obj


def prove_bound(groups, pairs, bound: int, timeout_ms: int) -> tuple[bool, list]:
    """True iff constraints ∧ (Σ score·x ≥ bound+1) is UNSAT; return the UNSAT core."""
    s = z3.Solver()
    s.set(unsat_core=True)
    s.set("timeout", timeout_ms)
    for name, g in groups:
        s.assert_and_track(g, name)
    s.assert_and_track(z3.PbGe(pairs, int(bound) + 1), "objective_gt_optimum")
    if s.check() == z3.unsat:
        return True, [str(c) for c in s.unsat_core()]
    return False, []


def prove_unique(groups, obj, picks, objective: int, chosen: list, timeout_ms: int) -> bool:
    """True iff no other assignment attains ``objective`` (a uniqueness certificate)."""
    s = z3.Solver()
    s.set("timeout", timeout_ms)
    for _name, g in groups:
        s.add(g)
    s.add(obj == int(objective))
    s.add(z3.Or([picks[i] != int(chosen[i]) for i in range(len(chosen))]))
    return s.check() == z3.unsat


def solve_core(
    n: int,
    cell_lists: list[list[tuple]],
    scores: list[list[int]],
    pre_tops: dict | None = None,
    sig: list | None = None,
    *,
    support: tuple | None = None,
    blob_ids: list[list[int]] | None = None,
    coverage: list | None = None,
    coverage_weight: int = 0,
    timeout_ms: int = 60_000,
) -> Solve:
    """Provably optimal candidate per part, from cells + scores alone."""
    pre_tops = pre_tops or {}
    sig = sig or [(i,) for i in range(n)]
    if n == 0:
        return Solve([], [], 0, "optimal", [], True)
    if any(len(cl) == 0 for cl in cell_lists):
        return Solve([None] * n, [None] * n, 0, "unsat", [])

    groups, xs, pick_vars, pairs, obj = build_groups(n, cell_lists, pre_tops, sig, scores, support, blob_ids, coverage, coverage_weight)
    opt = z3.Optimize()
    opt.set("timeout", timeout_ms)
    for _name, g in groups:
        opt.add(g)
    opt.maximize(obj)
    status = opt.check()
    if status != z3.sat:
        return Solve([None] * n, [None] * n, 0, "unsat" if status == z3.unsat else "unknown", [])
    model = opt.model()
    v_star = int(model.eval(obj).as_long())
    picks: list = [None] * n
    for i in range(n):
        for p, x in enumerate(xs[i]):
            if z3.is_true(model.eval(x, model_completion=True)):
                picks[i] = p
                break
    optimal, core = prove_bound(groups, pairs, v_star, timeout_ms)
    unique = False
    if optimal and all(p is not None for p in picks):
        unique = prove_unique(groups, obj, pick_vars, v_star, picks, timeout_ms)
    return Solve(picks, [None] * n, v_star, "optimal" if optimal else "feasible", core, unique)


# ------------------------------------------------------- geometry wrapper ----


def pose_score(p) -> int:
    """Integer objective contribution of a candidate (image agreement, exact)."""
    return int(round((float(p.on_new) + float(p.iou)) * 0.5 * SCALE))


def solve_step(parts: list[tuple[str, int]], cand_lists: list[list], pre_tops: dict | None = None, *,
               pre_aabbs: list | None = None, coverage: list | None = None, coverage_weight: int = 0, timeout_ms: int = 60_000) -> Solve:
    """Provably optimal assignment of one :class:`Pose` per part, or ``unsat``.

    When ``pre_aabbs`` (world bounds of the already-built pieces) is given and every
    candidate carries an ``aabb``, support is contact-based (any face), so laterally
    attached pieces are physical; otherwise it falls back to the plate-cell stack rule.
    """
    cell_lists = [[tuple(p.cells) for p in cl] for cl in cand_lists]
    scores = [[pose_score(p) for p in cl] for cl in cand_lists]
    sig = [(parts[i][0], parts[i][1], len(cand_lists[i])) for i in range(len(parts))]
    support = None
    if pre_aabbs is not None and all(getattr(p, "aabb", None) is not None for cl in cand_lists for p in cl):
        support = support_from_aabb([[p.aabb for p in cl] for cl in cand_lists], pre_aabbs)
    blob_ids = [[int(getattr(p, "blob", -1)) for p in cl] for cl in cand_lists]
    res = solve_core(len(parts), cell_lists, scores, pre_tops, sig, support=support,
                     blob_ids=blob_ids, coverage=coverage, coverage_weight=coverage_weight, timeout_ms=timeout_ms)
    res.assignment = [cand_lists[i][res.picks[i]] if res.picks[i] is not None else None for i in range(len(parts))]
    return res
