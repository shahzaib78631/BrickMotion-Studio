"""Network-free camera fit to the page's lines (docs/coordnet/linefit-design.md), built bottom-up."""
import numpy as np
import pytest

from coordnet.camera import BookletCamera, project
from coordnet.solve import Matches, fit_camera

CAM = BookletCamera(38, 33, 1.0, 2.4, 230, 170, eye=4200)


def _matches(cam, n=400, seed=0):
    rng = np.random.default_rng(seed)
    X = rng.uniform(-60, 60, (n, 3))
    p, _ = project(cam, np.zeros(3), X)
    return Matches(p, X, np.ones(n), np.zeros(n, int))


# --- fit_camera contract --------------------------------------------------------------------------------------

def test_fit_camera_respects_parameter_bounds():
    m = _matches(CAM.with_(scale=CAM.scale * 1.10))          # the page is 10% larger than the start
    fit = fit_camera(m, CAM, np.zeros(3), free=("scale", "cx", "cy"),
                     bounds={"scale": (CAM.scale * 0.97, CAM.scale * 1.03)})
    assert CAM.scale * 0.97 - 1e-9 <= fit.cam.scale <= CAM.scale * 1.03 + 1e-9


def test_fit_camera_keeps_eye_when_not_free():
    m = _matches(CAM.with_(eye=2500, cx=CAM.cx + 3))
    fit = fit_camera(m, CAM, np.zeros(3), free=("yaw", "pitch", "roll", "scale", "cx", "cy"))
    assert fit.cam.eye == CAM.eye


def test_fit_camera_with_no_matches_returns_none():
    empty = Matches(np.zeros((0, 2)), np.zeros((0, 3)), np.zeros(0), np.zeros(0, int))
    assert fit_camera(empty, CAM, np.zeros(3), free=("cx", "cy")) is None


def test_fit_camera_with_too_few_matches_for_its_parameters_returns_none():
    m = _matches(CAM, n=2)
    assert fit_camera(m, CAM, np.zeros(3), free=("yaw", "pitch", "roll", "scale", "cx", "cy")) is None


# --- visible model lines ---------------------------------------------------------------------------------------

def _parts():
    from coordnet import realdata
    from test_coordnet_realdata import BASE, NEW
    return [realdata.norm(p) for p in BASE + NEW]


@pytest.mark.parametrize("cam", [CAM, CAM.with_(yaw=128, turned=True), CAM.with_(eye=0.0, pitch=20)])
def test_visible_line_samples_rasterise_to_line_mask(cam):
    from coordnet import render as R
    parts = _parts()
    centre = R.bounds_centre(parts)
    W, H = 460, 340
    g = R.gbuffer(*R.scene(parts), cam, centre, W, H)
    lines = R.scene_lines(parts)
    mask = R.line_mask(*lines, g, cam, centre, 1)
    s = R.visible_line_samples(*lines, g, cam, centre, 1)
    raster = np.zeros((H, W), bool)
    raster[np.floor(s.uv[:, 1]).astype(int), np.floor(s.uv[:, 0]).astype(int)] = True
    assert (raster == mask).all()
    uv, _ = project(cam, centre, s.X)
    assert np.abs(uv - s.uv).max() < 1e-6                   # the 3D samples are the points drawn
    assert set(np.unique(s.part)) <= set(range(len(parts)))


# --- page features ---------------------------------------------------------------------------------------------

def _page(h=120, w=160, v=200):
    return np.full((h, w, 3), v, np.uint8)


def test_a_thick_dark_stroke_gives_one_centre_line():
    """Codex: dark_lines kept all six rows of a 6 px stroke; ICP could stop anywhere inside it."""
    from coordnet import linefit
    img = _page()
    img[57:63, 20:140] = 0                                    # rows 57..62: centre y = 60.0 in pixel-centre units
    f = linefit.page_features(img, stroke=8.0)
    mid = f.p[(f.p[:, 0] > 40) & (f.p[:, 0] < 120) & (f.kind < 2)]
    assert len(mid) > 60
    assert np.abs(mid[:, 1] - 60.0).max() < 0.25


def test_a_thin_stroke_is_found_at_sub_pixel_precision():
    from coordnet import linefit
    img = _page().astype(float)
    y0 = 50.3                                                 # a 2 px antialiased stroke centred at y = 50.3
    ys = np.arange(img.shape[0]) + 0.5
    cover = np.clip(1.0 - np.maximum(np.abs(ys - y0) - 1.0 + 0.5, 0), 0, 1)
    img[:, 20:140] *= (1 - 0.9 * cover)[:, None, None]
    f = linefit.page_features(img.astype(np.uint8), stroke=4.0)
    mid = f.p[(f.p[:, 0] > 40) & (f.p[:, 0] < 120) & (f.kind == 0)]
    assert len(mid) > 60 and abs(np.median(mid[:, 1]) - y0) < 0.15


def test_a_light_line_on_a_dark_part_is_found():
    """The renderer (and booklets) draw light lines on dark parts; a dark-only detector misses them."""
    from coordnet import linefit
    img = _page()
    img[30:90, 20:140] = 40                                   # a dark part
    img[59:61, 30:130] = 190                                  # its light internal line, centre y = 60.0
    f = linefit.page_features(img, stroke=4.0)
    light = f.p[(f.kind == 1) & (f.p[:, 0] > 40) & (f.p[:, 0] < 120)]
    assert len(light) > 60 and np.abs(light[:, 1] - 60.0).max() < 0.3


def test_a_filled_dark_face_gives_its_outline_not_its_inside():
    from coordnet import linefit
    img = _page()
    img[30:90, 40:120] = 30
    f = linefit.page_features(img, stroke=4.0)
    inside = (f.p[:, 0] > 50) & (f.p[:, 0] < 110) & (f.p[:, 1] > 40) & (f.p[:, 1] < 80)
    assert not inside.any()
    top = f.p[(f.p[:, 0] > 50) & (f.p[:, 0] < 110) & (f.p[:, 1] < 40)]
    assert len(top) > 40 and np.abs(top[:, 1] - 30.0).max() < 0.75    # the silhouette, at the step


def test_the_red_new_part_band_is_not_a_page_line():
    from coordnet import linefit
    img = _page()
    img[59:62, 20:140] = (205, 30, 38)
    f = linefit.page_features(img, stroke=4.0)
    assert not ((f.p[:, 1] > 55) & (f.p[:, 1] < 66)).any()


# --- refinement -------------------------------------------------------------------------------------------------

from test_coordnet_realdata import TRUE_CAM          # noqa: E402

PW, PH = 600, 460


def _true_page(style=None):
    from coordnet import render as R
    parts = _parts()
    centre = R.bounds_centre(parts)
    pic = R.render(parts, set(), TRUE_CAM, centre, PW, PH, style or R.Style(), ss=2, red=False).picture
    return parts, centre, pic


def _drawn_error(parts, centre, cam):
    """Mean distance between where `cam` and the true camera draw the model's visible line samples (px)."""
    from coordnet import render as R
    g = R.gbuffer(*R.scene(parts), TRUE_CAM, centre, PW, PH)
    s = R.visible_line_samples(*R.scene_lines(parts), g, TRUE_CAM, centre, 1)
    a, _ = project(cam, centre, s.X)
    return float(np.linalg.norm(a - s.uv, axis=1).mean())


def test_refine_recovers_the_camera_from_a_nearby_start():
    from coordnet import linefit
    parts, centre, pic = _true_page()
    start = TRUE_CAM.with_(cx=TRUE_CAM.cx + 1.5, cy=TRUE_CAM.cy - 1, yaw=TRUE_CAM.yaw + 0.5)
    assert _drawn_error(parts, centre, start) > 1.5
    r = linefit.refine(linefit.page_features(pic), parts, start, centre, PW, PH, print_scale=TRUE_CAM.scale)
    assert r is not None and _drawn_error(parts, centre, r.cam) < 0.5
    assert r.cover > 0.8


def test_refine_ignores_the_palette():
    from coordnet import linefit
    from coordnet import render as R
    parts, centre, pic = _true_page()
    page = np.clip(pic[..., [2, 0, 1]].astype(int) * 0.7 + 50, 0, 255).astype(np.uint8)
    start = TRUE_CAM.with_(cx=TRUE_CAM.cx + 1.5, yaw=TRUE_CAM.yaw - 0.5)
    r = linefit.refine(linefit.page_features(page), parts, start, centre, PW, PH, print_scale=TRUE_CAM.scale)
    assert r is not None and _drawn_error(parts, centre, r.cam) < 0.5


def test_refine_with_no_page_lines_returns_none():
    from coordnet import linefit
    parts, centre, _pic = _true_page()
    blank = np.full((PH, PW, 3), 137, np.uint8)
    assert linefit.refine(linefit.page_features(blank), parts, TRUE_CAM, centre, PW, PH,
                          print_scale=TRUE_CAM.scale) is None


# --- coarse search + fit ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("off", [dict(cx=6, cy=-4, yaw=3, pitch=-2), dict(cx=44, cy=0, yaw=0, pitch=0),
                                 dict(cx=-30, cy=25, yaw=-3, pitch=3)])
def test_fit_view_recovers_the_camera_from_a_framed_start(off):
    """A standard view framed on the page is off by up to a stud pitch (20 LDU = 44 px here) and a few degrees;
    the coarse search must not settle on a neighbouring stud."""
    from coordnet import linefit
    parts, centre, pic = _true_page()
    start = TRUE_CAM.with_(cx=TRUE_CAM.cx + off["cx"], cy=TRUE_CAM.cy + off["cy"], yaw=TRUE_CAM.yaw + off["yaw"],
                           pitch=TRUE_CAM.pitch + off["pitch"])
    fits = linefit.fit_view(linefit.page_features(pic), parts, start, centre, PW, PH, print_scale=TRUE_CAM.scale)
    assert fits and _drawn_error(parts, centre, fits[0].cam) < 0.5


def test_coarse_candidates_are_distinct():
    from coordnet import linefit
    parts, centre, pic = _true_page()
    c = linefit.coarse(linefit.page_features(pic), parts, TRUE_CAM.with_(cx=TRUE_CAM.cx + 10), centre, PW, PH, k=3)
    for i in range(len(c)):
        for j in range(i + 1, len(c)):
            a, b = c[i][1], c[j][1]
            assert abs(a.cx - b.cx) + abs(a.cy - b.cy) >= 3 or abs(a.yaw - b.yaw) + abs(a.pitch - b.pitch) > 0.5


def test_page_with_very_many_edges_does_not_crash():
    """A real page gave > 32767 step candidates, beyond cv2.remap's map size limit."""
    from coordnet import linefit
    yy, xx = np.mgrid[:640, :640]
    img = np.repeat((((yy // 5) + (xx // 5)) % 2 * 160 + 40).astype(np.uint8)[..., None], 3, 2)
    f = linefit.page_features(img, stroke=4.0)
    assert len(f.p) > 0


# --- view from line directions ----------------------------------------------------------------------------------

def _ang(a, b, period):
    d = (a - b) % period
    return min(d, period - d)


@pytest.mark.parametrize("cam", [TRUE_CAM, TRUE_CAM.with_(yaw=145, pitch=35, roll=0, turned=True)])
def test_view_angles_read_yaw_and_pitch_off_the_line_directions(cam):
    """Edges of a brick model run along three axes; their drawn directions fix yaw (up to a quarter turn) and
    pitch without any translation or colour."""
    from coordnet import linefit
    from coordnet import render as R
    parts = _parts()
    centre = R.bounds_centre(parts)
    pic = R.render(parts, set(), cam, centre, PW, PH, R.Style(), ss=2, red=False).picture
    page = np.clip(pic[..., [2, 0, 1]].astype(int) * 0.7 + 50, 0, 255).astype(np.uint8)
    yaw, pitch, _roll = linefit.view_angles(linefit.page_features(page), parts, centre, cam.scale)[0]
    assert _ang(yaw, cam.yaw, 90) <= 2.0 and abs(pitch - cam.pitch) <= 3.0


def test_search_finds_the_camera_with_no_start():
    from coordnet import linefit
    from coordnet import realdata
    parts, centre, pic = _true_page()
    fg = ~realdata.paper_mask(pic)
    fits = linefit.search(linefit.page_features(pic), parts, centre, PW, PH, TRUE_CAM.scale, fg)
    assert fits and _drawn_error(parts, centre, fits[0].cam) < 0.5


def test_search_from_the_section_view_tries_it_first():
    from coordnet import linefit
    from coordnet import realdata
    parts, centre, pic = _true_page()
    fg = ~realdata.paper_mask(pic)
    start = TRUE_CAM.with_(cx=TRUE_CAM.cx + 9, cy=TRUE_CAM.cy - 5, yaw=TRUE_CAM.yaw + 2)
    fits = linefit.search(linefit.page_features(pic), parts, centre, PW, PH, TRUE_CAM.scale, fg, start=start)
    assert fits and _drawn_error(parts, centre, fits[0].cam) < 0.5


def test_view_angles_find_a_tilted_model_over_the_full_circle():
    """Codex: a model that is not axis-aligned to the camera's turntable has no quarter-turn symmetry."""
    from coordnet import linefit
    from coordnet import render as R
    c, s = np.cos(np.radians(25)), np.sin(np.radians(25))
    Rz = np.array([[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1.0]])
    parts = [(p, col, Rz @ np.asarray(m, float)) for p, col, m in _parts()]
    centre = R.bounds_centre(parts)
    cam = TRUE_CAM.with_(yaw=145, pitch=35, roll=0)
    pic = R.render(parts, set(), cam, centre, PW, PH, R.Style(), ss=2, red=False).picture
    cands = linefit.view_angles(linefit.page_features(pic), parts, centre, cam.scale, k=4)
    assert any(_ang(y, 145, 360) <= 2.0 and abs(p - 35) <= 3.0 for y, p, _r in cands)


def test_search_refines_every_view_not_just_the_best_coarse_scores(monkeypatch):
    from coordnet import linefit
    from coordnet import realdata
    parts, centre, pic = _true_page()
    refined = []
    real = linefit.refine
    monkeypatch.setattr(linefit, "refine", lambda feat, parts, cam, *a, **k: (refined.append(cam), real(feat, parts, cam, *a, **k))[1])
    linefit.search(linefit.page_features(pic), parts, centre, PW, PH, TRUE_CAM.scale, ~realdata.paper_mask(pic))
    views = {(int(((c.yaw - refined[0].yaw + 45) % 360) // 90), c.turned) for c in refined}   # quarter turn, turned
    assert len(views) == 8


@pytest.mark.parametrize("roll", [3.0, -3.0])        # larger roll: unsupported (booklets: ~0)
def test_search_handles_a_rolled_page(roll):
    """Big Pickle: roll rotates every drawn direction; unmodelled, it shifts the yaw estimate. (The direction
    histogram is only a start: hidden model edges bias it by a few degrees on small models.)"""
    from coordnet import linefit
    from coordnet import realdata
    from coordnet import render as R
    parts = _parts()
    centre = R.bounds_centre(parts)
    cam = TRUE_CAM.with_(roll=roll)
    pic = R.render(parts, set(), cam, centre, PW, PH, R.Style(), ss=2, red=False).picture
    feat = linefit.page_features(pic)
    fits = linefit.search(feat, parts, centre, PW, PH, cam.scale, ~realdata.paper_mask(pic))
    g = R.gbuffer(*R.scene(parts), cam, centre, PW, PH)
    s = R.visible_line_samples(*R.scene_lines(parts), g, cam, centre, 1)
    err = float(np.linalg.norm(project(fits[0].cam, centre, s.X)[0] - s.uv, axis=1).mean())
    assert err < 0.5


def test_refine_keeps_the_eye_and_the_scale_within_three_percent():
    from coordnet import linefit
    from coordnet import render as R
    parts = _parts()
    centre = R.bounds_centre(parts)
    page_cam = TRUE_CAM.with_(scale=TRUE_CAM.scale * 1.05, eye=3000)
    pic = R.render(parts, set(), page_cam, centre, PW, PH, R.Style(), ss=2, red=False).picture
    r = linefit.refine(linefit.page_features(pic), parts, TRUE_CAM, centre, PW, PH, print_scale=TRUE_CAM.scale)
    assert r is not None and r.cam.eye == TRUE_CAM.eye
    assert abs(r.cam.scale / TRUE_CAM.scale - 1) <= 0.03 + 1e-9
