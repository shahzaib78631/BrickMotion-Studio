"""Ray/lattice voting: turn labelled pixels into votes for legal part poses.

The camera is solved, so a pixel is a ray. A pixel that shows part-local point `u` of a part with rotation `R`
standing at height `t_y` lies on the plane `y = t_y + (R u)_y`; the ray meets that plane at `X`, and the part's
translation is `t = X - R u`. Legal poses (from `booklet_mpd.solver.candidates`) are grouped by rotation and
height, so `t` is snapped to the nearest legal X/Z with a KD-tree. Every pixel votes; the true pose collects
votes from all of its pixels with small snap distances, a line-of-sight twin collects few.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from . import labels
from .camera import BookletCamera, unproject


@dataclass
class Vote:
    key: tuple[str, int]
    pose: np.ndarray
    score: float
    pixels: int
    residual: float          # mean snap distance (LDU) of the pixels that voted


@dataclass
class _Level:
    rot: np.ndarray          # [3,3]
    y: float
    tree: cKDTree
    index: np.ndarray        # pose indices into PoseTable.poses


@dataclass
class PoseTable:
    part: str
    poses: list[np.ndarray]
    levels: list[_Level] = field(default_factory=list)
    fallback: list[np.ndarray] = field(default_factory=list)

    @staticmethod
    def build(part: str, poses: list) -> "PoseTable":
        t = PoseTable(part, [])
        groups: dict[tuple, list[int]] = {}
        order = labels.sym_order(part)
        turns = [labels._yaw(360.0 * k / order) for k in range(order)]
        seen: set[tuple] = set()
        for m in poses:
            m = np.asarray(m, float).reshape(4, 4)
            r = m[:3, :3]
            if np.abs(np.abs(r) - np.round(np.abs(r))).max() > 1e-3:
                t.fallback.append(m)
                continue
            # poses that differ only by a symmetry turn of the part are the same placement: keep one
            forms = {(tuple(np.round(r @ q).astype(int).ravel()), tuple(np.round(m[:3, 3], 1))) for q in turns}
            if forms & seen:
                continue
            seen |= forms
            t.poses.append(m)
            key = (tuple(np.round(r).astype(int).ravel()), round(float(m[1, 3]), 2))
            groups.setdefault(key, []).append(len(t.poses) - 1)
        for (rk, y), idx in groups.items():
            idx = np.array(idx)
            xz = np.array([[t.poses[i][0, 3], t.poses[i][2, 3]] for i in idx])
            t.levels.append(_Level(np.array(rk, float).reshape(3, 3), y, cKDTree(xz), idx))
        return t


def rays(cam: BookletCamera, centre, uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """World-space ray origins and unit directions for pixels `uv` [N,2]."""
    uv = np.asarray(uv, float)
    d0 = np.full(len(uv), cam.eye * 0.5 if cam.eye > 0 else -1000.0)
    d1 = d0 + 1000.0
    p0 = unproject(cam, centre, uv, d0)
    p1 = unproject(cam, centre, uv, d1)
    d = p1 - p0
    return p0, d / np.linalg.norm(d, axis=1, keepdims=True)


def vote(uv, local, size, rgb, weight, cam: BookletCamera, centre, tables: dict, colours: dict,
         snap: float = 6.0, size_tol: float = 6.0, colour_sigma: float = 40.0) -> list[Vote]:
    """Votes for every legal pose of every type, best first. Arrays are per pixel: uv [N,2], local/size/rgb [N,3]."""
    local = np.asarray(local, float)
    size = np.asarray(size, float)
    rgb = np.asarray(rgb, float)
    weight = np.asarray(weight, float)
    org, dirn = rays(cam, centre, uv)
    out: list[Vote] = []
    for key, table in tables.items():
        if not table.poses:
            continue
        box = labels.part_box(key[0])
        ok = (np.abs(size - box) <= size_tol).all(1)
        if not ok.any():
            continue
        col = colours.get(key)
        w = weight[ok] * (np.exp(-((rgb[ok] - col) ** 2).sum(1) / (2 * colour_sigma ** 2)) if col is not None else 1.0)
        o, d = org[ok], dirn[ok]
        variants = labels.canonical(local[ok], labels.sym_order(key[0]))      # [S,n,3]
        P = len(table.poses)
        score = np.zeros(P)
        count = np.zeros(P)
        dist_sum = np.zeros(P)
        for lv in table.levels:
            best_d = np.full(len(o), np.inf)
            best_i = np.zeros(len(o), int)
            for u in variants:
                ru = u @ lv.rot.T                                    # R u, [n,3]
                plane = lv.y + ru[:, 1]
                with np.errstate(divide="ignore", invalid="ignore"):
                    s = (plane - o[:, 1]) / d[:, 1]
                X = o + s[:, None] * d
                t = X - ru
                good = np.isfinite(t).all(1)
                dd = np.full(len(o), np.inf)
                ii = np.zeros(len(o), int)
                if good.any():
                    dd[good], ii[good] = lv.tree.query(t[good][:, [0, 2]])
                better = dd < best_d
                best_d[better], best_i[better] = dd[better], ii[better]
            hit = best_d < snap
            if not hit.any():
                continue
            pose = lv.index[best_i[hit]]
            np.add.at(score, pose, w[hit] * (1.0 - best_d[hit] / snap))
            np.add.at(count, pose, 1)
            np.add.at(dist_sum, pose, best_d[hit])
        for i in np.nonzero(count)[0]:
            out.append(Vote(key, table.poses[i], float(score[i]), int(count[i]), float(dist_sum[i] / count[i])))
    out.sort(key=lambda v: -v.score)
    return out
