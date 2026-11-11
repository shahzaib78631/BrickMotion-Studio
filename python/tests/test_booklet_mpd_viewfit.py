from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.camera_fit import exact_silhouette
from booklet_mpd.viewfit import PITCHES, YAWS, fit_view

ROOT = Path(__file__).resolve().parents[2]
BG = (211, 236, 247)
TAN = (205, 190, 140)


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def placed(x, y, z):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


PARTS = [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10)), ("3710", 1, placed(-20, -16, -30)),
         ("3023", 2, placed(30, -16, -10))]


def picture(lib, parts, orientation, yaw, pitch):
    mask = exact_silhouette(lib, parts, orientation, yaw, pitch, 160)
    img = np.zeros(mask.shape + (3,), np.uint8)
    img[:] = BG
    img[mask] = TAN
    return img


def test_the_search_range_covers_steeper_views_than_the_old_fixed_camera():
    assert min(YAWS) <= 5 and max(YAWS) >= 80 and min(PITCHES) <= 20 and max(PITCHES) >= 65


def test_recovers_a_steep_view_the_fixed_camera_would_miss(lib):
    img = picture(lib, PARTS, np.eye(3), 65, 65)
    r = fit_view(lib, PARTS, img)
    assert r["iou"] > 0.9 and abs(r["yaw"] - 65) <= 5 and abs(r["pitch"] - 65) <= 5


def test_recovers_a_flipped_model_at_a_nonstandard_camera(lib):
    flip = np.diag([1.0, -1.0, -1.0])
    img = picture(lib, PARTS, flip, 50, 35)
    r = fit_view(lib, PARTS, img)
    assert r["iou"] > 0.9


def test_exact_refinement_helps_for_a_concave_part(lib):
    clips = [("60470a", 4, np.eye(4)), ("3020", 4, placed(0, 8, 0))]
    img = picture(lib, clips, np.eye(3), 35, 35)
    r = fit_view(lib, clips, img)
    assert r["iou"] >= r["hull_iou"] and r["iou"] > 0.93


def test_wrong_parts_score_low(lib):
    other = [("3001", 4, placed(0, 0, 0)), ("3001", 4, placed(0, -24, 0)), ("3001", 4, placed(0, -48, 0)), ("3001", 4, placed(0, -72, 0))]
    img = picture(lib, other, np.eye(3), 35, 35)
    assert fit_view(lib, PARTS, img)["iou"] < 0.85


def test_empty_inputs_give_zero(lib):
    assert fit_view(lib, [], picture(lib, PARTS, np.eye(3), 35, 35))["iou"] == 0.0
    blank = np.zeros((100, 100, 3), np.uint8)
    blank[:] = BG
    assert fit_view(lib, PARTS, blank)["iou"] == 0.0


def test_fit_reports_the_picture_and_model_extents_so_scale_can_be_checked(lib):
    from booklet_mpd.camera_fit import _clouds
    from brickheadz.instruction_place import rotation
    img = picture(lib, PARTS, np.eye(3), 35, 35)           # silhouette framed to 148 px (160 - 12)
    r = fit_view(lib, PARTS, img)
    pts = np.concatenate(_clouds(lib, PARTS)) @ rotation(35, 35).T
    true_extent = float(np.ptp(pts[:, :2], axis=0).max())
    assert r["model_extent_ldu"] == pytest.approx(true_extent, rel=0.08)
    assert r["picture_extent_px"] == pytest.approx(148, rel=0.04)
    assert r["picture_extent_px"] / r["model_extent_ldu"] == pytest.approx(148 / true_extent, rel=0.1)


def two_copies(lib, small_size=56):
    """One picture holding the same model twice: a large copy and a small one (a 'tiny blob')."""
    big = exact_silhouette(lib, PARTS, np.eye(3), 35, 35, 160)
    small = exact_silhouette(lib, PARTS, np.eye(3), 35, 35, small_size)
    canvas = np.zeros((160, 160 + small_size + 20), bool)
    canvas[:, :160] = big
    canvas[:small_size, 170:170 + small_size] = small
    img = np.zeros(canvas.shape + (3,), np.uint8)
    img[:] = BG
    img[canvas] = TAN
    return img


def pts_per_px_for(lib, prior):
    """page points per pixel that make the large copy (148 px) sit exactly at scale `prior` pts/LDU."""
    from booklet_mpd.camera_fit import _clouds
    from brickheadz.instruction_place import rotation
    pts = np.concatenate(_clouds(lib, PARTS)) @ rotation(35, 35).T
    return prior * float(np.ptp(pts[:, :2], axis=0).max()) / 148


def test_scale_prior_selects_the_large_copy(lib):
    img = two_copies(lib)
    r = fit_view(lib, PARTS, img, pts_per_px=pts_per_px_for(lib, 0.8), scale_prior=0.8)
    assert r["feasible"] and r["iou"] > 0.9 and r["picture_extent_px"] == pytest.approx(148, rel=0.05)


def test_scale_prior_selects_the_small_copy_when_that_is_the_expected_size(lib):
    img = two_copies(lib)
    # with this pts/px the small copy (about 44 px) is the one at 0.8 pts/LDU
    r = fit_view(lib, PARTS, img, pts_per_px=pts_per_px_for(lib, 0.8) * 148 / 44, scale_prior=0.8)
    assert r["feasible"] and r["picture_extent_px"] < 60


def test_no_candidate_at_the_expected_scale_is_infeasible_not_a_good_score(lib):
    img = picture(lib, PARTS, np.eye(3), 35, 35)
    r = fit_view(lib, PARTS, img, pts_per_px=pts_per_px_for(lib, 0.8), scale_prior=0.4)
    assert r["feasible"] is False and r["iou"] == 0.0 and r["unconstrained_iou"] > 0.9


def test_without_a_prior_the_fit_is_unconstrained_and_feasible(lib):
    r = fit_view(lib, PARTS, picture(lib, PARTS, np.eye(3), 35, 35))
    assert r["feasible"] is True and r["iou"] > 0.9
