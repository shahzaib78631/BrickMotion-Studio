"""Inventory-constrained generation (Phase 5)."""
import csv
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.constrained import build_constrained, fill_vocab
from brickheadz.dna import load_catalog
from brickheadz.inventory import Inventory, load
from brickheadz.spec import Spec
from brickheadz.validate import validate

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
CATALOG = os.path.join(HERE, "..", "..", "public", "data", "catalog.json")
INVENTORY = os.path.join(HERE, "..", "..", "tests", "fixtures", "brickheadz", "inventory.json")


@pytest.fixture(scope="module")
def lib():
    return load_library(LIB)


@pytest.fixture(scope="module")
def catalog():
    return load_catalog(CATALOG)


@pytest.fixture(scope="module")
def inv():
    return load(INVENTORY)


def test_load_rebrickable_inventory(inv):
    assert inv.has("22885")
    assert inv.parts["22885"] >= 6
    assert inv.colors
    assert sum(inv.parts.values()) > 50


def test_load_csv(tmp_path):
    path = tmp_path / "list.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["part", "color", "quantity"])
        w.writerow(["3001", "4", "10"])
        w.writerow(["3003", "4", "6"])
    inv = load(str(path))
    assert inv.parts["3001"] == 10 and inv.parts["3003"] == 6
    assert inv.colors[4] == 16


def test_constrained_build_is_valid_and_within_inventory(inv, lib):
    spec = Spec(name="X", head=4, body=4, body_h=12, head_courses=3, leg_h=2)
    b, report = build_constrained(lib, spec, inv, None, random.Random(0))
    assert report["withinInventory"], report["overBudget"]
    assert validate(b.model, b.cells, lib)["ok"]
    used = {p.part for p in b.model.pieces}
    assert used <= set(inv.parts)  # only shapes the inventory has
    assert {p.color for p in b.model.pieces} <= set(inv.colors) | {0}


def test_constrained_adapts_to_small_inventory(lib):
    small = Inventory(parts={"22885": 6, "3003": 8, "3023": 40, "3024": 20, "4073": 2}, colors={71: 60, 0: 60})
    b, report = build_constrained(lib, Spec(name="S", head=4, body=4, body_h=12, head_courses=3, leg_h=2), small, None, random.Random(0))
    assert report["withinInventory"], report["overBudget"]
    assert validate(b.model, b.cells, lib)["ok"]
    assert report["spec"]["body_h"] < 12  # shrank to fit


def test_too_small_inventory_raises(lib):
    tiny = Inventory(parts={"3004": 2}, colors={4: 2})
    with pytest.raises(ValueError):
        build_constrained(lib, Spec(name="S", head=4, body=4), tiny, None, random.Random(0))


def test_fill_vocab_only_lists_inventory_shapes(inv, lib, catalog):
    fill, tiles = fill_vocab(lib, inv, catalog)
    assert fill and fill.get(1)  # needs at least 1-plate parts
    for parts in fill.values():
        assert all(inv.has(p) for p in parts)
    assert all(inv.has(p) for p in tiles)


def test_constrained_is_deterministic(inv, lib):
    spec = Spec(name="X", head=4, body=4, body_h=12, head_courses=3, leg_h=2)
    a = [p.part for p in build_constrained(lib, spec, inv, None, random.Random(2))[0].model.pieces]
    b = [p.part for p in build_constrained(lib, spec, inv, None, random.Random(2))[0].model.pieces]
    assert a == b
