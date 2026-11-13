"""The certificate verifier: a valid proof passes, a tampered one fails."""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brickheadz.certificate import (
    Candidate,
    Certificate,
    StepCertificate,
    read_cert,
    verify,
    verify_step,
    write_cert,
)
from brickheadz.global_prove import SCALE, pose_score, solve_step
from brickheadz.pose_domain import Pose


def P(part, x, y, z, *, on_new=1.0, iou=1.0):
    return Pose(part, x, y, z, tuple(np.eye(3).ravel()), np.eye(4), ((x, z, y),), iou, on_new)


def _cert(parts, lists, pre_tops=None):
    pre_tops = pre_tops or {}
    res = solve_step(parts, lists, pre_tops)
    cands = [[Candidate(p.x, p.y, p.z, list(p.R), [list(c) for c in p.cells],
                        pose_score(p), float(p.on_new), float(p.iou),
                        None, int(getattr(p, "blob", -1))) for p in cl] for cl in lists]
    sc = StepCertificate(step=1, parts=[{"part": a, "color": b} for a, b in parts],
                         candidates=cands, pick=list(res.picks), objective=res.objective,
                         status=res.status, core=res.core, unique=res.unique, pre_tops=pre_tops)
    return sc, res


LISTS = [
    [P("3001", 0, 0, 0, on_new=0.9), P("3001", 5, 0, 0, on_new=0.3)],
    [P("3001", 0, 0, 0, on_new=0.8), P("3001", 6, 0, 0, on_new=0.2)],
]


def test_valid_certificate_verifies():
    sc, _res = _cert([("3001", 4), ("3001", 4)], LISTS)
    checks = verify_step(sc)
    assert checks == {"exactly_one": True, "disjoint_cells": True, "supported": True,
                      "objective": True, "optimal": True, "unique": True}


def test_tampered_objective_is_caught_by_consistency():
    sc, _res = _cert([("3001", 4), ("3001", 4)], LISTS)
    sc.objective += SCALE  # claim a better optimum than the picks achieve
    checks = verify_step(sc)
    assert checks["objective"] is False
    assert not all(checks.values())


def test_tampered_pick_collides():
    sc, _res = _cert([("3001", 4), ("3001", 4)], LISTS)
    sc.pick[1] = 0  # both parts on cell (0,0,0)
    checks = verify_step(sc)
    assert checks["disjoint_cells"] is False


def test_tampered_pick_floats():
    sc, _res = _cert([("3001", 4)], [[P("3001", 0, 3, 0)]])  # only an unsupported pose
    sc.pick = [0]
    sc.status = "optimal"
    sc.objective = pose_score(sc.candidates[0][0])
    assert verify_step(sc)["supported"] is False


def test_write_read_round_trip(tmp_path):
    sc, _res = _cert([("3001", 4), ("3001", 4)], LISTS)
    cert = Certificate(name="t", camera_cert={"yaw": 30, "pitch": 25}, steps=[sc])
    path = os.path.join(tmp_path, "cert.json")
    write_cert(cert, path)
    back = read_cert(path)
    assert verify(back)["ok"]
    assert back.steps[0].pick == sc.pick


LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "ldraw")
PALETTE = {4: (196, 40, 28)}


def test_score_reverification_detects_tampering():
    from assembly_model.ldraw import load_library
    from brickheadz.certificate import verify_step_scores
    from brickheadz.geometric_solver import STUDS_UP_ROTS
    from brickheadz.instruction_place import fit_camera, grid_matrix, render_pieces, world_points
    from brickheadz.new_segment import segment
    from brickheadz.pose_domain import candidates

    lib = load_library(LIB)
    m, _fw, _fd = grid_matrix(lib, "3020", 0, 0, 0, STUDS_UP_ROTS[0])
    cam = fit_camera(world_points(lib, "3020", m), 30, 25, 192, pad=20)
    rgb, _mask = render_pieces(lib, [("3020", PALETTE[4], m, True)], cam, 192)
    seg = segment(rgb, PALETTE, [4])
    cl = candidates(lib, "3020", 4, seg, cam, 192, set(), {})
    res = solve_step([("3020", 4)], [cl], {})
    cands = [[Candidate(p.x, p.y, p.z, list(p.R), [list(c) for c in p.cells], pose_score(p),
                        float(p.on_new), float(p.iou)) for p in cl]]
    sc = StepCertificate(step=1, parts=[{"part": "3020", "color": 4}], candidates=cands,
                         pick=list(res.picks), objective=res.objective, status=res.status, core=res.core)
    assert verify_step_scores(sc, lib, seg, cam, 192)["ok"]
    sc.candidates[0][0].on_new = 0.111  # forge a score
    assert not verify_step_scores(sc, lib, seg, cam, 192)["ok"]


def test_verifier_rejects_support_from_an_unchosen_candidate():
    # Piece 0 sits at y=1; the only piece that could hold it has two placements.
    # Tamper the witness to select its other, remote placement.
    lists=[[P('upper',0,1,0)], [P('base',0,0,0),P('base',5,0,0)]]
    sc,_=_cert([('upper',4),('base',4)],lists)
    sc.pick=[0,1]
    assert not verify_step(sc)['supported']
    assert not verify_step(sc)['optimal']


def test_verifier_handles_malformed_picks_without_crashing():
    sc,_=_cert([('3001',4)],[[P('3001',0,0,0)]])
    for picks in [[],[None],[999],[-1],[True],[0,0]]:
        sc.pick=picks
        assert not verify_step(sc)['exactly_one']


def test_aabb_support_uses_same_ground_rule_on_first_step():
    sc,_=_cert([('3001',4)],[[P('3001',0,0,0)]])
    sc.candidates[0][0].aabb=[[0,-24,0],[20,-16,20]]
    assert not verify_step(sc)['supported']


def test_union_coverage_certificate_roundtrip_and_tampering(tmp_path):
    lists=[[P('left',0,0,0)],[P('right',1,0,0),P('right',2,0,0,on_new=.9)]]
    coverage=[[[0,1]],[[0,1],[2,3]]]
    result=solve_step([('left',4),('right',4)],lists,{},coverage=coverage,coverage_weight=SCALE)
    sc,_=_cert([('left',4),('right',4)],lists)
    sc.pick=list(result.picks);sc.objective=result.objective
    sc.core=result.core;sc.unique=result.unique
    sc.coverage=coverage;sc.coverage_weight=SCALE
    cert=Certificate(name='coverage',camera_cert={},steps=[sc])
    path=str(tmp_path/'coverage.json');write_cert(cert,path)
    assert verify(read_cert(path))['ok']
    sc.coverage[1][1]=[0,1]
    assert not verify_step(sc)['objective']
