"""Synthetic placement dataset: pictures, base renders and part-local labels."""
import json

import numpy as np
import pytest
import torch

from coordnet import datagen, placedata


@pytest.fixture(scope="module")
def samples():
    files = datagen.model_files()[:40]
    out = []
    seed = 0
    while len(out) < 20 and seed < 200:
        s = placedata.sample(seed, files)
        seed += 1
        if s is not None:
            out.append(s)
    assert len(out) == 20
    return out


def test_sample_labels_are_consistent(tmp_path, samples):
    placedata.write(tmp_path, 0, samples[0])
    item = placedata.PlaceDataset([tmp_path], crop=(256, 256), train=False)[0]
    new = item["new"] > 0.5
    assert new.sum() > 50
    assert torch.isfinite(item["local"]).all()
    assert (item["local"][:, ~new] == 0).all()
    assert item["picture"].shape == (3, 256, 256) and item["evidence"].shape == (1, 256, 256)
    assert set(torch.unique(item["sym"][new]).tolist()) <= {1, 2, 4}
    meta = json.loads((tmp_path / "00000.json").read_text())
    assert sum(n for _p, _c, n in meta["types"]) == sum(1 for p in meta["parts"] if p[3])


def test_local_labels_survive_the_int16_round_trip(tmp_path, samples):
    s = samples[1]
    placedata.write(tmp_path, 0, s)
    lab = np.load(tmp_path / "00000.labels.npz")
    sel = s["labels"]["new"]
    back = lab["local"].transpose(1, 2, 0)[sel] / 4.0
    assert np.abs(back - s["labels"]["local"][sel]).max() <= 0.125 + 1e-6


def test_shard_size_budget(tmp_path, samples):
    for k, s in enumerate(samples):
        placedata.write(tmp_path, k, s)
    total = sum(p.stat().st_size for p in tmp_path.iterdir())
    assert total / len(samples) < 160_000, total / len(samples)
