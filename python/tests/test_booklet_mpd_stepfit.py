from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.camera_fit import exact_silhouette
from booklet_mpd.stepfit import fit_step, hypotheses

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


BASE = [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10))]
NEW = [("3710", 1, placed(-20, -16, -30)), ("3023", 2, placed(30, -16, -10))]
CONTEXT = [("3001", 4, placed(0, 0, 0)), ("3001", 4, placed(40, 0, 0))]


def picture(lib, parts):
    mask = exact_silhouette(lib, parts, np.eye(3), 35, 35, 160)
    img = np.zeros(mask.shape + (3,), np.uint8)
    img[:] = BG
    img[mask] = TAN
    return img


def test_hypotheses_are_before_and_after_the_step():
    h = hypotheses(BASE, CONTEXT, NEW)
    assert h["before"] == BASE and h["after"] == BASE + NEW


def test_a_submodel_with_nothing_built_uses_the_surrounding_model():
    h = hypotheses([], CONTEXT, NEW)
    assert h["before"] == CONTEXT and h["after"] == CONTEXT + NEW


def test_nothing_visible_and_no_context_has_only_the_after_state():
    h = hypotheses([], [], NEW)
    assert h["before"] == [] and h["after"] == NEW


def test_a_picture_of_the_state_before_the_step_chooses_before(lib):
    r = fit_step(lib, BASE, [], NEW, picture(lib, BASE))
    assert r["hypothesis"] == "before" and r["iou"] > 0.9


def test_a_picture_with_the_new_parts_seated_chooses_after(lib):
    r = fit_step(lib, BASE, [], NEW, picture(lib, BASE + NEW))
    assert r["hypothesis"] == "after" and r["iou"] > 0.9


def test_no_parts_at_all_gives_a_zero_infeasible_style_result(lib):
    r = fit_step(lib, [], [], [], picture(lib, BASE))
    assert r["iou"] == 0.0 and r["hypothesis"] is None
