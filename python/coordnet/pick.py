"""Whole-step pick: choose exactly the step's parts from the lattice votes.

Objective for a layout = sum of vote scores + lam * (new pixels its footprints cover) - mu * (footprint pixels
outside the new pixels). Parts must not collide (exact collider when given, else part boxes overlapping by more
than 4 LDU, the same rule as `booklet_mpd.solver.collide`). Layouts that place more parts always win; among
those the objective decides. Branch and bound over a few dozen candidates; identical parts tiling one area are
the exact-cover case of the same search (overlap is forbidden, coverage is rewarded).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import labels
from .camera import BookletCamera, project
from .lattice import Vote


@dataclass
class Pick:
    placed: list[tuple[str, int, np.ndarray]]
    score: float
    margin: float
    unplaced: dict[tuple[str, int], int] = field(default_factory=dict)
    review: bool = False


def splat(part: str, pose: np.ndarray, cam: BookletCamera, centre, shape: tuple[int, int], ds: float = 1.0) -> np.ndarray:
    """Footprint of the part (convex hull of its projected vertices) at `shape`; `ds` = full-res px per mask px."""
    v = labels._vertices(part)
    out = np.zeros(shape, np.uint8)
    if len(v) == 0:
        return out.astype(bool)
    pose = np.asarray(pose, float)
    uv, _d = project(cam, centre, v @ pose[:3, :3].T + pose[:3, 3])
    pts = np.round(uv / ds - 0.5).astype(np.int32)
    hull = cv2.convexHull(pts)
    cv2.fillConvexPoly(out, hull, 1)
    return out.astype(bool)


def _box(part: str, pose: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    w = labels._vertices(part) @ pose[:3, :3].T + pose[:3, 3]
    return w.min(0), w.max(0)


def pick(votes: list[Vote], need: dict, newmask: np.ndarray, cam: BookletCamera, centre, collider=None,
         keep: int = 40, min_votes: float = 20.0, lam: float = 1.0, mu: float = 1.0, ds: float = 1.0,
         budget: int = 200_000) -> Pick:
    M = np.asarray(newmask, bool)
    flatM = M.ravel()
    # candidates: per key the best few (enough for every copy plus alternatives)
    cands: list[Vote] = []
    for key, n in need.items():
        mine = [v for v in votes if v.key == key][: max(3 * n + 4, keep // max(len(need), 1))]
        cands += mine
    fps = [np.flatnonzero(splat(v.key[0], v.pose, cam, centre, M.shape, ds)) for v in cands]
    cap = [v.score + lam * float(flatM[f].sum()) for v, f in zip(cands, fps)]
    boxes = [_box(v.key[0], v.pose) for v in cands]
    clash_cache: dict[tuple[int, int], bool] = {}

    def clash(i: int, j: int) -> bool:
        a, b = (i, j) if i < j else (j, i)
        if (a, b) not in clash_cache:
            (la, ha), (lb, hb) = boxes[a], boxes[b]
            touching = np.all(np.minimum(ha, hb) - np.maximum(la, lb) > -1.0)
            if not touching:
                hit = False
            elif collider is not None:
                va, vb = cands[a], cands[b]
                collider.set_model([(va.key[0], va.key[1], va.pose)])
                hit = bool(collider.hits(vb.key[0], vb.pose))
            else:
                hit = bool(np.all(np.minimum(ha, hb) - np.maximum(la, lb) > 4.0))
            clash_cache[(a, b)] = hit
        return clash_cache[(a, b)]

    order = sorted(need, key=lambda k: -max((v.score for v in cands if v.key == k), default=0.0))
    slots = [k for k in order for _ in range(need[k])]
    by_key = {k: [i for i, v in enumerate(cands) if v.key == k] for k in need}
    # best possible remaining gain from slot s on (each slot takes its key's best cap; loose but admissible)
    best_cap = {k: sorted((cap[i] for i in by_key[k]), reverse=True) for k in need}
    rest = np.zeros(len(slots) + 1)
    used_per_key: dict = {}
    for s in range(len(slots) - 1, -1, -1):
        k = slots[s]
        r = used_per_key.get(k, 0)
        used_per_key[k] = r + 1
        rest[s] = rest[s + 1] + (best_cap[k][r] if r < len(best_cap[k]) else 0.0)

    count = np.zeros(M.size, np.int32)
    top: list[tuple[int, float, list[int]]] = []          # (placed, objective, chosen) best two
    nodes = 0
    chosen: list[int] = []

    def better(a: tuple[int, float], b: tuple[int, float]) -> bool:
        return a[0] > b[0] or (a[0] == b[0] and a[1] > b[1])

    def offer(placed: int, obj: float) -> None:
        top.append((placed, obj, list(chosen)))
        top.sort(key=lambda t: (-t[0], -t[1]))
        del top[2:]

    def dfs(s: int, placed: int, obj: float, last: dict) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > budget:
            return
        if s == len(slots):
            offer(placed, obj)
            return
        if len(top) == 2 and not better((placed + len(slots) - s, obj + rest[s]), top[1][:2]):
            return
        k = slots[s]
        start = last.get(k, -1) + 1
        for pos in range(start, len(by_key[k])):
            i = by_key[k][pos]
            if any(clash(i, j) for j in chosen):
                continue
            f = fps[i]
            free = count[f] == 0
            gain = cands[i].score + lam * float((flatM[f] & free).sum()) - mu * float((~flatM[f] & free).sum())
            count[f] += 1
            chosen.append(i)
            dfs(s + 1, placed + 1, obj + gain, {**last, k: pos})
            chosen.pop()
            count[f] -= 1
        dfs(s + 1, placed, obj, {**last, k: len(by_key[k])})        # leave this copy unplaced

    dfs(0, 0, 0.0, {})
    if not top:
        return Pick([], 0.0, 0.0, dict(need), True)
    placed_n, obj, best = top[0]
    second = next((t for t in top[1:] if t[0] == placed_n), None)
    margin = obj - second[1] if second is not None else abs(obj)
    placed = [(cands[i].key[0], cands[i].key[1], cands[i].pose) for i in best]
    unplaced: dict = {}
    for k, n in need.items():
        got = sum(1 for i in best if cands[i].key == k)
        if got < n:
            unplaced[k] = n - got
    review = (bool(unplaced) or nodes > budget or any(cands[i].score < min_votes for i in best)
              or margin < 0.2 * min((cands[i].score for i in best), default=0.0))
    return Pick(placed, float(obj), float(margin), unplaced, review)
