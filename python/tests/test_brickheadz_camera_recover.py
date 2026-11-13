"""Closed-form camera recovery: exactness, noise, degeneracy."""
from __future__ import annotations

import numpy as np
import pytest

from brickheadz.axonometric import (
    affine_from_axes,
    apply_affine,
    camera_from_affine,
    project_basis,
    project_offset,
    projected_axes,
    recover_camera,
)
from brickheadz.instruction_place import Camera

PTS = np.array([
    [0, 0, 0], [20, 0, 0], [0, 8, 0], [0, 0, 20],
    [40, 20, 60], [-30, 10, 15], [10, -40, 30], [60, 0, -20],
], float)


def _uvs(cam, pts):
    u, v, _ = cam.project(pts)
    return np.stack([u, v], 1)


def test_basis_matches_projection():
    cam = Camera(yaw=23, pitch=17, scale=3.3, ox=41, oy=55)
    a, o = project_basis(cam), project_offset(cam)
    got = apply_affine(a, o, PTS)
    want = _uvs(cam, PTS)
    assert np.allclose(got, want, atol=1e-9)


def test_projected_axes_are_the_world_axes():
    cam = Camera(yaw=35, pitch=20, scale=2.0, ox=10, oy=10)
    a = projected_axes(cam)
    for i, axis in enumerate(np.eye(3)):
        want = apply_affine(a, np.zeros(2), axis.reshape(1, 3))[0]
        assert np.allclose(a[:, i], want, atol=1e-9)


def test_affine_from_axes_round_trips():
    cam = Camera(yaw=12, pitch=28, scale=4.1, ox=7, oy=9)
    a = affine_from_axes(projected_axes(cam).T)
    assert np.allclose(a, project_basis(cam), atol=1e-9)


def test_recovers_exact_camera():
    cam = Camera(yaw=30, pitch=25, scale=2.5, ox=100, oy=90)
    got, cert = recover_camera(PTS, _uvs(cam, PTS))
    assert cert.ok
    assert cert.residual < 1e-6
    assert cert.orthonormality < 1e-9
    assert cert.rank == 8
    assert abs(got.yaw - 30) < 1e-6
    assert abs(got.pitch - 25) < 1e-6
    assert abs(got.scale - 2.5) < 1e-6
    assert abs(got.ox - 100) < 1e-6 and abs(got.oy - 90) < 1e-6


def test_noisy_correspondences_stay_close():
    cam = Camera(yaw=-40, pitch=33, scale=1.7, ox=200, oy=210)
    rng = np.random.default_rng(7)
    uvs = _uvs(cam, PTS) + rng.normal(0, 0.3, (_uvs(cam, PTS).shape))
    got, cert = recover_camera(PTS, uvs, residual_tol=2.0)
    assert cert.ok
    assert abs(got.yaw - (-40)) < 0.5
    assert abs(got.pitch - 33) < 0.5
    assert abs(got.scale - 1.7) < 0.05


def test_coplanar_points_are_flagged_degenerate():
    plane = np.array([[0, 0, 0], [20, 0, 0], [0, 8, 0], [40, 16, 0], [60, 24, 0], [20, 40, 0]], float)
    cam = Camera(yaw=30, pitch=25, scale=2.0, ox=50, oy=50)
    _got, cert = recover_camera(plane, _uvs(cam, plane))
    assert cert.rank < 8
    assert not cert.ok


def test_too_few_correspondences_raises():
    with pytest.raises(ValueError):
        recover_camera(PTS[:3], np.zeros((3, 2)))


def test_camera_from_affine_round_trips_parameters():
    cam = Camera(yaw=64, pitch=-18, scale=5.5, ox=3, oy=4)
    back, _r, defect = camera_from_affine(project_basis(cam), project_offset(cam))
    assert defect < 1e-9
    assert abs(back.yaw - 64) < 1e-6
    assert abs(back.pitch - (-18)) < 1e-6
    assert abs(back.scale - 5.5) < 1e-6


def test_camera_certificate_rejects_unrepresentable_roll_and_anisotropic_scale():
    cam=Camera(yaw=30,pitch=25,scale=2,ox=100,oy=100)
    theta=np.deg2rad(20)
    roll=np.array([[np.cos(theta),-np.sin(theta)],[np.sin(theta),np.cos(theta)]])
    for distortion in (roll,np.diag([1.,1.4])):
        uv=apply_affine(distortion@project_basis(cam),project_offset(cam),PTS)
        _got,cert=recover_camera(PTS,uv)
        assert not cert.ok
        assert cert.residual>.5


def test_explicit_legacy_camera_recovery():
    cam=Camera(yaw=30,pitch=25,scale=2,screen_y=-1)
    recovered,cert=recover_camera(PTS,_uvs(cam,PTS),screen_y=-1)
    assert cert.ok and np.allclose(_uvs(recovered,PTS),_uvs(cam,PTS))
