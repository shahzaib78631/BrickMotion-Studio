"""Experiment 1: does the legal-moves builder reach 100 parts with no overlaps?

    python -m lab.exp1 [--weights LAB/lab.pt] [--n 64] [--steps 100] [--out LAB/exp1]   (from python/)

For n val captions (evenly spread, one per model) it builds one model with legal moves only and one
"free" (the BrickNet-style baseline: whatever the builder says, overlaps recorded). Each model is
written as legal_##.ldr / free_##.ldr and judged twice:
    python  every part re-checked against the parts before it (lab.world, the sampler's own test)
    app     the editor's own collision world (scripts/lab-oracle.ts): parts it finds inside earlier parts.
            On real BrickNet models it flags about 22% of parts, so its count is read against that.
exp1.json holds every run; report.md the summary.
Data: BrickNet (Kulits & Schmid, CVPR 2026), for research.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bricknet'))
import decode  # noqa: E402

from .connectors import Connectors, load_compat  # noqa: E402
from .dataset import D, LAB, caption_ids  # noqa: E402
from .oracle import Oracle  # noqa: E402
from .sample import Legal, generate  # noqa: E402
from .world import World  # noqa: E402

REAL_APP_RATE = 0.22  # share of real BrickNet parts the app's collision world flags (Task 4)
BRICKNET_FIRST_OVERLAP = 19  # BrickNet 14B's average first overlapping step, as its paper reports


def judge(steps: list[dict], poses: list[np.ndarray], conn: Connectors, compat, oracle: Oracle | None) -> dict:
    w = World(conn, compat)
    py, app = [], []
    if oracle:
        oracle.reset()
    for k, (s, m) in enumerate(zip(steps, poses)):
        stem = conn.cat.stems[s['part']]
        if k and w.collides(s['part'], m, s['parent']):
            py.append(k)
        if oracle:
            if k and oracle.hits(stem, m):
                app.append(k)
            oracle.add(stem, m)
        w.add(s['part'], s['colour'], m)
    return {'python_overlaps': py, 'app_overlaps': app}


def run(weights: Path | None = None, n: int = 64, steps: int = 100, out: Path = LAB / 'exp1',
        model=None, vocab=None, use_app: bool = True, log=print) -> list[dict]:
    if model is None:
        from .train import load_builder
        from .train import device
        model, vocab = load_builder(weights or LAB / 'lab.pt', device())
    conn = Connectors(decode.Catalog(D))
    compat = load_compat(LAB / 'compat.json')
    rules = Legal(vocab, conn, compat)
    clip = np.load(LAB / 'clip_val.npy')
    _, texts = caption_ids('val')
    rows = np.linspace(0, len(texts) - 1, n).astype(int)
    out.mkdir(parents=True, exist_ok=True)
    oracle = Oracle() if use_app else None
    runs: list[dict] = []
    try:
        for j, row in enumerate(rows):
            for mode in ('legal', 'free'):
                r = generate(model, vocab, lambda: World(conn, compat), clip[row], steps=steps, seed=int(row),
                             legal=mode == 'legal', rules=rules)
                w, st = r['world'], r['steps']
                name = f'{mode}_{j:02d}'
                (out / f'{name}.ldr').write_text(w.to_ldr(name, texts[row]))
                rec = {'file': f'{name}.ldr', 'mode': mode, 'row': int(row), 'caption': texts[row], 'parts': w.n,
                       'rollbacks': r['rollbacks'], 'rejected': r['rejected'], 'seconds': round(r['seconds'], 1),
                       'first_overlap': r['first_overlap'],
                       **judge(st, list(w.poses), conn, compat, oracle)}
                runs.append(rec)
                log(f"{j + 1}/{n} {mode}: {w.n} parts, python overlaps {len(rec['python_overlaps'])}, "
                    f"app {len(rec['app_overlaps'])}, first overlap {rec['first_overlap']}, {rec['seconds']}s",
                    flush=True)
                (out / 'exp1.json').write_text(json.dumps(runs, indent=1))
    finally:
        if oracle:
            oracle.close()
    (out / 'report.md').write_text(report(runs, steps))
    return runs


def report(runs: list[dict], steps: int) -> str:
    def rows(mode):
        return [r for r in runs if r['mode'] == mode]

    lines = ['# Brick Lab experiment 1', '',
             'Models built from BrickNet val captions (Kulits & Schmid, CVPR 2026; research use).', '',
             '| | legal moves | free (baseline) |', '|---|---|---|']
    L, F = rows('legal'), rows('free')

    def mean(xs):
        return f'{np.mean(xs):.1f}' if xs else '-'

    def stat(rs, f):
        return f(rs) if rs else '-'

    app_share = lambda rs: f"{sum(len(r['app_overlaps']) for r in rs) / max(1, sum(r['parts'] - 1 for r in rs)):.1%}"
    table = [
        ('models', len(L), len(F)),
        (f'reached {steps} parts', stat(L, lambda rs: sum(r['parts'] == steps for r in rs)),
         stat(F, lambda rs: sum(r['parts'] == steps for r in rs))),
        ('average parts', mean([r['parts'] for r in L]), mean([r['parts'] for r in F])),
        ('models with a Python overlap', stat(L, lambda rs: sum(bool(r['python_overlaps']) for r in rs)),
         stat(F, lambda rs: sum(bool(r['python_overlaps']) for r in rs))),
        (f'parts the app flags (real models: {REAL_APP_RATE:.0%})', stat(L, app_share), stat(F, app_share)),
        ('average first overlapping step (BrickNet 14B: about 19)', '-',
         mean([r['first_overlap'] for r in F if r['first_overlap'] is not None])),
        ('free models with no overlap at all', '-', stat(F, lambda rs: sum(r['first_overlap'] is None for r in rs))),
        ('average rollbacks', mean([r['rollbacks'] for r in L]), '-'),
        ('average seconds', mean([r['seconds'] for r in L]), mean([r['seconds'] for r in F])),
    ]
    lines += [f'| {a} | {b} | {c} |' for a, b, c in table]
    ok = L and all(r['parts'] == steps and not r['python_overlaps'] for r in L)
    lines += ['', f"Pass (every legal model has {steps} parts and no Python overlap): {'yes' if ok else 'no'}", '']
    return '\n'.join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', type=Path)
    ap.add_argument('--n', type=int, default=64)
    ap.add_argument('--steps', type=int, default=100)
    ap.add_argument('--out', type=Path, default=LAB / 'exp1')
    ap.add_argument('--no-app', action='store_true')
    a = ap.parse_args()
    t = time.time()
    run(a.weights, a.n, a.steps, a.out, use_app=not a.no_app)
    print(f'done in {(time.time() - t) / 60:.0f} min; report in {a.out / "report.md"}')


if __name__ == '__main__':
    main()
