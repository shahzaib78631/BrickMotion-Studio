"""gates.joint_types: what kind of joint holds a new part to the model (from the answer key), so candidate
coverage can be reported per joint type."""
import json
from pathlib import Path

import numpy as np
import pytest

from brickheadz.connectors import build_graph, catalog, free_connectors, ry, snap_candidates
from booklet_mpd.gates import joint_types, primary

CASES = json.loads((Path(__file__).parent / "data" / "joint-cases.json").read_text())


@pytest.fixture(scope="module")
def lib():
    from assembly_model.ldraw import load_library
    return load_library(str(Path(__file__).resolve().parents[2] / "public/ldraw"))


def _at(x, y, z, yaw=0.0):
    m = ry(yaw)
    m[:3, 3] = (x, y, z)
    return m


def _on(part, host, pick):
    """A real snap pose of `part` on `host` [(id, colour, 4x4)], the first candidate `pick` accepts."""
    cat = catalog()
    names, mats = [p for p, _c, _m in host], [m for *_x, m in host]
    free = free_connectors(build_graph(names, [c for _p, c, _m in host], mats, cat), mats, cat)
    return next(c["matrix"] for c in snap_candidates(part, free, cat) if pick(c, cat, names))


def test_a_brick_on_a_brick_is_a_stud_joint(lib):
    t = joint_types(lib, "3001", _at(0, -24, 0), [("3001", 4, _at(0, 0, 0))])
    assert t == {"stud"} and primary(t) == "stud"


def test_a_brick_turned_45_degrees_on_a_stud_is_an_off_grid_rotation(lib):
    t = joint_types(lib, "3062b", _at(0, -24, 0, 45), [("3001", 4, _at(10, 0, 10))])
    assert "rotation" in t and primary(t) == "rotation"


def test_a_plate_on_a_side_stud_is_snot(lib):
    host = [("87087", 4, _at(0, 0, 0))]
    side = lambda c, cat, names: abs(c["matrix"][1, 1]) < 0.5        # its up axis is no longer vertical
    m = _on("3024", host, side)
    assert primary(joint_types(lib, "3024", m, host)) == "snot"


def test_a_hinge_top_on_its_base_is_a_hinge(lib):
    case = next(c for c in CASES if c["name"].startswith("hinge 1x2"))
    host = [(case["host"][0].replace(".dat", ""), case["host"][1], np.array(case["host"][2]))]
    t = joint_types(lib, "3938", np.array(case["part"][2]), host)
    assert "hinge" in t and primary(t) == "hinge"


def test_a_bar_in_a_clip_is_bar_clip(lib):
    case = next(c for c in CASES if "6020" in c["name"])
    host = [(case["host"][0].replace(".dat", ""), case["host"][1], np.array(case["host"][2]))]
    assert primary(joint_types(lib, "6020", np.array(case["part"][2]), host)) == "bar/clip"


def test_a_part_touching_nothing_has_no_joint(lib):
    assert primary(joint_types(lib, "3001", _at(500, 0, 0), [("3001", 4, _at(0, 0, 0))])) == "none"


def test_a_part_without_catalogue_data_is_uncatalogued(lib):
    assert catalog().connectors("4592c01") is None
    assert primary(joint_types(lib, "4592c01", _at(0, -24, 0), [("3001", 4, _at(0, 0, 0))])) == "uncatalogued"
