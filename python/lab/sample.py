"""Generate a model step by step, offering the builder only legal moves.

Every token is drawn from the builder's prediction (top-k, then top-p), but only among the values that
are legal right now:
    part    parts that have connectors and geometry, and that can join a free connector in the model
    parent  placed parts with a free connector the part can join
    pconn   those free connectors
    oconn   the part's connectors that join that one
    kind    the joint kinds seen between those two connector types
    a1..a3, flip   the kind's own values (NONE where the kind has none)
When the finished step would overlap the model (world.collides), the last choices are drawn again,
deepest first, excluding what failed: angles, then connectors, parent and part (8 tries each, within a
budget per step). A step that cannot be placed is taken back with the step before it, as BrickGPT does;
after max_rollbacks the run stops with what it has.

legal=False draws from each field's whole range (only what is needed to pose the part is enforced) and
records the first step that overlaps: the BrickNet-style baseline.
"""
from __future__ import annotations

import collections
import json
import time
from pathlib import Path
from typing import Callable

import numpy as np
import torch

from .connectors import REV, Compat, Connectors, fits
from .sequence import FIELDS, KIND_NAMES, Vocab, to_steps
from .world import World, _file

TRIES = 8
BUDGET = 400  # pose checks per step
STRICT = 0.0  # share of a part allowed inside parts it does not connect to (real models: 2.9% do at all)


ANGLE_SHARE = 0.002  # a joint angle is legal when real sets use it for at least this share of that kind
FLIP_SHARE = 0.01
HABITS = Path('/Users/mac/Projects/BrickMotion-Data/lab/habits.json')


def habits(path: Path = HABITS) -> dict:
    """The joint angles (a1) and flips real BrickNet val sets use per joint kind: studded parts sit at
    right angles (98%), hinges are rarely turned over. Worked out once and kept in habits.json."""
    if path.exists():
        return json.loads(path.read_text())
    import decode
    from .connectors import Connectors
    from .dataset import D
    conn = Connectors(decode.Catalog(D))
    arrs = decode.load(D / 'val.npz')
    count = {'a1': collections.defaultdict(collections.Counter), 'flip': collections.defaultdict(collections.Counter)}
    for i in range(len(arrs['node_ptr']) - 1):
        pids, colors, edges = decode.model(arrs, i)
        order, _ = decode.realise(conn.cat, pids, edges)
        for st in to_steps(pids, colors, edges, order[0], conn)[1:]:
            k = st['kind'].rstrip(REV)
            for f in ('a1', 'flip'):
                if st[f] is not None:
                    count[f][k][int(st[f])] += 1
    share = {'a1': ANGLE_SHARE, 'flip': FLIP_SHARE}
    out = {f: {k: sorted(v for v, n in c.items() if n >= share[f] * sum(c.values())) for k, c in by.items()}
           for f, by in count.items()}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1))
    return out


class Legal:
    def __init__(self, vocab: Vocab, conn: Connectors, compat: Compat):
        self.vocab, self.conn, self.compat = vocab, conn, compat
        self.types = {p: frozenset(conn.types(p)) for p in vocab.parts}
        self.usable = [p for p in vocab.parts if len(conn.frames(p)) and _file(conn.cat.stems[p] + '.dat')]
        self.habits = habits()
        self.children: dict[str, set[str]] = {}
        for ta, tb in compat:
            self.children.setdefault(ta, set()).add(tb)

    def tok(self, field: str, values) -> np.ndarray:
        return np.array([self.vocab.encode(field, v) for v in values], dtype=np.int64)

    def _free_types(self, w: World, i: int) -> dict[str, list[int]]:
        out: dict[str, list[int]] = {}
        types = self.conn.types(w.pids[i])
        for c in w.free(i):
            out.setdefault(types[c], []).append(c)
        return out

    def parts(self, w: World) -> np.ndarray:
        if w.n == 0:
            return self.tok('part', self.usable)
        ok: set[str] = set()
        for i in range(w.n):
            for ta in self._free_types(w, i):
                ok |= self.children.get(ta, set())
        return self.tok('part', [p for p in self.usable if self.types[p] & ok])

    def parents(self, w: World, pid: int) -> list[int]:
        mine = self.types.get(pid, frozenset())
        return [i for i in range(w.n) if any(self.children.get(ta, set()) & mine for ta in self._free_types(w, i))]

    def pconns(self, w: World, i: int, pid: int) -> list[int]:
        mine = self.types.get(pid, frozenset())
        return [c for ta, cs in self._free_types(w, i).items() if self.children.get(ta, set()) & mine for c in cs]

    def oconns(self, pid: int, ta: str) -> list[int]:
        return [c for c, tb in enumerate(self.conn.types(pid)) if fits(self.compat, ta, tb)]

    def values(self, field: str, kind: str) -> np.ndarray:
        """Legal tokens of a joint value field for this kind."""
        base = kind.rstrip(REV)
        v = self.vocab
        none = np.array([v.NONE])
        angle = np.arange(v.lo['angle'], v.hi['angle'])
        if field == 'a1':
            if base == 'fixed':
                return none
            seen = self.habits['a1'].get(base)
            return self.tok('a1', seen) if seen else angle
        if field == 'a2':
            return np.arange(v.lo['slide'], v.hi['slide']) if base == 'axle' else angle if base == 'ball' else none
        if field == 'a3':
            return angle if base == 'ball' else none
        if base not in ('hinge', 'axle'):
            return none
        seen = self.habits['flip'].get(base)
        return self.tok('flip', seen) if seen else np.arange(v.lo['flip'], v.hi['flip'])


def pick(logits: np.ndarray, allowed: np.ndarray, rng: np.random.Generator, top_k: int, top_p: float,
         exclude: set[int] = frozenset()) -> int | None:
    if len(exclude):
        allowed = allowed[~np.isin(allowed, list(exclude))]
    if not len(allowed):
        return None
    lg = logits[allowed].astype(np.float64)
    order = np.argsort(-lg)[:top_k]
    p = np.exp(lg[order] - lg[order[0]])
    p /= p.sum()
    keep = np.searchsorted(np.cumsum(p), top_p) + 1
    p = p[:keep] / p[:keep].sum()
    return int(allowed[order[rng.choice(keep, p=p)]])


class Run:
    """One build, advanced a part at a time (step), so a population of builds can be grown, compared
    and copied (lab.smc). max_parts is the most parts placed. finish=True lets the builder end the set
    (EOS where the next part would go) once min_parts are placed, as real sets end; otherwise EOS is
    never offered. A step that cannot be placed takes back the part before it (max_rollbacks in all)."""

    def __init__(self, model, vocab: Vocab, new_world: Callable[[], World], clip, rules: Legal | None = None,
                 seed: int = 0, legal: bool = True, finish: bool = False, min_parts: int = 2, max_parts: int = 100,
                 top_k: int = 20, top_p: float = 0.95, max_rollbacks: int = 20, _blank: bool = False):
        self.model, self.vocab, self.new_world = model, vocab, new_world
        self.legal, self.finish, self.min_parts, self.max_parts = legal, finish, min_parts, max_parts
        self.top_k, self.top_p, self.max_rollbacks = top_k, top_p, max_rollbacks
        self.rng = np.random.default_rng(seed)
        self.dev = next(model.parameters()).device
        self.clip = clip
        self.clip_t = torch.as_tensor(np.asarray(clip, dtype=np.float32), device=self.dev)[None]
        self.t0 = time.time()
        self.done = False
        self.steps: list[dict] = []
        self.stats = {'rollbacks': 0, 'rejected': 0, 'first_overlap': None, 'finished': False}
        if not _blank:
            self.world = new_world()
            self.rules = rules or Legal(vocab, self.world.conn, self.world.compat)

    # ---------------------------------------------------------------- the builder's predictions

    def logits_after(self, seq: list[int]) -> np.ndarray:
        with torch.no_grad():
            out = self.model(self.clip_t, torch.tensor([seq + [self.vocab.PAD]], device=self.dev))
        return out[0, -1].float().cpu().numpy()

    def tokens(self) -> list[int]:
        # each step keeps the tokens it was drawn as: free mode may pair a value with a kind it does not
        # belong to (an angle for an axle's slide), which re-encoding the values cannot reproduce
        return [self.vocab.BOS] + [t for s in self.steps for t in s['_tok']]

    def pick(self, logits, allowed, exclude=frozenset()):
        return pick(logits, allowed, self.rng, self.top_k, self.top_p, exclude)

    # ---------------------------------------------------------------- one part

    def _root(self) -> dict | None:
        vocab, w = self.vocab, self.world
        seq = self.tokens()
        lg = self.logits_after(seq)
        bad: set[int] = set()
        for _ in range(TRIES):
            t = self.pick(lg, self.rules.parts(w), bad)
            if t is None:
                return None
            pid = vocab.decode(t)[1]
            if not len(w._world_keys(pid, np.eye(4))):
                bad.add(t)
                continue
            c = self.pick(self.logits_after(seq + [t]), np.arange(vocab.lo['colour'], vocab.hi['colour']))
            return {'part': pid, 'colour': vocab.decode(c)[1], 'parent': None, 'pconn': None, 'oconn': None,
                    'kind': None, 'a1': None, 'a2': None, 'a3': None, 'flip': None,
                    '_tok': [t, c] + [vocab.NONE] * (len(FIELDS) - 2)}
        return None

    def _legal(self) -> tuple[dict, np.ndarray] | None:
        vocab, w, rules = self.vocab, self.world, self.rules
        seq0 = self.tokens()
        budget = [BUDGET]

        def fill(k: int, seq: list[int], ch: dict):
            if k == len(FIELDS):
                pose = w.pose_for(ch['parent'], ch['pconn'], ch['part'], ch['oconn'], ch['kind'],
                                  {f: ch[f] for f in ('a1', 'a2', 'a3', 'flip')})
                budget[0] -= 1
                if w.collides(ch['part'], pose, ch['parent'], loose=STRICT):
                    self.stats['rejected'] += 1
                    return None
                return {**ch, '_tok': seq[len(seq0):]}, pose
            f = FIELDS[k]
            if f == 'part':
                allowed = rules.parts(w)
            elif f == 'colour':
                allowed = np.arange(vocab.lo['colour'], vocab.hi['colour'])
            elif f == 'parent':
                allowed = rules.tok('parent', rules.parents(w, ch['part']))
            elif f == 'pconn':
                allowed = rules.tok('pconn', rules.pconns(w, ch['parent'], ch['part']))
            elif f == 'oconn':
                ta = rules.conn.types(w.pids[ch['parent']])[ch['pconn']]
                allowed = rules.tok('oconn', rules.oconns(ch['part'], ta))
            elif f == 'kind':
                ta = rules.conn.types(w.pids[ch['parent']])[ch['pconn']]
                tb = rules.conn.types(ch['part'])[ch['oconn']]
                allowed = rules.tok('kind', fits(rules.compat, ta, tb))
            else:
                allowed = rules.values(f, ch['kind'])
            lg = self.logits_after(seq)
            bad: set[int] = set()
            for _ in range(1 if f == 'colour' else TRIES):
                if budget[0] <= 0:
                    return None
                t = self.pick(lg, allowed, bad)
                if t is None:
                    return None
                v = None if t == vocab.NONE else vocab.decode(t)[1]
                if f == 'part' and not len(w._world_keys(v, np.eye(4))):
                    bad.add(t)
                    continue
                got = fill(k + 1, seq + [t], {**ch, f: v})
                if got:
                    return got
                bad.add(t)
            return None

        return fill(0, seq0, {})

    def _free(self) -> tuple[dict, np.ndarray] | None:
        vocab, w, rules = self.vocab, self.world, self.rules
        seq = self.tokens()
        ch: dict = {}
        for f in FIELDS:
            if f == 'part':
                allowed = rules.tok('part', rules.usable)
            elif f == 'parent':
                allowed = rules.tok('parent', range(w.n))
            elif f == 'pconn':
                allowed = rules.tok('pconn', range(len(rules.conn.frames(w.pids[ch['parent']]))))
            elif f == 'oconn':
                allowed = rules.tok('oconn', range(len(rules.conn.frames(ch['part']))))
            elif f == 'kind':
                allowed = rules.tok('kind', KIND_NAMES)
            else:
                lo, hi = vocab.range(f)
                allowed = np.r_[np.arange(lo, hi), vocab.NONE]
            t = self.pick(self.logits_after(seq), allowed)
            seq.append(t)
            ch[f] = None if t == vocab.NONE else vocab.decode(t)[1]
        pose = w.pose_for(ch['parent'], ch['pconn'], ch['part'], ch['oconn'], ch['kind'],
                          {f: ch[f] for f in ('a1', 'a2', 'a3', 'flip')})
        if self.stats['first_overlap'] is None and w.collides(ch['part'], pose, ch['parent']):
            self.stats['first_overlap'] = len(self.steps)
        return {**ch, '_tok': seq[-len(FIELDS):]}, pose

    def _rebuild(self, poses: list[np.ndarray]) -> None:
        self.world = self.new_world()
        for s, m in zip(self.steps, poses):
            self.world.add(s['part'], s['colour'], m)

    def step(self) -> bool:
        """Place one more part (or end the set). False once the run is done."""
        if self.done:
            return False
        if len(self.steps) >= self.max_parts:
            self.done = True
            return False
        if not self.steps:
            s = self._root()
            if s is None:
                self.done = True
                return False
            self.steps.append(s)
            self.world.add(s['part'], s['colour'], np.eye(4))
            return True
        if self.finish and len(self.steps) >= self.min_parts:
            ends = np.r_[self.rules.parts(self.world) if self.legal else self.rules.tok('part', self.rules.usable),
                         self.vocab.EOS]
            if self.pick(self.logits_after(self.tokens()), ends) == self.vocab.EOS:
                self.stats['finished'] = True
                self.done = True
                return False
        got = self._legal() if self.legal else self._free()
        if got is None:
            self.stats['rollbacks'] += 1
            if self.stats['rollbacks'] > self.max_rollbacks or len(self.steps) <= 1:
                self.done = True
                return False
            self.steps.pop()
            self._rebuild(list(self.world.poses)[:len(self.steps)])
            return True
        s, pose = got
        self.steps.append(s)
        self.world.add(s['part'], s['colour'], pose)
        return True

    def copy(self, seed: int) -> 'Run':
        """An independent run from the same parts so far (own World, steps and random stream)."""
        c = Run(self.model, self.vocab, self.new_world, self.clip, seed=seed, legal=self.legal, finish=self.finish,
                min_parts=self.min_parts, max_parts=self.max_parts, top_k=self.top_k, top_p=self.top_p,
                max_rollbacks=self.max_rollbacks, _blank=True)
        c.rules, c.steps, c.stats, c.done = self.rules, list(self.steps), dict(self.stats), self.done
        c._rebuild(list(self.world.poses))
        return c

    def model_view(self):
        """(stems, colours, poses) for the renderer."""
        stems = self.world.conn.cat.stems
        return [stems[p] for p in self.world.pids], list(self.world.colors), list(self.world.poses)

    def result(self) -> dict:
        return {'world': self.world, 'steps': self.steps,
                'tokens': np.array(self.tokens() + [self.vocab.EOS], dtype=np.int64),
                'seconds': time.time() - self.t0, **self.stats}


def generate(model, vocab: Vocab, new_world: Callable[[], World], clip, steps: int = 100, top_k: int = 20,
             top_p: float = 0.95, seed: int = 0, legal: bool = True, max_rollbacks: int = 20,
             rules: Legal | None = None, finish: bool = False, min_parts: int = 2) -> dict:
    """One build to the end (see Run): steps is the most parts placed."""
    r = Run(model, vocab, new_world, clip, rules, seed=seed, legal=legal, finish=finish, min_parts=min_parts,
            max_parts=steps, top_k=top_k, top_p=top_p, max_rollbacks=max_rollbacks)
    while r.step():
        pass
    return r.result()
