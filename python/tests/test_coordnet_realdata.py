"""Real booklet train-set pages labelled through the solved camera."""
from dataclasses import dataclass

import numpy as np
import pytest

from coordnet import labels, realdata
from coordnet import render as R
from coordnet.camera import BookletCamera
from coordnet.evaluate import ROOT


def _m(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


@dataclass
class FakeCase:
    set_number: str
    step_number: int
    visible: list
    added: list
    rgb: np.ndarray
    pts_per_px: float = 0.48


BASE = [("3958", 72, _m(0, 8, 0)), ("3001", 4, _m(-40, -16, -30)), ("3004", 1, _m(50, -16, 40)),
        ("3003", 14, _m(40, -16, -40)), ("3003", 14, _m(40, -40, -40))]
NEW = [("3020", 0, _m(-30, -40, -30)), ("3023", 15, _m(-10, 0, 50))]
TRUE_CAM = BookletCamera(-38, 31, 0.5, 2.2, 300, 230, eye=4200)


def _case():
    parts = [realdata.norm(p) for p in BASE + NEW]
    centre = R.bounds_centre(parts)
    pic = R.render(parts, {5, 6}, TRUE_CAM, centre, 600, 460, R.Style(), ss=2).picture
    # pages are printed at booklet_mpd's BOOKLET_SCALE (0.815 pt per LDU): 2.2 px per LDU is 0.815 / 2.2 pt per px
    return FakeCase("99999", 3, BASE, NEW, pic, pts_per_px=0.815 / 2.2), parts, centre


def test_refuses_heldout_sets():
    with pytest.raises(SystemExit):
        realdata.main(["--sets", "21065"])


@pytest.mark.skipif(not (ROOT / ".cache/coordnet/ckpt/best.pt").exists(), reason="needs the CoordNet checkpoint")
def test_label_case_on_a_rendered_page():
    case, parts, centre = _case()
    net = realdata.load_net()
    s = realdata.label_case(net, case)
    assert s is not None
    assert s["meta"]["real"] and s["meta"]["fit"]["median"] < 1.0
    truth = labels.local_labels(R.gbuffer(*R.scene(parts), TRUE_CAM, centre, 600, 460), parts, {5, 6})
    both = truth["new"] & s["labels"]["new"]
    assert both.sum() > 0.9 * truth["new"].sum()
    err = np.linalg.norm(truth["local"][both] - s["labels"]["local"][both], axis=1)
    assert np.mean(err < 2.0) > 0.95


def test_bad_fit_is_dropped(monkeypatch):
    case, _parts, _centre = _case()
    monkeypatch.setattr(realdata, "solve_camera",
                        lambda net, pic, parts, cam, centre, W, H, rounds=4, log=None:
                        (cam, [dict(round=0, n=900, median=3.0, p90=6.0, inliers=0.5, flow_median=2.0)]))
    assert realdata.label_case(object(), case, start=TRUE_CAM) is None


def test_small_booklet_pictures_are_upscaled():
    case, _parts, _centre = _case()
    case.rgb = case.rgb[::4, ::4]                     # 150 x 115, like small sets' embedded pictures
    pic, pts = realdata._prepare(case)
    assert max(pic.shape[:2]) == realdata.MIN_SIDE
    assert abs(pts - case.pts_per_px * 150 / 512) < 1e-3


def test_blue_paper_is_repainted_grey():
    case, _parts, _centre = _case()
    pic = case.rgb.copy()
    bg = (np.abs(pic.astype(int) - pic[0, 0]).sum(-1) < 10)
    pic[bg] = (190, 215, 235)                            # light-blue booklet paper
    case.rgb = pic
    out, _pts = realdata._prepare(case)
    corner = out[:5, :5].reshape(-1, 3)
    assert np.abs(corner.astype(int) - realdata.PAPER).max() <= 2


def test_standard_views_use_the_print_scale():
    case, parts, centre = _case()
    pic, pts = realdata._prepare(case)
    starts = realdata.standard_views(pic, parts, pts)
    assert len(starts) == 8
    from booklet_mpd.viewfit import BOOKLET_SCALE
    assert all(abs(c.scale - BOOKLET_SCALE / pts) < 1e-9 for c in starts)
    assert {round(c.yaw) % 360 for c in starts} == {35, 125, 215, 305}
    assert {c.turned for c in starts} == {False, True}


def test_view_with_most_matches_wins_among_tight_fits(monkeypatch):
    case, _parts, _centre = _case()
    fits = {35: dict(median=0.2, p90=0.5, n=2000), 125: dict(median=0.3, p90=0.6, n=19000),
            215: dict(median=3.0, p90=6.0, n=30000)}

    def fake_solve(net, pic, parts, cam, centre, W, H, rounds=4, log=None):
        f = fits.get(round(cam.yaw) % 360)
        return (cam, [dict(round=0, inliers=1.0, flow_median=0.2, **f)]) if f and not cam.turned else (cam, [])

    monkeypatch.setattr(realdata, "solve_camera", fake_solve)
    monkeypatch.setattr(realdata, "change_evidence", lambda pic, base: np.ones(pic.shape[:2], bool))
    s = realdata.label_case(object(), case, min_agree=0.0)
    assert s is not None and round(s["cam"].yaw) % 360 == 125
