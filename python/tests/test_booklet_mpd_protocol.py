import numpy as np
import pytest

from booklet_mpd.metrics import chamfer_distance, component_accuracy, model_accuracy
from booklet_mpd.protocol import (ProtocolError, assert_tuning_allowed, eligible, heldout_sets, protocol_hash,
                                  tuning_sets)

GRADES = [
    {"set": "S1", "split": "train", "grade": "A", "reasons": []},
    {"set": "S2", "split": "train", "grade": "B", "reasons": ["median visible IoU 0.7 < 0.8"]},
    {"set": "S3", "split": "train", "grade": "C", "reasons": []},
    {"set": "V1", "split": "validation", "grade": "B", "reasons": ["no printed parts list to verify identity"]},
    {"set": "V2", "split": "validation", "grade": "B", "reasons": ["alignment evidence is weak"]},
    {"set": "40351", "split": "test", "grade": "B", "reasons": []},
    {"set": "T1", "split": "test", "grade": "A", "reasons": []},
]


def test_eligibility_excludes_grade_c_and_weak_alignment():
    assert [eligible(r) for r in GRADES] == [True, True, False, True, False, True, True]


def test_tuning_uses_only_eligible_train_sets():
    assert tuning_sets(GRADES) == ["S1", "S2"]


def test_heldout_excludes_ineligible_and_contaminated_sets():
    assert heldout_sets(GRADES, "validation") == ["V1"]
    assert heldout_sets(GRADES, "test") == ["T1"]      # 40351 was tuned on


def test_tuning_guard_rejects_validation_and_test_sets():
    assert_tuning_allowed("S1", GRADES)
    with pytest.raises(ProtocolError, match="validation"):
        assert_tuning_allowed("V1", GRADES)
    with pytest.raises(ProtocolError):
        assert_tuning_allowed("unknown-set", GRADES)


def test_protocol_hash_is_stable_and_a_hex_digest():
    assert protocol_hash() == protocol_hash() and len(protocol_hash()) == 64


class Lib:
    def triangles(self, name):
        return np.array([[0, 0, 0], [20, 0, 0], [0, 8, 0], [0, 0, 10]], float)


def part(x):
    m = np.eye(4)
    m[:3, 3] = (x, 0, 0)
    return ("3001", 4, m)


def test_metrics_identical_prediction():
    truth = [part(0), part(40), part(80)]
    assert component_accuracy(Lib(), truth, truth) == 1.0
    assert model_accuracy(Lib(), truth, truth) == 1.0
    assert chamfer_distance(Lib(), truth, truth) == 0.0


def test_metrics_one_part_displaced():
    truth = [part(0), part(40), part(80)]
    pred = [part(0), part(40), part(100)]
    assert component_accuracy(Lib(), pred, truth) == pytest.approx(2 / 3)
    assert model_accuracy(Lib(), pred, truth) == 0.0
    assert chamfer_distance(Lib(), pred, truth) > 0.0


def test_missing_and_extra_parts_count_against_accuracy():
    truth = [part(0), part(40)]
    assert component_accuracy(Lib(), [part(0)], truth) == 0.5
    assert model_accuracy(Lib(), truth + [part(200)], truth) == 0.0
    assert component_accuracy(Lib(), [], truth) == 0.0
    assert chamfer_distance(Lib(), [], truth) == float("inf") and chamfer_distance(Lib(), [], []) == 0.0
