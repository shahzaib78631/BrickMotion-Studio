"""Resumable runs and the parallel-builds search (python/lab/sample.py Run, python/lab/smc.py)."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')
pytestmark = pytest.mark.skipif(not (LAB / 'vocab.json').exists(), reason='run python -m lab.dataset val first')


@pytest.fixture(scope='module')
def env():
    import torch
    import decode
    from lab.builder import Builder
    from lab.connectors import Connectors, load_compat
    from lab.sample import Legal
    from lab.sequence import Vocab
    from lab.world import World
    torch.manual_seed(0)
    vocab = Vocab.load(LAB / 'vocab.json')
    conn = Connectors(decode.Catalog(D))
    compat = load_compat(LAB / 'compat.json')
    model = Builder(vocab.size, width=64, layers=2, heads=4).eval()
    clip = np.load(LAB / 'clip_val.npy')[0]
    return model, vocab, (lambda: World(conn, compat)), clip, Legal(vocab, conn, compat), conn


def test_run_steps_like_generate(env):
    from lab.sample import Run, generate
    model, vocab, new_world, clip, rules, _ = env
    a = generate(model, vocab, new_world, clip, steps=8, seed=4, rules=rules)
    r = Run(model, vocab, new_world, clip, rules, seed=4, finish=False, max_parts=8)
    while r.step():
        pass
    assert r.done and r.world.n == a['world'].n == 8
    assert [s['part'] for s in r.steps] == [s['part'] for s in a['steps']]


def test_copy_diverges(env):
    from lab.sample import Run
    model, vocab, new_world, clip, rules, _ = env
    r = Run(model, vocab, new_world, clip, rules, seed=1, finish=False, max_parts=12)
    for _ in range(4):
        r.step()
    c = r.copy(seed=99)
    assert c.world.n == r.world.n and c.world is not r.world
    assert all(np.allclose(a, b) for a, b in zip(c.world.poses, r.world.poses))
    for _ in range(4):
        c.step()
    assert r.world.n == 4 and c.world.n == 8 and len(r.steps) == 4


class ColourScorer:
    """Scores a model by its share of parts in one colour."""

    def __init__(self, colour):
        self.colour = colour

    def score(self, models, text_vec):
        return np.array([np.mean([c == self.colour for c in co]) if co else 0.0 for _, co, _ in models])


RedScorer = lambda: ColourScorer(4)  # noqa: E731


def test_smc_follows_the_scorer(env):
    """Rewarding one colour, the search ends with more of it than single builds have on average."""
    from lab.sample import Run
    from lab.smc import smc
    model, vocab, new_world, clip, rules, conn = env
    singles = []
    for sd in range(6):
        r = Run(model, vocab, new_world, clip, rules, seed=100 + sd, finish=False, max_parts=9)
        while r.step():
            pass
        singles.append([s['colour'] for s in r.steps])
    colours = {c for run in singles for c in run}
    target = max(colours, key=lambda c: np.var([np.mean([x == c for x in run]) for run in singles]))
    mean_single = np.mean([np.mean([x == target for x in run]) for run in singles])
    out = smc(model, vocab, new_world, clip, None, ColourScorer(target), rules, n=6, every=3, max_parts=9, seed=0)
    best = np.mean([s['colour'] == target for s in out['best'].steps])
    assert best > mean_single
    assert out['rounds'] >= 2 and len(out['scores']) == out['rounds']


def test_smc_all_dead_ends(env):
    from lab.smc import smc
    model, vocab, new_world, clip, rules, _ = env

    class Stuck:
        def __init__(self, r):
            self.r = r

        def parts(self, w):
            return self.r.parts(w) if w.n == 0 else np.zeros(0, dtype=np.int64)

        def __getattr__(self, k):
            return getattr(self.r, k)

    out = smc(model, vocab, new_world, clip, None, RedScorer(), Stuck(rules), n=4, every=3, max_parts=9, seed=0)
    assert out['best'] is not None and out['best'].world.n >= 1
