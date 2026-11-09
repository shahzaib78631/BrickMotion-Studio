"""Experiment 2's baselines (python/lab/baselines.py): real val sets and the app's Sketch model."""
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'bricknet'))

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
BIN = Path(HERE).parent / 'public' / 'data' / 'ai' / 'shape2.bin'


def test_real_model_matches_the_val_set():
    import decode
    from lab.baselines import real_model
    arrs = decode.load(D / 'val.npz')
    stems, colours, poses = real_model(0)
    n = int(arrs['node_ptr'][1] - arrs['node_ptr'][0])
    assert 0 < len(stems) <= n and len(stems) == len(colours) == len(poses)
    assert all(p.shape == (4, 4) for p in poses)


@pytest.mark.skipif(not BIN.exists(), reason='needs public/data/ai/shape2.bin')
def test_sketch_writes_plates_in_its_colours():
    from lab.baselines import Sketch
    from lab.render import Scorer
    f = BIN.open('rb')
    colours = json.loads(f.read(struct.unpack('<I', f.read(4))[0]))['config']['colours']
    vec = Scorer('cpu').text(['a red car'])[0]
    stems, cols, poses = Sketch(device='cpu').model(vec, seed=0)
    assert len(stems) >= 10 and set(stems) == {'3024'}
    assert set(cols) <= set(colours) | {71}
    ys = {round(p[1, 3]) for p in poses}
    assert all(y % 8 == 0 for y in ys)  # whole plates
