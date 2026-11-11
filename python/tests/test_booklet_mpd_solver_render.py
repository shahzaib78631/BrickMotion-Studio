from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.solver.render import View, rasterize, render, sprite

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def placed(x, y, z, r=None):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    if r is not None:
        m[:3, :3] = r
    return m


def test_rasterize_fills_a_triangle_and_keeps_the_nearer_one():
    a = np.array([[[0, 0, 5], [10, 0, 5], [0, 10, 5]]], float)
    b = np.array([[[0, 0, 1], [10, 0, 1], [0, 10, 1]]], float)
    depth, label = rasterize(np.concatenate([a, b]), np.array([7, 9]), (12, 12))
    assert (label >= 0).sum() == 66          # lattice points with x, y >= 0 and x + y <= 10
    assert set(np.unique(label[label >= 0])) == {9}
    assert depth[0, 0] == pytest.approx(1.0)


def test_top_of_a_brick_is_nearer_than_its_bottom_from_above(lib):
    view = View(yaw=35, pitch=35, scale=2.0, offset=(80, 80))
    q_top = view.project(np.array([[0, -24, 0]]))[0]
    q_bottom = view.project(np.array([[0, 0, 0]]))[0]
    assert q_top[1] < q_bottom[1]            # up is up on screen
    assert q_top[2] < q_bottom[2]            # and nearer to a camera above the model


def test_sprite_placement_matches_direct_render(lib):
    view = View(yaw=35, pitch=35, scale=1.5, offset=(150.0, 150.0))
    t = np.array([40.0, -24.0, 20.0])
    direct_depth, direct_label = render(lib, [("3001", 4, placed(*t))], view, (300, 320))
    sp = sprite(lib, "3001", np.eye(3), view)
    row0, col0, dd = sp.place(view, t)
    canvas = np.zeros((300, 320), bool)
    h, w = sp.mask.shape
    canvas[row0:row0 + h, col0:col0 + w] = sp.mask
    direct = direct_label >= 0
    assert (canvas & direct).sum() / (canvas | direct).sum() > 0.97
    rows, cols = np.where(sp.mask)
    k = len(rows) // 2
    assert sp.depth[rows[k], cols[k]] + dd == pytest.approx(direct_depth[rows[k] + row0, cols[k] + col0], abs=1.0)


def test_render_labels_index_the_parts(lib):
    view = View(yaw=35, pitch=35, scale=1.0, offset=(60, 70))
    parts = [("3001", 4, placed(0, 0, 0)), ("3001", 1, placed(0, -24, 0))]
    _depth, label = render(lib, parts, view, (140, 140))
    assert {0, 1} <= set(np.unique(label))
