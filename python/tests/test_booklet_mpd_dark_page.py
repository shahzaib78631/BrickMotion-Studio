"""Parts reading on dark booklet pages (75277, 21036 draw on near-black): the page is background, not
ink, so the piece's mask and colour come from the piece alone."""
from pathlib import Path

import cv2

from booklet_mpd.solver.parts import describe, similarity

D = Path(__file__).parent / "data" / "dark-page"


def _d(name):
    return describe(cv2.imread(str(D / name))[:, :, ::-1].copy())


def test_the_dark_page_is_not_part_of_the_piece():
    d = _d("callout-3666-378.png")
    assert d.colour.max() > 80          # sand green, not the near-black page


def test_sand_green_callout_matches_sand_green_list_entry():
    callout = _d("callout-3666-378.png")
    assert similarity(callout, _d("list-3666-378.png")) > similarity(callout, _d("list-3666-71.png"))
