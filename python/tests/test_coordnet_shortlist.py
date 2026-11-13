"""Centre-vote shortlist: answer-key offsets must put every true pose on the shortlist."""
import numpy as np
import pytest

from coordnet import labels, shortlist
from coordnet import render as R
from coordnet.camera import BookletCamera, project
from coordnet.place import same_pose

CAM = BookletCamera(36, 33, 0.8, 3.0, 230, 170, eye=4500)
W, H = 460, 340


def _m(x=0.0, y=0.0, z=0.0, yaw=0.0):
    m = np.eye(4)
    m[:3, :3] = labels._yaw(yaw)
    m[:3, 3] = (x, y, z)
    return m


BASE = [("3958.dat", 72, _m(0, 8, 0))]
# on the 6x6 plate's studs (x, z in +-10, +-30, +-50), not overlapping: 2x4 along x, 2x4 along z, 1x1
TRUTH = [("3020.dat", 0, _m(0, 0, -40)), ("3020.dat", 0, _m(-40, 0, 20, yaw=90)), ("3024.dat", 4, _m(30, 0, 30))]
NEED = {("3020.dat", 0): 2, ("3024.dat", 4): 1}


def test_half_res_pixel_centre():
    xs, ys = np.array([0, 3]), np.array([5, 1])
    assert shortlist.half_uv(xs, ys).tolist() == [[0.5, 10.5], [6.5, 2.5]]   # half-res x is full-res pixel 2x


@pytest.fixture(scope="module")
def lib():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.dataset import ROOT
    return load_library(str(ROOT / "public/ldraw"))


def test_answer_key_offsets_shortlist_every_true_pose(lib):
    from coordnet.fastplace import connection_candidates
    model = BASE + TRUTH
    centre = R.bounds_centre(model)
    g = R.gbuffer(*R.scene(model), CAM, centre, W, H)
    new = np.isin(g.part, [1, 2, 3])
    assert all((g.part == i).sum() > 200 for i in (1, 2, 3)), "fixture: every true part must be visible"
    off, _ext = labels.centre_targets(g.part.astype(int), new, model, CAM, centre)
    h = lambda a: a[::2, ::2]
    ys, xs = np.nonzero(h(new))
    uv = shortlist.half_uv(xs, ys)
    pic = R.render(model, {1, 2, 3}, CAM, centre, W, H, R.Style(), ss=2).picture
    depth = R.render(BASE, set(), CAM, centre, W, H, R.Style(), ss=2, red=False).gt.depth
    poses = connection_candidates(lib, NEED, BASE)
    cands, info = shortlist.shortlist(uv, h(off)[ys, xs], np.ones(len(xs)), pic[2 * ys, 2 * xs].astype(float),
                                      CAM, centre, poses, {k: np.array(R.colour_table()[k[1]], float) for k in NEED},
                                      NEED, depth=depth[2 * ys, 2 * xs])
    for p, c, m in TRUTH:
        assert any(same_pose(p, m, q) for q, _s in cands[(p, c)]), (p, m[:3, 3], info)
    assert sum(len(v) for v in cands.values()) < 0.25 * sum(len(v) for v in poses.values())   # it is short


def test_outline_consistency_separates_rotation_and_type():
    model = BASE + TRUTH
    centre = R.bounds_centre(model)
    g = R.gbuffer(*R.scene(model), CAM, centre, W, H)
    new = np.isin(g.part, [1, 2, 3])
    off, _ext = labels.centre_targets(g.part.astype(int), new, model, CAM, centre)
    h = lambda a: a[::2, ::2]
    ys, xs = np.nonzero(h(new))
    target = shortlist.half_uv(xs, ys) + h(off)[ys, xs] * CAM.scale
    base_depth = h(R.gbuffer(*R.scene(BASE), CAM, centre, W, H).depth)
    p, c, m = TRUTH[0]                                            # 2x4 plate along x
    score = lambda part, pose: shortlist.consistency(part, pose, xs, ys, target, np.ones(len(xs)), h(new),
                                                     base_depth, CAM, centre)
    good = score(p, m)
    turned = score(p, _m(*m[:3, 3], yaw=90))                      # same centre, along z
    brick = score("3001.dat", m)                                  # a brick where the plate is
    assert good["precision"] > 0.85 and good["recall"] > 0.85, good
    assert shortlist.accepted(good)
    assert not shortlist.accepted(turned), turned
    assert not shortlist.accepted(brick), brick                   # (its centre is drawn elsewhere: no voters)
    # a line-of-sight twin under the base plate: slid along the viewing ray through its centre, so its centre is
    # drawn where the true one is (same voters), but the base plate hides it
    from coordnet.lattice import rays
    cw, _e = labels.pose_centre_extent(p, m)
    (cuv,), _z = project(CAM, centre, cw[None])
    _o, d = rays(CAM, centre, cuv[None])
    q = m.copy()
    q[:3, 3] = m[:3, 3] + d[0] * (12.0 / d[0, 1])                   # 12 LDU lower (+Y is down): under the base
    (quv,), _z = project(CAM, centre, labels.pose_centre_extent(p, q)[0][None])
    assert np.abs(quv - cuv).max() < 0.05                          # the twin really is on the same sight line
    twin = score(p, q)
    assert twin["voters"] > 100 and not shortlist.accepted(twin), twin
