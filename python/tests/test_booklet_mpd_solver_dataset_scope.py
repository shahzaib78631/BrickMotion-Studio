"""Which parts a booklet step's picture shows when the answer key is one flat model (truth_mode "lump").

40348: steps 34-40 build a display base on its own; the answer key has the clown standing on it, so its parts
mate with the clown's, yet the pictures show the base alone. A step whose new parts connect to nothing built
so far starts a sub-build; steps that keep connecting to it stay in it; a step that connects only to the older
model goes back to it.
"""
import numpy as np

from booklet_mpd.solver.dataset import picture_scope


def _at(x, y, z):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


BRICK, PLATE = "3001", "3020"          # 2x4 brick (24 LDU), 2x4 plate (8 LDU)
CLOWN = [(BRICK, 4, _at(0, 0, 0)), (BRICK, 4, _at(0, -24, 0))]              # stacked on the first
BASE1 = [(PLATE, 2, _at(200, 0, 0))]                                       # far away, touches nothing
BASE2 = [(PLATE, 2, _at(200, -8, 0))]                                      # on BASE1
BRIDGE = [(PLATE, 2, _at(100, 0, 0))]                                      # (no contact either side)
TOP = [(BRICK, 4, _at(0, -48, 0))]                                         # back on the clown


def _keys(parts):
    return {(p, c, tuple(np.round(np.asarray(m)[:3, 3]).astype(int))) for p, c, m in parts}


def test_a_step_that_connects_to_nothing_starts_a_sub_build_shown_alone():
    steps = [(CLOWN[:1], CLOWN[1:]), (CLOWN, BASE1), (CLOWN + BASE1, BASE2)]
    scope = picture_scope(steps)
    assert _keys(scope[0]) == _keys(CLOWN[:1])            # main model: everything built so far
    assert scope[1] == []                                 # the base's first part: nothing else is drawn
    assert _keys(scope[2]) == _keys(BASE1)                # the base so far, not the clown


def test_going_back_to_the_older_model_shows_everything_again():
    steps = [(CLOWN[:1], CLOWN[1:]), (CLOWN, BASE1), (CLOWN + BASE1, BASE2), (CLOWN + BASE1 + BASE2, TOP)]
    scope = picture_scope(steps)
    assert _keys(scope[3]) == _keys(CLOWN + BASE1 + BASE2)


def test_a_flat_model_built_in_one_piece_is_unchanged():
    steps = [(CLOWN[:1], CLOWN[1:]), (CLOWN, TOP)]
    assert [_keys(s) for s in picture_scope(steps)] == [_keys(CLOWN[:1]), _keys(CLOWN)]
