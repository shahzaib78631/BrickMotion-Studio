"""Bundle the detailed shape model's training data and code for a free Kaggle GPU.

    python -I kaggle_bundle.py SHAPE2_DIR OUT_DIR

Writes OUT_DIR/brickmotion-shape2-data.zip (upload it as a private Kaggle dataset) and
OUT_DIR/brickmotion-shape2-train.ipynb (import it as a notebook, add the dataset, run).
The notebook trains vq -> tokens -> gpt -> export with shape2.py and leaves shape2.bin and
shape2.reference.json in its output, ready for public/data/ai.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = ['omr_grids.npy', 'omr_samples.jsonl', 'omr_text_clip.npy', 'omr_text_owner.npy', 'omr_image_clip.npy',
        'colours.json', 'stb_occ.npy', 'stb_split.npy', 'stb_clip.npy', 'stb_caption_shape.npy']
CODE = ['shape.py', 'shape2.py']

SETTINGS = '''# Settings. Times are in minutes; the whole run must fit in Kaggle's 12-hour limit.
VQ_MINUTES = 150      # the shape/colour encoder (VQ-VAE)
GPT_MINUTES = 240     # the prompt -> codes transformer
VQ_WIDTH, VQ_LAYERS = 256, 4   # 384, 6 was no better per step in a 20-minute trial, and 2x slower
VQ_BATCH = 64
GPT_BATCH = 64
EXTRA = ['--fill-weight', '10', '--omr-share', '0.75', '--empty-keep', '0.15']
# True: train the transformer again on a finished run (add that run's output as an input):
# keeps its VQ and tokens, so only the transformer and the export run (under an hour)
REDO_GPT = False
'''

SETUP = '''# Find the dataset, put the code and data where the scripts expect them.
import os, shutil, subprocess, sys
from pathlib import Path
import torch
print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE - turn on a GPU in Settings > Accelerator')
# The dataset is the folder with the code AND the data: an earlier run's output also holds
# a copy of the code (in code/), which may be older. With several, the newest code wins.
def version(f):
    import re
    m = re.search(r"^CODE_VERSION = '(.+)'", f.read_text(), re.M)
    return m.group(1) if m else 'none (old code)'
found = [p.parent for p in Path('/kaggle/input').rglob('shape2.py') if (p.parent / 'omr_samples.jsonl').exists()]
assert found, 'Add the brickmotion-shape2-data dataset to this notebook (Add Input).'
src = max(found, key=lambda d: version(d / 'shape2.py'))
print('code from', src, '- version', version(src / 'shape2.py'))
work, code = Path('/kaggle/working/shape2'), Path('/kaggle/working/code')
work.mkdir(parents=True, exist_ok=True); code.mkdir(exist_ok=True)
for f in src.iterdir():
    if f.suffix == '.py':
        shutil.copy(f, code / f.name)
    elif not (work / f.name).exists():
        os.symlink(f, work / f.name)
# Resuming: if an earlier run's output is added as an input too, carry its progress over,
# unless that run had gone to NaN (resuming it would only carry on with NaN).
def healthy(ckpt):
    st = torch.load(ckpt, map_location='cpu', weights_only=False)
    return all(torch.isfinite(v).all() for v in st['model'].values() if v.is_floating_point())
for prev in Path('/kaggle/input').rglob('vq2.ckpt'):
    if not healthy(prev):
        print('NOT carrying over', prev.parent, '- its model is NaN; this run starts fresh')
        continue
    for f in prev.parent.iterdir():
        if f.is_file() and not (work / f.name).exists():
            shutil.copy(f, work / f.name)
    print('carried over an earlier run from', prev.parent)
print(sorted(p.name for p in work.iterdir()))
'''

RUN = '''# Train. Each stage is skipped when it has already finished (a resumed run).
def stage(name, *args):
    done = work / f'{name}.done'
    if done.exists():
        print(f'{name}: already done'); return
    cmd = [sys.executable, '-I', str(code / 'shape2.py'), *args]
    print(' '.join(cmd), flush=True)
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        if 'vq step' in line or 'gpt step' in line or not line.startswith('::progress'):
            print(line, end='', flush=True)
    if p.wait():
        raise RuntimeError(f'{name} failed')
    done.touch()

if REDO_GPT:
    for name in ['gpt.done', 'export.done', 'gpt2.ckpt', 'gpt2.pt', 'gpt2.best.pt', 'gpt2.best.json']:
        (work / name).unlink(missing_ok=True)
    print('training the transformer again')
stage('vq', 'vq', str(work), '--minutes', str(VQ_MINUTES), '--width', str(VQ_WIDTH), '--layers', str(VQ_LAYERS),
      '--batch', str(VQ_BATCH), *EXTRA)
stage('tokens', 'tokens', str(work))
stage('gpt', 'gpt', str(work), '--minutes', str(GPT_MINUTES), '--gpt-batch', str(GPT_BATCH))
stage('export', 'export', str(work), '/kaggle/working/shape2.bin')
'''

TIDY = '''# Keep the output small: the model, its PyTorch reference, and what a resumed run needs.
for f in work.iterdir():
    if f.is_symlink():
        f.unlink()
print(sorted((p.name, round(p.stat().st_size / 1e6, 1)) for p in Path('/kaggle/working').rglob('*') if p.is_file()))
print('Download shape2.bin and shape2.reference.json from the Output tab into public/data/ai/.')
'''


def cell(src: str, kind: str = 'code') -> dict:
    c = {'cell_type': kind, 'metadata': {}, 'source': src.splitlines(keepends=True)}
    if kind == 'code':
        c.update(execution_count=None, outputs=[])
    return c


def notebook() -> dict:
    intro = ('# BrickMotion detailed shape model (v2) training\n\n'
             'Settings > Accelerator: **GPU T4**. Add Input: the **brickmotion-shape2-data** dataset. '
             'Then **Save Version > Save & Run All** to train in the background (about 3-4 hours).\n\n'
             'To resume a stopped run, also add that run\'s output as an input and run again. '
             'To retrain only the transformer of a finished run, add its output and set `REDO_GPT = True`.\n')
    return {'nbformat': 4, 'nbformat_minor': 5,
            'metadata': {'kernelspec': {'name': 'python3', 'display_name': 'Python 3', 'language': 'python'},
                         'language_info': {'name': 'python'},
                         'kaggle': {'accelerator': 'nvidiaTeslaT4', 'isGpuEnabled': True, 'isInternetEnabled': False}},
            'cells': [cell(intro, 'markdown'), cell(SETTINGS), cell(SETUP), cell(RUN), cell(TIDY)]}


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    z = out / 'brickmotion-shape2-data.zip'
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as f:
        for name in DATA:
            f.write(src / name, name)
            print('added', name, flush=True)
        for name in CODE:
            f.write(HERE / name, name)
    (out / 'brickmotion-shape2-train.ipynb').write_text(json.dumps(notebook(), indent=1))
    print(f'{z} ({z.stat().st_size / 1e6:.0f} MB) and the notebook are in {out}')


if __name__ == '__main__':
    main()
