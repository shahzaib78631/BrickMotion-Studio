"""P4: for booklets with no parts list, candidate renders keep the part's real size (LEGO draws every callout
of a booklet at one scale), so a 1x6 plate is not the same picture as a 1x4."""
from pathlib import Path

import pytest

from booklet_mpd.solver.parts import rendered_descriptor

LDRAW = Path(__file__).resolve().parents[2] / "public/ldraw"


@pytest.fixture(scope="module")
def lib():
    from assembly_model.ldraw import load_library
    return load_library(str(LDRAW))


def test_a_longer_plate_renders_bigger(lib):
    assert rendered_descriptor(lib, "3666", 0).size > 1.3 * rendered_descriptor(lib, "3710", 0).size


def test_callout_scale_is_learnt_from_rendered_candidates(lib):
    """A callout drawn at LEGO's callout scale (~2.29 px/LDU) teaches that scale from our renders."""
    import numpy as np
    from booklet_mpd.solver.parts import size_ratio
    inv = [[rendered_descriptor(lib, p, 4)] for p in ("3001", "3003", "3666", "3710", "3020", "3004")]
    callouts = {}
    for i, entry in enumerate(inv):
        d = rendered_descriptor(lib, ("3001", "3003", "3666", "3710", "3020", "3004")[i], 4)
        d.size *= 2.29
        callouts[i] = d
    assert abs(size_ratio(callouts, inv, 0.65) - 2.29) < 0.05
