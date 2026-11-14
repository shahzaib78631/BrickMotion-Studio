"""Gate 1 look-alikes from real booklets: the callout matches its own parts-list entry, not the near miss
the 32-px outline / RGB colour matching picked (jumper vs tile, black pin vs red, 1x1 tile variants)."""
from pathlib import Path

import cv2
import pytest

from booklet_mpd.solver.parts import describe, similarity

D = Path(__file__).parent / "data" / "parts-detail"


def _d(name):
    return describe(cv2.imread(str(D / name))[:, :, ::-1].copy())


@pytest.mark.parametrize("case", ["40441", "42061", "75272"])
def test_callout_matches_its_own_entry(case):
    callout = _d(f"{case}-callout.png")
    true = _d(next(p.name for p in D.glob(f"{case}-true-*.png")))
    wrong = _d(next(p.name for p in D.glob(f"{case}-wrong-*.png")))
    assert similarity(callout, true) > similarity(callout, wrong)
