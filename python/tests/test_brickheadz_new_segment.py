"""Segmentation: background / built / new split and per-colour blobs."""
from __future__ import annotations

import numpy as np

from brickheadz.instruction_place import BACKGROUND
from brickheadz.new_segment import chroma, nearest_palette, segment, srgb_to_lab

RED, BLUE, GREY = 4, 1, 71
PALETTE = {RED: (196, 40, 28), BLUE: (0, 85, 170), GREY: (150, 150, 150)}


def _image():
    img = np.tile(np.array(BACKGROUND, float), (60, 60, 1))
    img[10:20, 10:20] = PALETTE[RED]  # 100 px new red
    img[30:40, 30:45] = PALETTE[BLUE]  # 150 px new blue
    img[45:55, 5:20] = PALETTE[GREY]  # 150 px built grey
    return img


def test_lab_of_white_is_near_100():
    lab = srgb_to_lab(np.array([[[255, 255, 255]]], float))
    assert abs(lab[0, 0, 0] - 100.0) < 0.5
    assert chroma(lab)[0, 0] < 0.5


def test_nearest_palette_picks_the_right_code():
    lab = srgb_to_lab(np.array([[[196, 40, 28], [0, 85, 170]]], float))
    pal = srgb_to_lab(np.array([[196, 40, 28], [0, 85, 170], [150, 150, 150]], float))
    idx, dist = nearest_palette(lab[0], pal)
    assert list(idx) == [0, 1]
    assert dist.max() < 1.0


def test_segment_splits_new_built_and_background():
    seg = segment(_image(), PALETTE, [RED, BLUE])
    assert seg.new_mask.sum() == 100 + 150
    assert seg.built_mask[45:55, 5:20].all()
    assert seg.background[0, 0]
    assert seg.residual < 2.0


def test_segment_finds_two_blobs_with_the_right_colours():
    seg = segment(_image(), PALETTE, [RED, BLUE])
    assert len(seg.blobs) == 2
    assert {b.color for b in seg.blobs} == {RED, BLUE}
    biggest = seg.blobs[0]
    assert biggest.area == 150 and biggest.color == BLUE
    assert 30 <= biggest.centroid[0] <= 45 and 30 <= biggest.centroid[1] <= 40


def test_built_grey_is_not_new():
    seg = segment(_image(), PALETTE, [RED, BLUE])
    assert not seg.new_mask[45:55, 5:20].any()


def test_prior_recovers_a_grey_new_part():
    """A grey part on a grey layer has no chroma cue; the change from the prior frame does."""
    base = np.tile(np.array(BACKGROUND, float), (60, 60, 1))
    prior = base.copy()
    prior[30:45, 30:45] = (109, 110, 104)  # dark grey already built
    current = base.copy()
    current[30:45, 30:45] = (160, 163, 166)  # light grey new part on top
    palette = {71: (160, 163, 166), 0: (109, 110, 104)}

    assert segment(current, palette, [71]).new_mask.sum() == 0  # chroma alone misses it
    seg = segment(current, palette, [71], prior=prior)
    assert seg.new_mask.sum() == 225
    assert seg.blobs and seg.blobs[0].color == 71


def test_tiled_nearest_palette_matches_direct_distance():
    rng=np.random.default_rng(7)
    lab=rng.normal(size=(60,100,3))*30
    pal=rng.normal(size=(80,3))*30
    index,distance=nearest_palette(lab,pal)
    direct=np.linalg.norm(lab[:,:,None,:]-pal[None,None,:,:],axis=-1)
    assert np.array_equal(index,direct.argmin(-1))
    assert np.allclose(distance,direct.min(-1))


def test_near_black_rgb_is_converted_to_lab():
    from brickheadz.new_segment import _to_lab
    rgb=np.array([[[1.,1.,1.]]])
    assert np.allclose(_to_lab(rgb),srgb_to_lab(rgb))


def test_prior_with_different_crop_is_rejected():
    import pytest
    with pytest.raises(ValueError,match='aligned'):
        segment(_image(),PALETTE,[RED],prior=np.zeros((10,10,3)))
