"""Path-A reconstruct: exact OMR assembly, and honest image-mode proposals."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz import reconstruct as R
from brickheadz.image_spec import ldconfig_rgb

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
LDCONFIG = os.path.join(LIB, "LDConfig.ldr")

MPD = """0 FILE x
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 1 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat
1 2 0 20 0 1 0 0 0 1 0 0 0 1 3004.dat
0 NOFILE
"""


def test_steps_from_omr():
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".mpd", delete=False) as f:
        f.write(MPD)
        path = f.name
    steps = R.steps_from_omr(path)
    assert len(steps) == 2
    assert steps[0][0][0] == "3001"
    assert len(steps[1]) == 2


def test_from_omr_is_trusted(tmp_path):
    mpd = tmp_path / "m.mpd"
    mpd.write_text(MPD)
    report = R.from_omr(str(mpd), str(tmp_path), "Unit")
    assert report["trusted"] is True
    assert report["steps"] == 2 and report["pieces"] == 3
    assert (tmp_path / "Unit.mpd").exists()
    assert (tmp_path / "Unit.plan.json").exists()


def _save_png(rgb, path):
    import pymupdf

    arr = np.clip(rgb, 0, 255).astype(np.uint8)
    h, w = arr.shape[:2]
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w, h), False)
    pix.samples_mv[:] = arr.tobytes()
    pix.save(path)


def test_propose_gates_by_confidence(tmp_path):
    from brickheadz.instruction_place import CUBE_ROTATIONS, fit_camera, grid_matrix, render_pieces, world_points

    lib = load_library(LIB)
    palette = ldconfig_rgb(LDCONFIG)
    m, _, _ = grid_matrix(lib, "3001", 0, 0, 0, CUBE_ROTATIONS[0])
    cam = fit_camera(world_points(lib, "3001", m), 30, 25, 128)
    rgb, _ = render_pieces(lib, [("3001", palette[4], m, True)], cam, 128)
    img = tmp_path / "s.png"
    _save_png(rgb, str(img))
    spec = {
        "cam": {"yaw": cam.yaw, "pitch": cam.pitch, "scale": cam.scale, "ox": cam.ox, "oy": cam.oy},
        "steps": [{"image": str(img), "parts": [["3001", 4]]}],
    }
    strict = R.propose(lib, palette, spec, str(tmp_path / "a"), "t", min_confidence=1.01)
    assert strict["summary"]["committed"] == 0
    assert strict["summary"]["total"] == 1
    assert strict["trusted"] is False
    loose = R.propose(lib, palette, spec, str(tmp_path / "b"), "t", min_confidence=0.0)
    assert loose["summary"]["committed"] == 1
    assert (tmp_path / "b" / "t.committed.mpd").exists()
