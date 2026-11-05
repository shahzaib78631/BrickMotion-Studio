"""Path-B CNN candidate-verifier: plumbing, learning, and save/load."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytest.importorskip("torch")

from brickheadz import verify_learn as VL


def test_patch_and_net_shapes():
    rng = np.random.default_rng(0)
    X = rng.random((48, VL.CHANNELS, VL.PATCH, VL.PATCH)).astype(np.float32)
    Y = (X[:, 2].mean(axis=(1, 2)) > 0.5).astype(np.float32)
    net = VL.train(X, Y, epochs=6, batch=16)
    p = VL.predict(net, X)
    assert p.shape == (48,)
    assert p.min() >= 0.0 and p.max() <= 1.0
    acc = ((p > 0.5).astype(float) == Y).mean()
    assert acc > 0.8  # separable toy rule


def test_save_load_roundtrip(tmp_path):
    net = VL.make_net()
    path = str(tmp_path / "v.pt")
    VL.save(net, path)
    net2 = VL.load(path)
    x = np.zeros((1, VL.CHANNELS, VL.PATCH, VL.PATCH), np.float32)
    assert abs(float(VL.predict(net, x)[0]) - float(VL.predict(net2, x)[0])) < 1e-6
