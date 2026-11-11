from pathlib import Path

import numpy as np
import pytest

import booklet_mpd.baseline as baseline
from assembly_model.ldraw import load_library
from booklet_mpd.baseline import classify_step, error_budget, run_set

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def test_classify_supported_plate(lib):
    assert classify_step(lib, [("3020", 4)]) == "supported"
    assert classify_step(lib, [("3023", 4), ("3023", 4)]) == "supported"


def test_classify_brick_unsupported(lib):
    assert classify_step(lib, [("3001", 4)]) == "unsupported:not a plate/tile"


def test_classify_three_additions_unsupported(lib):
    assert classify_step(lib, [("3023", 4)] * 3) == "unsupported:more than two additions"


def fake_sequence(lib_, palette, steps, foundation, *, observer=None, candidate_ranker=None):
    if len(steps) >= 2:
        raise ValueError("camera")
    eye = np.eye(4)
    groups = [[(foundation[0], foundation[1], eye)] + [(p, c, eye) for p, c in steps[0]["parts"]]]
    reports = [{"step": steps[0]["number"], "camera": {"rmsPixels": 0.1, "scale": 2.0},
                "fit": {"geometricScore": 0.9, "nextDifferentBoundsScore": None, "arrowErrorPixels": 0.0}}]
    return [], groups, reports


def test_run_set_keeps_earlier_steps_when_solver_fails(lib, monkeypatch):
    monkeypatch.setattr(baseline, "reconstruct_sequence", fake_sequence)
    eye = np.eye(4)
    truth = [[("3020", 4, eye), ("3023", 4, eye)], [("3023", 4, eye)], [("3023", 4, eye)]]
    pictures = [np.zeros((8, 8, 3), np.uint8)] * 3
    r = run_set(lib, {4: (0, 0, 0)}, truth, pictures, [[0, 0], [1, 1], [2, 2]])
    assert r["first_failure"] == {"step": 2, "message": "camera"}
    assert r["steps_total"] == 3 and r["steps_supported"] == 3 and r["steps_attempted"] == 2
    assert r["parts_predicted"] == 1
    assert [p["step"] for p in r["per_part"]] == [1]
    assert r["statuses"][1] == "solver_failed" and r["statuses"][2] == "not_reached"


def test_error_budget_sums_to_one():
    b = error_budget(["placed_exact", "placed_wrong", "unsupported:x", "not_reached", "solver_failed"])
    assert abs(sum(b.values()) - 1.0) < 1e-9
    assert b["unsupported"] == 0.2


def test_identical_first_step_plates_are_a_valid_foundation(lib, monkeypatch):
    monkeypatch.setattr(baseline, "reconstruct_sequence", fake_sequence)
    eye = np.eye(4)
    r = run_set(lib, {4: (0, 0, 0)}, [[("3020", 4, eye), ("3020", 4, eye)]],
                [np.zeros((8, 8, 3), np.uint8)], [[0, 0]])
    assert r["first_failure"] is None and r["parts_predicted"] == 1


def _row(score, exact):
    return {"exact": exact, "report": {"camera": {"rmsPixels": 0.1, "scale": 2.0},
                                       "fit": {"geometricScore": score, "nextDifferentBoundsScore": None, "arrowErrorPixels": 0.0}}}


def test_calibration_lines_refuse_to_report_on_too_few_parts():
    text = "\n".join(baseline.calibration_lines([{"split": "train", "per_part": [_row(0.9, True)]}]))
    assert "too few parts to calibrate" in text


def test_calibration_lines_report_unflagged_exactness():
    train = [{"split": "train", "per_part": [_row(0.95, True)] * 20 + [_row(0.3, False)] * 20}]
    test = [{"split": "test", "per_part": [_row(0.95, True)] * 20 + [_row(0.3, False)] * 20}]
    text = "\n".join(baseline.calibration_lines(train + test))
    assert "unflagged exact" in text and "100.0%" in text


def test_group_truth_merges_omr_steps_and_drops_picture_for_merged_booklet_steps():
    eye = np.eye(4)
    truth = [[("3023", 4, eye)], [("3023", 4, eye)], [("3023", 4, eye)], [("3023", 4, eye)]]
    pics = ["p0", "p1", "p2"]
    steps, pictures = baseline.group_truth(truth, pics, [[[0], [0, 1]], [[1, 2], [2]], [[2], [3]]])
    assert [len(s) for s in steps] == [2, 1, 1]
    assert pictures == ["p0", None, "p2"]


def test_classify_unknown_part_is_unsupported_not_a_crash(lib):
    assert classify_step(lib, [("40354 - 36840", 4)]) == "unsupported:part not in library"


def test_foundation_ignores_parts_missing_from_the_library(lib, monkeypatch):
    monkeypatch.setattr(baseline, "reconstruct_sequence", fake_sequence)
    eye = np.eye(4)
    r = run_set(lib, {4: (0, 0, 0)}, [[("3020", 4, eye), ("nope - 1", 4, eye)]],
                [np.zeros((8, 8, 3), np.uint8)], [[0, 0]])
    assert r["first_failure"] is None and r["statuses"] == ["unsupported:part not in library"]


def test_group_visible_uses_the_first_omr_step_of_each_group():
    scoped = [{"visible": ["a"]}, {"visible": ["a", "b"]}, {"visible": ["x"]}]
    assert baseline.group_visible(scoped, [[[0], [0, 1]], [[1], [2]]]) == [["a"], ["x"]]


def test_group_context_uses_the_first_omr_step_of_each_group():
    scoped = [{"context": ["x"]}, {"context": []}, {"context": ["y"]}]
    assert baseline.group_context(scoped, [[[0], [0, 1]], [[1], [2]]]) == [["x"], ["y"]]
