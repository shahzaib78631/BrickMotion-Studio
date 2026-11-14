"""P5: a learned callout <-> parts-list matcher. Pictures are normalised the same way on light and dark pages,
and the embedding is unit length, so callouts and parts-list entries compare by cosine."""
from pathlib import Path

import cv2
import numpy as np
import torch

from booklet_mpd.solver.partsnet import PATCH, Net, patch

D = Path(__file__).parent / "data" / "dark-page"


def test_patch_is_square_on_white_whatever_the_page():
    p = patch(cv2.imread(str(D / "callout-3666-378.png"))[:, :, ::-1].copy())
    assert p.shape == (PATCH, PATCH, 3) and p.dtype == np.uint8
    assert (p[0, 0] == 255).all() and (p[-1, -1] == 255).all()      # the black page became white
    assert (p < 200).any()                                              # the piece is still there


def test_embedding_is_unit_length():
    x = torch.rand(3, 3, PATCH, PATCH)
    z = Net()(x)
    assert z.shape == (3, 128) and torch.allclose(z.norm(dim=1), torch.ones(3), atol=1e-4)


def test_learned_similarity_breaks_hand_made_ties():
    """Two look-alike entries the hand-made similarity can't tell apart: the learned score decides."""
    from booklet_mpd.solver.parts import Descriptor, assign
    m = np.zeros((64, 64), bool)
    m[16:48, 8:56] = True
    d = Descriptor(m, np.array([100.0, 100.0, 100.0]), 1.5, 30.0)
    learned = {"g": np.array([0.1, 0.9])}
    out = assign({"g": d}, {"g": 1}, [d, d], [1, 1], learned=learned)
    assert out["g"][0] == 1
