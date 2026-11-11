import pytest

from booklet_mpd.scale import scale_consistency, scale_ratio


def test_scale_ratio_is_page_points_per_ldraw_unit():
    fit = {"picture_extent_px": 200.0, "model_extent_ldu": 160.0}
    assert scale_ratio(fit, pts_per_px=0.5) == pytest.approx(0.625)


def test_scale_ratio_is_none_when_nothing_was_measured():
    assert scale_ratio({"picture_extent_px": None, "model_extent_ldu": None}, 0.5) is None
    assert scale_ratio({"picture_extent_px": 100.0, "model_extent_ldu": 0.0}, 0.5) is None
    assert scale_ratio({"picture_extent_px": 100.0, "model_extent_ldu": 50.0}, None) is None


def test_consistent_ratios_have_a_small_cv():
    c = scale_consistency([0.80, 0.82, 0.81, 0.83])
    assert c["n"] == 4 and c["median"] == pytest.approx(0.815) and c["cv"] < 0.02


def test_scattered_ratios_have_a_large_cv():
    assert scale_consistency([0.8, 1.2, 0.5, 0.9])["cv"] > 0.2


def test_too_few_ratios_give_no_cv_and_none_are_ignored():
    c = scale_consistency([0.8, None, 0.82])
    assert c["n"] == 2 and c["cv"] is None
    assert scale_consistency([])["median"] is None
