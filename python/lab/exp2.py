"""Experiment 2: do many parallel builds, picked by how their renders match the caption, close at least
half the CLIP-match gap between the Sketch model and real sets?

    python -m lab.exp2 [--n-captions 64] [--runs 16] [--every 8] [--max-parts 150] [--out LAB/exp2]
                       [--methods real,sketch,single,smc]    (from python/; resumes where it stopped)

For each val caption (the same evenly spread rows as experiment 1) every method makes one model, which
is rendered from two three-quarter views and scored by CLIP (mean cosine of views and caption):
    real    the BrickNet val set the caption describes (Kulits & Schmid, CVPR 2026; research use)
    sketch  the app's Sketch shape model, cells as 1x1 plates
    single  one legal-moves build that ends when the builder ends it
    smc     --runs builds grown together, scored every --every parts, weaker half replaced by copies
Pass: mean(smc) - mean(sketch) >= 0.5 * (mean(real) - mean(sketch)).
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

from .baselines import Sketch, real_model  # noqa: E402
from .connectors import Connectors, load_compat  # noqa: E402
from .dataset import D, LAB, caption_ids  # noqa: E402
from .render import Scorer  # noqa: E402
from .sample import Legal, Run  # noqa: E402
from .smc import smc  # noqa: E402
from .world import World, upright  # noqa: E402

METHODS = ('real', 'sketch', 'single', 'smc')
# 20 unseen (val) captions that clearly describe a small vehicle: the review's narrow first gate
VEHICLES = (5, 10, 19, 40, 54, 66, 80, 93, 98, 118, 126, 167, 194, 200, 238, 257, 259, 270, 300, 314)


def ldr(stems, colours, poses, name: str, caption: str) -> str:
    lines = [f'0 {name}', f'0 Name: {name}.ldr', '0 Author: Brick Lab; BrickNet data (Kulits & Schmid, CVPR 2026)',
             f'0 // {caption}']
    for s, c, m in zip(stems, colours, poses):
        nums = ' '.join(f'{round(float(v), 4) + 0.0:g}' for v in [*m[:3, 3], *m[:3, :3].flat])
        lines.append(f'1 {c} {nums} {s}.dat')
    return '\n'.join(lines) + '\n'


def report(rows: list[dict]) -> tuple[str, bool]:
    def mean(k):
        v = [r[k]['score'] for r in rows if k in r]
        return float(np.mean(v)) if v else float('nan')

    m = {k: mean(k) for k in METHODS}
    gap = m['real'] - m['sketch']
    ok = bool(m['smc'] - m['sketch'] >= 0.5 * gap)
    lines = ['# Brick Lab experiment 2', '',
             'CLIP ViT-B/32 match between two renders and the caption, on BrickNet val captions '
             '(Kulits & Schmid, CVPR 2026; research use).', '',
             '| method | mean CLIP match | mean parts | mean seconds | captions |', '|---|---|---|---|---|']
    for k in METHODS:
        rs = [r[k] for r in rows if k in r]
        if rs:
            lines.append(f"| {k} | {m[k]:.4f} | {np.mean([r['parts'] for r in rs]):.0f} | "
                         f"{np.mean([r['seconds'] for r in rs]):.0f} | {len(rs)} |")
    closed = (m['smc'] - m['sketch']) / gap if gap else float('nan')
    lines += ['', f'Gap real - sketch: {gap:.4f}; smc closes {closed:.0%} of it (pass needs 50%): '
                  f"{'PASS' if ok else 'FAIL'}", '']
    wins = sum(r['smc']['score'] > r['single']['score'] for r in rows if 'smc' in r and 'single' in r)
    both = sum('smc' in r and 'single' in r for r in rows)
    if both:
        lines.append(f'smc beats single on {wins} of {both} captions.')
    return '\n'.join(lines) + '\n', ok


def run(n_captions: int = 64, runs: int = 16, every: int = 8, max_parts: int = 150, out: Path = LAB / 'exp2',
        methods=METHODS, device: str | None = None, log=print, rows_wanted=None, judge_app: bool = True) -> list[dict]:
    from .train import device as auto, load_builder
    dev = device or auto()
    out.mkdir(parents=True, exist_ok=True)
    state = out / 'exp2.json'
    rows: list[dict] = json.loads(state.read_text()) if state.exists() else []
    done = {r['row']: r for r in rows}
    _, texts = caption_ids('val')
    clip = np.load(LAB / 'clip_val.npy')
    picks = np.array(rows_wanted) if rows_wanted is not None else np.linspace(0, len(texts) - 1, n_captions).astype(int)
    n_captions = len(picks)
    scorer = Scorer(dev)
    model = vocab = conn = compat = rules = sketch = oracle = None
    for j, row in enumerate(picks):
        row = int(row)
        rec = done.get(row) or {'row': row, 'caption': texts[row]}
        vec = clip[row]
        for k in methods:
            if k in rec:
                continue
            t0 = time.time()
            extra = {}
            if k == 'real':
                view = real_model(row)
            elif k == 'sketch':
                sketch = sketch or Sketch(device='cpu')
                view = sketch.model(vec, seed=row)
            else:
                if model is None:
                    model, vocab = load_builder(LAB / 'lab.pt', dev)
                    conn = Connectors(decode.Catalog(D))
                    compat = load_compat(LAB / 'compat.json')
                    rules = Legal(vocab, conn, compat)

                def new_world():
                    return World(conn, compat)

                if k == 'single':
                    r = Run(model, vocab, new_world, vec, rules, seed=row, finish=True, max_parts=max_parts)
                    while r.step():
                        pass
                else:
                    o = smc(model, vocab, new_world, vec, vec, scorer, rules, n=runs, every=every,
                            max_parts=max_parts, seed=row)
                    r = o['best']
                    extra = {'rounds': o['rounds'], 'by_round': o['scores'], 'final': o['final'][:4]}
                stems, cols, poses = r.model_view()
                view = (stems, cols, upright(poses))
                extra['closed'] = bool(r.stats['finished'])
                if judge_app:
                    from .exp1 import judge
                    from .oracle import Oracle
                    oracle = oracle or Oracle()
                    extra.update(judge(r.steps, list(r.world.poses), conn, compat, oracle))
            score = float(scorer.score([view], vec)[0])
            (out / f'{k}_{j:02d}.ldr').write_text(ldr(*view, f'{k}_{j:02d}', texts[row]))
            rec[k] = {'score': score, 'parts': len(view[0]), 'seconds': round(time.time() - t0, 1), **extra}
            log(f"{j + 1}/{n_captions} {k}: {score:.4f}, {len(view[0])} parts, {rec[k]['seconds']}s", flush=True)
            done[row] = rec
            rows = [done[int(p)] for p in picks if int(p) in done]
            state.write_text(json.dumps(rows, indent=1))
        sheet(out, j, rec)
        (out / 'report.md').write_text(report(rows)[0])
    if oracle:
        oracle.close()
    overview(out, rows)
    return rows


def read_ldr(path: Path):
    stems, cols, poses = [], [], []
    for line in path.read_text().splitlines():
        t = line.split()
        if len(t) >= 15 and t[0] == '1':
            v = [float(x) for x in t[2:14]]
            m = np.eye(4)
            m[:3, 3] = v[:3]
            m[:3, :3] = np.array(v[3:]).reshape(3, 3)
            stems.append(t[14].removesuffix('.dat'))
            cols.append(int(t[1]))
            poses.append(m)
    return stems, cols, poses


def sheet(out: Path, j: int, rec: dict) -> Path:
    """One caption's contact sheet: every method, both views, same renderer, caption on top."""
    from PIL import Image, ImageDraw
    from .render import SIZE, views
    tiles = []
    for k in METHODS:
        f = out / f'{k}_{j:02d}.ldr'
        ims = views(*read_ldr(f)) if f.exists() else [np.full((SIZE, SIZE, 3), 1.0)] * 2
        tiles.append((k, rec.get(k), np.concatenate(ims, 0)))
    W, H, top = SIZE * len(tiles), SIZE * 2 + 34, 44
    img = Image.new('RGB', (W, H + top), 'white')
    d = ImageDraw.Draw(img)
    cap = rec['caption']
    d.text((6, 4), cap[:150], fill='black')
    d.text((6, 20), cap[150:300], fill='black')
    for i, (k, r, a) in enumerate(tiles):
        img.paste(Image.fromarray((a * 255).astype(np.uint8)), (i * SIZE, top))
        label = k if r is None else f"{k}: {r['parts']} parts, CLIP {r['score']:.3f}"
        if r and 'app_overlaps' in r:
            label += f", app flags {len(r['app_overlaps'])}"
        d.text((i * SIZE + 4, top + 2 * SIZE + 8), label, fill='black')
    p = out / f'sheet_{j:02d}.png'
    img.save(p)
    return p


def overview(out: Path, rows: list[dict]) -> Path | None:
    """All captions in one picture: a row each, one view per method (real | sketch | single | smc)."""
    from PIL import Image
    files = sorted(out.glob('sheet_*.png'))
    if not files:
        return None
    from .render import SIZE
    strips = []
    for f in files:
        im = Image.open(f)
        top = 44
        strips.append(im.crop((0, 0, im.width, top + SIZE)))
    img = Image.new('RGB', (strips[0].width, sum(s.height for s in strips)), 'white')
    y = 0
    for s in strips:
        img.paste(s, (0, y))
        y += s.height
    p = out / 'overview.png'
    img.save(p)
    return p


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--n-captions', type=int, default=64)
    ap.add_argument('--runs', type=int, default=16)
    ap.add_argument('--every', type=int, default=8)
    ap.add_argument('--max-parts', type=int, default=150)
    ap.add_argument('--out', type=Path, default=LAB / 'exp2')
    ap.add_argument('--methods', default=','.join(METHODS))
    ap.add_argument('--device')
    ap.add_argument('--vehicles', action='store_true', help='the 20 small-vehicle captions (out defaults to LAB/exp2-vehicles)')
    a = ap.parse_args()
    if a.vehicles and a.out == LAB / 'exp2':
        a.out = LAB / 'exp2-vehicles'
    run(a.n_captions, a.runs, a.every, a.max_parts, a.out, tuple(a.methods.split(',')), a.device,
        rows_wanted=VEHICLES if a.vehicles else None)
    print((a.out / 'report.md').read_text())


if __name__ == '__main__':
    main()
