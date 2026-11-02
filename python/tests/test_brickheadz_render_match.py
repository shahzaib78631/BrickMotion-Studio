"""Render-and-match search (Phase 6 groundwork)."""
import os
import random
import sys

import numpy as np
import pymupdf
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.constrained import build_constrained
from brickheadz.dna import load_catalog
from brickheadz.image_spec import foreground_mask, ldconfig_rgb, load_pixels, spec_from_image
from brickheadz.inventory import load
from brickheadz.render_match import fit, render_front, score
from brickheadz.spec import Spec

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
LIB = os.path.join(ROOT, "public", "ldraw")
LDCONFIG = os.path.join(ROOT, "public", "ldraw", "LDConfig.ldr")
CATALOG = os.path.join(ROOT, "public", "data", "catalog.json")
INVENTORY = os.path.join(ROOT, "tests", "fixtures", "brickheadz", "inventory.json")


@pytest.fixture(scope="module")
def lib():
    return load_library(LIB)


@pytest.fixture(scope="module")
def env():
    inv = load(INVENTORY)
    cat = load_catalog(CATALOG)
    return inv, cat


def make_image(path):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 120, 160), False)
    pix.set_rect(pix.irect, (255, 255, 255))
    for box, c in (((30, 10, 90, 42), (0, 0, 0)), ((30, 42, 90, 96), (242, 205, 55)), ((30, 96, 90, 150), (201, 26, 9))):
        pix.set_rect(pymupdf.IRect(*box), c)
    pix.save(str(path))
    return str(path)


def test_render_front_is_nonempty(lib, env):
    inv, cat = env
    b, _ = build_constrained(lib, Spec(name="R", head=4, body=4, body_h=12, head_courses=3, leg_h=2), inv, None, random.Random(0), cat)
    img, mask = render_front(lib, b, ldconfig_rgb(LDCONFIG))
    assert img is not None and mask.sum() > 0


def test_identity_score_is_near_zero(lib, env):
    inv, cat = env
    b, _ = build_constrained(lib, Spec(name="R", head=4, body=4, body_h=12, head_courses=3, leg_h=2), inv, None, random.Random(0), cat)
    rgb = ldconfig_rgb(LDCONFIG)
    img, mask = render_front(lib, b, rgb)
    assert score(img, mask, img, mask, inv.palette(), rgb) < 0.05


def test_fit_returns_a_built_candidate(lib, env, tmp_path):
    inv, cat = env
    image = make_image(tmp_path / "c.png")
    spec = spec_from_image(image, inv, LDCONFIG)
    best, info = fit(lib, spec, inv, None, image, LDCONFIG, cat, random.Random(0))
    assert best is not None
    cost, pattern, b, report = best
    assert np.isfinite(cost) and cost < 2.0
    assert report["withinInventory"]


def test_fit_prefers_a_pattern_when_available(lib, env, tmp_path):
    inv, cat = env
    if not os.path.exists(os.path.join(ROOT, ".cache", "brickheadz", "patterns.json")):
        pytest.skip("pattern library not built")
    from brickheadz import patterns as P

    pats = P.read(os.path.join(ROOT, ".cache", "brickheadz", "patterns.json"))
    image = make_image(tmp_path / "c.png")
    spec = spec_from_image(image, inv, LDCONFIG)
    best, info = fit(lib, spec, inv, pats, image, LDCONFIG, cat, random.Random(0))
    assert best is not None and info["candidates"] > 1
