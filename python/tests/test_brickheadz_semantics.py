"""Semantic decomposition against real BrickHeadz geometry (committed fixtures)."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.dat import load_pieces
from brickheadz.semantics import analyze

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
BATMAN = os.path.join(HERE, "..", "..", "40859-batman.mpd")
TRUCK = os.path.join(HERE, "..", "..", "tests", "fixtures", "models", "10156-1.mpd")


@pytest.fixture(scope="module")
def lib():
    return load_library(LIB)


def test_batman_decomposition(lib):
    pieces = load_pieces(BATMAN)
    assert len(pieces) > 60
    a = analyze(lib, pieces)

    assert a["figures"], "a figure should be detected"
    labels = {p["component"] for p in a["pieces"]}
    assert "head" in labels
    assert a["figures"][0]["roles"].get("head", 0) > 5
    assert a["face"]["side"] in ("+x", "-x", "+z", "-z")
    assert a["face"]["tiles"] >= 2  # Batman has eyes/brows/mouth

    cube = a["figures"][0]["headCube"]
    assert 2.0 <= cube["wStuds"] <= 12.0
    assert cube["hPlates"] > 3.0


def test_decomposition_is_deterministic(lib):
    r1 = analyze(lib, load_pieces(BATMAN))
    r2 = analyze(lib, load_pieces(BATMAN))
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


def test_non_brickheadz_does_not_crash(lib):
    # a minifig/truck model: labels may be rough, but analysis must be robust
    a = analyze(lib, load_pieces(TRUCK))
    assert a["pieces"]
    assert a["bbox"]["dims"]["hPlates"] > 0
