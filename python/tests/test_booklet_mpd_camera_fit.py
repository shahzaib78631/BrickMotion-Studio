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


from booklet_mpd.camera_fit import _clouds, exact_silhouette, silhouette


def test_exact_silhouette_keeps_the_notch_of_a_non_convex_part(lib):
    clips = [("60470a", 4, np.eye(4))]           # plate with two clips: concave, its hull fills the gaps (about 12% here)
    hull = silhouette(_clouds(lib, clips), 35, 35, 160)
    exact = exact_silhouette(lib, clips, np.eye(3), 35, 35, 160)
    assert 0.8 * hull.sum() < exact.sum() < 0.93 * hull.sum()


def test_exact_silhouette_matches_the_hull_for_a_convex_part(lib):
    brick = [("3001", 4, np.eye(4))]
    hull = silhouette(_clouds(lib, brick), 35, 35, 160)
    exact = exact_silhouette(lib, brick, np.eye(3), 35, 35, 160)
    inter = (hull & exact).sum()
    assert inter / (hull | exact).sum() > 0.93


def test_exact_silhouette_applies_the_orientation(lib):
    parts = [("3020", 4, np.eye(4)), ("3023", 15, np.array([[1, 0, 0, 20], [0, 1, 0, -8], [0, 0, 1, 10], [0, 0, 0, 1.0]]))]
    flip = np.diag([1.0, -1.0, -1.0])
    a = exact_silhouette(lib, parts, flip, 35, 35, 160)
    b = exact_silhouette(lib, parts, np.eye(3), 35, 35, 160)
    assert (a ^ b).sum() > 0.05 * a.sum()
