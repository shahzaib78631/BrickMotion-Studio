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
    return FakeCase("99999", 3, BASE, NEW, pic), parts, centre


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
