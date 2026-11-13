"""Joint placement on a synthetic step: the picture is our own booklet render of a known model, the candidates are
generated (no answer key), and the new parts must come back at their exact poses."""
import numpy as np

from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.place import JointScene, place_rounds, same_pose


def _m(x=0.0, y=0.0, z=0.0, rot=None):
    m = np.eye(4)
    if rot is not None:
        m[:3, :3] = rot
    m[:3, 3] = (x, y, z)
    return m


def test_two_identical_plates_side_by_side_come_back_exactly():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.dataset import ROOT
    lib = load_library(str(ROOT / "public/ldraw"))
    base = [("3958.dat", 72, _m(0, 8, 0))]                         # 6x6 plate
    new = [("3020.dat", 0, _m(0, 0, -20)), ("3020.dat", 0, _m(0, 0, 20))]   # two 2x4 plates side by side
    model = base + new
    cam = BookletCamera(36, 33, 0.8, 3.0, 230, 170, eye=4500)
    centre = R.bounds_centre(model)
    W, H = 460, 340
    picture = R.render(model, {1, 2}, cam, centre, W, H, R.Style(), ss=2).picture
    placed, stats = place_rounds(lib, picture, base, {("3020.dat", 0): 2}, cam, centre,
                                 scene=JointScene(picture, base, cam, centre), seeds=8, per_type=60, verify=3)
    assert len(placed) == 2, stats
    left = list(new)
    for p, _c, m in placed:
        hit = next((i for i, t in enumerate(left) if t[0] == p and same_pose(p, t[2], m)), None)
        assert hit is not None, (m[:3, 3], stats)
        left.pop(hit)
