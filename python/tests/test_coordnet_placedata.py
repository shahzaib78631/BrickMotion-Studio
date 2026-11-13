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
    assert torch.isfinite(item["offset"]).all() and (item["offset"][:, ~new] == 0).all()
    assert item["offset"].shape == (2, 256, 256)
    assert item["camera"].shape == (6,) and torch.isfinite(item["camera"]).all()
    assert item["picture"].shape == (3, 256, 256) and item["evidence"].shape == (1, 256, 256)
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


def test_offsets_are_unchanged_by_the_crop(tmp_path, samples):
    from coordnet import labels
    from coordnet.camera import BookletCamera
    s = samples[2]
    placedata.write(tmp_path, 0, s)
    item = placedata.PlaceDataset([tmp_path], crop=(192, 224), train=True, seed=3)[0]
    meta = json.loads((tmp_path / "00000.json").read_text())
    lab = np.load(tmp_path / "00000.labels.npz")
    parts = [(p, c, np.array(m, float)) for p, c, m, _n in meta["parts"]]
    full, _ext = labels.centre_targets(lab["inst"].astype(int), lab["new"].astype(bool), parts,
                                       BookletCamera(**meta["cam"]), np.array(meta["centre"]))
    top, left = item["origin"].tolist()
    H, W = full.shape[:2]
    win = np.zeros((192, 224, 2), np.float32)
    ys, xs = np.mgrid[0:192, 0:224]
    inside = (ys + top >= 0) & (ys + top < H) & (xs + left >= 0) & (xs + left < W)
    win[inside] = full[(ys + top)[inside], (xs + left)[inside]]
    assert item["new"].sum() > 20
    assert np.abs(item["offset"].numpy().transpose(1, 2, 0) - win).max() < 1e-4
