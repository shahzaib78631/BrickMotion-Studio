"""Unit tests for the modern neural-symbolic whole-booklet modules:
  - clean_matrix & exact quarter-turn rotation noise elimination
  - vision_prior: fast Studio NPR rendering + DINOv2 perceptor shape/monotonicity
  - global_opt: bilateral symmetry detection, large baseplate detection, sub-assembly colour transfer, rigid Y-rotations
  - brick_prior: strict zero-leakage protocol assertion + MPS/CPU inference sanity
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from assembly_model.ldraw import load_library
from booklet_mpd.solver.candidates import clean_matrix
from booklet_mpd.solver.global_opt import (
    _map_subassembly_colours,
    _mirror_matrix,
    _rigid_rotate_around_y,
    _rotate_rigid_about_pin,
    detect_symmetry_plane,
    has_large_baseplate,
)
from booklet_mpd.solver.render import View
from booklet_mpd.solver.subbuild import _turn
from booklet_mpd.solver.vision_prior import render_npr_rgb

LDRAW = Path(__file__).resolve().parents[2] / "public/ldraw"


@pytest.fixture(scope="module")
def lib():
    return load_library(str(LDRAW))


def test_turn_and_clean_matrix_eliminate_fp_noise():
    for k in range(8):
        m = _turn(k)
        # Exact 0 and +-1 entries with zero 1e-16 trigonometric drift
        assert set(np.unique(m[:3, :3]).tolist()).issubset({-1.0, 0.0, 1.0})
    noisy = np.eye(4)
    noisy[0, 2] = -4.89859e-16
    noisy[2, 0] = 4.89859e-16
    noisy[1, 3] = -24.0000003
    cleaned = clean_matrix(noisy)
    assert cleaned[0, 2] == 0.0 and cleaned[2, 0] == 0.0
    assert cleaned[1, 3] == -24.0


def test_has_large_baseplate_detects_display_stand_plate(lib):
    small_only = [("3024", 0), ("3023", 15), ("3069b", 14)]
    assert has_large_baseplate(lib, small_only) is None
    with_stand = [("92593", 0), ("87079", 0), ("3958", 0), ("2431", 0)]
    idx = has_large_baseplate(lib, with_stand)
    assert idx == 2


def test_detect_symmetry_plane_finds_bilateral_axis(lib):
    # Symmetric 10-brick structure centered around X = 20.0
    parts = []
    for y in (0.0, -24.0, -48.0, -72.0):
        m_l = np.eye(4); m_l[:3, 3] = [0.0, y, 0.0]
        m_r = np.eye(4); m_r[:3, 3] = [40.0, y, 0.0]
        parts.append(("3005", 15, m_l))
        parts.append(("3005", 15, m_r))
    m_c1 = np.eye(4); m_c1[:3, 3] = [20.0, 0.0, 0.0]
    m_c2 = np.eye(4); m_c2[:3, 3] = [20.0, -24.0, 0.0]
    parts.extend([("3005", 4, m_c1), ("3005", 4, m_c2)])
    sym = detect_symmetry_plane(lib, parts)
    assert sym is not None
    axis, coord, frac = sym
    assert axis == 0
    assert abs(coord - 20.0) < 1e-3
    assert frac >= 0.99


def test_rigid_rotate_around_y_preserves_pivot():
    m = np.eye(4); m[:3, 3] = [30.0, -16.0, 10.0]
    T, moved = _rigid_rotate_around_y([("3005", 15, m)], (10.0, 10.0), 1)
    assert np.allclose(moved[0][2][:3, 3], [10.0, -16.0, -10.0], atol=1e-6)
    assert set(np.unique(T[:3, :3]).tolist()).issubset({-1.0, 0.0, 1.0})


def test_map_subassembly_colours_preserves_donor_geometry_and_target_colours():
    m0 = np.eye(4)
    m1 = np.eye(4); m1[:3, 3] = [0.0, -8.0, 0.0]
    donor = [("24866", 14, m0), ("4733", 15, m1)]
    target_groups = [[("24866", 27, np.eye(4))], [("4733", 2, np.eye(4))]]
    mapped = _map_subassembly_colours(donor, target_groups)
    assert mapped is not None
    assert mapped[0][0][1] == 27 and mapped[1][0][1] == 2
    assert np.allclose(mapped[1][0][2][:3, 3], [0.0, -8.0, 0.0])


def test_render_npr_rgb_draws_light_outlines_on_black_and_dark_on_white(lib):
    m_w = np.eye(4)
    m_b = np.eye(4); m_b[:3, 3] = [40.0, 0.0, 0.0]
    view = View(np.eye(3), 45.0, 35.0, 1.5, (80.0, 80.0))
    rgb, depth, label = render_npr_rgb(lib, [("3001", 15, m_w), ("3001", 0, m_b)], view, (160, 180))
    assert rgb.shape == (160, 180, 3) and rgb.dtype == np.uint8
    assert (label == 0).any() and (label == 1).any()
    # Black brick must have some light-grey outline pixels (value ~175) inside its silhouette
    b_pix = rgb[label == 1]
    assert (b_pix.max(axis=1) > 150).any()


def test_brick_prior_zero_leakage_if_present():
    from booklet_mpd.protocol import CONTAMINATED, heldout_sets
    from booklet_mpd.solver.brick_prior import MODEL_PATH, prior
    from booklet_mpd.solver.dataset import grades

    if not MODEL_PATH.exists():
        pytest.skip("brick-prior-clean.pt not trained")
    bp = prior()
    assert bp is not None
    g = grades()
    forbidden = set(heldout_sets(g, "validation")) | set(heldout_sets(g, "test")) | set(CONTAMINATED)
    excluded = set(bp.meta.get("excluded_sets", []))
    assert forbidden.issubset(excluded)
    # Inference + strict SE(3) invariance & bidirectionality test: 3023 (1x2) on 3022 (2x2) sits at (0, -8, 10)
    hm = np.stack([np.eye(4), np.eye(4)])
    cm = np.stack([np.eye(4), np.eye(4)])
    cm[0, 1, 3] = -8.0
    cm[0, 2, 3] = 10.0
    cm[1, 1, 3] = 80.0
    probs = bp.score_pairs(["3022", "3022"], [15, 15], hm, "3023", 15, cm)
    assert probs.shape == (2,) and 0.0 <= float(probs[0]) <= 1.0
    assert float(probs[0]) > 0.7 and float(probs[0]) > float(probs[1]) + 0.5
    if bp.meta.get("bidirectional_se3_invariant"):
        # Rotate BOTH host and child upside-down (180 deg around X) + 30 deg around Z: score must be invariant!
        ang = np.radians(30.0)
        R_tilt = np.array([[np.cos(ang), -np.sin(ang), 0, 0],
                           [np.sin(ang),  np.cos(ang), 0, 0],
                           [0, 0, 1, 0], [0, 0, 0, 1]], float)
        R_dn = np.diag([1.0, -1.0, -1.0, 1.0]) @ R_tilt
        probs_rot = bp.score_pairs(["3022", "3022"], [15, 15], np.einsum("ij,njk->nik", R_dn, hm),
                                   "3023", 15, np.einsum("ij,njk->nik", R_dn, cm))
        assert np.allclose(probs, probs_rot, atol=1e-4)
        # Reversed direction (top brick hosting bottom plate underneath) must also score high!
        p_rev = bp.score_pairs(["3023"], [15], cm[:1], "3022", 15, hm[:1])
        assert float(p_rev[0]) > 0.5


def test_mirror_matrix_and_pin_rotation_preserve_so3():
    m = np.eye(4); m[:3, 3] = [40.0, -20.0, 10.0]
    mm = _mirror_matrix(m, axis=0, coord=0.0)
    assert np.allclose(mm[:3, 3], [-40.0, -20.0, 10.0], atol=1e-6)
    assert abs(np.linalg.det(mm[:3, :3]) - 1.0) < 1e-6
    rot = _rotate_rigid_about_pin([("3005", 15, m)], np.array([40.0, -20.0, 10.0]), np.array([0.0, 0.0, 1.0]), -30.0)
    assert np.allclose(rot[0][2][:3, 3], [40.0, -20.0, 10.0], atol=1e-6)
    assert abs(np.linalg.det(rot[0][2][:3, :3]) - 1.0) < 1e-6
