"""Placed parts: does a new part overlap them, and which connectors are still free.

Overlap: every part is sampled as surface points (studs left out), spaced after each primitive's
transform,
each point pulled 1.5 LDU toward the part's centre on every axis, so faces that only touch stay
apart. Placed points fill a dict of 2-LDU cells; a new part overlaps if any of its points lands in
a cell another part holds. The app's certify() stays the final judge (tests/lab/agreement.test.ts).

Free connectors: a connector is taken when another part's connector of a type that joins it
(connectors.fits, either way round) sits within 1 LDU with a parallel axis.
"""
from __future__ import annotations

import re
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bricknet'))
import decode  # noqa: E402
from omr.reader import LIB  # noqa: E402

from .connectors import Compat, Connectors, fits
from .sequence import child_pose

CELL = 2.0
STUD_TOL = 2  # cells of an unseated stud allowed inside another part
LOOSE = 0.02  # share of a part's cells allowed inside a part it doesn't connect to
MATED = 0.25  # ... and inside a part it connects to (joints interlock)
NEAR = 1.0


STUD = re.compile(r'^(stud|stug|stu\d)', re.I)
SPACING = 2.0
SEARCH = ['parts', 'p', 'unofficial/parts', 'unofficial/p', 'models']


@lru_cache(maxsize=None)
def _file(name: str) -> Path | None:
    name = name.lower().replace('\\', '/')
    for d in SEARCH:
        f = LIB / d / name
        if f.exists():
            return f
    return None


def _triangles(name: str, m: np.ndarray, out: list, studs: bool = False) -> None:
    base = name.lower().replace('\\', '/').rsplit('/', 1)[-1]
    if not studs and STUD.match(base):
        return
    f = _file(name)
    if f is None:
        return
    for line in f.read_text(errors='ignore').splitlines():
        t = line.split()
        if not t:
            continue
        try:
            if t[0] == '1' and len(t) >= 15:
                v = [float(x) for x in t[2:14]]
                sub = np.array([[v[3], v[4], v[5], v[0]], [v[6], v[7], v[8], v[1]], [v[9], v[10], v[11], v[2]],
                                [0, 0, 0, 1.0]])
                _triangles(' '.join(t[14:]), m @ sub, out, studs)
            elif t[0] in ('3', '4') and len(t) >= (11 if t[0] == '3' else 14):
                q = np.array(t[2:11] if t[0] == '3' else t[2:14], dtype=float).reshape(-1, 3)
                w = q @ m[:3, :3].T + m[:3, 3]
                out.append(w[[0, 1, 2]])
                if len(w) == 4:
                    out.append(w[[0, 2, 3]])
        except ValueError:
            continue


def _sample(tri: np.ndarray) -> np.ndarray:
    a, b, c = tri
    n = int(np.ceil(max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)) / SPACING))
    n = max(1, min(n, 400))
    i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing='ij')
    keep = (i + j) <= n
    u, v = i[keep] / n, j[keep] / n
    return a + np.outer(u, b - a) + np.outer(v, c - a)


@lru_cache(maxsize=None)
def surface(stem: str) -> np.ndarray:
    """A part's surface points (studs left out), about SPACING LDU apart, in its own frame."""
    tris: list = []
    _triangles(stem + '.dat', np.eye(4), tris)
    if not tris:
        return np.zeros((0, 3))
    p = np.concatenate([_sample(t) for t in tris])
    return np.unique(np.round(p), axis=0)


@lru_cache(maxsize=None)
def occupancy(stem: str) -> np.ndarray:
    """Centres of the part's solid CELL-sized cells, in its own frame.

    A cell is solid when the part's surface encloses its centre along all three axes: some surface
    point in the same row lies before it and some after, on each axis. Open cavities (a brick's
    hollow underside, a Technic hole) stay empty, and cell centres sit half a cell inside the faces,
    so two parts whose faces only touch never share a cell."""
    p = surface(stem)
    if len(p) == 0:
        return np.zeros((0, 3))
    lo = np.floor(p.min(0) / CELL).astype(int)
    hi = np.floor(p.max(0) / CELL).astype(int)
    shape = hi - lo + 1
    idx = np.floor(p / CELL).astype(int) - lo
    centres = (np.indices(shape).reshape(3, -1).T + lo + 0.5) * CELL
    solid = np.ones(len(centres), dtype=bool)
    flat = np.indices(shape).reshape(3, -1).T
    for ax in range(3):
        o = [k for k in range(3) if k != ax]
        n1, n2 = shape[o[0]], shape[o[1]]
        mn = np.full((n1, n2), np.inf)
        mx = np.full((n1, n2), -np.inf)
        np.minimum.at(mn, (idx[:, o[0]], idx[:, o[1]]), p[:, ax])
        np.maximum.at(mx, (idx[:, o[0]], idx[:, o[1]]), p[:, ax])
        c = centres[:, ax]
        r = (flat[:, o[0]], flat[:, o[1]])
        solid &= (mn[r] < c) & (c < mx[r])
    return centres[solid]


def _stud_offsets() -> np.ndarray:
    """Cell centres of one stud in its connector frame: radius 6, 4 LDU tall, on the -Y side."""
    g = np.arange(-5, 6, 2.0)
    pts = [(x, y, z, 1.0) for x in g for z in g for y in (-3.0, -1.0) if x * x + z * z <= 36]
    return np.array(pts).T


STUD_CELLS = _stud_offsets()


def _cells(pts: np.ndarray) -> np.ndarray:
    return np.unique(np.floor(pts / CELL).astype(np.int64), axis=0)


def _keys(cells: np.ndarray) -> np.ndarray:
    # pack three signed cell coords (|c| < 2^20) into one int64
    off = cells + (1 << 20)
    return (off[:, 0] << 42) | (off[:, 1] << 21) | off[:, 2]


def _right_angles() -> list[np.ndarray]:
    import itertools
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            r = np.zeros((4, 4))
            r[3, 3] = 1
            for i, (j, sg) in enumerate(zip(perm, signs)):
                r[i, j] = sg
            if np.linalg.det(r[:3, :3]) > 0:
                out.append(r)
    out.sort(key=lambda r: not np.allclose(r, np.eye(4)))  # no turn wins ties
    return out


RIGHT_ANGLES = _right_angles()


def upright(poses: list[np.ndarray]) -> list[np.ndarray]:
    """The model turned by the right angle that stands the most parts the way up they are made (their
    own y axis along the world's): a set built from a sideways first part otherwise lies tipped over."""
    best = max(RIGHT_ANGLES, key=lambda r: sum((r @ m)[1, 1] > 0.99 for m in poses))
    return [best @ m for m in poses]


class World:
    def __init__(self, conn: Connectors, compat: Compat):
        self.conn, self.compat = conn, compat
        self.pids: list[int] = []
        self.colors: list[int] = []
        self.poses: list[np.ndarray] = []
        self._cells: dict[int, int] = {}
        self._at: dict[tuple[int, int, int], list[tuple[int, int, str, np.ndarray]]] = {}
        self._taken: list[set[int]] = []
        self._studs: dict[int, tuple[int, int]] = {}

    @property
    def n(self) -> int:
        return len(self.pids)

    def _world_keys(self, pid: int, pose: np.ndarray) -> np.ndarray:
        pts = occupancy(self.conn.cat.stems[pid])
        if len(pts) == 0:
            return np.zeros(0, dtype=np.int64)
        w = pts @ pose[:3, :3].T + pose[:3, 3]
        return _keys(_cells(w))

    def _stud_keys(self, pid: int, pose: np.ndarray):
        """(connector, cell key) for every cell of the part's studs."""
        frames = self.conn.frames(pid)
        for c, t in enumerate(self.conn.types(pid)):
            if t.startswith('stud/'):
                w = (pose @ frames[c] @ STUD_CELLS)[:3].T
                for k in _keys(np.floor(w / CELL).astype(np.int64)):
                    yield c, int(k)

    def stud_clash(self, pid: int, pose: np.ndarray) -> int:
        """Cells where a stud that isn't seated sits inside another part (either part's studs)."""
        seated_own, seated_placed = set(), set()
        for c, j, cj in self._matches(pid, pose):
            seated_own.add(c)
            seated_placed.add((j, cj))
        n = 0
        studs = self._studs
        for k in self._world_keys(pid, pose):
            o = studs.get(int(k))
            if o is not None and o not in seated_placed and o[1] not in self._taken[o[0]]:
                n += 1
        for c, k in self._stud_keys(pid, pose):
            if c not in seated_own and (k in self._cells or k in studs):
                n += 1
        return n

    def _matches(self, pid: int, pose: np.ndarray, i: int | None = None):
        """(own connector, other part, its connector) for every connector pair that mates here."""
        frames = self.conn.frames(pid)
        if not len(frames):
            return
        types = self.conn.types(pid)
        for c, (f, t) in enumerate(zip(pose @ frames, types)):
            pos, axis = f[:3, 3], f[:3, 1]
            key = tuple(int(v) for v in np.round(pos))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for j, cj, tj, (pj, aj) in self._at.get((key[0] + dx, key[1] + dy, key[2] + dz), ()):
                            if j != i and np.abs(pj - pos).max() <= NEAR and abs(float(aj @ axis)) > 0.99 \
                                    and self._joins(t, tj):
                                yield c, j, cj

    def mates(self, pid: int, pose: np.ndarray) -> set[int]:
        """Placed parts this part would connect to at this pose."""
        return {j for _, j, _ in self._matches(pid, pose)}

    def overlap(self, pid: int, pose: np.ndarray) -> dict[int, float]:
        """Placed part -> the share of the new part's solid cells inside it."""
        keys = self._world_keys(pid, pose)
        if not len(keys) or not self._cells:
            return {}
        out: dict[int, int] = {}
        for k in keys:
            o = self._cells.get(int(k))
            if o is not None:
                out[o] = out.get(o, 0) + 1
        return {o: v / len(keys) for o, v in out.items()}

    def collides(self, pid: int, pose: np.ndarray, parent: int | None = None, loose: float = LOOSE) -> bool:
        """True when the part would sit inside another part. Parts it connects to (its parent and any
        part whose connector mates with one of its own) may interlock with it up to MATED of its
        cells, as real joints do; any other part up to `loose` (LOOSE when judging real models; the
        sampler passes 0, since generated parts otherwise lean on that allowance)."""
        over = self.overlap(pid, pose)
        mated = self.mates(pid, pose) | ({parent} if parent is not None else set())
        if any(v > (MATED if o in mated else loose) for o, v in over.items()):
            return True
        return self.stud_clash(pid, pose) > STUD_TOL

    def _joins(self, ta: str, tb: str) -> bool:
        return bool(fits(self.compat, ta, tb) or fits(self.compat, tb, ta))

    def add(self, pid: int, color: int, pose: np.ndarray) -> int:
        i = self.n
        self.pids.append(pid)
        self.colors.append(color)
        self.poses.append(pose)
        self._taken.append(set())
        for k in self._world_keys(pid, pose):
            self._cells.setdefault(int(k), i)
        for c, j, cj in list(self._matches(pid, pose, i)):
            self._taken[i].add(c)
            self._taken[j].add(cj)
        for c, k in self._stud_keys(pid, pose):
            self._studs.setdefault(k, (i, c))
        frames = self.conn.frames(pid)
        if len(frames):
            for c, (f, t) in enumerate(zip(pose @ frames, self.conn.types(pid))):
                pos = f[:3, 3]
                key = tuple(int(v) for v in np.round(pos))
                self._at.setdefault(key, []).append((i, c, t, (pos, f[:3, 1])))
        return i

    def free(self, i: int) -> list[int]:
        taken = self._taken[i]
        return [c for c in range(len(self.conn.types(self.pids[i]))) if c not in taken]

    def pose_for(self, parent_i: int, pconn: int, pid: int, oconn: int, kind: str, params: dict) -> np.ndarray:
        step = {'kind': kind, **params}
        return child_pose(self.poses[parent_i], self.conn.frames(self.pids[parent_i])[pconn],
                          self.conn.frames(pid)[oconn], step)

    def to_ldr(self, name: str, caption: str) -> str:
        return decode.to_ldr(self.conn.cat, self.pids, self.colors, list(range(self.n)), upright(self.poses), name,
                             caption)
