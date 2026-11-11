import numpy as np

from booklet_mpd.solver import confidence, mepnet
from booklet_mpd.solver.pipeline import FreeRun, write

MPD = """0 FILE model.ldr
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 0 10 -24 0 1 0 0 0 1 0 0 0 1 sub.ldr
1 1 0 -48 0 1 0 0 0 1 0 0 0 1 3003.dat
0 STEP
0 NOFILE
0 FILE sub.ldr
1 16 0 0 0 1 0 0 0 1 0 0 0 1 3004.dat
0 STEP
1 2 20 0 0 0 0 1 0 1 0 -1 0 0 3005.dat
0 STEP
0 NOFILE
"""


def test_parse_mpd_steps_and_flatten_submodels():
    files = mepnet.parse_mpd(MPD)
    assert list(files) == ["model.ldr", "sub.ldr"]
    assert [len(s) for s in files["model.ldr"]] == [1, 2]
    flat = mepnet.flatten(files, "model.ldr", np.eye(4))
    assert [(p, c) for p, c, _m in flat] == [("3001", 4), ("3004", 0), ("3005", 2), ("3003", 1)]
    # the submodel's parts are moved by the reference's matrix, colour 16 inherits the reference colour
    assert np.allclose(flat[2][2][:3, 3], [30, -24, 0])


def test_confidence_fit_orders_by_margin():
    rng = np.random.default_rng(0)
    rows = []
    for _ in range(200):
        good = rng.random() < 0.5
        c = {f: rng.normal() for f in confidence.FEATURES}
        c["margin"] = abs(rng.normal(0.05 if good else 0.0, 0.01))
        rows.append((c, good))
    model = confidence.fit(rows)
    base = {f: 0.0 for f in confidence.FEATURES}
    assert confidence.predict({**base, "margin": 0.06}, model) > confidence.predict({**base, "margin": 0.0}, model)


def test_write_flags_and_incomplete(tmp_path):
    m = np.eye(4)
    run = FreeRun(groups=[[("3001", 4, m)], [("3003", 1, m), ("3004", 2, m)]], confidences=[[0.9], [0.2, 0.8]],
                  failed_from=2)
    out = write(run, tmp_path / "x.mpd", "x", threshold=0.5)
    text = (tmp_path / "x.mpd").read_text()
    assert out == {"parts": 3, "flagged": 1, "steps_flagged": [2]}
    assert text.count("0 STEP") == 2 and "INCOMPLETE from step 2" in text
