"""BrickNet graphs -> LDraw models, our own reader (numpy only).

    python -I decode.py DATA_DIR SPLIT OUT_DIR [--first N] [--rows 1,5,9]

DATA_DIR holds the BrickNet files: SPLIT.npz (sft, val or pt), captions_SPLIT.jsonl, and the
catalog from the BrickNet code (MIT): part_names.json, labels.json.xz. Writes one .ldr per model
(its largest connected piece) with its first caption as the description.

The format is BrickNet's (Kulits & Schmid, CVPR 2026; github.com/kulits/BrickNet, DATA.md): a model
is its parts (vocabulary id, colour) and the joints between them (which connector of which part
mates with which connector of the other, plus a yaw / slide / flip / ball angles). There are no
absolute positions: a part's pose is found by walking the joints from a root part, the way
bricknet.decode_graph does. Separate pieces share no frame, so only the largest one is written.
"""
from __future__ import annotations

import json
import lzma
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np

KINDS = ['stud', 'hole', 'hinge', 'fixed', 'ball', 'axle']  # edge_kind values
RX_PI = np.diag([1.0, -1.0, -1.0, 1.0])


def ry4(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1.0]])


def euler_xyz(rx: float, ry: float, rz: float) -> np.ndarray:
    """Extrinsic x, then y, then z (scipy's 'xyz')."""
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    X = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Y = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Z = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    m = np.eye(4)
    m[:3, :3] = Z @ Y @ X
    return m


class Catalog:
    """Part stems and every part's connector frames in BrickNet's canonical flat order."""

    def __init__(self, d: Path):
        self.stems = list(json.loads((d / 'part_names.json').read_text()))
        self.labels = json.loads(lzma.decompress((d / 'labels.json.xz').read_bytes()))
        self._frames: dict[int, np.ndarray] = {}

    def frames(self, pid: int) -> np.ndarray:
        """(N, 4, 4) part-local connector frames, flat order: sorted kind, sorted subtype, sorted polarity, rows."""
        if pid in self._frames:
            return self._frames[pid]
        kinds = self.labels[self.stems[pid] + '.dat']
        rows = []
        for kind in sorted(kinds):
            for sub in sorted(kinds[kind]):
                val = kinds[kind][sub]
                groups = [val[p] for p in sorted(val)] if isinstance(val, dict) else [val]
                for g in groups:
                    for r in g:
                        rows.append((r[0], r[1], r[2], r[3] if len(r) > 3 else 0, r[4] if len(r) > 4 else 0,
                                     r[5] if kind == 'fixed' else 0))
        out = np.zeros((len(rows), 4, 4))
        for k, (px, py, pz, pitch, roll, yaw) in enumerate(rows):
            # the frame as bricknet.data builds it: angles (pitch=x, roll=z, yaw=y) in degrees
            ax, az, ay = math.radians(pitch), math.radians(roll), math.radians(yaw)
            cx, cz, cy, sx, sz, sy = math.cos(ax), math.cos(az), math.cos(ay), math.sin(ax), math.sin(az), math.sin(ay)
            out[k] = [[cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, px],
                      [cx * sz, cx * cz, -sx, py],
                      [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx, pz],
                      [0, 0, 0, 1]]
        self._frames[pid] = out
        return out


def joint(kind: str, yaw: float, flip: bool, rot: np.ndarray) -> np.ndarray:
    """The joint's own transform, a-side connector frame -> b-side connector frame."""
    if kind in ('stud', 'hole'):
        return ry4(yaw)
    if kind == 'hinge':
        r = ry4(yaw)
        return r @ RX_PI if flip else r
    if kind == 'axle':
        r = ry4(rot[0])
        if flip:
            r = r @ RX_PI
        r[1, 3] = -yaw  # an axle's "yaw" field is its slide, in LDU
        return r
    if kind == 'ball':
        return euler_xyz(*rot)
    return np.eye(4)  # fixed


def load(npz: Path):
    d = np.load(npz, allow_pickle=False)
    return {k: d[k] for k in d.files}


def model(arrs: dict, i: int):
    """Row i: (part ids, colours, edges as (a, a_conn, b, b_conn, kind, yaw, flip, rot))."""
    n0, n1 = arrs['node_ptr'][i], arrs['node_ptr'][i + 1]
    e0, e1 = arrs['edge_ptr'][i], arrs['edge_ptr'][i + 1]
    edges = [(int(a), int(ac), int(b), int(bc), KINDS[int(k)], float(y), bool(f), r)
             for (a, ac, b, bc), k, y, f, r in zip(arrs['edge_idx'][e0:e1], arrs['edge_kind'][e0:e1],
                                                   arrs['edge_yaw'][e0:e1], arrs['edge_flip'][e0:e1], arrs['edge_rot'][e0:e1])]
    return arrs['part_ids'][n0:n1].tolist(), arrs['colors'][n0:n1].tolist(), edges


def realise(cat: Catalog, pids: list[int], edges: list) -> tuple[list[int], list[np.ndarray]]:
    """Poses of the largest connected piece, walked breadth first from its lowest-index part."""
    adj: dict[int, list] = {}
    for k, e in enumerate(edges):
        adj.setdefault(e[0], []).append((e[2], k, True))
        adj.setdefault(e[2], []).append((e[0], k, False))
    seen: set[int] = set()
    best: list[int] = []
    for s in range(len(pids)):
        if s in seen:
            continue
        comp, stack = [], [s]
        seen.add(s)
        while stack:
            u = stack.pop()
            comp.append(u)
            for v, _, _ in adj.get(u, []):
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        if len(comp) > len(best):
            best = comp
    root = min(best)
    pose = {root: np.eye(4)}
    q = deque([root])
    while q:
        u = q.popleft()
        for v, k, fwd in sorted(adj.get(u, []), key=lambda t: t[1]):
            if v in pose:
                continue
            a, ac, b, bc, kind, yaw, flip, rot = edges[k]
            m = cat.frames(pids[a])[ac] @ joint(kind, yaw, flip, rot) @ np.linalg.inv(cat.frames(pids[b])[bc])
            pose[v] = pose[u] @ (m if fwd else np.linalg.inv(m))
            q.append(v)
    order = sorted(pose)
    return order, [pose[n] for n in order]


def to_ldr(cat: Catalog, pids, colors, order, poses, name: str, caption: str) -> str:
    lines = [f'0 {name}', f'0 Name: {name}.ldr', '0 Author: BrickNet dataset (Kulits & Schmid, CVPR 2026)']
    lines += [f'0 // {caption}'] if caption else []
    for n, m in zip(order, poses):
        nums = ' '.join(f'{round(float(v), 4) + 0.0:g}' for v in [*m[:3, 3], *m[:3, :3].flat])
        lines.append(f'1 {colors[n]} {nums} {cat.stems[pids[n]]}.dat')
    return '\n'.join(lines) + '\n'


def captions(path: Path, per_model: int) -> list[str]:
    if not path.exists():
        return []
    rows = [json.loads(l)['caption'] for l in path.read_text().splitlines() if l.strip()]
    return rows[::per_model]


def main() -> None:
    args = sys.argv[1:]
    d, split, out = Path(args[0]), args[1], Path(args[2])
    first = int(args[args.index('--first') + 1]) if '--first' in args else 20
    arrs = load(d / f'{split}.npz')
    n = len(arrs['node_ptr']) - 1
    rows = [int(x) for x in args[args.index('--rows') + 1].split(',')] if '--rows' in args else list(range(min(first, n)))
    caps = captions(d / f'captions_{split}.jsonl', 5 if split == 'sft' else 1)
    cat = Catalog(d)
    out.mkdir(parents=True, exist_ok=True)
    for i in rows:
        pids, colors, edges = model(arrs, i)
        order, poses = realise(cat, pids, edges)
        cap = caps[i] if i < len(caps) else ''
        (out / f'{split}_{i:05d}.ldr').write_text(to_ldr(cat, pids, colors, order, poses, f'{split} {i}', cap))
        print(f'{split} {i}: {len(order)}/{len(pids)} parts kept - {cap[:90]}', flush=True)


if __name__ == '__main__':
    main()
