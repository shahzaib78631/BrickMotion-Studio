"""Motion blobs: a part dropping in front of the model is found even though it touches the model's outline."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
cv2 = pytest.importorskip("cv2")

from brickheadz import video_steps as vst  # noqa: E402


def _frame(part_y: int) -> np.ndarray:
    img = np.zeros((720, 720, 3), np.uint8)
    rng = np.random.default_rng(0)
    model = rng.integers(60, 200, (40, 40, 3), dtype=np.uint8)  # textured, so flow can lock onto it
    img[200:600, 160:560] = cv2.resize(model, (400, 400), interpolation=cv2.INTER_NEAREST)
    part = np.zeros((90, 90, 3), np.uint8)
    part[:] = (30, 30, 230)
    part[::15, :] = (250, 250, 120)  # some texture on the part too
    img[part_y : part_y + 90, 300:390] = part
    return img


def test_dropping_part_over_model_is_one_motion_blob():
    a, b = _frame(300), _frame(318)  # the part drops 18 px, the model is still
    kept, _ = vst.blobs_in_frame(a, np.zeros(a.shape[:2], bool), 0)
    base, floaters = vst.split_base(kept)
    assert floaters == []  # the outline alone cannot separate it from the model
    found = vst.motion_blobs(a, b, base, floaters, 0)
    assert len(found) == 1
    x, y, w, h = found[0].bbox
    # side edges of a vertically moving part carry no vertical flow (aperture problem), so the
    # blob can sit a little inside them
    assert abs(x - 300) <= 15 and abs((x + w) - 390) <= 15
    assert found[0].motion and found[0].mask is not None and found[0].mask.shape == (h, w)
