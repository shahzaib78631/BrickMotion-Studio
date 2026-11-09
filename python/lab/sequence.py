"""A model as a sequence of build steps, BrickNet's graph representation, and back.

Each part is one step of 10 tokens: part, colour, parent (the step it attaches to), the parent's
connector, its own connector, the joint kind ('~' appended when the joint is read from its child
side), and the joint's values a1 a2 a3 flip:
    stud, hole: a1 = yaw (whole degrees)
    hinge: a1 = yaw, flip
    axle: a1 = rotation, a2 = slide (whole LDU), flip
    ball: a1 a2 a3 = rotation about x, y, z
    fixed: nothing
The first step (the root) has only part and colour. Steps run breadth first from the root over
the model's joints, the way decode.realise walks them.
"""
from __future__ import annotations

import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bricknet'))
import decode  # noqa: E402

from .connectors import REV, Connectors

FIELDS = ('part', 'colour', 'parent', 'pconn', 'oconn', 'kind', 'a1', 'a2', 'a3', 'flip')
MAX_STEPS = 100
MAX_CONN = 2304
KIND_NAMES = [k for k in decode.KINDS] + [k + REV for k in decode.KINDS]
SLIDE = 330


def kind_of(field: str) -> str:
    """Which value range a field draws from."""
    return {'part': 'part', 'colour': 'colour', 'parent': 'parent', 'pconn': 'conn', 'oconn': 'conn',
            'kind': 'kind', 'a1': 'angle', 'a3': 'angle', 'flip': 'flip'}.get(field, 'a2')


class Vocab:
    PAD, BOS, EOS, NONE = 0, 1, 2, 3

    def __init__(self, parts: list[int], colours: list[int]):
        self.parts, self.colours = list(parts), list(colours)
        self._pi = {p: i for i, p in enumerate(self.parts)}
        self._ci = {c: i for i, c in enumerate(self.colours)}
        sizes = [('part', len(self.parts)), ('colour', len(self.colours)), ('parent', MAX_STEPS),
                 ('conn', MAX_CONN), ('kind', len(KIND_NAMES)), ('angle', 360), ('slide', 2 * SLIDE + 1),
                 ('flip', 2)]
        self.lo: dict[str, int] = {}
        at = 4
        for name, n in sizes:
            self.lo[name] = at
            at += n
        self.hi = {name: self.lo[name] + n for name, n in sizes}
        self.size = at

    @classmethod
    def from_arrays(cls, arrs: dict) -> 'Vocab':
        return cls(np.unique(arrs['part_ids']).tolist(), np.unique(arrs['colors']).tolist())

    def range(self, field: str) -> tuple[int, int]:
        """Token range of a field. a2 is an angle for balls and a slide for axles: both ranges."""
        r = kind_of(field)
        if r == 'a2':
            return self.lo['angle'], self.hi['slide']
        return self.lo[r], self.hi[r]

    def has_part(self, pid: int) -> bool:
        return pid in self._pi

    def encode(self, field: str, value, kind: str | None = None) -> int:
        if value is None:
            return self.NONE
        r = kind_of(field)
        if field == 'a2':
            r = 'slide' if (kind or '').rstrip(REV) == 'axle' else 'angle'
        if r == 'part':
            return self.lo['part'] + self._pi[value]
        if r == 'colour':
            return self.lo['colour'] + self._ci[value]
        if r == 'kind':
            return self.lo['kind'] + KIND_NAMES.index(value)
        if r == 'slide':
            return self.lo['slide'] + int(value) + SLIDE
        return self.lo[r] + int(value)

    def decode(self, token: int):
        """token -> (range name, value); specials -> ('special', token)."""
        if token < 4:
            return 'special', token
        for name in self.lo:
            if self.lo[name] <= token < self.hi[name]:
                v = token - self.lo[name]
                if name == 'part':
                    return name, self.parts[v]
                if name == 'colour':
                    return name, self.colours[v]
                if name == 'kind':
                    return name, KIND_NAMES[v]
                if name == 'slide':
                    return name, v - SLIDE
                return name, v
        raise ValueError(token)

    def save(self, path: Path) -> None:
        Path(path).write_text(json.dumps({'parts': self.parts, 'colours': self.colours}))

    @classmethod
    def load(cls, path: Path) -> 'Vocab':
        d = json.loads(Path(path).read_text())
        return cls(d['parts'], d['colours'])


def _deg(x: float) -> int:
    return int(round(math.degrees(x))) % 360


def _values(kind: str, yaw: float, flip: bool, rot) -> dict:
    base = kind.rstrip(REV)
    v = {'a1': None, 'a2': None, 'a3': None, 'flip': None}
    if base in ('stud', 'hole'):
        v['a1'] = _deg(yaw)
    elif base == 'hinge':
        v['a1'], v['flip'] = _deg(yaw), int(flip)
    elif base == 'axle':
        v['a1'], v['a2'], v['flip'] = _deg(rot[0]), max(-SLIDE, min(SLIDE, int(round(yaw)))), int(flip)
    elif base == 'ball':
        v['a1'], v['a2'], v['a3'] = (_deg(r) for r in rot)
    return v


def joint_of(step: dict) -> np.ndarray:
    """The step's joint transform, parent connector frame -> child connector frame."""
    kind = step['kind']
    base = kind.rstrip(REV)
    rad = lambda a: math.radians(a or 0)  # noqa: E731
    if base == 'axle':
        j = decode.joint(base, float(step['a2'] or 0), bool(step['flip']), np.array([rad(step['a1']), 0, 0]))
    elif base == 'ball':
        j = decode.joint(base, 0.0, False, np.array([rad(step['a1']), rad(step['a2']), rad(step['a3'])]))
    else:
        j = decode.joint(base, rad(step['a1']), bool(step['flip']), np.zeros(3))
    return np.linalg.inv(j) if kind.endswith(REV) else j


def child_pose(parent: np.ndarray, pframe: np.ndarray, cframe: np.ndarray, step: dict) -> np.ndarray:
    return parent @ pframe @ joint_of(step) @ np.linalg.inv(cframe)


def to_steps(pids, colors, edges, root: int, conn: Connectors) -> list[dict]:
    """Breadth first from root. Edges whose connector the part doesn't have are skipped."""
    adj: dict[int, list] = {}
    for k, (a, ac, b, bc, kind, yaw, flip, rot) in enumerate(edges):
        if ac >= len(conn.frames(pids[a])) or bc >= len(conn.frames(pids[b])):
            continue
        adj.setdefault(a, []).append((b, k, True))
        adj.setdefault(b, []).append((a, k, False))
    steps = [{'node': root, 'part': pids[root], 'colour': colors[root], 'parent': None, 'pconn': None,
              'oconn': None, 'kind': None, 'a1': None, 'a2': None, 'a3': None, 'flip': None}]
    at = {root: 0}
    q = deque([root])
    while q and len(steps) < MAX_STEPS:
        u = q.popleft()
        for v, k, fwd in sorted(adj.get(u, []), key=lambda t: t[1]):
            if v in at or len(steps) >= MAX_STEPS:
                continue
            a, ac, b, bc, kind, yaw, flip, rot = edges[k]
            kind = kind if fwd else kind + REV
            pconn, oconn = (ac, bc) if fwd else (bc, ac)
            at[v] = len(steps)
            steps.append({'node': v, 'part': pids[v], 'colour': colors[v], 'parent': at[u], 'pconn': pconn,
                          'oconn': oconn, 'kind': kind, **_values(kind, yaw, flip, rot)})
            q.append(v)
    return steps


def encode(steps: list[dict], vocab: Vocab) -> np.ndarray:
    out = [vocab.BOS]
    for s in steps:
        out += [vocab.encode(f, s[f], s['kind']) for f in FIELDS]
    out.append(vocab.EOS)
    return np.array(out, dtype=np.int32)


def decode_tokens(tokens, vocab: Vocab) -> list[dict]:
    body = [int(t) for t in tokens if t not in (vocab.BOS, vocab.EOS, vocab.PAD)]
    steps = []
    for s in range(0, len(body) - len(body) % 10, 10):
        step = {}
        for f, t in zip(FIELDS, body[s:s + 10]):
            step[f] = None if t == vocab.NONE else vocab.decode(t)[1]
        steps.append(step)
    return steps


def poses(steps: list[dict], conn: Connectors) -> list[np.ndarray]:
    out: list[np.ndarray] = []
    for s in steps:
        if s['parent'] is None:
            out.append(np.eye(4))
            continue
        p = steps[s['parent']]
        out.append(child_pose(out[s['parent']], conn.frames(p['part'])[s['pconn']],
                              conn.frames(s['part'])[s['oconn']], s))
    return out
