"""The index the app searches when it remixes a real model: every OMR sample the shape model
trained on (a whole set, or a top-level submodel of a big one), with its CLIP embeddings.

    python -I remix_index.py OMR_MODELS SHAPE2_DIR OUT_DIR

Reads OMR_MODELS (python/omr/download_omr.py) and SHAPE2_DIR (omr_samples.jsonl,
omr_text_clip.npy, omr_text_owner.npy, omr_image_clip.npy from python/shape). Writes
OUT_DIR/remix_index.json (what each sample is, where its file is, who made it) and
OUT_DIR/remix_index.bin (the embeddings, 8-bit, see src/ai/remix.ts for the layout).
Build-step snapshots ("step 33") are left out: they are half-built copies of a model.
"""
from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

STEP = re.compile(r'(^|\s)step\s*\d+', re.I)


def mangle(name: str) -> str:
    """How python/omr/voxelise.py names a submodel sample."""
    return re.sub(r'\.(ldr|dat|mpd)$', '', name.lower()).replace('_', ' ').replace('-', ' ').strip()


def file_info(path: Path) -> tuple[dict[str, str], str]:
    """Submodel names as the file spells them (by voxelise's name), and the model's author."""
    text = path.read_text(errors='ignore')
    names = {}
    for m in re.finditer(r'^0\s+FILE\s+(.+?)\s*$', text, re.M):
        n = m.group(1).strip()
        names.setdefault(mangle(n), re.sub(r'\.(ldr|dat|mpd)$', '', n, flags=re.I))
    a = re.search(r'^0\s+Author:\s*(.+?)\s*$', text, re.M)
    return names, (a.group(1) if a else '')


def quantise(v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    scale = np.abs(v).max(-1, keepdims=True) / 127 + 1e-12
    return np.round(v / scale).astype(np.int8), scale[..., 0].astype(np.float32)


def main() -> None:
    models, shape2, out = (Path(a) for a in sys.argv[1:4])
    meta = [json.loads(l) for l in (shape2 / 'omr_samples.jsonl').read_text().splitlines()]
    text = np.load(shape2 / 'omr_text_clip.npy').astype(np.float32)
    owner = np.load(shape2 / 'omr_text_owner.npy').astype(np.int32)
    image = np.load(shape2 / 'omr_image_clip.npy').astype(np.float32)
    info: dict[str, tuple[dict[str, str], str]] = {}
    keep, rows = [], []
    for i, m in enumerate(meta):
        if STEP.search(m['part']):
            continue
        if m['file'] not in info:
            info[m['file']] = file_info(models / m['file'])
        names, author = info[m['file']]
        sub = names.get(m['part'], '') if m['part'] else ''
        if m['part'] and not sub:
            continue  # cannot find the submodel again: leave it out
        keep.append(i)
        rows.append({'set': m['set'], 'name': m['name'], 'theme': m['theme'], 'file': m['file'], 'sub': sub,
                     'pieces': m['pieces'], 'size': m['size'], 'author': author})
    new = {old: k for k, old in enumerate(keep)}
    tk = np.array([j for j, o in enumerate(owner) if int(o) in new])
    t8, ts = quantise(text[tk])
    towner = np.array([new[int(owner[j])] for j in tk], dtype=np.int32)
    i8, iscale = quantise(image[keep])  # samples x views x 512
    views = image.shape[1]
    out.mkdir(parents=True, exist_ok=True)
    with (out / 'remix_index.bin').open('wb') as f:
        f.write(struct.pack('<IIII', len(rows), len(tk), views, 512))
        f.write(towner.tobytes())
        f.write(ts.tobytes())
        f.write(iscale.reshape(-1).tobytes())
        f.write(t8.tobytes())
        f.write(i8.reshape(-1).tobytes())
    (out / 'remix_index.json').write_text(json.dumps(rows))
    print(f'{len(rows)} samples ({len(meta) - len(rows)} left out), {len(tk)} captions -> {out}', flush=True)


if __name__ == '__main__':
    main()
