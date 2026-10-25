"""Forward-construction planning over certified corridors.

Work-queue model (scales to 1.5k-piece models):
- every piece enters a FIFO queue;
- a piece is certified (swept-AABB corridor + support) against the placed set;
  on success it commits and its joint-anchored pieces are re-enqueued;
- on failure it re-queues, but only spends a retry when nothing has been
  committed since its last test; after the retry cap it waits for the
  stall-breaker, which force-commits the best-supported failed candidate with
  certificate.clear = False (a recorded trust gap).
The learned prior only reorders feasible candidates; it never approves one.
"""
from __future__ import annotations

import json
import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from .assembly import Assembly, supported
from .certify import swept_corridor
from .geometry import BoxGrid
from .prior import vectorize
from .schema import Insertion, Step, StepCertificate

DOWN = np.array([0.0, 1.0, 0.0])
BASE_DIST = 48.0


@dataclass
class Options:
    max_ms: int = 30_000
    frames: int = 32
    margin: float = 1.5
    prior_path: str | None = None
    trace_path: str | None = None
    retries: int = 3


@dataclass
class Cand:
    piece: str
    axis: np.ndarray
    tier: int
    tier_name: str
    dist: float
    contacts: int
    area: float
    mates: set[str] = field(default_factory=set)


@dataclass
class Result:
    steps: list[Step] = field(default_factory=list)
    placed: set[str] = field(default_factory=set)
    traces: list[dict] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def plan(asm: Assembly, options: Options = Options()) -> Result:
    from .prior import Prior

    prior = Prior.load(options.prior_path)
    grid = BoxGrid()
    placed: set[str] = set()
    steps: list[Step] = []
    traces: list[dict] = []
    started = time.perf_counter()
    by_piece = asm.by_key
    inputs: dict[str, set[str]] = {}
    for j in asm.joints:
        inputs.setdefault(j.child, set()).add(j.parent)
        inputs.setdefault(j.parent, set()).add(j.child)
    queue: deque = deque(p for p in asm.pieces)
    retry_pool: deque = deque()
    attempts: dict[str, int] = {}
    tested_at: dict[str, int] = {}
    failed_rows: dict[str, dict] = {}
    tests = 0
    forced = 0

    def stall_breaker() -> bool:
        nonlocal forced
        ranked = sorted(
            failed_rows.values(),
            key=lambda r: (-r["supported"], r["tier"], -r["area"], -r["contacts"], r["piece"]),
        )
        if not ranked:
            return False
        key = ranked[0]["piece"]
        piece = by_piece[key]
        cand = _cands(asm, piece, placed)[0]
        step = _step(
            asm,
            cand,
            StepCertificate(kind="swept-aabb", frames=options.frames, margin=options.margin, clear=False, blockers=["stall-breaker"]),
            len(steps),
        )
        step.uncertified = True
        step.reason = "no certified corridor within budget; stall-breaker commit"
        _commit(asm, grid, placed, cand)
        steps.append(step)
        forced += 1
        traces.append({"decision": step.order, "forced": 1, "candidates": []})
        attempts.pop(key, None)
        tested_at.pop(key, None)
        failed_rows.pop(key, None)
        for anchor in inputs.get(key, ()):
            anchor_piece = by_piece.get(anchor)
            if anchor not in placed and anchor_piece is not None:
                queue.append(anchor_piece)
        return True

    while (queue or retry_pool) and (time.perf_counter() - started) * 1000.0 < options.max_ms:
        piece = queue.popleft() if queue else retry_pool.popleft()
        key = piece.key
        if key in placed:
            continue
        if tested_at.get(key, -1) == len(placed):
            attempts[key] = attempts.get(key, 0) + 1
            if attempts[key] < options.retries:
                retry_pool.append(piece)
            continue
        tested_at[key] = len(placed)
        cands = _cands(asm, piece, placed)
        if not cands:
            continue
        rows: list[dict] = []
        feasible: list[tuple[Cand, Step]] = []
        for c in cands:
            cert = _certify(asm, grid, c, placed, options)
            tests += 1
            sup = supported(asm, key, placed | {key})
            f = vectorize(c)
            rows.append({
                "piece": key,
                "tier": c.tier_name,
                "axis": [int(round(v)) for v in c.axis],
                "contacts": c.contacts,
                "area": round(c.area, 1),
                "prior": round(prior.score(f), 5) if prior else None,
                "certified": 1 if cert.clear else 0,
                "supported": 1 if sup else 0,
                "features": {k: round(v, 4) for k, v in f.items()},
            })
            if cert.clear and sup:
                feasible.append((c, _step(asm, c, cert, len(steps))))
        if not feasible:
            failed_rows[key] = rows[0]
            retry_pool.append(piece)
            continue
        chosen, chosen_step = _pick(feasible, prior)
        for row in rows:
            if row["piece"] == chosen.piece and row["axis"] == [int(round(v)) for v in chosen.axis]:
                row["chosen"] = 1
        _commit(asm, grid, placed, chosen)
        steps.append(chosen_step)
        traces.append({"decision": chosen_step.order, "forced": 0, "candidates": rows})
        attempts.pop(key, None)
        tested_at.pop(key, None)
        failed_rows.pop(key, None)
        for anchor in inputs.get(key, ()):
            anchor_piece = by_piece.get(anchor)
            if anchor not in placed and anchor_piece is not None:
                retry_pool.append(anchor_piece)

    while len(placed) < len(asm.pieces) and (time.perf_counter() - started) * 1000.0 < options.max_ms:
        if not stall_breaker():
            break

    stats = {
        "pieces": len(asm.pieces),
        "placed": len(placed),
        "certified": len(placed) - forced,
        "forced": forced,
        "tests": tests,
        "ms": round((time.perf_counter() - started) * 1000.0, 1),
        "uncertified": len(asm.pieces) - len(placed),
    }
    result = Result(steps=steps, placed=placed, traces=traces, stats=stats)
    if options.trace_path:
        with open(options.trace_path, "w") as f:
            for row in traces:
                f.write(json.dumps(row) + "\n")
    return result


def _pick(feasible: list[tuple[Cand, Step]], prior) -> tuple[Cand, Step]:
    def rank(t: tuple[Cand, Step]) -> tuple:
        c = t[0]
        score = prior.score(vectorize(c)) if prior else 0.0
        return (c.tier, -score, -c.area, c.contacts, c.piece)

    return sorted(feasible, key=rank)[0]


def _cands(asm: Assembly, piece, placed: set[str]) -> list[Cand]:
    key = piece.key
    joints = [j for j in asm.joints_by_child.get(key, ()) if j.parent in placed]
    reverse = [j for j in asm.joints_by_parent.get(key, ()) if j.child in placed]
    contacts = len(joints) + len(reverse)
    area = _support_area(asm, key, placed)
    mates = {j.parent for j in joints} | {j.child for j in reverse}
    cands: list[Cand] = []
    seen: set[tuple] = set()

    def push(axis: np.ndarray, tier: int, tier_name: str, dist: float = BASE_DIST) -> None:
        ax = _snap_axis(axis)
        if tuple(np.round(ax, 3)) in seen:
            return
        seen.add(tuple(np.round(ax, 3)))
        cands.append(Cand(piece=key, axis=ax, tier=tier, tier_name=tier_name, dist=dist, contacts=contacts, area=area, mates=mates))

    for j in joints + reverse:
        push(-np.array(j.axis), 0, "snap")
    if not cands:
        if contacts or area > 0:
            push(DOWN, 1, "face")
        else:
            push(DOWN, 2, "drop")
    return cands


def _support_area(asm: Assembly, key: str, placed: set[str]) -> float:
    """Face area gained from placed supporters whose TOP (min y) meets this BOTTOM (max y)."""
    lo, hi = asm.boxes[key]
    area = 0.0
    for other in placed:
        if other not in asm.boxes:
            continue
        olo, ohi = asm.boxes[other]
        if abs(float(olo[1]) - float(hi[1])) < 3.2:
            ox = min(hi[0], ohi[0]) - max(lo[0], olo[0])
            oz = min(hi[2], ohi[2]) - max(lo[2], olo[2])
            if ox > 2 and oz > 2:
                area += float(ox * oz)
    return area


def _snap_axis(v: np.ndarray) -> np.ndarray:
    idx = int(np.argmax(np.abs(v)))
    out = np.zeros(3)
    out[idx] = float(np.sign(v[idx]) or 1.0)
    return out


def _certify(asm: Assembly, grid: BoxGrid, c: Cand, placed: set[str], options: Options) -> StepCertificate:
    lo, hi = asm.boxes[c.piece]
    start = lo - c.axis * c.dist
    start_hi = hi - c.axis * c.dist
    # Socket tiers (0): mate boxes interpenetrate by construction (pegs sit
    # inside sockets), so the sweep cannot be box-certified against them.
    # Non-mate obstacles still block every frame.
    forgive_t, forgive_set = (0.0, c.mates) if (c.tier == 0 and c.mates) else (1.0, set())
    res = swept_corridor(
        grid,
        (c.piece, 0),
        start,
        start_hi,
        lo,
        hi,
        frames=options.frames,
        margin=options.margin,
        allow_final=c.mates,
        forgive_after=forgive_t,
        forgive=forgive_set,
    )
    return StepCertificate(kind="swept-aabb", frames=res.frames, margin=res.margin, clear=res.clear, blockers=res.blockers[:8])


def _step(asm: Assembly, c: Cand, cert: StepCertificate, order: int) -> Step:
    lo, hi = asm.boxes[c.piece]
    origin = (lo + hi) / 2 - c.axis * c.dist
    return Step(
        id=f"s{order + 1}",
        pieces=[c.piece],
        order=order,
        insertion=Insertion(
            axis=[float(v) for v in c.axis],
            distance=float(c.dist),
            origin=[round(float(v), 1) for v in origin],
            priority=str(c.tier),
            tier=c.tier_name,
        ),
        certificate=cert,
    )


def _commit(asm: Assembly, grid: BoxGrid, placed: set[str], c: Cand) -> None:
    lo, hi = asm.boxes[c.piece]
    grid.add(lo, hi, (c.piece, 0))
    placed.add(c.piece)
