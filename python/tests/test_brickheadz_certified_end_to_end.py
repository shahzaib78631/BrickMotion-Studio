"""End-to-end: a small model is recovered exactly and the certificate verifies.

Builds a connected, bottom-up three-step model, renders instruction-style step
images, then runs the whole certified chain (camera recovery → segmentation →
pose domain → z3 prove → verify) and requires the truth back.
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.axonometric import recover_camera
from brickheadz.certificate import Candidate, Certificate, StepCertificate, verify, verify_step_scores, write_cert, read_cert
from brickheadz.geometric_solver import heights_update
from brickheadz.global_prove import pose_score, solve_step
from brickheadz.instruction_place import cells_of, fit_camera, grid_matrix, render_pieces, world_points
from brickheadz.new_segment import segment
from brickheadz.pose_domain import candidates

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
RED = 4
PALETTE = {RED: (196, 40, 28)}
PART = "3022"  # plate 2 x 2
SIZE = 192

# a connected bottom-up build: two on the ground, then one on top of the first
TRUTH = [
    [(0, 0, 0)],
    [(2, 0, 0)],
    [(0, 1, 0)],
]


def _box(lib, part, m):
    from brickheadz.parts import body_aabb
    return body_aabb(lib, part, m)


def test_end_to_end_recovers_the_truth_and_verifies(tmp_path):
    lib = load_library(LIB)

    steps = []
    for poses in TRUTH:
        steps.append([(PART, RED, grid_matrix(lib, PART, x, y, z, np.eye(3))[0]) for x, y, z in poses])

    # camera fitted to the whole model, then recovered from correspondences
    all_pts = np.concatenate([world_points(lib, p, m) for s in steps for p, _c, m in s])
    cam0 = fit_camera(all_pts, 30, 25, SIZE, pad=22)
    u, v, _ = cam0.project(all_pts)
    cam, cam_cert = recover_camera(all_pts, np.stack([u, v], 1))
    assert cam_cert.ok and cam_cert.residual < 1e-6

    built: list = []
    occupied: set = set()
    H: dict = {}
    cert = Certificate(name="toy", camera_cert=cam_cert.__dict__, steps=[])
    recovered: list = []

    for si, poses in enumerate(steps, 1):
        entries = [(p, PALETTE[c], m, False) for p, c, m in built]
        entries += [(p, PALETTE[c], m, True) for p, c, m in poses]
        rgb, _mask = render_pieces(lib, entries, cam, SIZE)
        seg = segment(rgb, PALETTE, [RED])

        parts = [(p, c) for p, c, _m in poses]
        cand_lists = [candidates(lib, p, c, seg, cam, SIZE, occupied, H, min_on_new=0.4) for p, c in parts]
        pre = dict(H)
        pre_aabbs = [_box(lib, p, m) for p, _c, m in built]
        res = solve_step(parts, cand_lists, pre, pre_aabbs=pre_aabbs)
        assert res.status == "optimal", f"step {si}: {res.status}"
        for pose in res.assignment:
            assert pose is not None
            built.append((PART, RED, pose.matrix))
            occupied.update(pose.cells)
            heights_update(H, pose.cells)
            recovered.append((pose.x, pose.y, pose.z))

        cert.steps.append(StepCertificate(
            step=si, parts=[{"part": p, "color": c} for p, c in parts],
            candidates=[[Candidate(q.x, q.y, q.z, list(q.R), [list(cc) for cc in q.cells],
                                   pose_score(q), float(q.on_new), float(q.iou),
                                   [list(q.aabb[0]), list(q.aabb[1])] if q.aabb else None,
                                   int(getattr(q, "blob", -1))) for q in cl] for cl in cand_lists],
            pick=list(res.picks), objective=res.objective, status=res.status, core=res.core,
            unique=res.unique, pre_tops=pre, pre_aabbs=[[list(lo), list(hi)] for lo, hi in pre_aabbs],
            camera={"yaw": cam.yaw, "pitch": cam.pitch, "scale": cam.scale, "ox": cam.ox, "oy": cam.oy},
            segmentation={"residual": seg.residual, "blobs": len(seg.blobs)},
        ))
        assert verify_step_scores(cert.steps[-1], lib, seg, cam, SIZE)["ok"]

    # the recovered model is exactly the truth
    assert recovered == [p for poses in TRUTH for p in poses]

    # the certificate verifies from its own data, and survives a round-trip
    report = verify(cert)
    assert report["ok"], report
    path = os.path.join(tmp_path, "toy.cert.json")
    write_cert(cert, path)
    assert verify(read_cert(path))["ok"]
