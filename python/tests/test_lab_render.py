"""The part renderer and the CLIP render-caption scorer (python/lab/render.py)."""
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

I = np.eye(4)


def red_share(img):
    return float(((img[..., 0] > 0.45) & (img[..., 1] < 0.3) & (img[..., 2] < 0.3)).mean())


def test_render_brick_has_its_colour():
    from lab.render import render
    img = render(['3001'], [4], [I], yaw=0.8)
    assert img.shape == (224, 224, 3)
    assert red_share(img) > 0.03
    assert img[0, 0].min() > 0.85  # background corner


def test_empty_and_unknown_parts_render_background():
    from lab.render import render
    for stems in ([], ['no-such-part-xyz']):
        img = render(stems, [4] * len(stems), [I] * len(stems), yaw=0.8)
        assert img.min() > 0.85


def test_tall_model_fills_the_frame():
    from lab.render import render
    poses = [np.array([[1, 0, 0, 0], [0, 1, 0, -24.0 * k], [0, 0, 1, 0], [0, 0, 0, 1]]) for k in range(40)]
    img = render(['3005'] * 40, [1] * 40, poses, yaw=0.8)
    rows = np.flatnonzero((img.min(-1) < 0.8).any(1))
    assert rows.max() - rows.min() > 0.6 * 224


def test_red_caption_prefers_red_brick():
    from lab.render import Scorer
    s = Scorer('cpu')
    t = s.text(['a red LEGO brick'])[0]
    red, blue = s.score([(['3001'], [4], [I]), (['3001'], [1], [I])], t)
    assert red > blue
    blank = s.score([([], [], [])], t)[0]
    assert np.isfinite(blank)
