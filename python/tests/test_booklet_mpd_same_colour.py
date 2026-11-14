"""Gate 1 scoring: a rubber colour is the same printed colour as its plain one (OMR files use
Rubber_Black 256 for tyres; Rebrickable inventories, and so the parts reader, say Black 0)."""
from booklet_mpd.solver.evaluate import same_colour


def test_rubber_black_is_black():
    assert same_colour(256, 0) and same_colour(0, 256)


def test_different_colours_differ():
    assert not same_colour(71, 378)
    assert not same_colour(256, 71)


def test_same_code():
    assert same_colour(15, 15)
