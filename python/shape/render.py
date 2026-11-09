"""Render coloured voxel shapes and embed them with CLIP, for the detailed shape model.

Each sample is drawn from two three-quarter views (front-left and front-right, from
above) in its real colours (LDConfig) and real proportions (a cell is 20 x 8 x 20 LDU),
then embedded with CLIP ViT-B/32's image encoder. CLIP puts pictures and text in one
space, so the model can be steered by a set's look as well as by its name, and a
reference picture can be a prompt.

    python -I render.py DATA_DIR [--views 2] [--previews 24]

DATA_DIR holds omr_voxels.npz and omr_samples.jsonl (python/omr/voxelise.py). Writes
DATA_DIR/omr_image_clip.npy (samples x views x 512, float16) and a few previews.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from omr.reader import LIB  # noqa: E402

SIZE = 224
MEAN = np.array([0.48145466, 0.4578275, 0.40821073])
STD = np.array([0.26862954, 0.26130258, 0.27577711])


def palette() -> dict[int, np.ndarray]:
    out = {}
    for line in (LIB / 'LDConfig.ldr').read_text(errors='ignore').splitlines():
        m = re.search(r'CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})', line)
        if m:
            h = m.group(2)
            out[int(m.group(1))] = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)]) / 255
    return out


PALETTE = palette()
FACES = [  # (normal, shade, offsets of the face's corner, the two in-face axes)
    (np.array([0, 1, 0]), 1.0),
    (np.array([1, 0, 0]), 0.78),
    (np.array([-1, 0, 0]), 0.78),
    (np.array([0, 0, 1]), 0.62),
    (np.array([0, 0, -1]), 0.62),
]


def render(cells: np.ndarray, yaw: float, pitch: float = 0.55) -> np.ndarray:
    """Cells (N x 4: x, y up, z, colour) -> SIZE x SIZE x 3 image in 0..1."""
    img = np.full((SIZE, SIZE, 3), 0.93)
    if len(cells) == 0:
        return img
    xyz = cells[:, :3].astype(int)
    lo = xyz.min(0)
    xyz = xyz - lo + 1
    occ = np.zeros(xyz.max(0) + 2, dtype=bool)
    occ[xyz[:, 0], xyz[:, 1], xyz[:, 2]] = True
    rgb = np.array([PALETTE.get(int(c), (0.6, 0.6, 0.6)) for c in cells[:, 3]])
    k = 4  # samples per face edge
    u = (np.arange(k) + 0.5) / k
    grid = np.stack(np.meshgrid(u, u, indexing='ij'), -1).reshape(-1, 2)
    dims = np.array([20.0, 8.0, 20.0])
    pts, cols = [], []
    for n, shade in FACES:
        nb = xyz + n
        show = ~occ[nb[:, 0], nb[:, 1], nb[:, 2]]  # faces with nothing in front of them
        if not show.any():
            continue
        axis = int(np.flatnonzero(n)[0])
        others = [a for a in range(3) if a != axis]
        face = np.zeros((len(grid), 3))
        face[:, axis] = 1.0 if n[axis] > 0 else 0.0
        face[:, others[0]] = grid[:, 0]
        face[:, others[1]] = grid[:, 1]
        p = (xyz[show][:, None, :] + face[None]) * dims  # cells x samples x 3
        pts.append(p.reshape(-1, 3))
        cols.append(np.repeat(rgb[show] * shade, len(grid), 0))
    P = np.concatenate(pts)
    C = np.concatenate(cols)
    P = P - (P.min(0) + P.max(0)) / 2
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    x1 = cy * P[:, 0] + sy * P[:, 2]
    z1 = -sy * P[:, 0] + cy * P[:, 2]
    y2 = cp * P[:, 1] - sp * z1
    depth = sp * P[:, 1] + cp * z1  # larger = nearer the viewer
    span = max(np.ptp(x1), np.ptp(y2), 1e-6)
    scale = (SIZE * 0.86) / span
    px = ((x1 - (x1.max() + x1.min()) / 2) * scale + SIZE / 2).astype(int)
    py = (-(y2 - (y2.max() + y2.min()) / 2) * scale + SIZE / 2).astype(int)
    # splat each point over a few pixels; a z-buffer keeps the nearest
    r = max(1, int(np.ceil(scale * 20 / k / 2))) + 1
    off = np.arange(-r + 1, r)
    dx, dy = np.meshgrid(off, off, indexing='ij')
    X = np.clip(px[:, None] + dx.ravel()[None], 0, SIZE - 1).ravel()
    Y = np.clip(py[:, None] + dy.ravel()[None], 0, SIZE - 1).ravel()
    Dp = np.repeat(depth, dx.size)
    Cp = np.repeat(C, dx.size, 0)
    pix = Y * SIZE + X
    order = np.lexsort((-Dp, pix))  # per pixel, nearest first
    first = np.r_[True, pix[order][1:] != pix[order][:-1]]
    keep = order[first]
    img.reshape(-1, 3)[pix[keep]] = Cp[keep]
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('data')
    ap.add_argument('--views', type=int, default=2)
    ap.add_argument('--previews', type=int, default=24)
    a = ap.parse_args()
    data = Path(a.data)
    z = np.load(data / 'omr_voxels.npz')
    cells, offsets = z['cells'], z['offsets']
    meta = [json.loads(l) for l in (data / 'omr_samples.jsonl').read_text().splitlines()]
    import torch
    from PIL import Image
    from transformers import CLIPVisionModelWithProjection
    model = CLIPVisionModelWithProjection.from_pretrained('openai/clip-vit-base-patch32').eval()
    torch.set_num_threads(4)
    yaws = [np.pi / 4 + i * np.pi / 2 for i in range(a.views)]  # front-left, front-right, …
    out = np.zeros((len(meta), a.views, 512), dtype=np.float16)
    prev = data / 'previews'
    prev.mkdir(exist_ok=True)
    batch, where = [], []

    def flush():
        if not batch:
            return
        x = torch.from_numpy(((np.stack(batch) - MEAN) / STD).transpose(0, 3, 1, 2).astype(np.float32))
        with torch.no_grad():
            e = model(pixel_values=x).image_embeds
        e = e / e.norm(dim=-1, keepdim=True)
        for (i, v), row in zip(where, e.numpy()):
            out[i, v] = row
        batch.clear()
        where.clear()

    step = max(1, len(meta) // max(1, a.previews))
    for i in range(len(meta)):
        c = cells[offsets[i]:offsets[i + 1]]
        for v, yaw in enumerate(yaws):
            img = render(c, yaw)
            batch.append(img)
            where.append((i, v))
            if v == 0 and i % step == 0:
                name = re.sub(r'[^\w-]+', '_', f"{meta[i]['set']}_{meta[i]['part'] or 'whole'}")[:80]
                Image.fromarray((img * 255).astype(np.uint8)).save(prev / f'{i:05d}_{name}.png')
        if len(batch) >= 64:
            flush()
        print(f'::progress {i + 1}/{len(meta)} rendered', flush=True)
    flush()
    np.save(data / 'omr_image_clip.npy', out)
    print(f'{len(meta)} samples x {a.views} views -> {data / "omr_image_clip.npy"}', flush=True)


if __name__ == '__main__':
    main()
