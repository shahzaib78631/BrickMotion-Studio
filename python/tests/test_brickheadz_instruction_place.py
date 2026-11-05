"""Math core of the instruction step-image -> 3D placement prototype."""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.builder import Placed, Model
from brickheadz.instruction_place import (
    Camera,
    calibrate,
    fill_polygon,
    foreground_mask,
    iou,
    normalise_mask,
    plane_hull,
    render,
    rotation,
)

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")


def test_rotation_is_orthonormal():
    r = rotation(30, 25)
    assert np.allclose(r @ r.T, np.eye(3), atol=1e-9)
    assert abs(np.linalg.det(r) - 1.0) < 1e-9


def test_projection_scale_and_offset():
    cam = Camera(yaw=0, pitch=0, scale=2.0, ox=10, oy=20)
    u, v, d = cam.project(np.array([[5.0, 3.0, -1.0]]))
    # yaw=pitch=0 -> u = 2*x+ox, v = -2*y+oy, depth = z
    assert u[0] == 20.0 and v[0] == 14.0 and d[0] == -1.0


def test_hull_of_square():
    pts = np.array([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]])
    poly = plane_hull(pts)
    assert len(poly) == 4  # interior point dropped


def test_fill_polygon():
    mask = np.zeros((10, 10), bool)
    fill_polygon(mask, np.array([[2, 2], [8, 2], [8, 8], [2, 8]]))
    assert mask[5, 5] and not mask[0, 0]
    assert mask.sum() > 20


def test_render_and_iou():
    lib = load_library(LIB)
    m = Model("x")
    m.pieces = [
        Placed("3001", 4, np.eye(4), "x", (0, 0, 0, 0), True),
        Placed("3003", 2, np.array([[1, 0, 0, 0], [0, 1, 0, -24], [0, 0, 1, 0], [0, 0, 0, 1]], float), "x", None, True),
    ]
    mask, _, _ = render(lib, m.pieces, Camera(30, 25), 64)
    assert mask.sum() > 0
    assert iou(mask, mask) == 1.0
    assert iou(mask, ~mask) == 0.0


def test_normalise_mask_shape():
    mask = np.zeros((20, 30), bool)
    mask[5:15, 10:20] = True
    n = normalise_mask(mask, 16)
    assert n.shape == (16, 16) and n.sum() > 0


def test_grid_matrix_matches_studio_convention():
    from brickheadz.builder import _grid_matrix, rot_matrix
    from brickheadz.instruction_place import grid_matrix
    from brickheadz.parts import info

    lib = load_library(LIB)
    a, _, _ = grid_matrix(lib, "3001", 2, 3, -1, rot_matrix(0))
    b, _, _ = _grid_matrix(info(lib, "3001"), 2, 3, -1, 0)
    assert np.allclose(a, b)


def test_solve_xz_recovers_pose():
    from brickheadz.instruction_place import CUBE_ROTATIONS, grid_matrix, solve_xz, world_points

    lib = load_library(LIB)
    cam = Camera(30, 25, 2.0, 60.0, 60.0)
    R = CUBE_ROTATIONS[0]
    m, _, _ = grid_matrix(lib, "3001", 2, 3, -1, R)
    u, v, _ = cam.project(world_points(lib, "3001", m))
    sx, sz = solve_xz(lib, "3001", cam, (u.mean(), v.mean()), 3, R)
    assert abs(sx - 2) < 0.01 and abs(sz - (-1)) < 0.01


def test_components_splits_blobs():
    from brickheadz.instruction_place import components

    mask = np.zeros((20, 20), bool)
    mask[2:6, 2:6] = True
    mask[12:18, 12:18] = True
    comps = components(mask)
    assert len(comps) == 2
    assert int(comps[0].sum()) == 36  # largest first


def test_colour_mask_selects_colour():
    from brickheadz.instruction_place import colour_mask

    rgb = np.zeros((8, 8, 3), float)
    rgb[:, :] = (211, 236, 247)  # background
    rgb[2:5, 2:5] = (4, 100, 60)  # a saturated green
    m = colour_mask(rgb, (4, 100, 60))
    assert m.sum() == 9
    assert not m[0, 0]
