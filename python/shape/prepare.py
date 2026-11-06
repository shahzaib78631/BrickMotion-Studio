"""Turn StableText2Brick into training arrays for the shape model.

Each structure becomes a 20x20x20 occupancy grid (x, y across in studs, z up in bricks,
as the dataset gives them), and each caption a CLIP text embedding
(openai/clip-vit-base-patch32, the same weights the app runs in the browser).

    python -I prepare.py DATA_DIR OUT_DIR

Writes OUT_DIR/occ.npy (N x 1000 bytes, bit-packed 20^3 grids), OUT_DIR/clip.npy
(M x 512 float16, unit length), OUT_DIR/caption_shape.npy (M, which grid each caption
describes), OUT_DIR/captions.json and OUT_DIR/split.npy (N, 1 = test).
"""
from __future__ import annotations

import argparse
import glob
import json
import re
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import torch

G = 20
BRICK = re.compile(r'(\d+)x(\d+) \((\d+),(\d+),(\d+)\)')


def grid(bricks: str) -> np.ndarray:
    g = np.zeros((G, G, G), dtype=bool)
    for h, w, x, y, z in BRICK.findall(bricks):
        h, w, x, y, z = map(int, (h, w, x, y, z))
        g[x:x + h, y:y + w, z] = True
    return g


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('data')
    ap.add_argument('out')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    grids, captions, owner, split = [], [], [], []
    files = sorted(glob.glob(str(Path(a.data) / 'data' / '*.parquet')))
    for f in files:
        t = pq.read_table(f, columns=['bricks', 'captions']).to_pylist()
        test = Path(f).name.startswith('test')
        for r in t:
            i = len(grids)
            grids.append(np.packbits(grid(r['bricks']).ravel()))
            split.append(1 if test else 0)
            for c in r['captions']:
                captions.append(c)
                owner.append(i)
        print(f'::progress {len(grids)}/47389 shapes', flush=True)
    np.save(out / 'occ.npy', np.stack(grids))
    np.save(out / 'split.npy', np.array(split, dtype=np.uint8))
    np.save(out / 'caption_shape.npy', np.array(owner, dtype=np.int32))
    (out / 'captions.json').write_text(json.dumps(captions))

    from transformers import CLIPTextModelWithProjection, CLIPTokenizer
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    tok = CLIPTokenizer.from_pretrained('openai/clip-vit-base-patch32')
    model = CLIPTextModelWithProjection.from_pretrained('openai/clip-vit-base-patch32').to(dev).eval()
    embs = []
    with torch.no_grad():
        for s in range(0, len(captions), 512):
            b = tok(captions[s:s + 512], padding=True, truncation=True, max_length=77, return_tensors='pt').to(dev)
            e = model(**b).text_embeds
            e = e / e.norm(dim=-1, keepdim=True)
            embs.append(e.half().cpu().numpy())
            print(f'::progress {min(s + 512, len(captions))}/{len(captions)} captions', flush=True)
    np.save(out / 'clip.npy', np.concatenate(embs))
    print(f'{len(grids)} shapes, {len(captions)} captions -> {out}', flush=True)


if __name__ == '__main__':
    main()
