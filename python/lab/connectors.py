"""Connector types per part, and which types join, counted from BrickNet's joints.

A connector's type is "kind/sub/polarity" from the BrickNet part labels (polarity is "" where the
label has none), in the same flat order as decode.Catalog.frames. compat[(parent type, child type)]
counts the joint kinds seen between those types. A joint read from the parent's side is the data's
kind; read from the other side it is the kind with REV appended, and its transform is inverted.

    python -I -m lab.connectors   (from python/)  -> BrickMotion-Data/lab/compat.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bricknet'))
import decode  # noqa: E402

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
OUT = Path('/Users/mac/Projects/BrickMotion-Data/lab')
REV = '~'

Compat = dict[tuple[str, str], dict[str, int]]


class Connectors:
    def __init__(self, cat: decode.Catalog):
        self.cat = cat
        self._types: dict[int, list[str]] = {}

    def types(self, pid: int) -> list[str]:
        if pid in self._types:
            return self._types[pid]
        kinds = self.cat.labels.get(self.cat.stems[pid] + '.dat', {})
        out: list[str] = []
        for kind in sorted(kinds):
            for sub in sorted(kinds[kind]):
                val = kinds[kind][sub]
                if isinstance(val, dict):
                    for pol in sorted(val):
                        out += [f'{kind}/{sub}/{pol}'] * len(val[pol])
                else:
                    out += [f'{kind}/{sub}/'] * len(val)
        self._types[pid] = out
        return out

    def frames(self, pid: int) -> np.ndarray:
        try:
            return self.cat.frames(pid)
        except KeyError:
            return np.zeros((0, 4, 4))


def build_compat(arrs: dict, conn: Connectors) -> Compat:
    pids = arrs['part_ids']
    used = np.unique(pids)
    names: dict[str, int] = {}
    off = np.full(int(used.max()) + 1, -1, dtype=np.int64)
    cnt = np.zeros(int(used.max()) + 1, dtype=np.int64)
    flat: list[int] = []
    for p in used:
        off[p] = len(flat)
        t = conn.types(int(p))
        cnt[p] = len(t)
        flat += [names.setdefault(x, len(names)) for x in t]
    flat_a = np.array(flat, dtype=np.int64)
    base = np.repeat(arrs['node_ptr'][:-1], np.diff(arrs['edge_ptr']))
    ei = arrs['edge_idx']
    pa, pb = pids[base + ei[:, 0]], pids[base + ei[:, 2]]
    ok = (ei[:, 1] < cnt[pa]) & (ei[:, 3] < cnt[pb])
    ta = flat_a[off[pa[ok]] + ei[ok, 1]]
    tb = flat_a[off[pb[ok]] + ei[ok, 3]]
    k = arrs['edge_kind'][ok].astype(np.int64)
    rows, counts = np.unique(np.stack([ta, tb, k], 1), axis=0, return_counts=True)
    inv = {i: n for n, i in names.items()}
    out: Compat = {}
    for (a, b, kk), c in zip(rows.tolist(), counts.tolist()):
        kind = decode.KINDS[kk]
        fwd = out.setdefault((inv[a], inv[b]), {})
        fwd[kind] = fwd.get(kind, 0) + c
        back = out.setdefault((inv[b], inv[a]), {})
        back[kind + REV] = back.get(kind + REV, 0) + c
    return out


def fits(compat: Compat, ta: str, tb: str) -> list[str]:
    """Joint kinds seen between a parent connector of type ta and a child connector of type tb, best first."""
    kinds = compat.get((ta, tb), {})
    return sorted(kinds, key=lambda k: -kinds[k])


def save_compat(path: Path, compat: Compat) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps([[a, b, k] for (a, b), k in compat.items()]))


def load_compat(path: Path) -> Compat:
    return {(a, b): k for a, b, k in json.loads(Path(path).read_text())}


if __name__ == '__main__':
    c = Connectors(decode.Catalog(D))
    compat = build_compat(decode.load(D / 'sft.npz'), c)
    save_compat(OUT / 'compat.json', compat)
    print(f'{len(compat)} type pairs -> {OUT / "compat.json"}')
