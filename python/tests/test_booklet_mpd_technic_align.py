"""technic._align: a rotation taking unit vector a onto b, including nearly opposite vectors."""
import numpy as np

from booklet_mpd.solver.technic import _align


def test_align_nearly_opposite_vectors():
    a = np.array([0.0, 0.0, 1.0])
    b = np.array([1e-8, 0.0, -1.0])
    b /= np.linalg.norm(b)
    r = _align(a, b)
    assert np.isfinite(r).all()
    assert np.allclose(r @ a, b, atol=1e-6)
    assert np.allclose(r @ r.T, np.eye(3), atol=1e-6)


def test_align_general_and_opposite():
    for a, b in [((1, 0, 0), (0, 1, 0)), ((0, 1, 0), (0, -1, 0)), ((1, 0, 0), (1, 0, 0))]:
        a, b = np.array(a, float), np.array(b, float)
        r = _align(a, b)
        assert np.allclose(r @ a, b) and np.allclose(r @ r.T, np.eye(3))
