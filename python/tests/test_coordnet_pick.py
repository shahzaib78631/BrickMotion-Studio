"""Whole-step pick: the step's exact part multiset from lattice votes."""
import time

import numpy as np
import pytest

from coordnet import labels, lattice, pick
from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.lattice import Vote
from coordnet.place import connection_candidates, same_pose

CAM = BookletCamera(36, 33, 0.8, 2.2, 260, 190, eye=4500)
W, H = 520, 380
PLATE = ("3832.dat", 0)          # 2x10 plate


def _m(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


@pytest.fixture(scope="module")
def lib():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.dataset import ROOT
    return load_library(str(ROOT / "public/ldraw"))


def _exact(placed, truth):
    left = list(truth)
    for p, c, m in placed:
        hit = next((i for i, t in enumerate(left) if (t[0], t[1]) == (p, c) and same_pose(p, t[2], m)), None)
        if hit is None:
            return False
        left.pop(hit)
    return not left


def test_pick_tiles_identical_plates_without_overlap(lib):
    # three 2x10 plates cover a 6x10 plate exactly; only seams and edges separate layouts
    base = [("3033.dat", 72, _m(0, 8, 0))]
    truth = [(*PLATE, _m(0, 0, -40)), (*PLATE, _m(0, 0, 0)), (*PLATE, _m(0, 0, 40))]
    model = base + truth
    centre = R.bounds_centre(model)
    idx = {1, 2, 3}
    ren = R.render(model, idx, CAM, centre, W, H, R.Style(), ss=2)
    lab = labels.local_labels(ren.gt, model, idx)
    sel = lab["new"]
    ys, xs = np.nonzero(sel)
    need = {PLATE: 3}
    tables = {k: lattice.PoseTable.build(k[0], v) for k, v in connection_candidates(lib, need, base).items()}
    votes = lattice.vote(np.stack([xs + 0.5, ys + 0.5], 1), lab["local"][sel], lab["size"][sel],
                         ren.picture[sel].astype(float), np.ones(len(xs)), CAM, centre, tables,
                         {PLATE: np.array(R.colour_table()[0], float)})
    t0 = time.perf_counter()
    p = pick.pick(votes, need, sel, CAM, centre)
    assert time.perf_counter() - t0 < 1.0
    assert _exact(p.placed, truth), [m[:3, 3] for _p, _c, m in p.placed]
    assert not p.review and p.margin > 0


def test_pick_forbids_colliding_pairs():
    votes = [Vote(PLATE, _m(0, 0, 0), 100.0, 100, 0.0), Vote(PLATE, _m(0, 0, 20), 90.0, 90, 0.0),
             Vote(PLATE, _m(0, 0, 60), 50.0, 50, 0.0)]
    p = pick.pick(votes, {PLATE: 2}, np.zeros((H, W), bool), CAM, np.zeros(3), lam=0.0, mu=0.0)
    got = sorted(float(m[2, 3]) for _p, _c, m in p.placed)
    assert got == [0.0, 60.0]


def test_hidden_part_placed_but_flagged():
    votes = [Vote(PLATE, _m(0, 0, 0), 5000.0, 4000, 0.0), Vote(PLATE, _m(0, 0, 60), 3.0, 3, 1.0)]
    p = pick.pick(votes, {PLATE: 2}, np.zeros((H, W), bool), CAM, np.zeros(3), lam=0.0, mu=0.0)
    assert len(p.placed) == 2 and p.review


def test_unplaceable_part_reported():
    votes = [Vote(PLATE, _m(0, 0, 0), 5000.0, 4000, 0.0)]
    need = {PLATE: 1, ("3001.dat", 4): 1}
    p = pick.pick(votes, need, np.zeros((H, W), bool), CAM, np.zeros(3), lam=0.0, mu=0.0)
    assert len(p.placed) == 1 and p.unplaced == {("3001.dat", 4): 1} and p.review


def test_splat_covers_the_rendered_part():
    part = [("3020.dat", 4, _m(0, 0, 0))]
    centre = R.bounds_centre(part)
    g = R.gbuffer(*R.scene(part), CAM, centre, W, H)
    fp = pick.splat("3020.dat", part[0][2], CAM, centre, (H, W))
    real = g.part >= 0
    assert (fp & real).sum() / real.sum() > 0.97
    assert (fp & ~real).sum() / real.sum() < 0.15
