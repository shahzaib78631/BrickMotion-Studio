"""Geometry-first solver: support field, analytic anchoring, orientation set."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.geometric_solver import (
    STUDS_UP_ROTS,
    _iou_at,
    candidate,
    heights_update,
    score_against_truth,
    support_at,
)
from brickheadz.instruction_place import Camera, fill_polygon, fit_camera, grid_matrix, plane_hull, world_points

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")


def test_support_field():
    H: dict = {}
    heights_update(H, [(0, 0, 0), (0, 0, 2)])
    assert support_at(H, [(0, 0)]) == 3       # top plate = max(cy)+1
    assert support_at(H, [(5, 5)]) == 0        # empty column -> ground


def test_exact_pose_reproduces_silhouette():
    """The analytic geometry is exact: the true pose re-renders the mask."""
    lib = load_library(LIB)
    R = STUDS_UP_ROTS[0]
    m, _fw, _fd = grid_matrix(lib, "3001", 2, 3, -1, R)
    pts = world_points(lib, "3001", m)
    cam = fit_camera(pts, 30, 25, 256)
    u, v, _ = cam.project(pts)
    mask = np.zeros((256, 256), bool)
    fill_polygon(mask, plane_hull(np.stack([u, v], 1)))
    res = _iou_at(lib, "3001", cam, 256, mask, set(), 2, 3, -1, R)
    assert res is not None and res[0] > 0.99


def test_analytic_finds_a_high_scoring_pose():
    lib = load_library(LIB)
    R = STUDS_UP_ROTS[0]
    m, _fw, _fd = grid_matrix(lib, "3001", 2, 3, -1, R)
    pts = world_points(lib, "3001", m)
    cam = fit_camera(pts, 30, 25, 256)
    u, v, _ = cam.project(pts)
    mask = np.zeros((256, 256), bool)
    fill_polygon(mask, plane_hull(np.stack([u, v], 1)))
    target = (float(np.where(mask)[1].mean()), float(np.where(mask)[0].mean()))
    res = candidate(lib, "3001", R, target, cam, 256, {}, mask, set())
    assert res is not None and res[0] > 0.8


def test_score_is_translation_and_symmetry_invariant():
    lib = load_library(LIB)
    base = np.eye(4)
    t = [("3001", 4, base)]
    assert score_against_truth(lib, [("3001", 4, None, base, 1.0)], t)[0] == 1
    # translate the reconstruction: still a match (global translation allowed)
    moved = base.copy(); moved[:3, 3] = [100, -40, 7]
    assert score_against_truth(lib, [("3001", 4, None, moved, 1.0)], t)[0] == 1
    # wrong part -> not a match
    assert score_against_truth(lib, [("3003", 4, None, base, 1.0)], t)[0] == 0
