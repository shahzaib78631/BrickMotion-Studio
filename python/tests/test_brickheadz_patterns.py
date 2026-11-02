"""Phase-4 pattern learning and recombination."""
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz import patterns as patterns_mod
from brickheadz.builder import build_figure
from brickheadz.recombine import build_recombined, repair_placed
from brickheadz.schema import read_jsonl
from brickheadz.spec import Spec
from brickheadz.validate import validate

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
RECORDS = os.path.join(HERE, "..", "..", ".cache", "brickheadz", "records.jsonl")


@pytest.fixture(scope="module")
def lib():
    return load_library(LIB)


@pytest.fixture(scope="module")
def pats():
    if not os.path.exists(RECORDS):
        pytest.skip("corpus records not built")
    return patterns_mod.extract(read_jsonl(RECORDS))


def test_extracts_hair_patterns(pats):
    assert len(pats["hair"]) >= 10
    p = pats["hair"][0]
    assert p["role"] == "hair"
    assert p["pieces"] and all("part" in piece and "matrix" in piece for piece in p["pieces"])
    assert len(p["pieces"][0]["matrix"]) == 16


def test_records_are_head_local(pats):
    # offsets are relative to the head, so they stay small vs. a raw world matrix
    assert any(abs(max(abs(v) for v in piece["matrix"])) <= 60 for pattern in pats["hair"] for piece in pattern["pieces"])


def test_recombine_places_hair(pats, lib):
    from dataclasses import replace

    spec = Spec(name="T", head=4, body=4, body_h=12, head_courses=3, leg_h=2)
    bare = build_figure(lib, replace(spec, hair="none"))
    cast = build_recombined(lib, spec, pats, random.Random(0))
    assert len(cast.model.pieces) >= len(bare.model.pieces)
    # across a few draws the learned headwear appears and survives repair
    assert any(any(p.role == "hair" for p in build_recombined(lib, spec, pats, random.Random(s)).model.pieces) for s in range(8))


def test_recombined_is_grid_valid(pats, lib):
    spec = Spec(name="T", head=4, body=4, body_h=12, head_courses=3, leg_h=2)
    cast = build_recombined(lib, spec, pats, random.Random(1))
    report = validate(cast.model, cast.cells, lib)
    assert report["ok"], report["problems"]


def test_recombined_is_deterministic(pats, lib):
    spec = Spec(name="T", head=4, body=4, body_h=12, head_courses=3, leg_h=2)
    a = [p.part for p in build_recombined(lib, spec, pats, random.Random(5)).model.pieces]
    b = [p.part for p in build_recombined(lib, spec, pats, random.Random(5)).model.pieces]
    assert a == b


def test_missing_patterns_fall_back(pats, lib):
    # a 6-wide head has no learned patterns -> procedural base still builds
    spec = Spec(name="T", head=6, body=4, body_h=9, head_courses=3, leg_h=2)
    cast = build_recombined(lib, spec, pats, random.Random(0))
    assert validate(cast.model, cast.cells, lib)["ok"]
