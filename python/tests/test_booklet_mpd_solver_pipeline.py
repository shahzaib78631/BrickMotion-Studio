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


def test_end_to_end_first_steps_of_grade_a_train_booklet(tmp_path):
    """Regression: 40349 (grade A, train) from the PDF, first 3 steps, scored against the answer key."""
    import pytest
    from pathlib import Path

    from booklet_mpd.solver.dataset import CACHE, ROOT
    pdf = ROOT / ".cache/instructions/arrow-catalog-100/pdf/40349-6270798.pdf"
    folder = CACHE / "extract" / "40349-6270798"
    if not pdf.exists() or not (folder / "extract.json").exists():
        pytest.skip("40349 booklet not cached")
    import json

    from assembly_model.ldraw import load_library
    from booklet_mpd.solver import pipeline
    from booklet_mpd.solver.bench import truth_model
    from booklet_mpd.solver.collide import Collider
    from booklet_mpd.solver.evaluate import aligned
    from booklet_mpd.solver.parts import element_index

    lib = load_library(str(ROOT / "public/ldraw"))
    data = json.loads((folder / "extract.json").read_text())
    run = pipeline.run(lib, pdf, data, folder, element_index(), collider=Collider(lib), max_steps=3)
    assert [len(g) for g in run.groups] == [3, 2, 5]
    _moved, exact = aligned(lib, run.model, truth_model("40349"))
    # regression guard, not a target: 5/10 on 2026-11-11; 4/10 since parts go best-shown first (2026-11-12),
    # which loses one part here but gains 3 on the four teacher-forced sets (267 vs 264)
    assert exact >= 4, exact
    out = pipeline.write(run, tmp_path / "x.mpd", "x", 0.5)
    assert out["parts"] == 10
