"""Models as step sequences, and back (python/lab/sequence.py)."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
pytestmark = pytest.mark.skipif(not (D / 'sft.npz').exists(), reason='BrickNet data not here')
N = 500


@pytest.fixture(scope='module')
def env():
    import decode
    from lab.connectors import Connectors
    from lab.sequence import Vocab
    arrs = decode.load(D / 'sft.npz')
    return decode, arrs, Connectors(decode.Catalog(D)), Vocab.from_arrays(arrs)


def sample(env, random_root=True):
    from lab.sequence import to_steps
    decode, arrs, conn, _ = env
    rng = np.random.default_rng(1)
    for i in rng.choice(len(arrs['node_ptr']) - 1, N, replace=False):
        pids, colors, edges = decode.model(arrs, int(i))
        order, _ = decode.realise(conn.cat, pids, edges)
        root = int(rng.choice(order)) if random_root else order[0]
        yield int(i), pids, colors, edges, root, to_steps(pids, colors, edges, root, conn)


def fields(steps):
    from lab.sequence import FIELDS
    return [{k: s[k] for k in FIELDS} for s in steps]


def test_round_trip_tokens(env):
    from lab.sequence import decode_tokens, encode
    vocab = env[3]
    for *_, steps in sample(env):
        t = encode(steps, vocab)
        assert t[0] == vocab.BOS and t[-1] == vocab.EOS and len(t) == 2 + 10 * len(steps)
        assert decode_tokens(t, vocab) == fields(steps)


def test_poses_match_realise(env):
    """Same root as decode.realise: every part lands where the data puts it. Angles are rounded to
    whole degrees (as BrickNet does), so a long chain of hinges may drift a little."""
    from lab.sequence import poses
    decode, arrs, conn, _ = env
    total = close = 0
    for i, pids, colors, edges, root, steps in sample(env, random_root=False):
        order, ref = decode.realise(conn.cat, pids, edges)
        want = dict(zip(order, ref))
        got = poses(steps, conn)
        assert len(got) == len(order)
        for s, m in zip(steps, got):
            w = want[s['node']]
            d = np.abs(m[:3, 3] - w[:3, 3]).max()
            r = np.abs(m[:3, :3] - w[:3, :3]).max()
            total += 1
            close += d < 0.6 and r < 0.02
            assert d < 5, (i, s)
    assert close / total > 0.97


def test_sample_covers_every_joint_kind(env):
    kinds = {s['kind'].rstrip('~') for *_, steps in sample(env) for s in steps[1:]}
    assert {'stud', 'hinge', 'fixed', 'ball', 'axle'} <= kinds


def test_root_step_has_no_parent(env):
    for *_, steps in sample(env):
        assert steps[0]['parent'] is None and steps[0]['pconn'] is None
        assert all(s['parent'] < k for k, s in enumerate(steps) if k)
