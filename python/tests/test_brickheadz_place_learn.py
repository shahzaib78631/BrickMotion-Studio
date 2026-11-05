"""Path-B learned placement scorer: dataset, training, and inference shape."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assembly_model.ldraw import load_library
from brickheadz import place_learn as PL
from brickheadz.builder import build_figure
from brickheadz.export import normalize
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.spec import random_spec

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "..", "..", "public", "ldraw")
LDCONFIG = os.path.join(LIB, "LDConfig.ldr")


def test_train_and_score_separates():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(400, len(PL.FEATURES)))
    Y = (X[:, 0] > 0.2).astype(float)  # learnable rule
    model = PL.train(X, Y, epochs=800, lr=0.5, l2=1e-3)
    assert len(model["w"]) == len(PL.FEATURES)
    pos = X[Y == 1][0]
    neg = X[Y == 0][0]
    assert PL.score(model, pos) > PL.score(model, neg)


def test_save_load_roundtrip(tmp_path):
    model = {"w": [1.0] * len(PL.FEATURES), "b": 0.0, "mu": [0.0] * len(PL.FEATURES), "sd": [1.0] * len(PL.FEATURES), "features": PL.FEATURES}
    path = str(tmp_path / "m.json")
    PL.save(model, path)
    loaded = PL.load(path)
    x = np.ones(len(PL.FEATURES))
    assert abs(PL.score(loaded, x) - PL.score(model, x)) < 1e-12
    assert 0.0 <= PL.score(loaded, x) <= 1.0


def test_dataset_shapes(tmp_path):
    lib = load_library(LIB)
    palette = ldconfig_rgb(LDCONFIG)
    models = []
    rng = random = __import__("random").Random(3)
    for _ in range(2):
        try:
            models.append(normalize(build_figure(lib, random_spec(rng)).model))
        except Exception:
            pass
    if not models:
        return
    X, Y = PL.build_dataset(lib, palette, models, size=96, steps_per_model=3, neg_per_part=3, seed=0)
    assert X.ndim == 2 and X.shape[1] == len(PL.FEATURES)
    assert X.shape[0] == Y.shape[0] and set(np.unique(Y)).issubset({0.0, 1.0})
