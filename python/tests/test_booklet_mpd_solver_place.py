"""Synthetic step pictures (flat colours + black LDraw edge lines) must be solved exactly."""
from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.score import exact_flags
from booklet_mpd.solver.candidates import candidates, stud_candidates
from booklet_mpd.solver.edges import part_edges, sample_segments, visible_points
from booklet_mpd.solver.picture import Picture, colour_rgb
from booklet_mpd.solver.render import View, render
from booklet_mpd.solver.step import solve

ROOT = Path(__file__).resolve().parents[2]
BG = (211, 236, 247)


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def placed(x, y, z, r=None):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    if r is not None:
        m[:3, :3] = r
    return m


def drawing(lib, parts, view, shape=(260, 300)):
    depth, label = render(lib, parts, view, shape)
    img = np.zeros(shape + (3,), np.uint8)
    img[:] = BG
    for k, (_p, c, _m) in enumerate(parts):
        img[label == k] = colour_rgb(c)
    pts = []
    for p, _c, m in parts:
        e = part_edges(lib, p)
        if len(e):
            pts.append(sample_segments(view.project(e.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]).reshape(-1, 2, 3)))
    vis = visible_points(np.concatenate(pts), depth)
    img[vis[:, 0], vis[:, 1]] = (20, 20, 20)
    return img


BASE = [("3958", 19, placed(0, 0, 0)), ("3001", 19, placed(-20, -24, -20))]


def test_stud_candidates_include_the_true_pose(lib):
    truth = placed(20, -24, 30)
    cands = stud_candidates("3004", BASE)
    assert any(exact_flags(lib, [("3004", 4, c["matrix"])], [("3004", 4, truth)])[0] for c in cands)
    assert all("axis" in c for c in cands)


def test_candidates_attach_a_part_under_a_plate(lib):
    base = [("3020", 15, placed(0, 0, 0))]
    cands = candidates(lib, "3005", base)
    under = [c for c in cands if c["matrix"][1, 3] > 0]
    assert under, "anti-studs on the underside are connection points too"


@pytest.mark.parametrize("new", [
    [("3004", 4, placed(20, -24, 30))],
    [("3023", 1, placed(10, -8, 40, np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], float))),
     ("3024", 14, placed(-50, -8, 50))],
])
def test_solve_recovers_seated_parts_from_a_synthetic_picture(lib, new):
    view = View(np.eye(3), 35, 35, 1.1, (150, 140))
    img = drawing(lib, BASE + new, view)
    result = solve(lib, BASE, [(p, c) for p, c, _m in new], img, None)
    assert result.view is not None
    assert all(exact_flags(lib, result.placed, new)), [np.round(m[:3, 3]) for _p, _c, m in result.placed]


def test_picture_classes_separate_white_from_grey():
    img = np.zeros((10, 20, 3), np.uint8)
    img[:] = BG
    img[2:8, 2:8] = colour_rgb(15)
    img[2:8, 12:18] = colour_rgb(71)
    pic = Picture.from_rgb(img)
    pic.foreground[:] = True
    cls = pic.classes([15, 71])
    assert cls[4, 4] == 0 and cls[4, 14] == 1
