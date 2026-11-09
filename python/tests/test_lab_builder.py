"""Training data and the builder model (python/lab/dataset.py, python/lab/builder.py)."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
pytestmark = pytest.mark.skipif(not (D / 'val.npz').exists(), reason='BrickNet data not here')


@pytest.fixture(scope='module')
def built(tmp_path_factory):
    from lab.dataset import build
    out = tmp_path_factory.mktemp('lab')
    return build('val', out_dir=out, roots=2), out


def test_dataset_counts(built):
    path, _ = built
    d = np.load(path)
    assert len(np.unique(d['model'])) >= 0.95 * 512
    assert len(d['ptr']) - 1 == len(d['model'])


def test_tokens_in_vocab(built):
    from lab.sequence import Vocab
    path, out = built
    d = np.load(path)
    v = Vocab.load(out / 'vocab.json')
    t, p = d['tokens'], d['ptr']
    assert t.max() < v.size and t.min() >= 0
    for a, b in zip(p[:-1][:200], p[1:][:200]):
        assert t[a] == v.BOS and t[b - 1] == v.EOS and (b - a - 2) % 10 == 0


def test_builder_shapes():
    import torch
    from lab.builder import Builder
    m = Builder(vocab_size=500, width=64, layers=2, heads=4)
    tok = torch.randint(0, 500, (2, 31))
    assert m(torch.randn(2, 512), tok).shape == (2, 31, 500)


def test_builder_overfits_8_models(built):
    import torch
    from lab.builder import Builder
    from lab.dataset import SeqData, collate
    from lab.sequence import Vocab
    path, out = built
    v = Vocab.load(out / 'vocab.json')
    data = SeqData(path, np.load(out / 'clip_val.npy'), np.load(out / 'clip_val_model.npy'))
    batch = collate([data[i] for i in range(8)])
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    torch.manual_seed(0)
    m = Builder(v.size, width=128, layers=2, heads=4).to(dev)
    opt = torch.optim.AdamW(m.parameters(), lr=2e-3)
    clip, tok = batch[0].to(dev), batch[1].to(dev)
    for _ in range(300):
        loss = m.loss(clip, tok)
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert loss.item() < 0.5
