"""Network-free checks used by the CoordNet evaluation and placement."""
import numpy as np

from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.evaluate import shift_summary
from coordnet.place import same_pose


def _m(x=0.0, y=0.0, z=0.0, rot=None):
    m = np.eye(4)
    if rot is not None:
        m[:3, :3] = rot
    m[:3, 3] = (x, y, z)
    return m


PARTS = [("3001.dat", 4, _m()), ("3020.dat", 15, _m(0, -24, 0)), ("3001.dat", 1, _m(60, 0, 0)),
         ("3003.dat", 14, _m(-50, -8, 30)), ("3023.dat", 2, _m(10, -32, -10))]


def test_tile_shifts_recover_a_known_subpixel_offset():
    """Phase correlation per tile resolves offsets to about 0.3 px."""
    cam = BookletCamera(38, 33, 1.0, 2.4, 230, 170, eye=4500)
    centre = R.bounds_centre(PARTS)
    W, H = 460, 340
    a = R.render(PARTS, set(), cam, centre, W, H, R.Style(), ss=2, red=False)
    region = a.gt.part >= 0
    for dx, dy in ((0.0, 0.0), (0.5, 0.0), (1.0, -1.0), (2.0, 0.5)):
        b = R.render(PARTS, set(), cam.with_(cx=cam.cx + dx, cy=cam.cy + dy), centre, W, H, R.Style(), ss=2,
                     red=False).picture
        s = shift_summary(a.picture, b, region)
        assert s["tiles"] >= 3
        assert abs(s["mean_dx"] - dx) < 0.35 and abs(s["mean_dy"] - dy) < 0.35, (dx, dy, s)


def test_same_pose_accepts_symmetric_turns_and_rejects_offsets():
    turn = np.diag([-1.0, 1.0, -1.0])                 # 180 deg about -Y: a 2x4 brick lands on itself
    assert same_pose("3001.dat", _m(), _m(rot=turn))
    assert not same_pose("3001.dat", _m(), _m(20, 0, 0))
    quarter = np.array([[0.0, 0, 1], [0, 1, 0], [-1, 0, 0]])
    assert not same_pose("3001.dat", _m(), _m(rot=quarter))
