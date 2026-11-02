"""The procedural generator must emit structurally valid, recognisable BrickHeadz."""
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.builder import build_figure
from brickheadz.dat import load_pieces
from brickheadz.export import normalize, to_mpd, to_plan
from brickheadz.semantics import analyze
from brickheadz.spec import Spec, random_spec
from brickheadz.validate import validate

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")


@pytest.fixture(scope="module")
def lib():
    return load_library(LIB)


def generate(lib, spec):
    b = build_figure(lib, spec)
    model = normalize(b.model)
    return model, validate(model, b.cells, lib)


def test_default_spec_is_valid(lib):
    _, r = generate(lib, Spec(name="T"))
    assert r["ok"], r["problems"]
    assert r["connected"] and r["grounded"]
    assert r["pieces"] > 30


def test_mpd_roundtrip(lib, tmp_path):
    model, _ = generate(lib, Spec(name="T"))
    path = tmp_path / "t.mpd"
    path.write_text(to_mpd(model, "T"))
    assert len(load_pieces(str(path))) == len(model.pieces)


def test_generated_model_reads_as_a_brickheadz(lib, tmp_path):
    model, _ = generate(lib, Spec(name="T"))
    path = tmp_path / "t.mpd"
    path.write_text(to_mpd(model, "T"))
    a = analyze(lib, load_pieces(str(path)))
    cube = a["figures"][0]["headCube"]
    assert 3.0 <= cube["wStuds"] <= 7.0
    assert 3.0 <= cube["dStuds"] <= 7.0
    assert a["face"]["tiles"] >= 2  # two eyes


def test_plan_json_shape(lib):
    model, _ = generate(lib, Spec(name="T"))
    plan = to_plan(model, "T")
    assert plan["format"] == "brickmotion-plan" and plan["version"] == 1
    assert plan["steps"]
    pieces = [p for s in plan["steps"] for p in s["pieces"]]
    assert len(pieces) == len(model.pieces)
    assert all("part" in p and "color" in p for p in pieces)
    assert all(("rot" in p) ^ ("matrix" in p) for p in pieces)


def test_random_specs_are_all_valid(lib):
    rng = random.Random(3)
    for i in range(12):
        spec = random_spec(rng, f"r{i}")
        _, r = generate(lib, spec)
        assert r["ok"], (spec.to_dict(), r["problems"])


def test_random_spec_is_deterministic():
    assert random_spec(random.Random(5), "x").to_dict() == random_spec(random.Random(5), "x").to_dict()


def test_face_panel_arms_and_cape(lib):
    spec = Spec(name="D", head=4, body=4, body_h=9, head_courses=3, leg_h=2, color_head=2, color_face=71, trim_arm=35, prop_cape=2)
    model, r = generate(lib, spec)
    assert r["ok"], r["problems"]
    colors = {p.color for p in model.pieces}
    assert {2, 71, 35} <= colors  # hood, face panel, claws
    assert any(p.role == "head" and p.color == 71 for p in model.pieces)  # face panel on the front
    assert any(p.role == "arm" and p.color == 35 for p in model.pieces)  # trans-green claws
    assert any(p.role == "cape" for p in model.pieces)  # back cape


def test_trim_bands_and_clip(lib):
    spec = Spec(name="T", head=4, body=4, body_h=9, head_courses=3, leg_h=2, trim_collar=12, trim_belt=14, trim_clip=26, trim_center=15, trim_center_width=2)
    model, r = generate(lib, spec)
    assert r["ok"], r["problems"]
    colors = {p.color for p in model.pieces}
    assert {12, 14, 15, 26} <= colors  # collar, belt, centre stripe, hair clip
    assert any(p.role == "hair" and p.color == 26 for p in model.pieces)
