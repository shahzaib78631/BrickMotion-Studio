"""Finite pose domain: the true pose is a candidate; pruning is sound."""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz.geometric_solver import STUDS_UP_ROTS
from brickheadz.instruction_place import cells_of, fit_camera, grid_matrix, render_pieces, world_points
from brickheadz.new_segment import segment
from brickheadz.pose_domain import candidates

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")

RED, BLUE = 4, 1
PALETTE = {RED: (196, 40, 28), BLUE: (0, 85, 170)}
PART = "3020"  # plate 2 x 4
SIZE = 192


def _scene(colour=RED, x=0, y=0, z=0):
    lib = load_library(LIB)
    m, _fw, _fd = grid_matrix(lib, PART, x, y, z, STUDS_UP_ROTS[0])
    pts = world_points(lib, PART, m)
    cam = fit_camera(pts, 30, 25, SIZE, pad=20)
    rgb, _mask = render_pieces(lib, [(PART, PALETTE[colour], m, True)], cam, SIZE)
    return lib, cam, segment(rgb, PALETTE, [colour])


def _footprint(x, y, z):
    _m, fw, fd = grid_matrix(load_library(LIB), PART, x, y, z, STUDS_UP_ROTS[0])
    return [(cx, cz) for cx in range(x, x + fw) for cz in range(z, z + fd)]


def test_true_pose_is_a_candidate_with_full_coverage():
    lib, cam, seg = _scene()
    assert len(seg.blobs) == 1
    cands = candidates(lib, PART, RED, seg, cam, SIZE, set(), {})
    # the drawn outlines are not part pixels, so the exact pose covers ~0.95 of the mask
    assert any((p.x, p.y, p.z) == (0, 0, 0) and p.on_new > 0.9 for p in cands)
    assert cands[0].on_new > 0.9  # the truth ranks at the top


def test_occupied_cells_exclude_the_true_pose():
    lib, cam, seg = _scene()
    cells = set(cells_of(lib, PART, 0, 0, 0, STUDS_UP_ROTS[0])[1])
    cands = candidates(lib, PART, RED, seg, cam, SIZE, cells, {})
    assert not any((p.x, p.y, p.z) == (0, 0, 0) for p in cands)


def test_wrong_colour_yields_no_candidates():
    lib, cam, seg = _scene(colour=RED)
    assert candidates(lib, PART, BLUE, seg, cam, SIZE, set(), {}) == []


def test_height_follows_the_support_field():
    lib, cam, seg = _scene(y=2)
    H = {c: 2 for c in _footprint(0, 2, 0)}
    cands = candidates(lib, PART, RED, seg, cam, SIZE, set(), H)
    assert any((p.x, p.y, p.z) == (0, 2, 0) and p.on_new > 0.9 for p in cands)


def test_large_model_is_not_clipped_to_brickheadz_24_stud_radius():
    lib,cam,seg=_scene(x=40,z=-30)
    poses=candidates(lib,PART,RED,seg,cam,SIZE,set(),{},spread=1)
    assert any((p.x,p.y,p.z)==(40,0,-30) for p in poses)


def test_explicit_elevation_search_recovers_non_floor_pose():
    lib,cam,seg=_scene(y=7)
    poses=candidates(lib,PART,RED,seg,cam,SIZE,set(),{},height_levels=(7,),spread=1)
    assert poses and all(p.y==7 for p in poses)
    assert any((p.x,p.y,p.z)==(0,7,0) for p in poses)


def test_same_step_stack_offsets_include_combined_heights():
    from brickheadz.pose_domain import stack_offsets
    lib=load_library(LIB)
    assert stack_offsets(lib,[('3020',RED)]*3)==(0,1,2,3)
    assert stack_offsets(lib,[('3001',RED),('3020',BLUE)])==(0,1,3,4)
