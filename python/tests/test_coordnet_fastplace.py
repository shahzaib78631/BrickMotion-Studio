"""Fast placer end to end, with a stand-in network that returns ground-truth labels."""
import numpy as np
import pytest

from coordnet import fastplace, labels
from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.place import same_pose

CAM = BookletCamera(36, 33, 0.8, 3.0, 230, 170, eye=4500)
W, H = 460, 340


def _m(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


BASE = [("3958.dat", 72, _m(0, 8, 0))]
TRUTH = [("3020.dat", 0, _m(0, 0, -20)), ("3020.dat", 0, _m(0, 0, 20)),
         ("3024.dat", 4, _m(-30, -8, -30))]                    # 1x1 plate on the first new plate
NEED = {("3020.dat", 0): 2, ("3024.dat", 4): 1}


class Oracle:
    """Returns the true labels at half resolution, like a perfect PlaceNet."""

    def __init__(self, model, cam, centre, blank=False):
        idx = list(range(len(BASE), len(model)))
        g = R.gbuffer(*R.scene(model), cam, centre, W, H)
        new = np.isin(g.part, idx)
        off, _ext = labels.centre_targets(g.part.astype(int), new, model, cam, centre)
        h = lambda a: a[::2, ::2]
        self.out = dict(new=h(new).astype(np.float32) * (0 if blank else 1), offset=h(off),
                        conf=np.ones(h(new).shape, np.float32))

    def __call__(self, picture, base_img, evidence, cam, centre):
        return self.out


@pytest.fixture(scope="module")
def lib():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.dataset import ROOT
    return load_library(str(ROOT / "public/ldraw"))


def _scene():
    model = BASE + TRUTH
    centre = R.bounds_centre(model)
    pic = R.render(model, set(range(1, len(model))), CAM, centre, W, H, R.Style(), ss=2).picture
    return model, centre, pic


def _exact(placed, truth):
    left = list(truth)
    for p, c, m in placed:
        hit = next((i for i, t in enumerate(left) if (t[0], t[1]) == (p, c) and same_pose(p, t[2], m)), None)
        if hit is None:
            return False
        left.pop(hit)
    return not left


def test_place_fast_with_oracle_net_is_exact(lib):
    model, centre, pic = _scene()
    # the camera stage already rendered the base at the solved camera; the placer reuses it (as at run time)
    base_ren = R.render(BASE, set(), CAM, centre, W, H, R.Style(), ss=2, red=False)
    placed, rep = fastplace.place_fast(Oracle(model, CAM, centre), lib, pic, BASE, NEED, CAM, centre,
                                       base_ren=base_ren)
    assert _exact(placed, TRUTH), (rep, [(p, m[:3, 3]) for p, _c, m in placed])
    assert not rep["review"] and rep["seconds"] < 5, rep


def test_part_only_on_new_part_is_found_in_pass_two(lib):
    model, centre, pic = _scene()
    placed, rep = fastplace.place_fast(Oracle(model, CAM, centre), lib, pic, BASE, NEED, CAM, centre)
    assert rep["pass2"]
    assert any(p == "3024.dat" and same_pose(p, TRUTH[2][2], m) for p, _c, m in placed)


def test_place_fast_with_no_new_pixels(lib):
    model, centre, pic = _scene()
    placed, rep = fastplace.place_fast(Oracle(model, CAM, centre, blank=True), lib, pic, BASE, NEED, CAM, centre)
    assert placed == [] and rep["review"]


def test_type_with_no_legal_pose_is_reported(lib):
    model, centre, pic = _scene()
    need = dict(NEED)
    need[("3001.dat", 1)] = 1                                       # not in the picture at all
    placed, rep = fastplace.place_fast(Oracle(model, CAM, centre), lib, pic, BASE, need, CAM, centre)
    assert rep["review"] and rep["unplaced"].get("3001.dat|1") == 1
