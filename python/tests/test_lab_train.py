"""Training the builder: resumes from its checkpoint, exports loadable weights (python/lab/train.py)."""
import os
import shutil
import sys
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')
pytestmark = pytest.mark.skipif(not (LAB / 'tokens_val.npz').exists(), reason='run python -m lab.dataset val first')
TINY = dict(width=64, layers=2, heads=4)


@pytest.fixture()
def work(tmp_path):
    for f in ['tokens_val.npz', 'clip_val.npy', 'clip_val_model.npy', 'vocab.json']:
        shutil.copy(LAB / f, tmp_path / f)
    return tmp_path


def run(work, steps):
    from lab.train import train
    # the val split stands in for sft here: train and test on the same small set
    return train(work, steps=steps, batch=8, every=20, train_split='val', model_kw=TINY)


def test_smoke_train_and_resume(work):
    import torch
    run(work, 40)
    assert torch.load(work / 'lab.ckpt', weights_only=False)['step'] == 40
    assert (work / 'lab.best.pt').exists()
    log = run(work, 60)
    assert log['resumed_from'] == 40
    assert torch.load(work / 'lab.ckpt', weights_only=False)['step'] == 60


def test_export_loads(work):
    import torch
    from lab.dataset import SeqData, collate
    from lab.train import export, load_builder
    import numpy as np
    run(work, 20)
    best = torch.load(work / 'lab.best.pt', weights_only=False)
    out = export(work, work / 'lab.pt')
    m, vocab = load_builder(out)
    data = SeqData(work / 'tokens_val.npz', np.load(work / 'clip_val.npy'), np.load(work / 'clip_val_model.npy'))
    clip, tok = collate([data[i] for i in range(4)])
    from lab.builder import Builder
    ref = Builder(**best['config'])
    ref.load_state_dict(best['model'])
    ref.eval()
    with torch.no_grad():
        a, b = m(clip, tok).float(), ref(clip, tok)
    assert (a - b).abs().max().item() < 2e-2 * max(1.0, b.abs().max().item())
    assert vocab.size == m.config['vocab_size']


def test_time_limit_still_keeps_best(work):
    from lab.train import train
    train(work, steps=1000, batch=8, every=500, minutes=0.0, train_split='val', model_kw=TINY)
    assert (work / 'lab.best.pt').exists()
