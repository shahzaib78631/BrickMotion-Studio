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


from booklet_mpd.stepimage import largest_component


def test_largest_component_drops_the_floating_part():
    img = canvas()
    img[60:100, 100:160] = TAN
    img[10:25, 110:140] = TAN
    m = largest_component(model_mask(img))
    assert m[80, 130] and not m[17, 125]


def test_largest_component_of_empty_mask_is_empty():
    assert not largest_component(np.zeros((10, 10), bool)).any()


def test_a_red_part_is_kept_while_a_thin_red_arrow_is_removed():
    img = canvas(h=200, w=300)
    img[100:160, 150:230] = RED          # a large red brick face
    img[10:100, 180:184] = RED           # arrow shaft above it
    m = model_mask(img)
    assert m[130, 190] and not m[40, 182]


BLUE_PANEL = (176, 208, 236)


from booklet_mpd.stepimage import model_components


def test_components_separate_a_blue_panel_from_the_model_and_a_floating_part():
    img = canvas(h=240, w=400)
    img[10:130, 10:230] = BLUE_PANEL
    img[40:90, 40:100] = (40, 40, 40)   # dark sub-assembly inside the panel (own colour)
    img[140:230, 260:380] = TAN         # main model
    img[20:40, 300:340] = TAN           # floating new part
    comps = model_components(img)
    areas = sorted(int(c.sum()) for c in comps)
    assert len(comps) >= 3
    assert any(c[190, 320] and not c[60, 70] and not c[30, 320] for c in comps)  # the model alone
    assert any(c[30, 320] and not c[190, 320] for c in comps)                    # the floating part alone
    assert any(c[20, 20] for c in comps)                                          # the panel is its own component


def test_thin_details_close_to_the_model_are_kept_but_a_long_connector_is_not():
    img = canvas(h=200, w=300)
    img[80:160, 150:260] = TAN
    img[110:113, 260:264] = TAN         # a 3px-wide stub, 4px long, on the right edge
    img[118:121, 20:150] = (0, 0, 0)    # a long thin connector line reaching the model from the left
    m = model_mask(img)
    assert m[111, 262] and not m[119, 60]
