"""Bundle Brick Lab's builder training (data + code) for a free Kaggle GPU.

    python -m lab.kaggle_bundle [OUT_DIR]   (from python/; default BrickMotion-Data/kaggle-lab)

Writes OUT_DIR/brickmotion-lab-data.zip (upload as a private Kaggle dataset) and
OUT_DIR/brickmotion-lab-train.ipynb (import as a notebook, add the dataset, run). The notebook builds
the step tokens, trains the builder, and leaves lab.pt in its output.
Data: BrickNet (Kulits & Schmid, CVPR 2026), released for research.
"""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import numpy as np

PY = Path(__file__).resolve().parents[1]
D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')
DATA = ['sft.npz', 'val.npz', 'captions_sft.jsonl', 'captions_val.jsonl', 'part_names.json', 'labels.json.xz',
        'LICENSE.bricknet-code']
WORK = ['vocab.json', 'clip_val.npy', 'clip_val_model.npy']
CODE = ['lab/__init__.py', 'lab/connectors.py', 'lab/sequence.py', 'lab/dataset.py', 'lab/builder.py',
        'lab/train.py', 'bricknet/decode.py', 'shape/shape.py']

SETTINGS = '''# Settings. Times are in minutes; the whole run must fit in Kaggle's 12-hour limit.
TRAIN_MINUTES = 600   # the builder (stops sooner if the test loss stops improving)
STEPS = 120000        # the learning-rate schedule's length
BATCH = 32
# True: carry on training a run that hit the time limit (add that run's output as an input)
CONTINUE_TRAIN = False
'''

SETUP = '''# Find the dataset, put code and data in place, carry over an earlier run if one is added.
import os, re, shutil, subprocess, sys, zipfile
from pathlib import Path
import torch
print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE - turn on a GPU in Settings > Accelerator')
def walk(root):
    # Kaggle mounts inputs as linked folders, which Path.rglob does not follow on Python 3.13
    for d, _, files in os.walk(root, followlinks=True):
        for f in files:
            yield Path(d) / f
def version(f):
    m = re.search(r"^CODE_VERSION = '(.+)'", f.read_text(), re.M)
    return m.group(1) if m else 'none'
inputs = list(walk('/kaggle/input'))
print(len(inputs), 'input files, e.g.', [str(p) for p in inputs[:8]])
if not any(str(p).endswith('code/lab/train.py') for p in inputs):
    # the dataset was kept as a zip: unpack it here
    for z in [p for p in inputs if p.suffix == '.zip']:
        print('unpacking', z, flush=True)
        zipfile.ZipFile(z).extractall('/kaggle/working/bundle')
    inputs += list(walk('/kaggle/working/bundle'))
found = [p.parents[2] for p in inputs if str(p).endswith('code/lab/train.py')]
assert found, 'No brickmotion-lab-data found under /kaggle/input: add the dataset (Add Input) and wait until it shows in the Input panel.'
src = max(found, key=lambda d: version(d / 'code' / 'lab' / 'train.py'))
data = next(p.parent for p in inputs if p.name == 'sft.npz')
print('code from', src, '- version', version(src / 'code' / 'lab' / 'train.py'), '; data from', data)
work, code = Path('/kaggle/working/lab'), Path('/kaggle/working/code')
work.mkdir(parents=True, exist_ok=True)
if code.exists():
    shutil.rmtree(code)
shutil.copytree(src / 'code', code)
for f in (src / 'work').iterdir():
    if not (work / f.name).exists():
        shutil.copy(f, work / f.name)
for prev in [p for p in inputs if p.name == 'lab.ckpt']:
    for f in prev.parent.iterdir():
        if f.is_file() and not (work / f.name).exists():
            shutil.copy(f, work / f.name)
    print('carried over an earlier run from', prev.parent)
print(sorted(p.name for p in work.iterdir()))
'''

RUN = '''# Train. Each stage is skipped when it has already finished.
def stage(name, *args):
    done = work / f'{name}.done'
    if done.exists():
        print(f'{name}: already done'); return
    cmd = [sys.executable, '-m', 'lab.train', name, str(work), *map(str, args)]
    print(' '.join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=code, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        if not line.startswith('lab step') or ' 000 ' in line or line.split()[2].endswith('000'):
            print(line, end='', flush=True)
    if p.wait():
        raise RuntimeError(f'{name} failed')
    done.touch()

if CONTINUE_TRAIN:
    for name in ['train.done', 'export.done']:
        (work / name).unlink(missing_ok=True)
    print('carrying on training')
stage('tokens', data)
stage('train', data, '--minutes', TRAIN_MINUTES, '--steps', STEPS, '--batch', BATCH)
stage('export', '/kaggle/working/lab.pt')
'''

TIDY = '''print(sorted((p.name, round(p.stat().st_size / 1e6, 1)) for p in Path('/kaggle/working').rglob('*') if p.is_file() and 'code' not in p.parts))
print(open(work / 'lab.best.json').read())
print('Download lab.pt from the Output tab into /Users/mac/Projects/BrickMotion-Data/lab/.')
'''


def cell(src: str, kind: str = 'code') -> dict:
    c = {'cell_type': kind, 'metadata': {}, 'source': src.splitlines(keepends=True)}
    if kind == 'code':
        c.update(execution_count=None, outputs=[])
    return c


def notebook() -> dict:
    intro = ('# Brick Lab builder training (experiment 1)\n\n'
             'Settings > Accelerator: **GPU T4**. Add Input: the **brickmotion-lab-data** dataset. '
             'Then **Save Version > Save & Run All** (up to about 10 hours).\n\n'
             'To carry on a run that hit the time limit, add its output as an input and set `CONTINUE_TRAIN = True`.\n\n'
             'Data: BrickNet (Kulits & Schmid, CVPR 2026), for research.\n')
    return {'nbformat': 4, 'nbformat_minor': 5,
            'metadata': {'kernelspec': {'name': 'python3', 'display_name': 'Python 3', 'language': 'python'},
                         'language_info': {'name': 'python'},
                         'kaggle': {'accelerator': 'nvidiaTeslaT4', 'isGpuEnabled': True, 'isInternetEnabled': False}},
            'cells': [cell(intro, 'markdown'), cell(SETTINGS), cell(SETUP), cell(RUN), cell(TIDY)]}


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/Users/mac/Projects/BrickMotion-Data/kaggle-lab')
    out.mkdir(parents=True, exist_ok=True)
    z = out / 'brickmotion-lab-data.zip'
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as f:
        for name in DATA:
            f.write(D / name, f'data/{name}')
            print('added', name, flush=True)
        buf = io.BytesIO()
        np.save(buf, np.load(D / 'captions_sft_clip.npy', mmap_mode='r').astype(np.float16))
        f.writestr('data/captions_sft_clip16.npy', buf.getvalue())
        print('added captions_sft_clip16.npy', flush=True)
        for name in WORK:
            f.write(LAB / name, f'work/{name}')
        for name in CODE:
            f.write(PY / name, f'code/{name}')
    (out / 'brickmotion-lab-train.ipynb').write_text(json.dumps(notebook(), indent=1))
    print(f'{z} ({z.stat().st_size / 1e6:.0f} MB) and the notebook are in {out}')


if __name__ == '__main__':
    main()
