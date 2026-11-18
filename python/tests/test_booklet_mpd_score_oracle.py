"""Gate 4s: is the whole-model score itself right? With the true camera, the true layout of a step should
outscore every layout that moves one new part to another candidate pose. Where a single move beats the truth,
no search can find the truth; the score has to change first."""
import numpy as np

from booklet_mpd.gates import one_move_check


def _at(x):
    m = np.eye(4)
    m[0, 3] = x
    return m


def test_counts_the_moves_that_beat_the_true_layout():
    base = [("b", 1, _at(0))]
    truth = [("p", 1, _at(20)), ("q", 1, _at(40))]
    alternatives = {0: [_at(60), _at(80)], 1: [_at(100)]}
    score = lambda model: -sum(abs(float(m[0, 3]) - {"b": 0, "p": 60, "q": 40}[n]) for n, _c, m in model)
    r = one_move_check(score, base, truth, alternatives)
    assert r["beaten"] == [2, 0]                   # p at 60 or 80 beats its truth at 20; nothing beats q
    assert r["truth_best"] is False
    assert r["margin"][0] > 0 and r["margin"][1] < 0


def test_the_true_pose_among_the_alternatives_is_not_counted():
    base = [("b", 1, _at(0))]
    truth = [("p", 1, _at(20))]
    r = one_move_check(lambda model: 0.0, base, truth, {0: [_at(20)]})
    assert r["beaten"] == [0] and r["truth_best"] is True
