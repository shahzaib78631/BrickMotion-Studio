import json

from booklet_mpd.report import build_report, regressions


def write(path, data):
    path.write_text(json.dumps(data))


def fixture(tmp_path, iou_a=0.9):
    write(tmp_path / "audit.json", {"pairs": [{"set": "A1", "alignment_ok": True}, {"set": "V1", "alignment_ok": True}, {"set": "T1", "alignment_ok": False}]})
    write(tmp_path / "grades.json", [
        {"set": "A1", "split": "train", "grade": "A", "reasons": [], "median_iou": iou_a, "iou_steps": 8, "scale_feasible": 0.9, "scale_median": 0.81},
        {"set": "V1", "split": "validation", "grade": "B", "reasons": [], "median_iou": 0.7, "iou_steps": 8, "scale_feasible": 0.5, "scale_median": 0.7},
        {"set": "T1", "split": "test", "grade": "C", "reasons": [], "median_iou": None, "iou_steps": 0, "scale_feasible": None, "scale_median": None},
    ])
    write(tmp_path / "part-identity-api.json", [
        {"set": "A1", "booklet_vs_omr": {"total_a": 100, "exact": 95}, "reconcile": {"reconciled": 4}},
        {"set": "V1", "booklet_vs_omr": {"total_a": 100, "exact": 90}, "reconcile": {"reconciled": 0}}])
    write(tmp_path / "mask-gate.json", [
        {"split": "train", "passed": True}, {"split": "train", "passed": False},
        {"split": "validation", "passed": True}, {"split": "test", "passed": True}])
    return tmp_path


def test_report_aggregates_cached_stage_outputs(tmp_path):
    r = build_report(fixture(tmp_path))
    assert r["audit_usable"] == 2 and r["grade_counts"] == {"A": 1, "B": 1, "C": 1}
    assert r["identity_matched_fraction"] == (95 + 4 + 90) / 200
    assert r["mask_pass"] == {"train": 0.5, "validation": 1.0, "test": 1.0}
    assert r["tuning_median_iou"] == 0.9 and r["heldout_median_iou"] == {"validation": 0.7}
    assert len(r["protocol_hash"]) == 64
    assert r["scale_feasible_sets"] == 1 and r["scale_median_of_feasible_sets"] == 0.81


def test_report_is_deterministic(tmp_path):
    d = fixture(tmp_path)
    assert json.dumps(build_report(d), sort_keys=True) == json.dumps(build_report(d), sort_keys=True)


def test_no_regression_when_metrics_hold_or_improve():
    base = {"audit_usable": 30, "mask_pass": {"train": 0.95}, "tuning_median_iou": 0.88}
    cur = {"audit_usable": 31, "mask_pass": {"train": 0.951}, "tuning_median_iou": 0.88}
    assert regressions(base, cur) == []


def test_regression_is_reported_for_drops_beyond_tolerance():
    base = {"audit_usable": 30, "mask_pass": {"train": 0.95}, "tuning_median_iou": 0.88, "protocol_hash": "x"}
    cur = {"audit_usable": 29, "mask_pass": {"train": 0.90}, "tuning_median_iou": 0.87, "protocol_hash": "y"}
    found = regressions(base, cur)
    assert any("audit_usable" in f for f in found)
    assert any("mask_pass.train" in f for f in found)
    assert any("tuning_median_iou" in f for f in found)
    assert any("protocol_hash" in f for f in found)


def test_missing_metric_in_current_is_a_regression():
    assert any("mask_pass.validation" in f for f in regressions({"mask_pass": {"validation": 0.9}}, {"mask_pass": {}}))
