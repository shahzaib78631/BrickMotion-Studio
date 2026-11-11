import numpy as np

from booklet_mpd.flagged_mpd import write_flagged_mpd
from brickheadz.reconstruct import steps_from_omr


def m(x):
    out = np.eye(4)
    out[:3, 3] = (x, -8, 20)
    return out


GROUPS = [[("3020", 4, m(0)), ("3023", 15, m(40))], [("3001", 1, m(80))]]


def test_flag_precedes_low_confidence_part_and_marks_its_step(tmp_path):
    path = tmp_path / "out.mpd"
    stats = write_flagged_mpd(path, "out", GROUPS, [[0.9, 0.2], [0.8]], 0.5)
    lines = path.read_text().splitlines()
    flags = [i for i, l in enumerate(lines) if "BRICKMOTION FLAG" in l]
    assert len(flags) == 1 and lines[flags[0] + 1].endswith("3023.dat")
    assert [l for l in lines if "STEP_FLAGGED" in l] == ["0 // BRICKMOTION STEP_FLAGGED 1"]
    assert lines[0] == "0 FILE out.ldr" and lines[-1] == "0 NOFILE"
    assert stats == {"parts": 3, "flagged": 1, "steps_flagged": [1]}


def test_incomplete_marker_only_when_requested(tmp_path):
    a, b = tmp_path / "a.mpd", tmp_path / "b.mpd"
    write_flagged_mpd(a, "a", GROUPS, [[1, 1], [1]], 0.5, failed_from_step=3)
    write_flagged_mpd(b, "b", GROUPS, [[1, 1], [1]], 0.5)
    assert "0 // BRICKMOTION INCOMPLETE from step 3" in a.read_text()
    assert "INCOMPLETE" not in b.read_text()


def test_round_trips_through_steps_from_omr(tmp_path):
    path = tmp_path / "r.mpd"
    write_flagged_mpd(path, "r", GROUPS, [[0.1, 0.1], [0.1]], 0.5)
    back = steps_from_omr(str(path))
    assert [[(p, c) for p, c, _ in s] for s in back] == [[("3020", 4), ("3023", 15)], [("3001", 1)]]
    assert np.allclose(back[1][0][2], GROUPS[1][0][2])
