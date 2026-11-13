"""The solver's geometry, with ground-truth correspondence (from datagen) in place of the network."""
import random

import numpy as np

from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.datagen import correspondence, perturb
from coordnet.solve import candidate_offsets, correspondences, fit_camera


def _m(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


PARTS = [("3001.dat", 4, _m()), ("3020.dat", 15, _m(0, -24, 0)), ("3001.dat", 1, _m(60, 0, 0)),
         ("3003.dat", 14, _m(-50, -8, 30)), ("3023.dat", 2, _m(10, -32, -10))]


def _setup(eye, turned, level, seed):
    cam = BookletCamera(38, 33, 1.0, 2.4, 230, 170, eye=eye, turned=turned)
    centre = R.bounds_centre(PARTS)
    W, H = 460, 340
    gp = R.gbuffer(*R.scene(PARTS), cam, centre, W, H)
    est = perturb(random.Random(seed), cam, level)
    gr = R.gbuffer(*R.scene(PARTS), est, centre, W, H)
    flow, valid = correspondence(gp, PARTS, PARTS, est, centre, gr)
    return cam, est, centre, flow, valid, gr


def test_ground_truth_flow_recovers_the_camera():
    for eye, turned in ((4500, False), (0, False), (3000, True)):
        cam, est, centre, flow, valid, gr = _setup(eye, turned, 1.5, 3)
        m = correspondences(flow, valid.astype(float), gr)
        fit = fit_camera(m, est, centre)
        assert fit.median < 0.05 and fit.p90 < 0.25, fit
        for k in ("yaw", "pitch", "roll"):
            assert abs(getattr(fit.cam, k) - getattr(cam, k)) < 0.05
        assert abs(fit.cam.scale / cam.scale - 1) < 2e-3
        assert abs(fit.cam.cx - cam.cx) < 0.3 and abs(fit.cam.cy - cam.cy) < 0.3


def test_robust_to_outliers():
    cam, est, centre, flow, valid, gr = _setup(4500, False, 1.0, 5)
    rng = np.random.default_rng(0)
    bad = valid & (rng.random(valid.shape) < 0.25)
    flow = flow.copy()
    flow[:, bad] += rng.normal(0, 15, (2, int(bad.sum())))
    fit = fit_camera(correspondences(flow, valid.astype(float), gr), est, centre)
    assert abs(fit.cam.yaw - cam.yaw) < 0.15 and abs(fit.cam.cx - cam.cx) < 0.6


def test_wrong_candidate_shows_a_consistent_offset():
    cam = BookletCamera(38, 33, 1.0, 2.4, 230, 170, eye=4500)
    centre = R.bounds_centre(PARTS)
    W, H = 460, 340
    gp = R.gbuffer(*R.scene(PARTS), cam, centre, W, H)
    for shift, expect_wrong in (((0, 0, 0), False), ((20, 0, 0), True), ((0, 8, 0), True)):
        cand = list(PARTS)
        p, c, mm = cand[4]
        mm = mm.copy()
        mm[:3, 3] += shift
        cand[4] = (p, c, mm)
        gr = R.gbuffer(*R.scene(cand), cam, centre, W, H)
        flow, valid = correspondence(gp, PARTS, cand, cam, centre, gr)
        # flow on the candidate is the picture->render motion; the solver sees the candidate's own points
        m = correspondences(flow, valid.astype(float), gr)
        off = candidate_offsets(m, cam, centre, 4)
        assert off["n"] > 50
        assert (off["median"] > 5) == expect_wrong, (shift, off)
