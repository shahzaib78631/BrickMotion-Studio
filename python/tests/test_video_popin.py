"""Pop-in clips: step finding, inventory colours and the colour score."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
cv2 = pytest.importorskip("cv2")

from brickheadz import video_popin as vp  # noqa: E402

ROI = (10, 190)


def _clip() -> list[np.ndarray]:
    """Black frames; a square pops in at frames 5 and 12, then a 'turntable' moves a bar every frame."""
    frames = []
    for i in range(30):
        f = np.zeros((200, 200, 3), np.uint8)
        if i >= 5:
            f[40:80, 40:80] = (0, 0, 200)
        if i >= 12:
            f[100:140, 100:140] = (200, 0, 0)
        if i >= 20:
            x = 10 + 5 * (i - 20)
            f[150:180, x : x + 20] = (0, 200, 0)
        frames.append(f)
    return frames


def test_find_steps_finds_pops_and_turntable():
    st = vp.find_steps(_clip(), ROI)
    assert st.changes == [5, 12]
    assert st.turn_start == 20
    assert st.settled == [7, 14]


def test_find_steps_ignores_rows_outside_roi():
    frames = _clip()
    for i, f in enumerate(frames):
        f[0:8, :] = (i * 8) % 255  # caption flicker above the ROI
    assert vp.find_steps(frames, ROI).changes == [5, 12]


def test_colour_code_handles_ocr_run_on():
    names = {"medium azure": 322, "black": 0, "light bluish grey": 71}
    assert vp.colour_code("Medium AzureMedium", names) == 322
    assert vp.colour_code("Black", names) == 0
    assert vp.colour_code("", names) is None


def test_inventory_items_merges_uncoloured_rows():
    names = {"black": 0}
    rows = [{"part": "3001", "color": "Black", "qty": 2}, {"part": "3001", "color": "", "qty": 1},
            {"part": "3023", "color": None}]
    items = {(i.part, i.colour): i.qty for i in vp.inventory_items(rows, names)}
    assert items == {("3001", 0): 3, ("3023", 71): 1}


def test_colour_error_tells_black_from_white():
    dark = np.full((50, 3), 30, np.uint8)
    assert vp._chroma_err(dark, (27, 42, 52)) < vp._chroma_err(dark, (255, 255, 255))
    azure = np.tile(np.array([[220, 170, 60]], np.uint8), (50, 1))  # BGR of a shaded azure
    assert vp._chroma_err(azure, (54, 174, 191)) < vp._chroma_err(azure, (255, 255, 255))
