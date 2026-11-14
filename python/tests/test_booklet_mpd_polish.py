"""place.polish: after the beam, move one part at a time to the alternative that raises the completed-model
score (gate 4b: in every step where the beam lost a better-scoring layout, a single move toward the truth
raised the completed score)."""
import numpy as np

from booklet_mpd.solver.place import State, polish


def _at(x):
    m = np.eye(4)
    m[0, 3] = x
    return m


def _xs(state):
    return [round(float(m[0, 3])) for _p, _c, m in state.placed]


SLOTS = {"a": [0, 10, 20], "b": [0, 10, 20]}


def shortlist(part, colour, model):
    return [(_at(x), None) for x in SLOTS[part]]


def test_moves_parts_to_the_layout_the_completed_score_prefers():
    # completed score rewards a at 20 and b at 10; the beam handed over a at 0, b at 20
    target = {"a": 20, "b": 10}
    score = lambda model: -sum(abs(float(m[0, 3]) - target[p]) for p, _c, m in model)
    start = State([("a", 1, _at(0)), ("b", 1, _at(20))], [None, None], 0.0, {0, 1})
    out = polish([], start, shortlist, score)
    assert _xs(out) == [20, 10]


def test_never_accepts_a_move_that_collides():
    # best layout is a=20, b=0, but a at 20 collides: the best allowed one is a=10, b=0
    target = {"a": 20, "b": 0}
    score = lambda model: -sum(abs(float(m[0, 3]) - target[p]) for p, _c, m in model)
    start = State([("a", 1, _at(0)), ("b", 1, _at(20))], [None, None], 0.0, {0, 1})
    collides = lambda part, matrix, model: part == "a" and round(float(matrix[0, 3])) == 20
    out = polish([], start, shortlist, score, collides=collides)
    assert _xs(out) == [10, 0]


def test_two_parts_cannot_end_up_in_the_same_place():
    score = lambda model: sum(float(m[0, 3]) for _p, _c, m in model)        # both want x=20
    start = State([("a", 1, _at(0)), ("b", 1, _at(10))], [None, None], 0.0, {0, 1})
    out = polish([], start, shortlist, score)
    xs = _xs(out)
    assert len(set(xs)) == 2 and 20 in xs


def test_keeps_the_beam_layout_when_nothing_improves():
    score = lambda model: 0.0
    start = State([("a", 1, _at(0)), ("b", 1, _at(20))], [None, None], 0.0, {0, 1})
    assert polish([], start, shortlist, score) is start
