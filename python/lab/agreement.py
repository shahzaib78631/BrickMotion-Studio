"""Python's overlap test against the editor's own collision world (scripts/lab-oracle.ts).

Cases come from real BrickNet validation models: a model is built up to a random part, then that
part is asked about twice, at its real pose ("real": it fits, as its designer built it) and moved
4-20 LDU along one axis ("shifted": often pushed into a neighbour). Both judges answer each case.

    python -m lab.agreement   (from python/)  -> BrickMotion-Data/lab/agreement/verdicts.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bricknet'))
import decode  # noqa: E402

from .connectors import Connectors, load_compat
from .oracle import Oracle
from .sequence import poses, to_steps
from .world import World

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')


def run(n_models: int = 150, seed: int = 0) -> list[dict]:
    conn = Connectors(decode.Catalog(D))
    compat = load_compat(LAB / 'compat.json')
    arrs = decode.load(D / 'val.npz')
    rng = np.random.default_rng(seed)
    oracle = Oracle()
    out: list[dict] = []
    try:
        for i in range(min(n_models, len(arrs['node_ptr']) - 1)):
            pids, colors, edges = decode.model(arrs, i)
            order, _ = decode.realise(conn.cat, pids, edges)
            steps = to_steps(pids, colors, edges, order[0], conn)
            if len(steps) < 3:
                continue
            ps = poses(steps, conn)
            k = int(rng.integers(1, len(steps)))
            w = World(conn, compat)
            oracle.reset()
            for s, m in zip(steps[:k], ps[:k]):
                w.add(s['part'], s['colour'], m)
                oracle.add(conn.cat.stems[s['part']], m)
            s, m = steps[k], ps[k]
            stem = conn.cat.stems[s['part']]
            d = np.zeros(3)
            d[rng.integers(3)] = rng.choice([-1, 1]) * rng.uniform(4, 20)
            moved = m.copy()
            moved[:3, 3] += d
            for label, pose in (('real', m), ('shifted', moved)):
                out.append({'model': i, 'part': stem, 'case': label,
                            'python': bool(w.collides(s['part'], pose, s['parent'] if label == 'real' else None)),
                            'app': bool(oracle.hits(stem, pose))})
    finally:
        oracle.close()
    return out


if __name__ == '__main__':
    v = run()
    (LAB / 'agreement').mkdir(parents=True, exist_ok=True)
    (LAB / 'agreement' / 'verdicts.json').write_text(json.dumps(v, indent=0))
    print(f'{len(v)} verdicts')
