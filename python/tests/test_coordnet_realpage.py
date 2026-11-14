"""Real-page label checks that do not trust colour or the network's own residuals (docs/coordnet/realpage-design.md)."""
import json

import numpy as np

from coordnet import realdata
from coordnet import render as R
from coordnet.camera import project
from coordnet.place import red_band
from coordnet.solve import Matches, fit_camera

from test_coordnet_realdata import BASE, NEW, TRUE_CAM, FakeCase, _case

W, H = 600, 460


def _scene():
    parts = [realdata.norm(p) for p in BASE + NEW]
    centre = R.bounds_centre(parts)
    g = R.gbuffer(*R.scene(parts), TRUE_CAM, centre, W, H)
    full = R.render(parts, set(), TRUE_CAM, centre, W, H, R.Style(), ss=2, red=False).picture
    base = R.render(parts[:len(BASE)], set(), TRUE_CAM, centre, W, H, R.Style(), ss=2, red=False).picture
    return parts, centre, g, full, base


NEW_IDS = {len(BASE), len(BASE) + 1}


def _without(parts, centre):
    return lambda i: R.render([q for j, q in enumerate(parts) if j != i], set(), TRUE_CAM, centre, W, H, R.Style(),
                              ss=2, red=False).picture


# --- red band -------------------------------------------------------------------------------------------------

def test_red_band_ignores_orange_parts():
    pic = np.full((80, 80, 3), 137, np.uint8)
    pic[20:60, 20:60] = (238, 138, 44)                      # an orange part, as printed in 40348
    assert red_band(pic).sum() == 0


def test_red_band_ignores_a_filled_red_part_but_finds_a_thin_band():
    pic = np.full((120, 120, 3), 137, np.uint8)
    pic[10:60, 10:60] = (201, 26, 9)                        # a red brick: filled, not a band
    pic[80:83, 20:100] = (205, 30, 38)                      # the renderer's red outline, ~3 px wide
    band = red_band(pic)
    assert band[20:50, 20:50].sum() == 0
    assert band[81, 30:90].all()


# --- camera ---------------------------------------------------------------------------------------------------

def test_fit_camera_keeps_eye_in_the_training_range():
    rng = np.random.default_rng(0)
    X = rng.uniform(-20, 20, (400, 3))                      # a small model: perspective is barely observable
    far = TRUE_CAM.with_(eye=1e9)
    p, _ = project(far, np.zeros(3), X)
    p += rng.normal(0, 0.3, p.shape)
    fit = fit_camera(Matches(p, X, np.ones(len(X)), np.zeros(len(X), int)), TRUE_CAM, np.zeros(3))
    assert realdata.EYE_RANGE[0] <= fit.cam.eye <= realdata.EYE_RANGE[1]


def test_camera_check_passes_the_true_camera_and_fails_a_shifted_one():
    parts, centre, _g, full, _base = _scene()
    assert realdata.camera_check(full, parts, TRUE_CAM, centre, print_scale=TRUE_CAM.scale)["ok"]
    off = realdata.camera_check(full, parts, TRUE_CAM.with_(cx=TRUE_CAM.cx + 5), centre, print_scale=TRUE_CAM.scale)
    assert not off["ok"]


def test_camera_check_fails_a_scale_far_from_print():
    parts, centre, _g, full, _base = _scene()
    assert not realdata.camera_check(full, parts, TRUE_CAM, centre, print_scale=TRUE_CAM.scale * 1.2)["ok"]


def test_tight_network_fit_with_wrong_lines_is_dropped(monkeypatch):
    case, _parts, _centre = _case()
    shifted = TRUE_CAM.with_(cx=TRUE_CAM.cx + 6)
    monkeypatch.setattr(realdata, "solve_camera", lambda net, pic, parts, cam, centre, W, H, rounds=4, free=None:
                        (shifted, [dict(round=0, n=20000, median=0.3, p90=0.6, inliers=1.0, flow_median=0.1)]))
    why: list = []
    s = realdata.label_case(object(), case, start=TRUE_CAM, why=why)
    # the network's tight-but-wrong camera is never used; the line fit may still find the true one on this page
    assert s is None or (s["meta"]["solver"] == "linefit" and abs(s["cam"].cx - TRUE_CAM.cx) < 1.0)


def test_tight_network_fit_with_wrong_lines_is_dropped_when_the_line_fit_fails_too(monkeypatch):
    from coordnet import linefit
    case, _parts, _centre = _case()
    shifted = TRUE_CAM.with_(cx=TRUE_CAM.cx + 6)
    monkeypatch.setattr(realdata, "solve_camera", lambda net, pic, parts, cam, centre, W, H, rounds=4, free=None:
                        (shifted, [dict(round=0, n=20000, median=0.3, p90=0.6, inliers=1.0, flow_median=0.1)]))
    monkeypatch.setattr(linefit, "search", lambda *a, **k: [linefit.Fit(shifted, 0.5, 0.8, 1000)])
    why: list = []
    assert realdata.label_case(object(), case, start=TRUE_CAM, why=why) is None
    assert why[-1].startswith("camera: off the page")


def test_chained_start_is_fitted_translation_only_first(monkeypatch):
    case, _parts, _centre = _case()
    calls = []

    def fake(net, pic, parts, cam, centre, W, H, rounds=4, free=None):
        calls.append(free)
        return TRUE_CAM, [dict(round=0, n=20000, median=0.2, p90=0.5, inliers=1.0, flow_median=0.1)]

    monkeypatch.setattr(realdata, "solve_camera", fake)
    s = realdata.label_case(object(), case, start=TRUE_CAM.with_(cx=TRUE_CAM.cx + 20))
    assert s is not None
    assert calls[0] == ("cx", "cy")


# --- new parts ------------------------------------------------------------------------------------------------

def test_edge_agreement_ignores_the_booklet_palette():
    parts, centre, g, full, base = _scene()
    page = np.clip(full[..., [2, 0, 1]].astype(int) * 0.8 + 40, 0, 255).astype(np.uint8)   # other colours, same lines
    assert realdata.edge_agreement(page, full, base, g.part, NEW_IDS, _without(parts, centre))["ok"]


def test_edge_agreement_rejects_a_page_without_the_new_parts():
    parts, centre, g, full, base = _scene()
    assert not realdata.edge_agreement(base, full, base, g.part, NEW_IDS, _without(parts, centre))["ok"]


def test_edge_agreement_rejects_a_page_missing_one_new_part():
    parts, centre, g, full, base = _scene()
    one = R.render(parts[:len(BASE) + 1], set(), TRUE_CAM, centre, W, H, R.Style(), ss=2, red=False).picture
    assert (g.part == len(BASE) + 1).sum() >= 40              # the missing part would be visible
    a = realdata.edge_agreement(one, full, base, g.part, NEW_IDS, _without(parts, centre))
    assert not a["ok"]


# --- main -----------------------------------------------------------------------------------------------------

def _patch_main(monkeypatch, tmp_path, cases, label):
    import booklet_mpd.protocol as P
    import booklet_mpd.solver.dataset as D
    monkeypatch.setattr(P, "tuning_sets", lambda grades: ["99999"])
    monkeypatch.setattr(D, "grades", lambda: [])
    monkeypatch.setattr(D, "cases", lambda s: cases)
    monkeypatch.setattr(realdata, "load_net", lambda ckpt=None: object())
    monkeypatch.setattr(realdata, "label_case", label)


def test_missing_image_is_reported_and_stale_samples_cleared(monkeypatch, tmp_path, capsys):
    out = tmp_path / "real-99999"
    out.mkdir()
    (out / "00007.json").write_text("{}")
    case, _p, _c = _case()
    case.rgb = None
    _patch_main(monkeypatch, tmp_path, [case], lambda *a, **k: None)
    realdata.main(["--sets", "99999", "--out", str(tmp_path)])
    assert "no image" in capsys.readouterr().out
    assert not (out / "00007.json").exists()


def test_section_camera_follows_a_checked_camera_even_when_the_page_is_dropped(monkeypatch, tmp_path):
    a, _p, _c = _case()
    b = FakeCase("99999", 4, a.visible, a.added, a.rgb, a.pts_per_px)
    starts = []

    def label(net, case, start=None, why=None, checked=None, **k):
        starts.append(start)
        if case.step_number == 3:
            checked["cam"] = TRUE_CAM                      # camera passed, new parts failed
            why.append("new parts: edges")
        return None

    _patch_main(monkeypatch, tmp_path, [a, b], label)
    realdata.main(["--sets", "99999", "--out", str(tmp_path)])
    assert starts[0] is None
    assert starts[1] is not None and abs(starts[1].yaw - TRUE_CAM.yaw) < 1e-9


# --- paper ----------------------------------------------------------------------------------------------------

def test_white_part_on_white_paper_is_not_paper():
    pic = np.full((100, 100, 3), 250, np.uint8)             # white booklet paper
    pic[30:70, 30:70] = 20                                    # the part's black outline
    pic[32:68, 32:68] = 244                                   # a white part, inside it
    paper = realdata.paper_mask(pic)
    assert paper[5, 5] and not paper[50, 50]


# --- review follow-ups ----------------------------------------------------------------------------------------

def test_camera_check_requires_a_tight_line_median(monkeypatch):
    parts, centre, _g, full, _base = _scene()
    monkeypatch.setattr(realdata, "line_distance", lambda pic, ren, region, up=4, thin=False, native=1.0: (2.0, 3.0))
    assert not realdata.camera_check(full, parts, TRUE_CAM, centre, print_scale=TRUE_CAM.scale)["ok"]


def test_camera_check_needs_enough_tiles():
    parts, centre, _g, full, _base = _scene()
    c = realdata.camera_check(full, parts, TRUE_CAM, centre, print_scale=TRUE_CAM.scale, min_tiles=10_000)
    assert not c["ok"]


def test_edge_agreement_rejects_when_new_parts_cannot_be_checked():
    """If removing any new part barely changes the drawing, nothing proves the new parts are there."""
    parts, centre, g, full, base = _scene()
    full_again = lambda i: full                              # removal changes nothing: every part uninformative
    a = realdata.edge_agreement(full, full, base, g.part, NEW_IDS, full_again)
    assert not a["ok"] and "cannot be verified" in a["reason"]


def test_edge_agreement_reports_too_few_lines():
    _parts, _centre, g, full, base = _scene()
    blank = np.full_like(full, 137)
    a = realdata.edge_agreement(blank, full, base, g.part, NEW_IDS, lambda i: base)
    assert not a["ok"] and a["reason"] == "too few lines"


def test_set_summary_counts_drop_reasons(monkeypatch, tmp_path, capsys):
    a, _p, _c = _case()
    b = FakeCase("99999", 4, a.visible, a.added, None, a.pts_per_px)

    def label(net, case, start=None, why=None, checked=None, **k):
        why.append("camera: off the page (...)")
        return None

    _patch_main(monkeypatch, tmp_path, [a, b], label)
    realdata.main(["--sets", "99999", "--out", str(tmp_path)])
    rows = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith('{"set"')]
    assert rows[0]["reasons"] == {"camera": 1, "no image": 1}


def test_black_part_printed_lighter_still_agrees():
    """Booklets print black parts as anything from black to mid grey; only their outlines may count as lines."""
    import cv2
    parts, centre, g, full, base = _scene()
    inside = cv2.erode((g.part == len(BASE)).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    page = full.copy()
    page[inside] = (full[inside] * 0.6 + 80).astype(np.uint8)     # lighter grey face, outlines kept
    assert realdata.edge_agreement(page, full, base, g.part, NEW_IDS, _without(parts, centre))["ok"]


def test_kept_meta_has_no_nan():
    parts, centre, g, full, base = _scene()
    a = realdata.edge_agreement(full, full, base, g.part, NEW_IDS, _without(parts, centre))
    a["base"] = [float("nan"), float("nan")]
    json.dumps(realdata.finite(a), allow_nan=False)


def test_part_with_too_few_lines_rejects_the_page_as_unverified():
    parts, centre, g, full, base = _scene()
    real = realdata.line_distance
    calls = {"n": 0}

    def few(pic, ren, region, up=4, thin=False, native=1.0):
        calls["n"] += 1
        return (float("nan"), float("nan")) if calls["n"] > 2 and pic is full and ren is full else real(pic, ren, region, up, thin, native)

    import pytest
    mp = pytest.MonkeyPatch()
    mp.setattr(realdata, "line_distance", few)
    try:
        a = realdata.edge_agreement(full, full, base, g.part, NEW_IDS, _without(parts, centre))
    finally:
        mp.undo()
    assert not a["ok"] and "cannot be verified (too few lines)" in a["reason"]


def test_thin_dark_lines_leave_out_a_black_part_face():
    import cv2
    from coordnet.evaluate import dark_lines
    _parts, _centre, g, full, _base = _scene()
    inside = cv2.erode((g.part == len(BASE)).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    assert dark_lines(full)[inside].mean() > 0.5                 # the plain mask fills the black face
    assert dark_lines(full, thin=True)[inside].mean() < 0.15     # thin keeps its stud outlines only


# --- Codex review ---------------------------------------------------------------------------------------------

def test_tile_shift_reads_a_two_pixel_shift():
    """phaseCorrelate windows its inputs in place; overlapping tiles must not see each other's windowing."""
    from coordnet.evaluate import shift_summary
    _parts, _centre, g, full, _base = _scene()
    s = shift_summary(np.roll(full, 2, axis=1), full, g.part >= 0)
    assert abs(s["median"] - 2.0) < 0.05


def test_one_unverifiable_part_rejects_the_page():
    """Codex: a page passed with 79% of its new pixels checked while the unchecked part was missing from the page;
    every new pixel becomes a label, so every visible new part must be verified."""
    parts, centre, g, full, base = _scene()
    real = _without(parts, centre)
    second = max(NEW_IDS)
    without = lambda i: full if i == second else real(i)     # removing the second part changes nothing
    a = realdata.edge_agreement(full, full, base, g.part, NEW_IDS, without)
    assert not a["ok"] and f"new part {second} cannot be verified" in a["reason"]


def _outline_scene():
    grey = np.full((200, 200, 3), 160, np.uint8)
    full = grey.copy()
    full[60:140, 60:62] = full[60:140, 138:140] = full[60:62, 60:140] = full[138:140, 60:140] = 0
    part = np.full((200, 200), -1)
    part[60:140, 60:140] = 1
    return grey, full, part


def test_removal_that_leaves_no_lines_verifies_a_drawn_part():
    grey, full, part = _outline_scene()
    a = realdata.edge_agreement(full, full, grey, part, {1}, lambda i: grey)
    assert a["ok"], a["reason"]


def test_removal_that_leaves_no_lines_does_not_verify_a_missing_part():
    grey, full, part = _outline_scene()
    a = realdata.edge_agreement(grey, full, grey, part, {1}, lambda i: grey)
    assert not a["ok"]


def test_thin_lines_keep_a_stroke_widened_by_upscaling():
    """Codex: a 6 px stroke (a 1.5 px booklet line upscaled 4x) vanished under the fixed ~4 px opening."""
    from coordnet.evaluate import dark_lines
    img = np.full((120, 120, 3), 200, np.uint8)
    img[57:63, 10:110] = 0                                   # 6 px wide black line
    img[20:50, 20:100] = 0                                   # a 30 px black face
    lines = dark_lines(img, thin=realdata.stroke_width(4.0))
    assert lines[57:63, 20:100].any()
    assert not lines[30:40, 30:90].any()


def test_stroke_width_follows_the_upscale():
    assert realdata.stroke_width(1.0) == 4.0
    assert realdata.stroke_width(4.0) > 6.0


def test_smaller_tile_shift_wins_between_two_passing_cameras(monkeypatch):
    case, _parts, _centre = _case()
    near = TRUE_CAM.with_(cx=TRUE_CAM.cx + 0.6)
    fits = {35: near, 125: TRUE_CAM}

    def fake(net, pic, parts, cam, centre, W, H, rounds=4, free=None):
        c = fits.get(round(cam.yaw) % 360)
        return (c, [dict(round=0, n=20000, median=0.2, p90=0.5, inliers=1.0, flow_median=0.1)]) \
            if c is not None and not cam.turned else (cam, [])

    picked = []
    real = realdata.camera_check
    monkeypatch.setattr(realdata, "camera_check", lambda *a, **k: (lambda r: (picked.append(r), r)[1])(real(*a, **k)))
    monkeypatch.setattr(realdata, "solve_camera", fake)
    s = realdata.label_case(object(), case)
    assert sum(r["ok"] for r in picked) == 2                # both candidates pass the check
    assert s is not None and s["cam"].cx == TRUE_CAM.cx


def test_too_few_tiles_is_its_own_reason(monkeypatch):
    case, _parts, _centre = _case()
    monkeypatch.setattr(realdata, "solve_camera", lambda net, pic, parts, cam, centre, W, H, rounds=4, free=None:
                        (TRUE_CAM, [dict(round=0, n=20000, median=0.2, p90=0.5, inliers=1.0, flow_median=0.1)]))
    monkeypatch.setattr(realdata, "shift_summary", lambda pic, ren, region: dict(tiles=3, median=0.2))
    why: list = []
    assert realdata.label_case(object(), case, start=TRUE_CAM, why=why) is None
    assert why[-1].startswith("camera: too few tiles to verify")


def test_kept_sample_meta_is_strict_json(monkeypatch):
    case, _parts, _centre = _case()
    monkeypatch.setattr(realdata, "solve_camera", lambda net, pic, parts, cam, centre, W, H, rounds=4, free=None:
                        (TRUE_CAM, [dict(round=0, n=20000, median=0.2, p90=0.5, inliers=1.0, flow_median=0.1)]))
    s = realdata.label_case(object(), case, start=TRUE_CAM)
    assert s is not None
    json.dumps(s["meta"], allow_nan=False)


def test_malformed_image_is_a_page_error_not_a_crash(monkeypatch, tmp_path, capsys):
    case, _p, _c = _case()
    case.rgb = np.zeros((0, 0, 3), np.uint8)
    _patch_main(monkeypatch, tmp_path, [case], realdata.label_case)
    realdata.main(["--sets", "99999", "--out", str(tmp_path)])
    out = capsys.readouterr()
    assert "drop set 99999 step 3" in out.out


# --- line fit fallback ------------------------------------------------------------------------------------------

def test_camera_check_tolerance_follows_the_pictures_native_resolution(monkeypatch):
    """A 1.2 px shift on a picture upscaled 2.56x is 0.47 px of the booklet's own raster."""
    parts, centre, _g, full, _base = _scene()
    monkeypatch.setattr(realdata, "shift_summary", lambda pic, ren, region: dict(tiles=50, median=1.2))
    monkeypatch.setattr(realdata, "line_distance", lambda pic, ren, region, up=4, thin=0.0, native=1.0:
                        (0.9 / native, 5.6 / native))        # 0.9/5.6 working px
    assert not realdata.camera_check(full, parts, TRUE_CAM, centre, TRUE_CAM.scale)["ok"]
    assert realdata.camera_check(full, parts, TRUE_CAM, centre, TRUE_CAM.scale, upscale=2.56)["ok"]


def _no_network(monkeypatch):
    monkeypatch.setattr(realdata, "solve_camera", lambda net, pic, parts, cam, centre, W, H, rounds=4, free=None:
                        (cam, []))


def test_label_case_falls_back_to_the_line_fit_when_the_network_sees_nothing(monkeypatch):
    case, parts, centre = _case()
    _no_network(monkeypatch)
    checked: dict = {}
    s = realdata.label_case(object(), case, start=TRUE_CAM.with_(cx=TRUE_CAM.cx + 7, yaw=TRUE_CAM.yaw + 2),
                            checked=checked)
    assert s is not None and s["meta"]["solver"] == "linefit" and "cam" in checked
    c = s["cam"]
    assert abs(c.cx - TRUE_CAM.cx) < 1.0 and abs(c.cy - TRUE_CAM.cy) < 1.0
    assert abs((c.yaw - TRUE_CAM.yaw + 180) % 360 - 180) < 0.5 and abs(c.pitch - TRUE_CAM.pitch) < 0.5


def test_ambiguous_line_fits_abstain_and_do_not_chain(monkeypatch):
    from coordnet import linefit
    case, parts, centre = _case()
    _no_network(monkeypatch)
    other = TRUE_CAM.with_(yaw=TRUE_CAM.yaw + 90)            # a different view that (here) also passes
    monkeypatch.setattr(linefit, "search", lambda *a, **k: [linefit.Fit(TRUE_CAM, 0.3, 0.9, 1000),
                                                           linefit.Fit(other, 0.3, 0.9, 1000)])
    monkeypatch.setattr(realdata, "camera_check",
                        lambda pic, parts, cam, centre, ps, **k: dict(ok=True, tiles=50, shift=0.3, p50=0.2, p90=1.0,
                                                                      scale_err=0.0, render=None, gbuffer=None))
    why, checked = [], {}
    assert realdata.label_case(object(), case, start=TRUE_CAM, why=why, checked=checked) is None
    assert "ambiguous" in why[-1] and "cam" not in checked


# --- review fixes: native units, cross-pass ambiguity -------------------------------------------------------------

def test_line_distance_is_reported_in_native_pixels_and_clipped_there():
    from coordnet.evaluate import line_distance
    a = np.full((200, 300, 3), 230, np.uint8); b = a.copy()
    a[:, 100:102] = 0; b[:, 124:126] = 0                       # 24 working px apart
    reg = np.ones((200, 300), bool)
    assert line_distance(a, b, reg)[0] == 15.0                  # clipped
    assert abs(line_distance(a, b, reg, native=2.0)[0] - 12.0) < 1.0     # 2 px wide lines: centre within a px


def test_edge_agreement_measures_in_native_pixels(monkeypatch):
    from coordnet import realdata as rd
    parts, centre, g, full, base = _scene()
    seen = []
    real = rd.line_distance
    monkeypatch.setattr(rd, "line_distance", lambda *a, **k: (seen.append(k.get("native")), real(*a, **k))[1])
    rd.edge_agreement(full, full, base, g.part, NEW_IDS, _without(parts, centre), upscale=2.5)
    assert seen and all(n == 2.5 for n in seen)


def _ok_check_with_real_gbuffer(parts_, centre_):
    def chk(pic, parts, cam, centre, ps, **k):
        g = R.gbuffer(*R.scene(parts), cam, centre, pic.shape[1], pic.shape[0])
        return dict(ok=True, tiles=50, shift=0.3, p50=0.2, p90=1.0, scale_err=0.0, render=pic, gbuffer=g)
    return chk


def test_a_section_fit_is_compared_with_the_global_search_before_it_is_kept(monkeypatch):
    from coordnet import linefit
    case, parts, centre = _case()
    _no_network(monkeypatch)
    other = TRUE_CAM.with_(yaw=TRUE_CAM.yaw + 90)
    monkeypatch.setattr(linefit, "search", lambda *a, start=None, **k:
                        [linefit.Fit(other if start is not None else TRUE_CAM, 0.3, 0.9, 1000)])
    monkeypatch.setattr(realdata, "camera_check", _ok_check_with_real_gbuffer(parts, centre))
    why, checked = [], {}
    assert realdata.label_case(object(), case, start=TRUE_CAM, why=why, checked=checked) is None
    assert "ambiguous" in why[-1] and "cam" not in checked


def test_equivalent_passing_fits_are_not_ambiguous(monkeypatch):
    from coordnet import linefit
    case, parts, centre = _case()
    _no_network(monkeypatch)
    monkeypatch.setattr(linefit, "search", lambda *a, start=None, **k:
                        [linefit.Fit(TRUE_CAM.with_(cx=TRUE_CAM.cx + (0.3 if start is None else 0.0)), 0.3, 0.9, 1000)])
    monkeypatch.setattr(realdata, "camera_check", _ok_check_with_real_gbuffer(parts, centre))
    why = []
    realdata.label_case(object(), case, start=TRUE_CAM, why=why)
    assert not any("ambiguous" in w for w in why)


def test_a_view_that_swaps_identical_new_parts_is_ambiguous(monkeypatch):
    """Big Pickle: two identical new parts on either side (eyes, ears) give the same new-part union from the
    true view and the half-turned one, but the labels of each part are swapped."""
    from types import SimpleNamespace
    from coordnet import linefit
    case, parts, centre = _case()
    _no_network(monkeypatch)
    a, b = len(BASE), len(BASE) + 1
    part0 = np.full((460, 600), -1, np.int32); part0[100:150, 100:200] = a; part0[100:150, 300:400] = b
    part1 = part0.copy(); part1[part0 == a] = b; part1[part0 == b] = a
    half = TRUE_CAM.with_(yaw=TRUE_CAM.yaw + 180)
    monkeypatch.setattr(linefit, "search", lambda *a_, start=None, **k:
                        [linefit.Fit(TRUE_CAM, 0.3, 0.9, 1000), linefit.Fit(half, 0.3, 0.9, 1000)])
    monkeypatch.setattr(realdata, "camera_check", lambda pic, parts, cam, centre, ps, **k:
                        dict(ok=True, tiles=50, shift=0.3, p50=0.2, p90=1.0, scale_err=0.0, render=pic,
                             gbuffer=SimpleNamespace(part=part0 if cam.yaw == TRUE_CAM.yaw else part1)))
    why, checked = [], {}
    assert realdata.label_case(object(), case, start=TRUE_CAM, why=why, checked=checked) is None
    assert "ambiguous" in why[-1] and "cam" not in checked


def test_downscaled_pictures_are_judged_in_native_pixels_too(monkeypatch):
    parts, centre, _g, full, _base = _scene()
    monkeypatch.setattr(realdata, "shift_summary", lambda pic, ren, region: dict(tiles=50, median=0.6))
    monkeypatch.setattr(realdata, "line_distance", lambda pic, ren, region, up=4, thin=0.0, native=1.0:
                        (0.5 / native, 2.5 / native))
    assert realdata.camera_check(full, parts, TRUE_CAM, centre, TRUE_CAM.scale)["ok"]
    assert not realdata.camera_check(full, parts, TRUE_CAM, centre, TRUE_CAM.scale, upscale=0.5)["ok"]
