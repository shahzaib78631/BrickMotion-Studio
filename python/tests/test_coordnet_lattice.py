"""Ray/lattice voting onto legal poses, fed with ground-truth labels (the network's stand-in)."""
import time

import numpy as np
import pytest

from coordnet import labels, lattice
from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.place import connection_candidates

CAM = BookletCamera(36, 33, 0.8, 3.0, 230, 170, eye=4500)
W, H = 460, 340
BASE = ("3958.dat", 72, None)


def _m(x=0.0, y=0.0, z=0.0, rot=None):
    m = np.eye(4)
    if rot is not None:
        m[:3, :3] = rot
    m[:3, 3] = (x, y, z)
    return m


@pytest.fixture(scope="module")
def lib():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.dataset import ROOT
    return load_library(str(ROOT / "public/ldraw"))


def scene_votes(lib, new, cam=CAM, extra_poses=None):
    """Render base + new, label the new pixels from the G-buffer, vote onto legal poses (+ extra)."""
    base = [("3958.dat", 72, _m(0, 8, 0))]
    model = base + new
    centre = R.bounds_centre(model)
    idx = set(range(1, len(model)))
    ren = R.render(model, idx, cam, centre, W, H, R.Style(), ss=2)
    lab = labels.local_labels(ren.gt, model, idx)
    sel = lab["new"]
    ys, xs = np.nonzero(sel)
    uv = np.stack([xs + 0.5, ys + 0.5], 1)
    need = {(p, c): 0 for p, c, _m2 in new}
    poses = connection_candidates(lib, need, base)
    for k, extra in (extra_poses or {}).items():
        poses[k] = list(poses[k]) + extra
    tables = {k: lattice.PoseTable.build(k[0], v) for k, v in poses.items()}
    colours = {k: np.array(R.colour_table()[k[1]], float) for k in need}
    t0 = time.perf_counter()
    votes = lattice.vote(uv, lab["local"][sel], lab["size"][sel], ren.picture[sel].astype(float),
                         np.ones(len(uv)), cam, centre, tables, colours)
    return votes, time.perf_counter() - t0


def _top(votes, key, n):
    return [v for v in votes if v.key == key][:n]


def _xyz(v):
    return tuple(int(round(a)) for a in v.pose[:3, 3])


def test_votes_recover_two_identical_plates_exactly(lib):
    new = [("3020.dat", 0, _m(0, 0, -20)), ("3020.dat", 0, _m(0, 0, 20))]
    votes, secs = scene_votes(lib, new)
    top = _top(votes, ("3020.dat", 0), 2)
    assert sorted(_xyz(v) for v in top) == [(0, 0, -20), (0, 0, 20)]
    assert all(v.residual < 1.0 for v in top)
    assert secs < 2.0, secs                           # ~0.2 s idle; the speed gate is the Task 7 benchmark


def test_line_of_sight_twin_scores_below_truth(lib):
    new = [("3020.dat", 0, _m(0, 0, 0))]
    twins = [_m(dx, -8, dz) for dx, dz in ((20, 0), (-20, 0), (0, 20), (0, -20))]
    votes, _ = scene_votes(lib, new, extra_poses={("3020.dat", 0): twins})
    score: dict = {}
    for v in votes:                                   # several rotations can share a position: keep the best
        if v.key == ("3020.dat", 0):
            score[_xyz(v)] = max(score.get(_xyz(v), 0.0), v.score)
    truth = score[(0, 0, 0)]
    best_twin = max(score.get(_xyz(type("V", (), {"pose": t})), 0.0) for t in twins)
    assert truth > 2 * best_twin, (truth, best_twin)


def test_colour_separates_same_shape_types(lib):
    new = [("3020.dat", 4, _m(0, 0, -20)), ("3020.dat", 0, _m(0, 0, 20))]
    votes, _ = scene_votes(lib, new)
    assert _xyz(_top(votes, ("3020.dat", 4), 1)[0]) == (0, 0, -20)
    assert _xyz(_top(votes, ("3020.dat", 0), 1)[0]) == (0, 0, 20)


def test_turned_camera_votes_the_same_poses(lib):
    # plates under the base: a turned (upside-down) view sees them
    new = [("3020.dat", 0, _m(0, 16, -20)), ("3020.dat", 0, _m(0, 16, 20))]
    votes, _ = scene_votes(lib, new, cam=CAM.with_(turned=True))
    top = _top(votes, ("3020.dat", 0), 2)
    assert sorted(_xyz(v) for v in top) == [(0, 16, -20), (0, 16, 20)]


def test_non_axis_poses_go_to_fallback():
    a = np.radians(30)
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    t = lattice.PoseTable.build("3020.dat", [np.eye(4), _m(0, 0, 0, rx)])
    assert len(t.fallback) == 1


def test_pose_hidden_behind_the_base_gets_no_votes(lib):
    # a 1x1 plate on top of a 2x4 plate; a legal pose under the base lies on the same lines of sight
    base = [("3958.dat", 72, _m(0, 8, 0)), ("3020.dat", 0, _m(0, 0, -20))]
    new = [("3024.dat", 4, _m(-30, -8, -30))]
    model = base + new
    centre = R.bounds_centre(model)
    ren = R.render(model, {2}, CAM, centre, W, H, R.Style(), ss=2)
    lab = labels.local_labels(ren.gt, model, {2})
    sel = lab["new"]
    ys, xs = np.nonzero(sel)
    hidden = _m(-50, 16, -50)
    table = {("3024.dat", 4): lattice.PoseTable.build("3024.dat", [new[0][2], hidden])}
    depth = R.gbuffer(*R.scene(base), CAM, centre, W, H).depth[sel]
    args = (np.stack([xs + 0.5, ys + 0.5], 1), lab["local"][sel], lab["size"][sel], ren.picture[sel].astype(float),
            np.ones(len(xs)), CAM, centre, table, {})
    blind = {_xyz(v) for v in lattice.vote(*args)}
    seen = {_xyz(v) for v in lattice.vote(*args, depth=depth)}
    assert (-50, 16, -50) in blind                       # without the depth test the twin collects votes
    assert seen == {(-30, -8, -30)}
