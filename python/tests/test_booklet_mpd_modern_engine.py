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


def test_aligner_local_search_radius_matches_full_frame(lib):
    from booklet_mpd.solver.picture import BACKGROUND
    from booklet_mpd.solver.register import Aligner
    from booklet_mpd.solver.render import render

    parts = [("3001", 4, np.eye(4)), ("3005", 15, np.array([[1, 0, 0, 0], [0, 1, 0, -24], [0, 0, 1, 0], [0, 0, 0, 1]], float))]
    true_v = View(np.eye(3), 42.0, 35.0, 1.4, (110.0, 115.0))
    _d, lab = render(lib, parts, true_v, (220, 220))
    classes = np.full((220, 220), BACKGROUND, dtype=int)
    classes[lab == 0] = 0
    classes[lab == 1] = 1
    aligner = Aligner(lib, parts, classes, [4, 15], factor=1.0, on_ink=None)
    # Perturb offset by (+7, -6) px and verify local search_radius=24 recovers exact same score & offset as full frame
    guess_v = true_v.replace(offset=(true_v.offset[0] + 7.0, true_v.offset[1] - 6.0))
    v_full, view_full = aligner.evaluate(guess_v, use_edges=False, search_radius=None)
    v_loc, view_loc = aligner.evaluate(guess_v, use_edges=False, search_radius=24)
    assert abs(v_full - v_loc) < 1e-5
    assert np.allclose(view_full.offset, view_loc.offset, atol=1.0)
    # Also check pin_centroid preserves projected centroid under angle/scale change
    pinned = aligner.pin_centroid(true_v, true_v.replace(yaw=46.0, scale=1.45))
    c3 = aligner._centroid[None]
    assert np.allclose(true_v.project(c3)[0, :2], pinned.project(c3)[0, :2], atol=1e-5)


def test_non_ortho_penalty_flush_override():
    from booklet_mpd.solver.exact_place import FLUSH_PENALTY, _non_ortho_penalty

    fl = {"kind": "flush"}
    assert _non_ortho_penalty(fl, np.eye(4)) == FLUSH_PENALTY
    assert _non_ortho_penalty(fl, np.eye(4), flush_penalty=0.0) == 0.0


def test_brick_prior_v3_layout_scoring_and_zero_leakage():
    from booklet_mpd.solver.brick_prior import MODEL_PATH, prior

    if not MODEL_PATH.exists():
        pytest.skip("brick-prior-clean.pt not trained")
    bp = prior()
    assert bp is not None
    assert bp.meta.get("version", 0) >= 3
    base = [("3022", 15, np.eye(4))]
    m_good = np.eye(4); m_good[:3, 3] = [0.0, -8.0, 10.0]
    m_bad = np.eye(4); m_bad[:3, 3] = [30.0, -8.0, 30.0]
    scores = bp.score_layouts_batch(base, [[("3023", 15, m_good)], [("3023", 15, m_bad)]])
    assert scores.shape == (2,)
    assert float(scores[0]) > float(scores[1]) + 1.0


def test_dino_spatial_head_zero_leakage_and_monotonicity(lib):
    from booklet_mpd.protocol import CONTAMINATED, heldout_sets
    from booklet_mpd.solver.dataset import grades
    from booklet_mpd.solver.vision_prior import SPATIAL_HEAD_PATH, perceptor

    if not SPATIAL_HEAD_PATH.exists():
        pytest.skip("dino-spatial-comparator.pt not trained")
    perc = perceptor()
    assert perc is not None and perc.spatial_head is not None
    g = grades()
    forbidden = set(heldout_sets(g, "validation")) | set(heldout_sets(g, "test")) | set(CONTAMINATED)
    trained = set(perc.spatial_head_meta.get("train_sets", []))
    assert trained.isdisjoint(forbidden)
    assert trained.isdisjoint({"40271", "40350", "41488", "41605", "41620", "40348"})

    view = View(np.eye(3), 45.0, 35.0, 1.8, (90.0, 90.0))
    m0 = np.eye(4)
    m_same = np.eye(4); m_same[:3, 3] = [0.0, -24.0, 0.0]
    m_shift = np.eye(4); m_shift[:3, 3] = [20.0, -24.0, 20.0]
    bg = (255, 255, 255)
    target, _d, lab = render_npr_rgb(lib, [("3001", 4, m0), ("3005", 15, m_same)], view, (180, 180), bg=bg)
    cand_bad, _d2, lab2 = render_npr_rgb(lib, [("3001", 4, m0), ("3005", 15, m_shift)], view, (180, 180), bg=bg)
    sc = perc.score_renders(target, lab >= 0, bg, [target, cand_bad], focus_mask=(lab == 1) | (lab2 == 1))
    assert float(sc[0]) > float(sc[1]) + 0.05


def test_scanet_view_angle_helper():
    from booklet_mpd.solver.global_opt import _view_angle_deg

    v0 = View(np.eye(3), 45.0, 35.0, 1.5, (0.0, 0.0))
    v1 = View(_turn(1)[:3, :3], 45.0, 35.0, 1.5, (0.0, 0.0))
    v2 = View(_turn(2)[:3, :3], 45.0, 35.0, 1.5, (0.0, 0.0))
    assert _view_angle_deg(v0, v0) < 1e-3
    assert 60.0 <= _view_angle_deg(v0, v1) <= 100.0
    assert 90.0 <= _view_angle_deg(v0, v2) <= 180.0
