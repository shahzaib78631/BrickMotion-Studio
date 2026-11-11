"""Global (Needleman-Wunsch) alignment of booklet steps to OMR steps."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable

PartKey = tuple[str, int]


def count_similarity(a: int, b: int) -> float:
    return 0.0 if a <= 0 or b <= 0 else min(a, b) / max(a, b)


def multiset_similarity(a: Counter, b: Counter) -> float:
    keys = set(a) | set(b)
    high = sum(max(a[k], b[k]) for k in keys)
    return 0.0 if high == 0 else sum(min(a[k], b[k]) for k in keys) / high


@dataclass
class Alignment:
    pairs: list[tuple[int | None, int | None]]
    mean_similarity: float
    ok: bool
    reason: str


def align_steps(a: list, b: list, sim: Callable[[Any, Any], float], *, gap: float = 0.3,
                min_similarity: float = 0.8, min_matched: float = 0.9) -> Alignment:
    n, m = len(a), len(b)
    sims = [[sim(a[i], b[j]) for j in range(m)] for i in range(n)]
    pair_score = lambda s: s if s >= min_similarity else -1.0
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = -gap * i
    for j in range(1, m + 1):
        score[0][j] = -gap * j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            score[i][j] = max(score[i - 1][j - 1] + pair_score(sims[i - 1][j - 1]),
                              score[i - 1][j] - gap, score[i][j - 1] - gap)
    pairs: list[tuple[int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and abs(score[i][j] - (score[i - 1][j - 1] + pair_score(sims[i - 1][j - 1]))) < 1e-12:
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif i > 0 and abs(score[i][j] - (score[i - 1][j] - gap)) < 1e-12:
            pairs.append((i - 1, None)); i -= 1
        else:
            pairs.append((None, j - 1)); j -= 1
    pairs.reverse()
    both = [(x, y) for x, y in pairs if x is not None and y is not None]
    mean = sum(sims[x][y] for x, y in both) / len(both) if both else 0.0
    matched = sum(1 for x, y in both if sims[x][y] >= min_similarity)
    longest = max(n, m)
    ok = longest > 0 and matched / longest >= min_matched
    return Alignment(pairs, mean, ok, "" if ok else f"{longest - matched} unmatched of {longest}")
