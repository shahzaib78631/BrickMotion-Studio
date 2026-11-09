"""The legal-moves sampler (python/lab/sample.py), driven by an untrained builder."""
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
    from lab.sequence import Vocab
    from lab.world import World
    torch.manual_seed(0)
    vocab = Vocab.load(LAB / 'vocab.json')
    conn = Connectors(decode.Catalog(D))
    compat = load_compat(LAB / 'compat.json')
    model = Builder(vocab.size, width=64, layers=2, heads=4).eval()
    clip = np.load(LAB / 'clip_val.npy')[0]
    return model, vocab, conn, compat, (lambda: World(conn, compat)), clip


def test_legal_reaches_100_parts_no_overlap(env):
    from lab.sample import generate
    from lab.world import World
    model, vocab, conn, compat, new_world, clip = env
    r = generate(model, vocab, new_world, clip, steps=100, seed=1)
    w = r['world']
    assert w.n == 100
    check = World(conn, compat)
    for k, s in enumerate(r['steps']):
        assert not check.collides(s['part'], w.poses[k], s['parent']), k
        check.add(s['part'], s['colour'], w.poses[k])
    print(f"rollbacks {r['rollbacks']} rejected {r['rejected']} {r['seconds']:.1f}s")


def test_never_offers_partless_parts(env):
    from lab.sample import Legal
    model, vocab, conn, compat, new_world, clip = env
    legal = Legal(vocab, conn, compat)
    w = new_world()
    for tok in legal.parts(w):
        pid = vocab.decode(int(tok))[1]
        assert len(conn.frames(pid)) > 0


def test_parent_masked_to_placed(env):
    from lab.sample import Legal
    model, vocab, conn, compat, new_world, clip = env
    legal = Legal(vocab, conn, compat)
    w = new_world()
    b = conn.cat.stems.index('3001')
    for k in range(5):
        w.add(b, 4, np.array([[1, 0, 0, 100.0 * k], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]))
    parents = legal.parents(w, b)
    assert parents and all(0 <= p < 5 for p in parents)


def test_illegal_baseline_reports_first_overlap(env):
    from lab.sample import generate
    model, vocab, conn, compat, new_world, clip = env
    r = generate(model, vocab, new_world, clip, steps=60, seed=2, legal=False)
    assert r['first_overlap'] is not None


def test_legal_never_touches_unconnected_parts(env):
    """Real parts rarely reach into a part they don't connect to (2.9% of val parts); an untrained
    sampler allowed LOOSE did so 25% of the time, and the app flagged those. Legal moves allow none."""
    from lab.sample import generate
    from lab.world import World
    model, vocab, conn, compat, new_world, clip = env
    r = generate(model, vocab, new_world, clip, steps=25, seed=3)
    w = World(conn, compat)
    for k, s in enumerate(r['steps']):
        m = r['world'].poses[k]
        if k:
            mated = w.mates(s['part'], m) | {s['parent']}
            assert not [j for j, f in w.overlap(s['part'], m).items() if j not in mated and f > 0], k
        w.add(s['part'], s['colour'], m)


def test_joint_values_follow_real_habits(env):
    """Studded parts sit at right angles in real sets (98% at 0/90/180/270); legal moves keep to the
    angles and flips real sets use, so parts are not skewed or turned over on their studs."""
    from lab.sample import Legal, habits
    model, vocab, conn, compat, new_world, clip = env
    h = habits()
    assert set(h['a1']['stud']) <= {0, 45, 90, 135, 180, 225, 270, 315} and {0, 90, 180, 270} <= set(h['a1']['stud'])
    legal = Legal(vocab, conn, compat)
    stud = {vocab.decode(int(t))[1] for t in legal.values('a1', 'stud~')}
    assert stud == set(h['a1']['stud'])
    assert {vocab.decode(int(t))[1] for t in legal.values('flip', 'hinge')} == set(h['flip']['hinge'])


def test_finish_stops_when_the_builder_ends_the_set(env):
    """With finish=True the builder may end the set (EOS at a part slot) once min_parts are placed,
    as real sets end: a minifigure is a few parts, not 100."""
    import torch
    from lab.sample import generate
    model, vocab, conn, compat, new_world, clip = env

    class Ends(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, c, t):
            out = self.m(c, t).clone()
            out[..., vocab.EOS] += 100.0
            return out

    r = generate(Ends(model), vocab, new_world, clip, steps=100, seed=1, finish=True, min_parts=3)
    assert r['world'].n == 3 and r['finished']
    assert int(r['tokens'][-1]) == vocab.EOS
    r = generate(Ends(model), vocab, new_world, clip, steps=5, seed=1)  # finish off: EOS never offered
    assert r['world'].n == 5 and not r['finished']
