import numpy as np
import pytest

from booklet_mpd.camera_fit import silhouette, _clouds
from booklet_mpd.consensus import consensus_camera, iou_surface, apply_consensus
from assembly_model.ldraw import load_library
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def placed(x, y, z):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


STEPS = [
    [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10))],
    [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10)), ("3710", 1, placed(-20, -16, -30))],
    [("3020", 4, placed(0, 0, 0)), ("3023", 15, placed(20, -8, 10)), ("3710", 1, placed(-20, -16, -30)),
     ("3023", 2, placed(30, -16, -10))],
]
YAWS, PITCHES = list(range(0, 360, 10)), list(range(10, 71, 10))


def surface_for(lib, parts, yaw, pitch):
    mask = silhouette(_clouds(lib, parts), yaw, pitch, 80)
    return iou_surface(_clouds(lib, parts), mask, YAWS, PITCHES, 80)


def test_surface_peaks_at_the_true_angle(lib):
    s = surface_for(lib, STEPS[1], 40, 20)
    i, j = np.unravel_index(s.argmax(), s.shape)
    assert s.shape == (len(YAWS), len(PITCHES)) and (YAWS[i], PITCHES[j]) == (40, 20) and s.max() > 0.95


def test_consensus_recovers_a_shared_base_angle_with_per_step_quarter_turns(lib):
    # the same camera (40, 20) but the model is turned by 0, 90 and 180 degrees between steps
    surfaces = [surface_for(lib, STEPS[0], 40, 20), surface_for(lib, STEPS[1], 130, 20), surface_for(lib, STEPS[2], 220, 20)]
    c = consensus_camera(surfaces, YAWS, PITCHES)
    assert (c["yaw"], c["pitch"]) == (40, 20)
    assert [s["turn"] for s in c["steps"]] == [0, 1, 2] and all(s["iou"] > 0.95 for s in c["steps"])


def test_apply_consensus_scores_a_held_out_step_with_only_the_turn_free(lib):
    c = {"yaw": 40, "pitch": 20}
    held = surface_for(lib, STEPS[2], 310, 20)  # 40 + 270
    r = apply_consensus(held, YAWS, PITCHES, c)
    assert r["turn"] == 3 and r["iou"] > 0.95


def test_consensus_requires_a_grid_that_contains_the_quarter_turns():
    with pytest.raises(ValueError):
        consensus_camera([np.zeros((3, 2))], [0, 7, 14], [10, 20])
