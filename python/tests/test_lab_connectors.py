"""Connector types and which ones join, learned from BrickNet's joints (python/lab/connectors.py)."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'bricknet'))

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
pytestmark = pytest.mark.skipif(not (D / 'sft.npz').exists(), reason='BrickNet data not here')


@pytest.fixture(scope='module')
def conn():
    import decode
    from lab.connectors import Connectors
    return Connectors(decode.Catalog(D))


@pytest.fixture(scope='module')
def arrs():
    import decode
    return decode.load(D / 'sft.npz')


@pytest.fixture(scope='module')
def compat(arrs, conn):
    from lab.connectors import build_compat
    return build_compat(arrs, conn)


def pid_of(conn, stem):
    return conn.cat.stems.index(stem)


def test_types_align_with_frames(conn, arrs):
    rng = np.random.default_rng(0)
    for p in rng.choice(np.unique(arrs['part_ids']), 200, replace=False):
        assert len(conn.types(int(p))) == len(conn.frames(int(p)))


def test_brick_stud_fits_brick_hole(conn, compat):
    from lab.connectors import fits
    t = conn.types(pid_of(conn, '3001'))
    stud = next(x for x in t if x.startswith('stud/'))
    hole = next(x for x in t if x.startswith('hole/'))
    assert 'stud' in fits(compat, stud, hole) or 'stud' in fits(compat, hole, stud)


def test_stud_does_not_fit_stud(conn, compat):
    from lab.connectors import fits
    stud = next(x for x in conn.types(pid_of(conn, '3001')) if x.startswith('stud/'))
    assert fits(compat, stud, stud) == []


def test_every_sft_edge_is_allowed(conn, compat, arrs):
    import decode
    from lab.connectors import fits
    for i in range(2000):
        pids, _, edges = decode.model(arrs, i)
        for a, ac, b, bc, kind, *_ in edges:
            ta, tb = conn.types(pids[a]), conn.types(pids[b])
            if ac < len(ta) and bc < len(tb):
                assert kind in fits(compat, ta[ac], tb[bc]), (i, ta[ac], tb[bc], kind)


def test_save_load_round_trip(tmp_path, compat):
    from lab.connectors import load_compat, save_compat
    save_compat(tmp_path / 'c.json', compat)
    assert load_compat(tmp_path / 'c.json') == compat
