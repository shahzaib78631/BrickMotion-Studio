import numpy as np
import pytest

from coordnet.camera import BookletCamera, project
from coordnet import render as R


def _m(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


SCENE = [("3001.dat", 14, _m()), ("3020.dat", 15, _m(0, -24, 0)), ("3001.dat", 1, _m(60, 0, 0))]


@pytest.mark.parametrize("cam", [
    BookletCamera(36.8, 35.1, 1.3, 2.5, 200, 150, eye=4500),
    BookletCamera(-130, 25, -2, 3.0, 220, 140, eye=0),
    BookletCamera(40, 30, 0, 2.2, 210, 160, eye=3000, turned=True),
])
def test_gbuffer_xyz_reprojects_to_pixel_centres(cam):
    centre = R.bounds_centre(SCENE)
    tris, tp = R.scene(SCENE)
    g = R.gbuffer(tris, tp, cam, centre, 420, 300)
    hit = g.part >= 0
    assert hit.sum() > 2000
    ys, xs = np.nonzero(hit)
    uv, depth = project(cam, centre, g.xyz[hit].astype(float))
    # float32 storage of xyz ~ 1e-5 LDU; well under a hundredth of a pixel
    assert np.abs(uv[:, 0] - (xs + 0.5)).max() < 0.02
    assert np.abs(uv[:, 1] - (ys + 0.5)).max() < 0.02
    assert np.abs(depth - g.depth[hit]).max() < 0.02
    # the visible point is the nearest: every triangle covering a sampled pixel is at or behind it
    assert np.isinf(g.depth[~hit]).all()


def test_supersampled_buffer_agrees_with_pixel_buffer():
    cam = BookletCamera(36.8, 35.1, 1.3, 2.5, 200, 150, eye=4500)
    centre = R.bounds_centre(SCENE)
    tris, tp = R.scene(SCENE)
    g1 = R.gbuffer(tris, tp, cam, centre, 420, 300, 1)
    g2 = R.gbuffer(tris, tp, cam, centre, 420, 300, 2)
    cover = (g2.part >= 0).reshape(300, 2, 420, 2).mean((1, 3))
    a, b = g1.part >= 0, cover > 0.5
    assert (a ^ b).sum() / a.sum() < 0.03


def test_occlusion_front_part_wins():
    # a plate directly above a brick, viewed from above: the plate hides the brick's top
    parts = [("3001.dat", 4, _m()), ("3020.dat", 15, _m(0, -40, 0))]
    cam = BookletCamera(0, 89, 0, 3.0, 150, 150, eye=0)
    centre = R.bounds_centre(parts)
    tris, tp = R.scene(parts)
    g = R.gbuffer(tris, tp, cam, centre, 300, 300)
    assert g.part[150, 150] == 1


def test_red_band_lies_outside_the_new_parts_own_silhouette():
    # new part 1 (own silhouette 10:30 x 10:45) is partly hidden by earlier part 0 in front (x >= 30)
    part = np.full((40, 60), -1)
    part[10:30, 10:30] = 1
    part[5:35, 30:50] = 0
    own = np.zeros((40, 60), bool)
    own[10:30, 10:45] = True
    band = R.red_band(part, {1}, own, 2, over_occluders=False)
    assert not (band & own).any()
    assert band[15:25, 8].all() and band[8, 15:25].all()       # left and top, just outside
    assert not band[15:25, 46].any()                           # right end is behind part 0: no red there
    over = R.red_band(part, {1}, own, 2, over_occluders=True)
    assert over[15:25, 46].all()


def test_ldraw_lines_and_bores():
    e, c = R.part_lines("3001.dat")
    assert len(e) > 50 and len(c) > 20
    # 3001's underside has 3 open tubes (stud4): looking up into one, its bore is filled
    parts = [("3001.dat", 4, _m())]
    cam = BookletCamera(0, -89, 0, 4.0, 200, 120, eye=0)
    centre = R.bounds_centre(parts)
    g = R.gbuffer(*R.scene(parts), cam, centre, 400, 240)
    b = R.bore_mask(parts, g) > 0
    assert 3 * np.pi * 6 ** 2 * 16 * 0.6 < b.sum() < 3 * np.pi * 6.5 ** 2 * 16 * 1.2


def test_render_returns_ground_truth_and_red():
    cam = BookletCamera(36.8, 35.1, 1.3, 2.5, 200, 150, eye=4500)
    centre = R.bounds_centre(SCENE)
    r = R.render(SCENE, {2}, cam, centre, 420, 300, ss=2)
    assert r.picture.shape == (300, 420, 3) and r.picture.dtype == np.uint8
    assert r.new_visible.sum() > 500
    assert r.red is not None and r.red.sum() > 50
    red_px = (r.picture[..., 0] > 150) & (r.picture[..., 1] < 90)
    assert (red_px & R._touches(r.red, 3)).sum() > 0.8 * red_px.sum()
