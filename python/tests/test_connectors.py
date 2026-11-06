"""Connector graph: exact stud edges, rebuilding poses from a build sequence, snap candidates."""
import glob
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz import connectors as cg

CORPUS = "/Users/mac/Projects/BrickMotion-Data/ldraw_brickheadz"
pytestmark = pytest.mark.skipif(not os.path.exists(os.path.join(cg.DEFAULT_DIR, "labels.json.xz")),
                                reason="BrickNet catalogue not present")


def _at(x, y, z, yaw=0.0):
    m = cg.ry(yaw)
    m[:3, 3] = (x, y, z)
    return m


def test_plate_on_plate_is_one_stud_edge_and_rebuilds():
    # 1x1 plate on a 1x1 plate: LDraw y points down, a plate is 8 LDU tall
    parts, colors = ["3024", "3024"], [4, 1]
    mats = [_at(0, 0, 0), _at(0, -8, 0, 90)]
    g = cg.build_graph(parts, colors, mats)
    assert len(g.edges) == 1 and g.edges[0].family == "stud"
    e = g.edges[0]
    assert (e.a, e.b) == (0, 1)  # male (lower plate's stud) -> female (upper plate's hole)
    steps = cg.build_sequence(g)
    out = cg.realize(g, steps, {0: mats[0]})
    assert np.abs(out[1] - mats[1]).max() < 1e-6


def test_print_suffix_maps_to_plain_part():
    cat = cg.catalog()
    assert cat.stem("3069bp01") == "3069bp01"  # printed parts are in the catalogue themselves
    assert cat.stem("3069bpq9x") == "3069b"  # an unknown print falls back to the plain part
    assert cat.stem("3024.dat") == "3024"


def test_snap_candidates_contain_the_true_pose():
    base = _at(0, 0, 0)
    g = cg.build_graph(["3022"], [4], [base])  # 2x2 plate, 4 free studs
    free = cg.free_connectors(g, [base])
    cands = cg.snap_candidates("3024", free)
    target = _at(10, -8, 10)  # 1x1 plate on one corner stud
    assert any(np.abs(c["matrix"] - target).max() < 1e-6 for c in cands)
    assert len(cg.near(cands, (10.0, 10.0), 3.0)) >= 1


@pytest.mark.skipif(not os.path.isdir(CORPUS), reason="BrickHeadz corpus not present")
def test_real_model_round_trip():
    from brickheadz.dat import load_pieces

    path = sorted(glob.glob(os.path.join(CORPUS, "40270*.mpd")))[0]
    ps = load_pieces(path)
    g = cg.graph_of_pieces(ps)
    steps = cg.build_sequence(g)
    out = cg.realize(g, steps, {s.index: ps[s.index].matrix for s in steps if s.edge is None})
    err = max(float(np.abs(m - p.matrix).max()) for m, p in zip(out, ps))
    assert err < 0.5
    assert len(g.components()[0]) > 0.8 * len(ps)
