"""Experiment 2's runner (python/lab/exp2.py): every method's model, its contact sheet, collision verdicts."""
import json
import os
import sys
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')
pytestmark = pytest.mark.skipif(not (LAB / 'lab.pt').exists(), reason='needs the trained builder lab.pt')


def test_runs_every_method_and_draws_sheets(tmp_path):
    from lab.exp2 import run
    rows = run(runs=2, every=4, max_parts=8, out=tmp_path, methods=('real', 'single', 'smc'), device='cpu',
               rows_wanted=[9, 40], log=lambda *a, **k: None)
    assert [r['row'] for r in rows] == [9, 40]
    for j, r in enumerate(rows):
        for k in ('real', 'single', 'smc'):
            assert (tmp_path / f'{k}_{j:02d}.ldr').exists() and r[k]['parts'] >= 1
        for k in ('single', 'smc'):
            assert isinstance(r[k]['app_overlaps'], list) and r[k]['python_overlaps'] == []
        assert (tmp_path / f'sheet_{j:02d}.png').exists()
    assert (tmp_path / 'overview.png').exists()
    assert json.loads((tmp_path / 'exp2.json').read_text()) == rows
    again = run(runs=2, every=4, max_parts=8, out=tmp_path, methods=('real', 'single', 'smc'), device='cpu',
                rows_wanted=[9, 40], log=lambda *a, **k: (_ for _ in ()).throw(AssertionError('redid work')))
    assert again == rows  # resumes: nothing redone
