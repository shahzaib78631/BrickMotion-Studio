from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.camera_fit import fit_camera_to_mask, pieces_from
from brickheadz.instruction_place import Camera, render

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def placed(x, y, z):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


# an asymmetric stack: different plates at different heights and offsets
PARTS = [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10)),
         ("3710", 1, placed(-20, -16, -30)), ("3023", 2, placed(30, -16, -10))]


def test_fit_recovers_a_known_camera_angle(lib):
    mask, _, _ = render(lib, pieces_from(PARTS), Camera(40, 20), 96)
    best = fit_camera_to_mask(lib, PARTS, mask, yaws=range(0, 91, 10), pitches=range(0, 61, 10), size=96)
    assert best["iou"] > 0.9
    assert abs(best["yaw"] - 40) <= 6 and abs(best["pitch"] - 20) <= 6


def test_fit_reports_low_iou_for_an_unrelated_mask(lib):
    junk = np.zeros((120, 120), bool)
    junk[10:110, 55:65] = True  # a thin vertical bar no assembly resembles
    best = fit_camera_to_mask(lib, PARTS, junk, yaws=range(0, 91, 30), pitches=range(0, 61, 30), size=64)
    assert best["iou"] < 0.5


def test_pieces_from_wraps_parts_for_the_renderer():
    p = pieces_from(PARTS)[0]
    assert (p.base_part, p.color) == ("3020", 4) and p.matrix.shape == (4, 4)
