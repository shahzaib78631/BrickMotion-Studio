import itertools

import numpy as np

from booklet_mpd.score import calibration, exact_flags, reliability_bins

CUBE = np.array(list(itertools.product([-10, 10], repeat=3)), float)
ASYM = np.array([[0, 0, 0], [40, 0, 0], [0, 20, 0], [0, 0, 60]], float)
ROT90 = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], float)


class Lib:
    def __init__(self, pts):
        self.pts = pts

    def triangles(self, name):
        return self.pts


def mat(t=(0, 0, 0), r=np.eye(3)):
    m = np.eye(4)
    m[:3, :3] = r
    m[:3, 3] = t
    return m


def test_identical_part_is_exact():
    assert exact_flags(Lib(ASYM), [("p", 4, mat())], [("p", 4, mat())]) == [True]


def test_translated_part_is_not_exact():
    assert exact_flags(Lib(ASYM), [("p", 4, mat((20, 0, 0)))], [("p", 4, mat())]) == [False]


def test_rotated_asymmetric_part_is_not_exact():
    assert exact_flags(Lib(ASYM), [("p", 4, mat(r=ROT90))], [("p", 4, mat())]) == [False]


def test_rotated_symmetric_part_is_exact():
    assert exact_flags(Lib(CUBE), [("p", 4, mat(r=ROT90))], [("p", 4, mat())]) == [True]


def test_wrong_colour_is_not_exact():
    assert exact_flags(Lib(ASYM), [("p", 1, mat())], [("p", 4, mat())]) == [False]


def test_expected_part_claimed_once():
    got = exact_flags(Lib(ASYM), [("p", 4, mat()), ("p", 4, mat())], [("p", 4, mat())])
    assert got == [True, False]


def test_calibration_counts():
    r = calibration([(0.9, True), (0.8, False), (0.2, False), (0.1, True)], 0.5)
    assert (r["n"], r["flagged"], r["unflagged"]) == (4, 2, 2)
    assert (r["unflagged_exact"], r["flagged_exact"], r["flag_recall"]) == (0.5, 0.5, 0.5)


def test_calibration_empty_and_all_flagged_do_not_divide_by_zero():
    e = calibration([], 0.5)
    assert e["n"] == 0 and e["unflagged_exact"] is None and e["flag_recall"] is None
    f = calibration([(0.1, True), (0.2, True)], 0.5)
    assert f["unflagged_exact"] is None and f["flag_recall"] is None


def test_reliability_bins_cover_unit_interval():
    rows = [(0.05, False), (0.55, True), (0.95, True), (1.0, True)]
    bins = reliability_bins(rows, bins=10)
    assert bins[0]["lo"] == 0.0 and bins[-1]["hi"] == 1.0
    assert sum(b["n"] for b in bins) == 4
