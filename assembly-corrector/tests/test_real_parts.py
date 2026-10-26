"""Optional network/cached-LDraw integration tests.

Run with AUTOSTEP_REAL_LDRAW=1 to enable. If a local library is available,
pass AUTOSTEP_LDRAW=/path/to/ldraw and AUTOSTEP_SHADOW=/path/to/shadow to
avoid downloading anything.
"""
import os
from pathlib import Path
import sys
import tempfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ldraw_autostep as A

pytestmark = pytest.mark.skipif(
    os.environ.get('AUTOSTEP_REAL_LDRAW') != '1',
    reason='set AUTOSTEP_REAL_LDRAW=1 to run downloaded/cached LDraw tests')

CACHE = os.environ.get('AUTOSTEP_CACHE', os.path.join(tempfile.gettempdir(), 'autostep_test_cache'))


@pytest.fixture(scope='module')
def lib():
    return A.Library(os.environ.get('AUTOSTEP_LDRAW'), os.environ.get('AUTOSTEP_SHADOW'), CACHE,
                     offline=bool(os.environ.get('AUTOSTEP_LDRAW')))


def units(text, lib):
    _, ms = A.split_models(text)
    return A.read_units(ms[0], set(), lib, A.SnapDB(lib))[1]


def test_stud_stack_is_connected(lib):
    us = units('1 7 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat', lib)
    an = A.Analysis(us)
    assert an.attach[0, 1] and an.snap_pairs >= 1


def test_floating_part_not_connected_by_snap(lib):
    us = units('1 7 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat\n1 4 0 -60 0 1 0 0 0 1 0 0 0 1 3001.dat', lib)
    an = A.Analysis(us)
    assert not an.attach[0, 1]


def test_side_by_side_bricks_not_connected(lib):
    us = units('1 7 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n1 4 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat', lib)
    an = A.Analysis(us)
    assert an.snap_pairs == 0
    assert an.fallback_pairs == 1


def test_axle_through_technic_brick_rotates(lib):
    us = units('1 7 0 0 0 1 0 0 0 1 0 0 0 1 3702.dat\n1 4 -60 10 0 0 0 1 0 1 0 -1 0 0 3708.dat', lib)
    an = A.Analysis(us)
    assert an.attach[0, 1] and not an.rigid[0, 1]
