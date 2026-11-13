"""Part-local labels and part symmetry for lattice-vote placement."""
import numpy as np

from coordnet import labels
from coordnet import render as R
from coordnet.camera import BookletCamera


def _m(x=0.0, y=0.0, z=0.0, yaw=0):
    m = np.eye(4)
    a = np.radians(yaw)
    m[:3, :3] = [[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]]
    m[:3, 3] = (x, y, z)
    return m


def test_sym_order_known_parts():
    assert labels.sym_order("3024.dat") == 4      # 1x1 plate
    assert labels.sym_order("3020.dat") == 2      # 2x4 plate
    assert labels.sym_order("3040.dat") == 1      # 1x2 slope


def test_local_labels_invert_the_part_matrix():
    parts = [("3020.dat", 4, _m(40, -8, 20, yaw=90)), ("3958.dat", 72, _m(0, 0, 0))]
    cam = BookletCamera(36, 33, 0.8, 3.0, 230, 170, eye=4500)
    centre = R.bounds_centre(parts)
    g = R.gbuffer(*R.scene(parts), cam, centre, 460, 340)
    lab = labels.local_labels(g, parts, {0})
    sel = lab["new"]
    assert sel.sum() > 200
    m = parts[0][2]
    w = lab["local"][sel] @ m[:3, :3].T + m[:3, 3]
    assert np.abs(w - g.xyz[sel]).max() < 1e-3
    assert np.allclose(lab["size"][sel][0], labels.part_box("3020.dat"))
    assert np.isnan(lab["local"][~sel]).all()
    assert (lab["inst"][sel] == 0).all() and (lab["inst"][g.part == 1] == 1).all()


def test_canonical_has_one_entry_per_symmetry():
    u = np.array([[30.0, 0.0, 10.0]])
    c = labels.canonical(u, 2)
    assert c.shape == (2, 1, 3) and np.allclose(c[1, 0], [-30.0, 0.0, -10.0])
    c4 = labels.canonical(u, 4)
    assert c4.shape == (4, 1, 3) and np.allclose(c4[0, 0], u[0])


def test_centre_targets_point_at_the_projected_part_centre():
    from coordnet import render as R
    from coordnet.camera import BookletCamera, project
    cam = BookletCamera(36, 33, 0.8, 3.0, 230, 170, eye=4500)
    m = np.eye(4); m[:3, 3] = (0, 0, 0)
    t = np.eye(4); t[:3, :3] = labels._yaw(90); t[:3, 3] = (20, -8, 10)       # 2x4 plate turned to run along x
    model = [("3958.dat", 72, m), ("3020.dat", 0, t)]
    centre = R.bounds_centre(model)
    g = R.gbuffer(*R.scene(model), cam, centre, 460, 340)
    lab = labels.local_labels(g, model, {1})
    off, ext = labels.centre_targets(lab["inst"], lab["new"], model, cam, centre)
    ys, xs = np.nonzero(lab["new"])
    assert len(xs) > 100
    c_world = t[:3, 3] + t[:3, :3] @ labels.part_centre("3020.dat")
    cuv = project(cam, centre, c_world[None])[0][0]
    pred = np.stack([xs + 0.5, ys + 0.5], 1) + off[ys, xs] * cam.scale
    assert np.abs(pred - cuv).max() < 1e-3                  # every pixel leads to the same point...
    assert off[ys, xs].std(0).min() > 1.0                    # ...through a per-pixel offset
    box = labels.part_box("3020.dat")
    assert np.allclose(ext[ys[0], xs[0]], [box[2], box[1], box[0]], atol=1e-3)   # turned: x and z swap
    assert (off[~lab["new"]] == 0).all() and (ext[~lab["new"]] == 0).all()


def test_camera_channels_describe_the_world_axes():
    from coordnet.camera import BookletCamera
    a = labels.camera_channels(BookletCamera(35, 35, 0, 2.0, 0, 0, eye=4200), np.zeros(3))
    b = labels.camera_channels(BookletCamera(125, 35, 0, 2.0, 0, 0, eye=4200), np.zeros(3))
    assert a.shape == (6,) and np.isfinite(a).all()
    ortho = labels.camera_channels(BookletCamera(35, 35, 0, 2.0, 0, 0, eye=0), np.zeros(3))
    near = labels.camera_channels(BookletCamera(35, 35, 0, 2.0, 0, 0, eye=2000), np.zeros(3))
    assert ortho[5] == 0 and near[5] > a[5] > 0          # perspective strength: 1000 / eye
    assert np.abs(a[:4] - b[:4]).max() > 0.5            # a quarter turn changes where world x and z point
