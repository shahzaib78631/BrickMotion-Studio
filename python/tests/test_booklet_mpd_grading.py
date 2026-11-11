from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.camera_fit import _clouds, silhouette
from booklet_mpd.consistency import visible_iou
from booklet_mpd.grading import grade_set

ROOT = Path(__file__).resolve().parents[2]
IDENT = {"booklet_total": 150, "booklet_residual": 0, "omr_residual": 0, "official_total": 150, "omr_total": 150}


def grade(**over):
    base = dict(alignment_ok=True, evidence="strong", identity=IDENT, median_iou=0.85, iou_steps=6, scale_feasible=1.0, scale_steps=6)
    base.update(over)
    return grade_set(**base)


def test_clean_set_is_grade_a():
    g = grade()
    assert g["grade"] == "A" and g["reasons"] == []


def test_failed_alignment_is_grade_c():
    assert grade(alignment_ok=False)["grade"] == "C"


def test_weak_alignment_evidence_caps_at_b():
    g = grade(evidence="weak")
    assert g["grade"] == "B" and "alignment evidence is weak" in g["reasons"]


def test_missing_printed_parts_list_caps_at_b():
    g = grade(identity=None)
    assert g["grade"] == "B" and "no printed parts list to verify identity" in g["reasons"]


def test_identity_residual_above_one_percent_is_not_a():
    g = grade(identity={**IDENT, "booklet_residual": 3})      # 2% of 150
    assert g["grade"] == "B" and any("booklet residual" in r for r in g["reasons"])


def test_identity_residual_above_five_percent_is_c():
    assert grade(identity={**IDENT, "omr_residual": 12})["grade"] == "C"


def test_omr_total_far_from_official_is_not_a():
    g = grade(identity={**IDENT, "official_total": 160})       # 6% off
    assert g["grade"] == "B" and any("official" in r for r in g["reasons"])


def test_low_or_missing_geometric_consistency_is_not_a():
    assert grade(median_iou=0.6)["grade"] == "B"
    assert grade(median_iou=None, iou_steps=0)["grade"] == "B"
    assert grade(median_iou=0.9, iou_steps=2)["grade"] == "B"   # too few steps sampled to trust


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def placed(x, y, z):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


PARTS = [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10)), ("3710", 1, placed(-20, -16, -30))]


def picture_from(mask, bg=(211, 236, 247), fg=(205, 190, 140)):
    img = np.zeros(mask.shape + (3,), np.uint8)
    img[:] = bg
    img[mask] = fg
    return img


def test_visible_iou_is_high_when_the_picture_shows_those_parts(lib):
    mask = silhouette(_clouds(lib, PARTS), 35, 35, 160)
    assert visible_iou(lib, PARTS, picture_from(mask)) > 0.9


def test_visible_iou_is_low_for_a_very_different_outline(lib):
    # IoU alone cannot separate near-identical outlines (that is the scale check's job), but it must
    # reject a clearly different aspect ratio: a long row of bricks against a compact cluster.
    row = [("3001", 4, placed(80 * i, 0, 0)) for i in range(8)]
    mask = silhouette(_clouds(lib, row), 35, 35, 160)
    assert visible_iou(lib, PARTS, picture_from(mask)) < 0.7


def rotated(parts, R):
    out = []
    for part, colour, m in parts:
        n = m.copy()
        n[:3, :3] = R @ m[:3, :3]
        n[:3, 3] = R @ m[:3, 3]
        out.append((part, colour, n))
    return out


FLIP_X_180 = np.diag([1.0, -1.0, -1.0])      # model turned upside down about a horizontal axis
TILT_X_90 = np.array([[1.0, 0, 0], [0, 0, -1], [0, 1, 0]])   # model laid on its back


def test_visible_iou_accepts_a_model_flipped_upside_down_or_on_its_back(lib):
    for R in (FLIP_X_180, TILT_X_90):
        mask = silhouette(_clouds(lib, rotated(PARTS, R)), 35, 35, 160)
        # all 24 orientations: 0.97 / 0.86 here; the version-1 vertical-turns-only check gave 0.61 / 0.57
        assert visible_iou(lib, PARTS, picture_from(mask)) > 0.8


def test_many_scale_infeasible_steps_is_not_a():
    g = grade(scale_feasible=0.5)
    assert g["grade"] == "B" and any("scale-feasible" in r for r in g["reasons"])


def test_three_quarters_feasible_is_enough_for_a():
    assert grade(scale_feasible=0.75)["grade"] == "A"


def test_unestablished_render_scale_is_not_a():
    g = grade(scale_feasible=None, scale_steps=2)
    assert g["grade"] == "B" and any("render scale not established" in r for r in g["reasons"])


def test_rules_version_is_part_of_the_protocol_identity():
    from booklet_mpd import grading, protocol
    assert grading.RULES_VERSION == 4 and protocol.PROTOCOL_VERSION == 4
