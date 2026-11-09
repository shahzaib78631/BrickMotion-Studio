"""Turn OMR models into coloured voxel shapes for the detailed shape model.

One cell per stud across (x, z) and per plate up (y), the stud grid the app builds on.
Each part's real LDraw geometry (from public/ldraw, studs left out) is sampled over its
faces, placed, and every column it covers is filled from its lowest to its highest
cell, so bricks come out solid, slopes keep their profile and the cell colour is the
part's colour.

A model that fits the grid is one sample. A bigger one is split into the submodels of
its main model (a set's vehicles, modules, figures' stands…), each a sample if it fits.

    python -I voxelise.py MODELS_DIR OUT_DIR [--size 32 32 64] [--jobs 8]

Writes OUT_DIR/omr_voxels.npz (cells: N x 4 int16 [x, y, z, colour] and per-sample
offsets/sizes) and OUT_DIR/omr_samples.jsonl (set, name, theme, part, size, pieces).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from omr.reader import LIB, read_model  # noqa: E402

SPACING = 4.0  # LDU between samples on a face (a cell is 20 x 8 x 20)
SEARCH = ['parts', 'p', 'unofficial/parts', 'unofficial/p', 'models']


def _find(name: str) -> Path | None:
    name = name.lower().replace('\\', '/')
    for d in SEARCH:
        f = LIB / d / name
        if f.exists():
            return f
    return None


def _sample(tri: np.ndarray) -> np.ndarray:
    """Points over a triangle (3 x 3), about SPACING apart."""
    a, b, c = tri
    n = int(np.ceil(max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)) / SPACING))
    n = max(1, min(n, 64))
    i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing='ij')
    keep = (i + j) <= n
    u, v = i[keep] / n, j[keep] / n
    return a + np.outer(u, b - a) + np.outer(v, c - a)


@lru_cache(maxsize=None)
def points(name: str) -> np.ndarray:
    """Surface points of an LDraw file in its own coordinates (studs left out)."""
    base = name.lower().replace('\\', '/').rsplit('/', 1)[-1]
    if re.match(r'^(stud|studp|studa|studel|stu\d)', base):
        return np.zeros((0, 3))
    f = _find(name)
    if f is None:
        return np.zeros((0, 3))
    out = []
    for line in f.read_text(errors='ignore').splitlines():
        t = line.split()
        if not t:
            continue
        try:
            if t[0] == '1' and len(t) >= 15:
                x, y, z, a, b, c, d, e, g, h, i, k = (float(v) for v in t[2:14])
                sub = points(' '.join(t[14:]))
                if len(sub):
                    m = np.array([[a, b, c], [d, e, g], [h, i, k]])
                    out.append(sub @ m.T + np.array([x, y, z]))
            elif t[0] == '3' and len(t) >= 11:
                out.append(_sample(np.array(t[2:11], dtype=float).reshape(3, 3)))
            elif t[0] == '4' and len(t) >= 14:
                q = np.array(t[2:14], dtype=float).reshape(4, 3)
                out.append(_sample(q[[0, 1, 2]]))
                out.append(_sample(q[[0, 2, 3]]))
        except ValueError:
            continue
    if not out:
        return np.zeros((0, 3))
    p = np.concatenate(out)
    return np.unique(np.round(p / 2) * 2, axis=0)  # 2 LDU grid keeps big parts small


@lru_cache(maxsize=None)
def part_points(part: str) -> np.ndarray:
    """A part's points pulled 2% toward its centre, so faces on a cell boundary fall inside."""
    p = points(part + '.dat')
    if len(p) == 0:
        return p
    c = (p.min(0) + p.max(0)) / 2
    return c + (p - c) * 0.98


def cells_of(parts) -> dict[tuple[int, int, int], int]:
    """Placed parts -> {(x, y up, z): colour}, each part's columns filled solid."""
    cells: dict[tuple[int, int, int], int] = {}
    for p in parts:
        pts = part_points(p.part)
        if len(pts) == 0:
            continue
        w = pts @ p.matrix[:3, :3].T + p.matrix[:3, 3]
        cx = np.floor(w[:, 0] / 20).astype(int)
        cy = np.floor(-w[:, 1] / 8).astype(int)
        cz = np.floor(w[:, 2] / 20).astype(int)
        key = cx * 100003 + cz
        order = np.argsort(key)
        key, cx, cy, cz = key[order], cx[order], cy[order], cz[order]
        starts = np.flatnonzero(np.r_[True, key[1:] != key[:-1]])
        lo = np.minimum.reduceat(cy, starts)
        hi = np.maximum.reduceat(cy, starts)
        for s, a, b in zip(starts, lo, hi):
            for yy in range(a, b + 1):
                cells[(int(cx[s]), yy, int(cz[s]))] = p.color
    return cells


def normalise(cells: dict, size: tuple[int, int, int]) -> np.ndarray | None:
    """Cells -> N x 4 [x, y, z, colour] from 0, centred across; None when it doesn't fit."""
    if not cells:
        return None
    a = np.array([[x, y, z, c] for (x, y, z), c in cells.items()], dtype=np.int64)
    lo, hi = a[:, :3].min(0), a[:, :3].max(0)
    ext = hi - lo + 1
    if ext[0] > size[0] or ext[1] > size[2] or ext[2] > size[1]:
        return None
    a[:, :3] -= lo
    a[:, 0] += (size[0] - ext[0]) // 2
    a[:, 2] += (size[1] - ext[2]) // 2
    return a.astype(np.int16)


def one(args):
    f, size = args
    try:
        parts = read_model(f)
    except Exception as e:  # a broken file is skipped
        return f, [], str(e)
    out = []
    whole = normalise(cells_of(parts), size)
    if whole is not None:
        out.append(('', len(parts), whole))
    else:
        tops = sorted({p.top for p in parts if p.top})
        for t in tops:
            sub = [p for p in parts if p.top == t]
            if len(sub) < 8:
                continue
            a = normalise(cells_of(sub), size)
            if a is not None:
                out.append((t, len(sub), a))
    return f, out, None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('models')
    ap.add_argument('out')
    ap.add_argument('--size', type=int, nargs=3, default=[32, 32, 64], help='studs x, studs z, plates up')
    ap.add_argument('--jobs', type=int, default=6)
    a = ap.parse_args()
    root, out = Path(a.models), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {}
    if (root / 'manifest.json').exists():
        manifest = {m['file']: m for m in json.loads((root / 'manifest.json').read_text())}
    files = sorted([*root.glob('*/*.mpd'), *root.glob('*/*.ldr')])
    size = tuple(a.size)
    arrays, meta = [], []
    with ProcessPoolExecutor(a.jobs) as ex:
        for i, (f, samples, err) in enumerate(ex.map(one, [(f, size) for f in files], chunksize=4), 1):
            print(f'::progress {i}/{len(files)} models, {len(meta)} samples', flush=True)
            if err:
                print(f'skip {f.name}: {err}', flush=True)
            m = manifest.get(str(f.relative_to(root)), {})
            for top, n, arr in samples:
                arrays.append(arr)
                sub = re.sub(r'\.(ldr|dat|mpd)$', '', top).replace('_', ' ').replace('-', ' ').strip()
                meta.append({'set': f.parent.name, 'name': m.get('name', f.stem), 'theme': m.get('theme', ''),
                             'part': sub, 'file': str(f.relative_to(root)), 'pieces': n,
                             'size': [int(v) for v in arr[:, :3].max(0) + 1], 'cells': len(arr)})
    offsets = np.cumsum([0] + [len(x) for x in arrays])
    np.savez_compressed(out / 'omr_voxels.npz', cells=np.concatenate(arrays), offsets=offsets, grid=np.array(size))
    (out / 'omr_samples.jsonl').write_text(''.join(json.dumps(m) + '\n' for m in meta))
    print(f'{len(meta)} samples from {len(files)} models -> {out}', flush=True)


if __name__ == '__main__':
    main()
