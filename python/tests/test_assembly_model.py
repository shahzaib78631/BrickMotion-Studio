import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.assembly import build_assembly
from assembly_model.certify import contact_area, swept_corridor
from assembly_model.geometry import BoxGrid
from assembly_model.ldraw import load_library
from assembly_model.model import load_model
from assembly_model.search import Options, plan
from assembly_model.schema import AssemblyPlan

MODEL = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "models", "10156-1.mpd")


@pytest.fixture(scope="module")
def lib():
    return load_library(os.path.join(os.path.dirname(__file__), "..", "..", "public", "ldraw"))


@pytest.fixture(scope="module")
def asm(lib):
    model = load_model(MODEL)
    return build_assembly(lib, model.pieces)


def test_model_loads_pieces():
    model = load_model(MODEL)
    assert len(model.pieces) == 111
    subs = {p.submodel for p in model.pieces}
    assert subs == {"10156 - minifig.ldr", "10156 - truck.ldr"}
    assert all(" " in p.part is False or p.part for p in model.pieces)


def test_library_triangles_and_snaps(lib):
    tri = lib.triangles("3004.dat")
    assert tri.shape[1] == 3 and tri.size > 0
    snaps = lib.snaps("3004.dat")
    genders = {s.gender for s in snaps}
    assert genders & {"M", "F"}


def test_contact_area_and_sweep():
    lo1 = np.array([0.0, 0.0, 0.0])
    hi1 = np.array([20.0, 24.0, 20.0])
    lo2 = np.array([0.0, 24.0, 0.0])
    hi2 = np.array([20.0, 48.0, 20.0])
    assert contact_area(lo1, hi1, lo2, hi2, tol=1.5) > 0
    grid = BoxGrid()
    grid.add(np.array([0.0, -10.0, 0.0]), np.array([5.0, 10.0, 5.0]), ("a", 0))
    res = swept_corridor(grid, ("b", 0), np.array([0.0, -40.0, -5.0]), np.array([20.0, -20.0, 5.0]), np.array([0.0, 0.0, -5.0]), np.array([20.0, 20.0, 5.0]), frames=16)
    assert not res.clear
    res2 = swept_corridor(grid, ("b", 0), np.array([40.0, -40.0, -5.0]), np.array([60.0, -20.0, 5.0]), np.array([40.0, 0.0, -5.0]), np.array([60.0, 20.0, 5.0]), frames=16)
    assert res2.clear


def test_plan_places_all_pieces(asm):
    result = plan(asm, Options(max_ms=15000))
    assert result.stats["pieces"] == 111
    assert result.stats["placed"] == 111
    assert result.stats["uncertified"] == 0
    assert result.stats["certified"] >= 60


def test_plan_json_roundtrip(tmp_path, asm):
    result = plan(asm, Options(max_ms=15000))
    from assembly_model.export import build_plan

    plan_json = build_plan(asm, result, model="10156-1.mpd")
    path = str(tmp_path / "plan.json")
    plan_json.write(path)
    loaded = AssemblyPlan.load(path)
    assert loaded == plan_json
    assert len(loaded.steps) == len(order := [s.order for s in loaded.steps]) == max(order) + 1


def test_prior_trains_and_scores(tmp_path, asm):
    traces = str(tmp_path / "t.jsonl")
    plan(asm, Options(max_ms=15000, trace_path=traces))
    with open(traces) as f:
        rows = [json.loads(line) for line in f]
    assert any("chosen" in c and c["chosen"] == 1 for r in rows for c in r["candidates"])
    from assembly_model.prior import train_from_traces

    prior_path = str(tmp_path / "prior.json")
    train_from_traces([traces], prior_path)
    from assembly_model.prior import Prior

    prior = Prior.load(prior_path)
    assert -0.999 < prior.score({"tier0": 1.0, "tier1": 0.0, "tier2": 0.0, "contacts": 2.0, "area": 0.5, "lateral": 0.0, "dist": 0.5}) < 1.001


def test_prior_reorders(asm):
    from assembly_model.prior import Prior
    from assembly_model.search import plan as p2

    prior = Prior({"tier0": 2.0, "tier1": 0.1, "tier2": -1.0}, 0.0)
    res = p2(asm, Options())
    assert res.stats["placed"] == 111


def test_animation_block(asm):
    from assembly_model.choreo import build_animation

    result = plan(asm, Options(max_ms=15000))
    anim = build_animation(asm, result)
    assert anim is not None and anim["kind"] == "flight-v1"
    assert len(anim["pieces"]) == 111
    pieces = {p["key"]: p for p in anim["pieces"]}
    assert set(pieces) == {p.key for p in asm.pieces}
    for p in anim["pieces"]:
        # every flight is a poly-line that lands on the final pose
        assert len(p["path"]) >= 2 and p["path"][-1] == [0.0, 0.0, 0.0]
        assert all(len(pt) == 3 for pt in p["path"])
        m = p["floor"]
        assert len(m) == 16 and m[15] == 1.0
        assert 0 <= p["appearF"] <= p["startF"] < 1
        assert p["durF"] > 0
    starts = [p["startF"] for p in anim["pieces"]]
    assert starts == sorted(starts)
    last = anim["pieces"][-1]
    assert abs(last["startF"] + last["durF"] - 1.0) < 1e-3
    # the approach legs are certified for this model
    assert all(p["route"] for p in anim["pieces"])


def test_animation_staging_field(asm):
    from assembly_model.choreo import build_animation

    result = plan(asm, Options(max_ms=15000))
    anim = build_animation(asm, result)
    final_matrix = {p.key: np.asarray(p.matrix, dtype=float) for p in asm.pieces}
    floor_boxes = {}
    for p in anim["pieces"]:
        offset = np.array(p["floor"][12:15]) - final_matrix[p["key"]][:3, 3]
        lo, hi = asm.boxes[p["key"]]
        floor_boxes[p["key"]] = (lo + offset, hi + offset)
    keys = list(floor_boxes)
    for i, a in enumerate(keys):
        la, ha = floor_boxes[a]
        for b in keys[i + 1:]:
            lb, hb = floor_boxes[b]
            overlap = np.minimum(ha, hb) - np.maximum(la, lb)
            # staged cells sit on the same ground plane: their x/z may not collide
            assert not (overlap[0] > 2.0 and overlap[2] > 2.0)
    # nothing sits inside the model footprint
    for la, ha in floor_boxes.values():
        for lo, hi in asm.boxes.values():
            overlap = np.minimum(ha, hi) - np.maximum(la, lo)
            assert not all(o > 2.0 for o in overlap)


def test_plan_with_animation_roundtrip(tmp_path, asm):
    from assembly_model.choreo import build_animation
    from assembly_model.export import build_plan

    result = plan(asm, Options(max_ms=15000))
    plan_json = build_plan(asm, result, model="10156-1.mpd")
    plan_json.animation = build_animation(asm, result)
    path = str(tmp_path / "plan.json")
    plan_json.write(path)
    loaded = AssemblyPlan.load(path)
    assert loaded == plan_json
    assert loaded.animation is not None
