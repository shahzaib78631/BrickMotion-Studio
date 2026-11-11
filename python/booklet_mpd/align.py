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


@dataclass
class MergedAlignment:
    runs: list[tuple[list[int], int]]  # (booklet step indices, OMR step index)
    unmatched_omr: list[int]
    extra_booklet: list[int]
    mean_similarity: float
    ok: bool
    reason: str


def align_merged(a: list[int], b: list[int], *, max_run: int = 12, gap: float = 0.3,
                 min_similarity: float = 0.8, min_matched: float = 0.9) -> MergedAlignment:
    """Align booklet step totals `a` to OMR step sizes `b`; one OMR step may equal
    the sum of several consecutive booklet steps (OMR authors often merge steps)."""
    n, m = len(a), len(b)
    NEG = float("-inf")
    prefix = [0]
    for x in a:
        prefix.append(prefix[-1] + x)
    score = [[NEG] * (m + 1) for _ in range(n + 1)]
    move: dict[tuple[int, int], tuple[str, int]] = {}
    score[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            if score[i][j] == NEG:
                continue
            base = score[i][j]
            if i < n and base - gap > score[i + 1][j]:
                score[i + 1][j] = base - gap
                move[(i + 1, j)] = ("extra", 1)
            if j < m and base - gap > score[i][j + 1]:
                score[i][j + 1] = base - gap
                move[(i, j + 1)] = ("miss", 1)
            if j < m:
                for k in range(1, min(max_run, n - i) + 1):
                    s = count_similarity(prefix[i + k] - prefix[i], b[j])
                    if s < min_similarity:
                        continue
                    value = base + s - 0.01 * (k - 1)
                    if value > score[i + k][j + 1]:
                        score[i + k][j + 1] = value
                        move[(i + k, j + 1)] = ("run", k)
    runs: list[tuple[list[int], int]] = []
    extra: list[int] = []
    missing: list[int] = []
    sims: list[float] = []
    i, j = n, m
    while i > 0 or j > 0:
        kind, k = move[(i, j)]
        if kind == "extra":
            extra.append(i - 1); i -= 1
        elif kind == "miss":
            missing.append(j - 1); j -= 1
        else:
            runs.append((list(range(i - k, i)), j - 1))
            sims.append(count_similarity(prefix[i] - prefix[i - k], b[j - 1]))
            i -= k; j -= 1
    runs.reverse(); extra.reverse(); missing.reverse()
    ok = m > 0 and len(runs) / m >= min_matched
    return MergedAlignment(runs, missing, extra, sum(sims) / len(sims) if sims else 0.0, ok,
                           "" if ok else f"{len(missing)} unmatched OMR steps of {m}")


@dataclass
class GroupAlignment:
    groups: list[tuple[list[int], list[int]]]  # (booklet step indices, OMR step indices)
    booklet_coverage: float
    omr_coverage: float
    mean_similarity: float
    ok: bool
    reason: str


def align_groups(a: list[int], b: list[int], *, max_group: int = 6, gap: float = 0.3,
                 omr_gap_open: float = 1.0, omr_gap_extend: float = 0.02,
                 min_similarity: float = 0.8, min_covered: float = 0.9) -> GroupAlignment:
    """Align booklet step totals `a` to OMR step sizes `b` allowing k booklet steps to
    equal l OMR steps (k, l <= max_group) when their summed counts agree.

    A booklet may show only some models of a set, so skipping OMR steps uses an affine
    cost (one opening cost, tiny per-step extension): one contiguous unrelated stretch is
    cheap, scattered skips are not. Skipping a booklet step costs `gap` each.
    Coverage uses the booklet side: `ok` means every booklet step is explained."""
    n, m = len(a), len(b)
    pa, pb = [0], [0]
    for x in a:
        pa.append(pa[-1] + x)
    for x in b:
        pb.append(pb[-1] + x)
    NEG = float("-inf")
    M, X, Y = 0, 1, 2  # ended with a group / a booklet skip / an OMR skip
    score = [[[NEG] * (m + 1) for _ in range(n + 1)] for _ in range(3)]
    back: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    score[M][0][0] = 0.0
    pick = lambda i, j: max(range(3), key=lambda st: score[st][i][j])
    for i in range(n + 1):
        for j in range(m + 1):
            if i > 0:  # booklet step i-1 has no OMR counterpart
                st = pick(i - 1, j)
                if score[st][i - 1][j] > NEG:
                    score[X][i][j] = score[st][i - 1][j] - gap
                    back[(X, i, j)] = (st, 1, 0)
            if j > 0:  # OMR step j-1 skipped
                best, arg = NEG, M
                for st, cost in ((M, omr_gap_open), (X, omr_gap_open), (Y, omr_gap_extend)):
                    value = score[st][i][j - 1] - cost
                    if value > best:
                        best, arg = value, st
                if best > NEG:
                    score[Y][i][j] = best
                    back[(Y, i, j)] = (arg, 0, 1)
            for k in range(1, min(max_group, i) + 1):
                for l in range(1, min(max_group, j) + 1):
                    sim = count_similarity(pa[i] - pa[i - k], pb[j] - pb[j - l])
                    if sim < min_similarity:
                        continue
                    st = pick(i - k, j - l)
                    if score[st][i - k][j - l] == NEG:
                        continue
                    value = score[st][i - k][j - l] + sim - 0.02 * (k + l - 2)
                    if value > score[M][i][j]:
                        score[M][i][j] = value
                        back[(M, i, j)] = (st, k, l)
    groups: list[tuple[list[int], list[int]]] = []
    sims: list[float] = []
    i, j, state = n, m, pick(n, m)
    while i > 0 or j > 0:
        previous, k, l = back[(state, i, j)]
        if state == M:
            groups.append((list(range(i - k, i)), list(range(j - l, j))))
            sims.append(count_similarity(pa[i] - pa[i - k], pb[j] - pb[j - l]))
        i, j, state = i - k, j - l, previous
    groups.reverse()
    cov_a = sum(len(x) for x, _ in groups) / n if n else 0.0
    cov_b = sum(len(y) for _, y in groups) / m if m else 0.0
    ok = n > 0 and m > 0 and cov_a >= min_covered
    return GroupAlignment(groups, cov_a, cov_b, sum(sims) / len(sims) if sims else 0.0, ok,
                          "" if ok else f"booklet coverage {cov_a:.0%}")
