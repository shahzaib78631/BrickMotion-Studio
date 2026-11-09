"""Experiment 1's runner (python/lab/exp1.py), on an untrained builder and a few short models."""
import json
import os
import sys
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')
pytestmark = pytest.mark.skipif(not (LAB / 'vocab.json').exists(), reason='run python -m lab.dataset val first')


def test_runs_judges_and_reports(tmp_path):
    import torch
    from lab.builder import Builder
    from lab.exp1 import run
    from lab.sequence import Vocab
    torch.manual_seed(0)
    vocab = Vocab.load(LAB / 'vocab.json')
    model = Builder(vocab.size, width=64, layers=2, heads=4).eval()
    runs = run(n=2, steps=12, out=tmp_path, model=model, vocab=vocab)
    assert [r['mode'] for r in runs] == ['legal', 'free', 'legal', 'free']
    for r in runs:
        assert (tmp_path / r['file']).read_text().count('\n1 ') == r['parts']
        assert 'BrickNet' in (tmp_path / r['file']).read_text()
    legal = [r for r in runs if r['mode'] == 'legal']
    assert all(r['parts'] == 12 and r['python_overlaps'] == [] for r in legal)
    assert all(isinstance(r['app_overlaps'], list) for r in runs)
    assert json.loads((tmp_path / 'exp1.json').read_text()) == runs
    rep = (tmp_path / 'report.md').read_text()
    assert 'Pass' in rep and 'BrickNet' in rep
