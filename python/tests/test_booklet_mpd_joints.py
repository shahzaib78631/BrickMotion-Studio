"""Bar/clip and hinge candidates: real joints from the synthetic shards must be among a part's candidates.

Fixture `data/joint-cases.json`: (host, new part) pairs from synthetic shard-000 whose only joint is a bar in a
clip or a hinge, with the true roll about the joint axis and slide along it. `exact` cases sit on the roll grid
(15 deg; real joints are on it 88% of the time) and must be generated exactly; the 2335 flag at 50 deg is off
the grid and must come within half a grid step.
"""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.solver.candidates import candidates
from booklet_mpd.solver.joints import ROLL_STEP, joint_candidates
from coordnet.place import same_pose

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((Path(__file__).parent / "data" / "joint-cases.json").read_text())


@pytest.fixture(scope="module")
def lib():
    return load_library(str(ROOT / "public/ldraw"))


def _pose(entry):
    p, c, m = entry
    return p.replace(".dat", ""), c, np.array(m, float)


def _angle(a, b):
    r = a[:3, :3].T @ b[:3, :3]
    return math.degrees(math.acos(np.clip((np.trace(r) - 1) / 2, -1, 1)))


@pytest.mark.parametrize("case", [c for c in CASES if c["exact"]], ids=lambda c: c["name"])
def test_a_real_joint_pose_is_a_candidate(lib, case):
    host = _pose(case["host"])
    part, _c, truth = _pose(case["part"])
    cands = candidates(lib, part, [host])
    assert any(same_pose(part, truth, np.asarray(q["matrix"], float)) for q in cands), case["name"]


def test_a_joint_off_the_roll_grid_is_within_half_a_step(lib):
    case = next(c for c in CASES if not c["exact"])
    host = _pose(case["host"])
    part, _c, truth = _pose(case["part"])
    near = [q for q in joint_candidates(part, [host]) if np.linalg.norm(q["matrix"][:3, 3] - truth[:3, 3]) < 1.0]
    assert near and min(_angle(truth, q["matrix"]) for q in near) <= ROLL_STEP / 2 + 0.01


def test_a_hinge_turned_off_the_quarter_grid_is_a_candidate(lib):
    case = next(c for c in CASES if c["name"].startswith("hinge 1x2"))
    host = _pose(case["host"])
    part, _c, truth = _pose(case["part"])
    # turn the hinge top 30 deg about the hinge axis (x through the hinge point, in the host's frame)
    pivot = host[2] @ np.array([0.0, 10.0, 0.0, 1.0])
    axis = host[2][:3, 0]
    t = math.radians(30)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    rot = np.eye(3) + math.sin(t) * k + (1 - math.cos(t)) * k @ k
    turned = np.eye(4)
    turned[:3, :3] = rot @ truth[:3, :3]
    turned[:3, 3] = rot @ (truth[:3, 3] - pivot[:3]) + pivot[:3]
    cands = candidates(lib, part, [host])
    assert any(same_pose(part, turned, np.asarray(q["matrix"], float)) for q in cands)


def test_joint_candidates_are_bounded_per_host(lib):
    host = ("3937", 0, np.eye(4))
    out = joint_candidates("3938", [host])
    assert 0 < len(out) <= 600
    assert all(q["kind"] in ("clip", "hinge") for q in out)


def test_a_part_without_joints_gets_none():
    assert joint_candidates("3001", [("3001", 4, np.eye(4))]) == []
