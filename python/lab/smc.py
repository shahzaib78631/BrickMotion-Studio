"""Many builds at once (sequential Monte Carlo): grow n builds of one caption, every few parts render
and score them against the caption, drop the weaker half and copy the stronger.

A build that ended (the builder closed the set, or it could go no further) keeps its last score and is
no longer copied: copies only grow from builds still going. The answer is the best-scoring build that
the builder closed itself, else the best of the rest.
"""
from __future__ import annotations

import time

import numpy as np

from .sample import Run


def smc(model, vocab, new_world, clip, caption_vec, scorer, rules, n: int = 16, every: int = 8,
        max_parts: int = 150, seed: int = 0, min_parts: int = 2, log=None) -> dict:
    t0 = time.time()
    rng = np.random.default_rng(seed)
    runs = [Run(model, vocab, new_world, clip, rules, seed=seed * 1000 + i, finish=True, min_parts=min_parts,
                max_parts=max_parts) for i in range(n)]
    score: dict[int, float] = {}
    best_by_round: list[float] = []
    rounds = 0
    while True:
        changed = []
        for r in runs:
            if r.done:
                continue
            moved = False
            for _ in range(every):
                if not r.step():
                    break
                moved = True
            changed.append(r)
            if not moved and id(r) in score:
                changed.pop()
        todo = [r for r in runs if id(r) not in score or r in changed]
        if todo:
            vals = scorer.score([r.model_view() for r in todo], caption_vec)
            for r, v in zip(todo, vals):
                score[id(r)] = float(v)
        rounds += 1
        best_by_round.append(max(score[id(r)] for r in runs))
        if log:
            log(f'round {rounds}: best {best_by_round[-1]:.4f}, live {sum(not r.done for r in runs)}, '
                f'parts {[r.world.n for r in runs]}')
        live = [r for r in runs if not r.done]
        if not live:
            break
        order = sorted(runs, key=lambda r: -score[id(r)])
        keep = order[:max(1, n // 2)]
        parents = [r for r in keep if not r.done] or sorted(live, key=lambda r: -score[id(r)])[:1]
        kids = []
        while len(keep) + len(kids) < n:
            p = parents[len(kids) % len(parents)]
            c = p.copy(seed=int(rng.integers(1 << 31)))
            score[id(c)] = score[id(p)]
            kids.append(c)
        runs = keep + kids
    closed = [r for r in runs if r.stats['finished']]
    pool = closed or runs
    best = max(pool, key=lambda r: score[id(r)])
    return {'best': best, 'score': score[id(best)], 'scores': best_by_round, 'rounds': rounds,
            'seconds': time.time() - t0, 'final': sorted((score[id(r)] for r in runs), reverse=True)}
