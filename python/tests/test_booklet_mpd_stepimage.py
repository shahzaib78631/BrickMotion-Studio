import numpy as np

from booklet_mpd.stepimage import model_mask

BG = (211, 236, 247)
PANEL = (253, 244, 214)
TAN = (205, 190, 140)
RED = (210, 30, 50)


def canvas(h=120, w=200):
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = BG
    return img


def test_background_only_gives_empty_mask():
    assert not model_mask(canvas()).any()


def test_model_blob_is_kept():
    img = canvas()
    img[50:90, 120:180] = TAN
    m = model_mask(img)
    assert m[70, 150] and not m[10, 10]
    assert m.sum() >= 0.9 * 40 * 60


def test_callout_panel_contents_are_excluded():
    img = canvas()
    img[5:70, 5:100] = PANEL           # sub-step panel
    img[20:40, 20:60] = TAN            # sub-assembly inside the panel
    img[50:100, 130:190] = TAN         # main model outside the panel
    m = model_mask(img)
    assert not m[30, 40] and m[75, 160]


def test_red_arrows_are_removed():
    img = canvas()
    img[50:90, 120:180] = TAN
    img[10:50, 150:154] = RED          # arrow shaft above the model
    m = model_mask(img)
    assert not m[30, 152] and m[70, 150]


def test_floating_part_separate_from_the_model_is_kept():
    img = canvas()
    img[60:100, 100:160] = TAN
    img[10:25, 110:140] = TAN          # floating new part
    m = model_mask(img)
    assert m[17, 125] and m[80, 130]
