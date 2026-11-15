"""A booklet draws a part's callout and its parts-list picture from the same render, at one fixed scale ratio.
Look-alikes that the outline, colour and lines cannot split (21065: plate 1x3 with 3 studs, 3623, and with
2 studs, 34103: 0.944 vs 0.939) differ clearly once the parts-list picture is scaled by that ratio and laid
over the callout."""
from pathlib import Path

import cv2

from booklet_mpd.solver.parts import template_score

DATA = Path(__file__).parent / "data" / "lookalike"
RATIO = 1.329      # 21065 book 1: callout size / parts-list size


def _rgb(name):
    return cv2.cvtColor(cv2.imread(str(DATA / name)), cv2.COLOR_BGR2RGB)


def test_the_callout_matches_its_own_parts_list_picture():
    for part, other in (("34103", "3623"), ("3623", "34103")):
        call = _rgb(f"callout-{part}.png")
        own, wrong = template_score(call, _rgb(f"list-{part}.png"), RATIO), template_score(call, _rgb(f"list-{other}.png"), RATIO)
        assert own > 0.85 and wrong < 0.6, (part, own, wrong)


def test_no_picture_scores_zero():
    assert template_score(None, _rgb("list-3623.png"), RATIO) == 0.0


def test_the_overlay_is_left_out_when_nothing_lies_over_the_callout():
    # a big part drawn smaller in its callout: no entry overlays well, so the shape score alone decides
    import numpy as np
    from booklet_mpd.solver.parts import assign, describe
    call, a, b = _rgb("callout-34103.png"), _rgb("list-34103.png"), _rgb("list-3623.png")
    small = cv2.resize(call, (call.shape[1] // 2, call.shape[0] // 2))      # half the callout scale
    descs = {"k": describe(call)}
    plain = assign(descs, {"k": 1}, [describe(a), describe(b)], [1, 1], RATIO)
    gated = assign(descs, {"k": 1}, [describe(a), describe(b)], [1, 1], RATIO, template=({"k": small}, [a, b]))
    assert gated["k"][1] == plain["k"][1]
