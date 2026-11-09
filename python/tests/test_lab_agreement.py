"""Python's overlap test against the editor's collision world on real and shifted parts (lab/agreement.py)."""
import os
import sys
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

pytestmark = pytest.mark.skipif(not Path('/Users/mac/Projects/BrickMotion-Data/lab/compat.json').exists(),
                                reason='run python -m lab.connectors first')


@pytest.fixture(scope='module')
def verdicts():
    from lab.agreement import run
    return run(n_models=150)


def rate(vs, key):
    return sum(v[key] for v in vs) / max(1, len(vs))


def test_real_parts_pass_python(verdicts):
    real = [v for v in verdicts if v['case'] == 'real']
    print(f"real: python flags {rate(real, 'python'):.3f}, app flags {rate(real, 'app'):.3f}")
    assert rate(real, 'python') <= 0.06


def test_python_catches_what_the_app_sees(verdicts):
    """Shifted parts the app finds inside a neighbour: Python must find them too."""
    hit = [v for v in verdicts if v['case'] == 'shifted' and v['app']]
    print(f"shifted with app overlap: {len(hit)}, python agrees {rate(hit, 'python'):.3f}")
    assert len(hit) >= 30
    assert rate(hit, 'python') >= 0.85
