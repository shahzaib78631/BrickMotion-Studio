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
