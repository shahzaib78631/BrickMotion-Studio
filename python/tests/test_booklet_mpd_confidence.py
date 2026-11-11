import pytest

from booklet_mpd.confidence import FEATURES, choose_threshold, confidence, cues_from_report, fit_combiner


def cue(score, margin=0.5, rms=0.1, arrow=0.0):
    return {"geometric_score": score, "margin": margin, "camera_rms_ratio": rms, "arrow_error_ratio": arrow}


def test_combiner_separates_high_and_low_scores():
    rows = [(cue(0.95), True), (cue(0.9), True), (cue(0.92), True), (cue(0.3), False), (cue(0.4), False), (cue(0.35), False)] * 4
    model = fit_combiner(rows)
    assert confidence(cue(0.93), model) > 0.8
    assert confidence(cue(0.35), model) < 0.2


def test_margin_is_one_when_no_alternative():
    report = {"camera": {"rmsPixels": 1.0, "scale": 4.0},
              "fit": {"geometricScore": 0.9, "nextDifferentBoundsScore": None, "arrowErrorPixels": 2.0}}
    c = cues_from_report(report, 4.0)
    assert c["margin"] == 1.0 and c["camera_rms_ratio"] == 0.25 and c["arrow_error_ratio"] == 0.5
    assert set(c) == set(FEATURES)


def test_margin_is_gap_to_next_alternative():
    report = {"camera": {"rmsPixels": 0, "scale": 1}, "fit": {"geometricScore": 0.9, "nextDifferentBoundsScore": 0.6}}
    assert cues_from_report(report, 1.0)["margin"] == pytest.approx(0.3)


def test_choose_threshold_meets_target():
    t = choose_threshold([(0.9, True), (0.8, True), (0.3, False)], 1.0)
    assert 0.3 < t <= 0.8


def test_choose_threshold_flags_everything_when_target_unreachable():
    assert choose_threshold([(0.9, False), (0.8, False)], 0.9) > 1.0


def test_fit_combiner_rejects_empty():
    with pytest.raises(ValueError):
        fit_combiner([])
