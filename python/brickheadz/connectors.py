"""Typed connector graph for LDraw models, after BrickNet (Kulits & Schmid, CVPR 2026).

A model is described by how its parts are attached rather than by absolute poses: each edge says
"connector X of part A mates with connector Y of part B, turned by this much". Executing a spanning
tree of edges from one root part recovers every pose exactly, and the connectors still free on a
built model are the only places a new part can go.

Connector positions come from BrickNet's catalogue (``knowledge/bricknet/labels.json.xz``, MIT);
the matching code here is our own. Modelled connections (as in BrickNet):

- stud: stud/open stud into hole/tube/post, same point (within 3 LDU), parallel mating axes.
  One free parameter, the turn (yaw) about the axis.
- clip: clip on bar, close (within 3 LDU) and (anti)parallel axes. The full relative transform is
  kept, since clips also slide and rotate along the bar.

Conventions: piece matrices are LDraw 4x4 (part -> model, y down); a connector frame's mating axis
is its -Y; rel = inv(W_a) @ W_b for world connector frames W_a, W_b, so W_b = W_a @ rel.
"""
from __future__ import annotations

import collections
import json
import lzma
import math
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

DEFAULT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "knowledge", "bricknet")
POS_THR = 3.0  # LDU: connector points closer than this can mate
AXIS_THR = 0.95  # |cos| between mating axes
STUD_MATES = {("stud", "hole"), ("open", "hole"), ("open", "post"), ("open", "tube"), ("stud", "tube")}  # (male, female)
MALE = {"stud", "open"}
CLIP_MATES = {("bar", "clip")}
_IDENT = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]


# ---------------------------------------------------------------- catalogue

@dataclass(frozen=True)
class Connector:
    family: str  # "stud" (stud/open/hole/tube/post) or "clip" (bar/clip)
    sub: str  # stud | open | hole | tube | post | bar | clip
    index: int  # order within the part (stable: kind, sub, row)
    frame: np.ndarray = field(compare=False, repr=False)  # 4x4 in part space

    @property
    def male(self) -> bool:
        return self.sub in MALE or self.sub == "bar"


def _frame(row) -> np.ndarray:
    """BrickNet row [x, y, z, pitch, roll, ...] -> 4x4 frame (rotation from pitch about x, roll about z)."""
    p = math.radians(row[3] if len(row) > 3 else 0.0)
    r = math.radians(row[4] if len(row) > 4 else 0.0)
    cx, sx, cz, sz = math.cos(p), math.sin(p), math.cos(r), math.sin(r)
    return np.array([[cz, -sz, 0.0, row[0]],
                     [cx * sz, cx * cz, -sx, row[1]],
                     [sx * sz, sx * cz, cx, row[2]],
                     [0.0, 0.0, 0.0, 1.0]])


class Catalog:
    def __init__(self, folder: str = DEFAULT_DIR):
        self.folder = folder
        self.labels = json.load(lzma.open(os.path.join(folder, "labels.json.xz")))
        self.names: dict[str, str] = json.load(open(os.path.join(folder, "part_names.json")))
        self.alias: dict[str, str] = {}
        apath = os.path.join(folder, "part_aliases.json.xz")
        if os.path.exists(apath):
            for r in json.load(lzma.open(apath)).get("rows", []):
                if [float(v) for v in r.get("final_matrix_3x4", [])] == _IDENT:
                    self.alias[r["src"].lower()] = r["dst"].lower()
        self._cache: dict[str, list[Connector] | None] = {}

    def stem(self, part: str) -> str | None:
        """Our part id -> catalogue stem: aliases, then print/pattern suffixes stripped (3069bp01 -> 3069b)."""
        p = os.path.splitext(part.lower().replace("\\", "/").split("/")[-1])[0]
        for cand in (p, self.alias.get(p, p), re.sub(r"p[0-9a-z]{2,4}$", "", p), re.sub(r"(p|pr|pat)[0-9a-z]+$", "", p)):
            cand = self.alias.get(cand, cand)
            if cand + ".dat" in self.labels:
                return cand
        return None

    def name(self, part: str) -> str:
        s = self.stem(part)
        return self.names.get(s, part) if s else part

    def connectors(self, part: str) -> list[Connector] | None:
        if part in self._cache:
            return self._cache[part]
        s = self.stem(part)
        out: list[Connector] | None = None
        if s is not None:
            out = []
            d = self.labels[s + ".dat"]
            for kind in ("stud", "hole", "axle"):
                for sub in sorted(d.get(kind, {})):
                    rows = d[kind][sub]
                    if isinstance(rows, dict) or (kind == "axle" and sub not in ("bar", "clip")):
                        continue
                    for row in rows:
                        out.append(Connector("clip" if kind == "axle" else "stud", sub, len(out), _frame(row)))
        self._cache[part] = out
        return out


@lru_cache(maxsize=4)
def catalog(folder: str = DEFAULT_DIR) -> Catalog:
    return Catalog(folder)


# ---------------------------------------------------------------- graph

@dataclass(frozen=True)
class Edge:
    a: int  # piece index of the male side (stud / bar)
    a_conn: int
    b: int  # piece index of the female side (hole / tube / post / clip)
    b_conn: int
    family: str  # stud | clip
    yaw: float  # degrees about the mating axis (stud edges)
    rel: tuple  # inv(W_a) @ W_b, 16 floats, row-major


@dataclass
class Graph:
    parts: list[str]
    colors: list[int]
    edges: list[Edge]
    unknown: list[int]  # pieces with no connector data

    def components(self) -> list[list[int]]:
        par = list(range(len(self.parts)))

        def f(x):
            while par[x] != x:
                par[x] = par[par[x]]
                x = par[x]
            return x

        for e in self.edges:
            par[f(e.a)] = f(e.b)
        groups: dict[int, list[int]] = collections.defaultdict(list)
        for i in range(len(self.parts)):
            groups[f(i)].append(i)
        return sorted(groups.values(), key=lambda g: (-len(g), g[0]))

    def used(self) -> set[tuple[int, int]]:
        return {(e.a, e.a_conn) for e in self.edges} | {(e.b, e.b_conn) for e in self.edges}


def _yaw_of(rel: np.ndarray) -> float:
    return math.degrees(math.atan2(rel[0, 2], rel[0, 0])) % 360.0


def ry(deg: float) -> np.ndarray:
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return np.array([[c, 0.0, s, 0.0], [0.0, 1.0, 0.0, 0.0], [-s, 0.0, c, 0.0], [0.0, 0.0, 0.0, 1.0]])


def world_connectors(parts: list[str], matrices: list[np.ndarray], cat: Catalog):
    """[(piece, Connector, world 4x4)] for every connector of every piece."""
    out = []
    for i, (p, m) in enumerate(zip(parts, matrices)):
        for c in cat.connectors(p) or []:
            out.append((i, c, m @ c.frame))
    return out


def _axis(w: np.ndarray) -> np.ndarray:
    v = -w[:3, 1]
    n = float(np.linalg.norm(v))
    return v / n if n else v


def _near_pairs(points: np.ndarray, thr: float):
    cell = collections.defaultdict(list)
    keys = np.floor(points / thr).astype(int)
    for i, k in enumerate(map(tuple, keys)):
        cell[k].append(i)
    for i, k in enumerate(map(tuple, keys)):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for j in cell.get((k[0] + dx, k[1] + dy, k[2] + dz), ()):
                        if j > i and float(np.sum((points[j] - points[i]) ** 2)) <= thr * thr:
                            yield i, j


def build_graph(parts: list[str], colors: list[int], matrices: list[np.ndarray], cat: Catalog | None = None) -> Graph:
    """Typed connector graph of placed pieces (each connector used at most once)."""
    cat = cat or catalog()
    wc = world_connectors(parts, matrices, cat)
    unknown = [i for i, p in enumerate(parts) if cat.connectors(p) is None]
    if not wc:
        return Graph(parts, colors, [], unknown)
    pts = np.array([w[:3, 3] for _, _, w in wc])
    cand = []
    for i, j in _near_pairs(pts, POS_THR):
        (pi, ci, wi), (pj, cj, wj) = wc[i], wc[j]
        if pi == pj or ci.family != cj.family:
            continue
        if ci.family == "stud":
            if ci.sub in MALE and (ci.sub, cj.sub) in STUD_MATES:
                m, f = (i, j)
            elif cj.sub in MALE and (cj.sub, ci.sub) in STUD_MATES:
                m, f = (j, i)
            else:
                continue
            if float(_axis(wc[m][2]) @ _axis(wc[f][2])) < AXIS_THR:
                continue
        else:
            if {ci.sub, cj.sub} != {"bar", "clip"} or abs(float(_axis(wi) @ _axis(wj))) < 0.9:
                continue
            m, f = (i, j) if ci.sub == "bar" else (j, i)
        d = float(np.sum((pts[m] - pts[f]) ** 2))
        cand.append((d, m, f))
    edges, taken = [], set()
    for d, m, f in sorted(cand):  # closest pairs first; one partner per connector
        if m in taken or f in taken:
            continue
        taken.update((m, f))
        (pa, ca, wa), (pb, cb, wb) = wc[m], wc[f]
        rel = np.linalg.inv(wa) @ wb
        edges.append(Edge(pa, ca.index, pb, cb.index, ca.family, round(_yaw_of(rel), 1) if ca.family == "stud" else 0.0,
                          tuple(np.round(rel, 4).ravel().tolist())))
    return Graph(parts, colors, edges, unknown)


def graph_of_pieces(pieces, cat: Catalog | None = None) -> Graph:
    """From brickheadz.dat pieces (uses base_part, so printed parts get their plain part's connectors)."""
    return build_graph([p.base_part for p in pieces], [p.color for p in pieces], [p.matrix for p in pieces], cat)


# ---------------------------------------------------------------- build sequences (spanning trees)

@dataclass(frozen=True)
class Step:
    """Add part `index`; attach it to already placed part `parent` through `edge` (None for a root)."""
    index: int
    parent: int | None
    edge: Edge | None


def build_sequence(g: Graph, root: int | None = None, order: str = "bfs") -> list[Step]:
    """A spanning forest as build steps: each component starts at its lowest-index part (or `root`)."""
    adj: dict[int, list[tuple[int, Edge]]] = collections.defaultdict(list)
    for e in g.edges:
        adj[e.a].append((e.b, e))
        adj[e.b].append((e.a, e))
    steps, seen = [], set()
    comps = g.components()
    if root is not None:
        comps.sort(key=lambda c: root not in c)
    for comp in comps:
        start = root if root in comp else min(comp)
        seen.add(start)
        steps.append(Step(start, None, None))
        frontier = collections.deque([start])
        while frontier:
            u = frontier.popleft() if order == "bfs" else frontier.pop()
            for v, e in sorted(adj[u], key=lambda t: t[0]):
                if v not in seen:
                    seen.add(v)
                    steps.append(Step(v, u, e))
                    frontier.append(v)
    return steps


def loose(e: Edge, tol: float = 0.05) -> bool:
    """A stud edge whose parts are not exactly seated (offset or tilted in the source file)."""
    return e.family == "stud" and float(np.abs(np.array(e.rel).reshape(4, 4) - ry(round(e.yaw))).max()) > tol


def edge_transform(e: Edge, quantize: bool = True) -> np.ndarray:
    """rel (inv(W_a) @ W_b). Seated stud edges are rebuilt from the yaw alone (rounded to 1 degree when
    quantize); loose ones and clip edges keep the stored transform."""
    if e.family == "stud" and not loose(e):
        return ry(round(e.yaw) if quantize else e.yaw)
    return np.array(e.rel, float).reshape(4, 4)


def realize(g: Graph, steps: list[Step], roots: dict[int, np.ndarray] | None = None, cat: Catalog | None = None,
            quantize: bool = True) -> list[np.ndarray | None]:
    """Execute build steps: poses of every part from the root poses (identity unless given) and the edges."""
    cat = cat or catalog()
    roots = roots or {}
    out: list[np.ndarray | None] = [None] * len(g.parts)
    for s in steps:
        if s.edge is None:
            out[s.index] = np.array(roots.get(s.index, np.eye(4)), float)
            continue
        e, parent = s.edge, out[s.parent]
        fa = cat.connectors(g.parts[e.a])[e.a_conn].frame
        fb = cat.connectors(g.parts[e.b])[e.b_conn].frame
        rel = edge_transform(e, quantize)
        if s.index == e.b:  # child is the female side: M_b = M_a F_a rel F_b^-1
            out[s.index] = parent @ fa @ rel @ np.linalg.inv(fb)
        else:  # child is the male side: M_a = M_b F_b rel^-1 F_a^-1
            out[s.index] = parent @ fb @ np.linalg.inv(rel) @ np.linalg.inv(fa)
    return out


def sequence_text(g: Graph, steps: list[Step], cat: Catalog | None = None, color_names: dict[int, str] | None = None) -> str:
    """Readable build steps, one per line, e.g.
    ``3 Slope Brick Curved 2x2 | Red  <- hole#0 on 1.stud#2 yaw 90``."""
    cat = cat or catalog()
    cn = color_names or {}
    lines = []
    for s in steps:
        p = g.parts[s.index]
        head = f"{s.index} {cat.name(p)} [{p}] | {cn.get(g.colors[s.index], g.colors[s.index])}"
        if s.edge is None:
            lines.append(head + "  (root)")
            continue
        e = s.edge
        mine, theirs = ((e.b, e.b_conn), (e.a, e.a_conn)) if s.index == e.b else ((e.a, e.a_conn), (e.b, e.b_conn))
        mc = cat.connectors(g.parts[mine[0]])[mine[1]]
        tc = cat.connectors(g.parts[theirs[0]])[theirs[1]]
        extra = f" yaw {round(e.yaw) % 360}" if e.family == "stud" else " clip"
        lines.append(f"{head}  <- {mc.sub}#{mc.index} on {theirs[0]}.{tc.sub}#{tc.index}{extra}")
    return "\n".join(lines)


# ---------------------------------------------------------------- free connectors and snapping

def free_connectors(g: Graph, matrices: list[np.ndarray], cat: Catalog | None = None, occupied=None):
    """Connectors not used by any edge: [(piece, Connector, world 4x4)].
    `occupied(point) -> bool` can drop ones buried inside other parts (optional)."""
    cat = cat or catalog()
    used = g.used()
    out = []
    for i, c, w in world_connectors(g.parts, matrices, cat):
        if (i, c.index) in used:
            continue
        if occupied is not None and occupied(w[:3, 3]):
            continue
        out.append((i, c, w))
    return out


def snap_candidates(part: str, free, cat: Catalog | None = None, yaws=(0, 90, 180, 270), dedupe: bool = True) -> list[dict]:
    """Every exact pose for `part` that puts one of its stud connectors onto one free stud connector.
    Returns [{'matrix', 'host', 'host_conn', 'conn', 'yaw'}] (one per distinct pose when dedupe);
    scoring against evidence is up to the caller."""
    cat = cat or catalog()
    mine = [c for c in (cat.connectors(part) or []) if c.family == "stud"]
    hosts = [(h, hc, w) for h, hc, w in free if hc.family == "stud"]
    if not mine or not hosts:
        return []
    R = np.stack([ry(y) for y in yaws])
    Rinv = np.transpose(R, (0, 2, 1)).copy()
    Rinv[:, :3, 3] = 0.0
    W = np.stack([w for _, _, w in hosts])
    out, seen = [], set()
    for c in mine:
        cinv = np.linalg.inv(c.frame)
        host_male = np.array([hc.sub in MALE and (hc.sub, c.sub) in STUD_MATES for _, hc, _ in hosts])
        host_female = np.array([c.sub in MALE and (c.sub, hc.sub) in STUD_MATES for _, hc, _ in hosts])
        for mask, rot in ((host_male, R), (host_female, Rinv)):  # host stud in my hole: W R F^-1; mine in host: W R^-1 F^-1
            idx = np.where(mask)[0]
            if not len(idx):
                continue
            M = np.einsum("nij,yjk,kl->nyil", W[idx], rot, cinv)
            for a, hi in enumerate(idx):
                for b, y in enumerate(yaws):
                    m = M[a, b]
                    if dedupe:
                        key = tuple(np.round(m[:3, 3] * 2).astype(int)) + tuple(np.round(m[:3, :3].ravel(), 2))
                        if key in seen:
                            continue
                        seen.add(key)
                    h, hc, _w = hosts[hi]
                    out.append({"matrix": m, "host": h, "host_conn": hc.index, "conn": c.index, "yaw": y})
    return out


def dedupe_poses(cands: list[dict]) -> list[dict]:
    """Keep one candidate per distinct pose (translation to 0.5 LDU, rotation to 0.01)."""
    seen, out = set(), []
    for c in cands:
        m = c["matrix"]
        key = tuple(np.round(m[:3, 3] * 2).astype(int)) + tuple(np.round(m[:3, :3].ravel(), 2))
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out



def near(cands: list[dict], xz: tuple[float, float], radius: float = 10.0) -> list[dict]:
    """Candidates whose origin lies within `radius` LDU of a horizontal position (any height), e.g. the
    x/z the video hover solver found; height is then chosen among the exact snap options."""
    x, z = xz
    return [c for c in cands if (c["matrix"][0, 3] - x) ** 2 + (c["matrix"][2, 3] - z) ** 2 <= radius * radius]
