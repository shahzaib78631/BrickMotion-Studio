"""Two moulds of one part count as the same part when scoring: the booklet's element may name one and the
answer key the other (42120: element 2780, the key embeds 61332; both the black Technic friction pin)."""
from assembly_model.ldraw import load_library

from booklet_mpd.solver.evaluate import same_part

LIB = load_library("/Users/mac/Projects/BrickMotion-Studio/public/ldraw")


def test_the_two_friction_pin_moulds_are_one_part():
    assert same_part(LIB, "2780", "61332") and same_part(LIB, "61332", "2780")
    assert same_part(LIB, "2780", "42120 - 61332")       # the key's embedded copy


def test_other_pins_stay_apart():
    assert not same_part(LIB, "2780", "3673")             # pin without friction
