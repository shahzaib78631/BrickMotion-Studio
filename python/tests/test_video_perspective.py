"""Perspective video camera: orthographic limit, hover height and edge prediction."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz.video_place import hover_height, predicted_edges
from brickheadz.video_synth import VCam

BOX = np.array([[x, y, z] for x in (-20, 20) for y in (-24, 0) for z in (-10, 10)], np.float32)


def test_dist_zero_is_orthographic():
    ortho = VCam(30.0, 28.0, 4.0, 300.0, 600.0)
    persp = VCam(30.0, 28.0, 4.0, 300.0, 600.0, dist=1e9)
    for a, b in zip(ortho.project(BOX)[:2], persp.project(BOX)[:2]):
        assert np.allclose(a, b, atol=1e-3)
    assert ortho.replace(yaw=10.0).dist == 0.0 and persp.replace(yaw=10.0).dist == 1e9


def test_hover_height_recovers_lift_under_perspective():
    cam = VCam(30.0, 28.0, 4.0, 300.0, 600.0, dist=700.0)
    rest = BOX + np.array([60.0, 0.0, -40.0], np.float32)
    lift = -70.0  # LDraw up is -y
    _u, v, _z = cam.project(rest + np.array([0.0, lift, 0.0], np.float32))
    dy = hover_height(rest, cam, (float(v.min()) + float(v.max())) / 2.0, 0.0)
    assert abs(dy - lift) < 0.1


def test_predicted_edges_follow_the_hovering_part():
    cam = VCam(30.0, 28.0, 4.0, 300.0, 600.0, dist=700.0)
    t = np.array([60.0, 0.0, -40.0], np.float32)
    hover = BOX + t + np.array([0.0, -70.0, 0.0], np.float32)
    u, v, _z = cam.project(hover)
    p0, p1 = predicted_edges(BOX, t, cam, (float(v.min()), float(v.max())))
    assert abs(p0 - float(u.min())) < 0.05 and abs(p1 - float(u.max())) < 0.05
    # at rest height the edges differ: perspective makes u depend on height
    ur, _vr, _zr = cam.project(BOX + t)
    assert abs(float(ur.min()) - float(u.min())) > 1.0
