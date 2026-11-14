"""place.polish: after the beam, move one group at a time (a part, or a sub-build unit copy as a whole) to
the alternative that raises the completed-model score (gate 4b: in every step where the beam lost a
better-scoring layout, a single move toward the truth raised the completed score)."""
import numpy as np

from booklet_mpd.solver.place import State, polish


def _at(x):
    m = np.eye(4)
    m[0, 3] = x
    return m


def _xs(state):
    return [round(float(m[0, 3])) for _p, _c, m in state.placed]


SLOTS = [0, 10, 20, 30, 40]


def shortlist(entries, model):
    """Every slot for the group's first part; the rest keep their offsets (a rigid move)."""
    x0 = float(entries[0][2][0, 3])
    return [([(p, c, _at(float(m[0, 3]) - x0 + x)) for p, c, m in entries], [None] * len(entries)) for x in SLOTS]


def _score(target):
    return lambda model: -sum(abs(float(m[0, 3]) - target[p]) for p, _c, m in model)


def test_moves_parts_to_the_layout_the_completed_score_prefers():
    start = State([("a", 1, _at(0)), ("b", 1, _at(20))], [None, None], 0.0, {0, 1})
    out = polish([], start, shortlist, _score({"a": 20, "b": 10}))
    assert _xs(out) == [20, 10]


def test_never_accepts_a_move_that_collides():
    # best layout is a=20, b=0, but a at 20 collides: the best allowed one is a=10, b=0
    start = State([("a", 1, _at(0)), ("b", 1, _at(20))], [None, None], 0.0, {0, 1})
    collides = lambda part, matrix, model: part == "a" and round(float(matrix[0, 3])) == 20
    out = polish([], start, shortlist, _score({"a": 20, "b": 0}), collides=collides)
    assert _xs(out) == [10, 0]


def test_two_parts_cannot_end_up_in_the_same_place():
    score = lambda model: sum(float(m[0, 3]) for _p, _c, m in model if m[0, 3] <= 20)      # both want x=20
    start = State([("a", 1, _at(0)), ("b", 1, _at(10))], [None, None], 0.0, {0, 1})
    xs = _xs(polish([], start, shortlist, score))
    assert len(set(xs)) == 2 and 20 in xs


def test_keeps_the_beam_layout_when_nothing_improves():
    start = State([("a", 1, _at(0)), ("b", 1, _at(20))], [None, None], 0.0, {0, 1})
    assert polish([], start, shortlist, lambda model: 0.0) is start


def test_a_unit_moves_as_a_whole():
    # a unit (u1 with u2 ten LDU to its right) at 0; the picture wants it at 20 (u1) / 30 (u2)
    start = State([("u1", 1, _at(0)), ("u2", 1, _at(10)), ("c", 1, _at(40))], [None] * 3, 0.0, {0, 1, 2},
                  groups=[[0, 1], [2]])
    out = polish([], start, shortlist, _score({"u1": 20, "u2": 30, "c": 40}))
    assert _xs(out) == [20, 30, 40]


def test_a_unit_part_is_never_moved_alone():
    # only u2 is drawn elsewhere (x=40); moving it alone would break the unit, so the unit stays together
    start = State([("u1", 1, _at(0)), ("u2", 1, _at(10))], [None] * 2, 0.0, {0, 1}, groups=[[0, 1]])
    out = polish([], start, shortlist, _score({"u1": 0, "u2": 40}))
    xs = _xs(out)
    assert xs[1] - xs[0] == 10
