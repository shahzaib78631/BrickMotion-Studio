"""The parts list's printed counts bind the assignment: two callouts of one look-alike picture can't both
take the slightly better-matching element when the list prints it once (gate 1: 87.4% -> 88.1%)."""
import numpy as np

from booklet_mpd.solver.parts import Descriptor, assign


def _d(grey):
    m = np.zeros((32, 32), bool)
    m[8:24, 4:28] = True
    return Descriptor(m, np.array([100.0, 100.0, grey]), 1.5, 30.0)


def test_printed_counts_split_look_alikes():
    groups = {"g1": _d(100), "g2": _d(100)}
    inventory = [_d(100), _d(110)]                  # A matches a bit better than B; each printed once
    out = assign(groups, {"g1": 1, "g2": 1}, inventory, [1, 1])
    assert sorted(v[0] for v in out.values()) == [0, 1]


def test_a_picture_embedded_twice_at_one_spot_counts_once():
    """Technic PDFs embed some callout pictures twice at the same box (318 on train): one part, not two."""
    from booklet_mpd.solver.parts import step_callouts
    step = {"callout": [{"crop": "a.png", "count": 1, "box": [83.0, 44.0, 91.0, 51.0]},
                        {"crop": "b.png", "count": 2, "box": [83.1, 44.0, 91.0, 51.2]},
                        {"crop": "c.png", "count": 1, "box": [10.0, 10.0, 20.0, 20.0]}]}
    out = step_callouts(step)
    assert [ci for ci, _c in out] == [0, 2] and out[0][1]["count"] == 2
