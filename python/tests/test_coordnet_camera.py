import json
from pathlib import Path

import numpy as np

from coordnet.camera import BookletCamera, project, unproject

FIXTURE = Path(__file__).parent / "data/coordnet_camera_fixture.json"


def _cam(c):
    k = c["cam"]
    return BookletCamera(k["yaw"], k["pitch"], k["roll"], k["scale"], k["cx"], k["cy"], eye=k["eye"], up=k["up"],
                         turned=c["turned"])


def test_matches_the_page_camera():
    for c in json.loads(FIXTURE.read_text()):
        cam = _cam(c)
        uv, depth = project(cam, np.array(c["centre"]), np.array(c["pts"]))
        ref = np.array(c["uv"])
        assert np.abs(uv - ref[:, :2]).max() < 1e-6
        if cam.eye > 0:
            assert np.abs(depth - ref[:, 2]).max() < 1e-6


def test_centre_lands_on_cx_cy_and_unproject_inverts():
    for c in json.loads(FIXTURE.read_text()):
        cam = _cam(c)
        centre = np.array(c["centre"])
        uv, depth = project(cam, centre, centre[None])
        assert np.allclose(uv[0], [cam.cx, cam.cy], atol=1e-9)
        pts = np.array(c["pts"])
        uv, depth = project(cam, centre, pts)
        assert np.abs(unproject(cam, centre, uv, depth) - pts).max() < 1e-6
