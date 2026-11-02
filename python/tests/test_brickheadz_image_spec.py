"""Image -> spec colour/proportion extraction (Phase 6 groundwork)."""
import os
import sys

import pymupdf
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz.image_spec import foreground_mask, load_pixels, spec_from_image
from brickheadz.inventory import load

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
INVENTORY = os.path.join(ROOT, "tests", "fixtures", "brickheadz", "inventory.json")
LDCONFIG = os.path.join(ROOT, "public", "ldraw", "LDConfig.ldr")


def make_image(path, hair=(0, 0, 0), face=(242, 205, 55), body=(201, 26, 9)):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 120, 160), False)
    pix.set_rect(pix.irect, (255, 255, 255))  # white background

    def fill(x0, y0, x1, y1, c):
        pix.set_rect(pymupdf.IRect(x0, y0, x1, y1), c)

    fill(30, 10, 90, 42, hair)
    fill(30, 42, 90, 96, face)
    fill(30, 96, 90, 150, body)
    pix.save(str(path))


@pytest.fixture
def image(tmp_path):
    path = tmp_path / "char.png"
    make_image(path)
    return str(path)


def test_foreground_separates_subject(image):
    px = load_pixels(image)
    mask = foreground_mask(px)
    assert mask.sum() > 0
    assert mask[0, 0] == False  # corner is background


def test_spec_colours_are_in_inventory_palette(image):
    inv = load(INVENTORY)
    spec = spec_from_image(image, inv, LDCONFIG)
    used = {spec.color_hair, spec.color_head, spec.color_body, spec.color_leg, spec.color_base}
    assert used <= set(inv.colors)  # every colour is one you own


def test_spec_recovers_the_three_colours(image):
    inv = load(INVENTORY)
    spec = spec_from_image(image, inv, LDCONFIG)
    used = {spec.color_hair, spec.color_head, spec.color_body, spec.color_leg, spec.color_base}
    # black hair, yellow face, red body all present in the derived colours
    assert 0 in used and 14 in used and 4 in used


def test_hints_override(image, tmp_path):
    inv = load(INVENTORY)
    spec = spec_from_image(image, inv, LDCONFIG, hints={"hair": "cap", "eyes": "none", "head_courses": 4})
    assert spec.hair == "cap" and spec.eyes == "none" and spec.head_courses == 4
