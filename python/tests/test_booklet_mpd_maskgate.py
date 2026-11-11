import numpy as np

from booklet_mpd.maskgate import mask_quality

BG = (211, 236, 247)
TAN = (205, 190, 140)


def canvas(h=200, w=200):
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = BG
    return img


def test_plain_model_passes():
    img = canvas()
    img[60:150, 50:150] = TAN
    q = mask_quality(img)
    assert q["passed"] and q["reasons"] == [] and 0.2 < q["area_fraction"] < 0.5 and q["solidity"] > 0.9


def test_blank_picture_fails():
    q = mask_quality(canvas())
    assert not q["passed"] and q["reasons"] == ["no foreground"]


def test_tiny_foreground_fails():
    img = canvas()
    img[100:112, 100:112] = TAN          # 0.4% of the image
    q = mask_quality(img)
    assert not q["passed"] and "foreground too small" in q["reasons"][0]


def test_picture_with_no_distinct_background_fails():
    img = canvas()
    img[:] = TAN                         # the dominant colour is read as the background
    img[0:3, 0:3] = BG
    q = mask_quality(img)
    assert not q["passed"]


def test_comb_shaped_foreground_fails_solidity():
    img = canvas()
    for x in (20, 90, 160):
        img[20:180, x:x + 14] = TAN      # three wide teeth
    img[20:40, 20:174] = TAN             # joined by a short spine
    q = mask_quality(img)
    assert not q["passed"] and any("solidity" in r for r in q["reasons"])


def test_missing_model_image_is_a_failure():
    q = mask_quality(None)
    assert not q["passed"] and q["reasons"] == ["model image not found in the PDF"]
