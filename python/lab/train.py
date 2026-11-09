"""Train the builder (stages for the Kaggle notebook; each can resume).

    python -m lab.train tokens WORK DATA          tokens_sft.npz / tokens_val.npz in WORK
    python -m lab.train train WORK DATA [--minutes M] [--steps S] [--batch B]
    python -m lab.train export WORK OUT.pt

DATA holds the BrickNet files (sft.npz, val.npz, captions_*.jsonl, captions_sft_clip16.npy or
captions_sft_clip.npy, part_names.json, labels.json.xz). WORK holds vocab.json and clip_val.npy (made
locally, shipped with the code) and everything training writes: lab.ckpt (latest, for resuming),
lab.best.pt / lab.best.json (best test loss so far).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch

from .builder import Builder
from .dataset import D, SeqData, build, collate
from .sequence import Vocab

CODE_VERSION = '2026-11-08a builder, legal-moves experiment 1'
TEST_SEQS = 512


def device() -> str:
    return 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'


def clip_rows(work: Path, split: str, data: Path) -> np.ndarray:
    if split == 'sft':
        for name in ('captions_sft_clip16.npy', 'captions_sft_clip.npy'):
            if (data / name).exists():
                return np.load(data / name, mmap_mode='r')
        raise FileNotFoundError('captions_sft_clip.npy')
    return np.load(work / f'clip_{split}.npy')


def batches(data: SeqData, batch: int, rng: np.random.Generator):
    """Endless batches of similar length (fewer pad tokens): draw 64 batches' worth, sort by
    length, cut, shuffle the batches."""
    lengths = np.diff(data.ptr)
    while True:
        idx = rng.choice(len(data), size=min(len(data), batch * 64), replace=False)
        idx = idx[np.argsort(lengths[idx], kind='stable')]
        cut = [idx[i:i + batch] for i in range(0, len(idx), batch)]
        rng.shuffle(cut)
        for c in cut:
            yield collate([data[int(i)] for i in c])


@torch.no_grad()
def test_loss(model: Builder, test: list, dev: str) -> float:
    model.eval()
    total = 0.0
    for clip, tok in test:
        with torch.autocast('cuda', dtype=torch.float16, enabled=dev == 'cuda'):
            total += model.loss(clip.to(dev), tok.to(dev)).item()
    model.train()
    return total / len(test)


def train(work: Path, steps: int = 100_000, batch: int = 32, lr: float = 3e-4, patience: int = 12,
          every: int = 1000, minutes: float | None = None, train_split: str = 'sft', data: Path = D,
          model_kw: dict | None = None, seed: int = 0) -> dict:
    work, data = Path(work), Path(data)
    dev = device()
    vocab = Vocab.load(work / 'vocab.json')
    tr = SeqData(work / f'tokens_{train_split}.npz', clip_rows(work, train_split, data),
                 np.load(work / f'clip_{train_split}_model.npy'), seed=seed)
    te = SeqData(work / 'tokens_val.npz', clip_rows(work, 'val', data), np.load(work / 'clip_val_model.npy'), seed=1)
    n_test = min(TEST_SEQS, len(te))
    test = [collate([te[i] for i in range(a, min(a + 16, n_test))]) for a in range(0, n_test, 16)]

    ckpt_path = work / 'lab.ckpt'
    st = torch.load(ckpt_path, map_location='cpu', weights_only=False) if ckpt_path.exists() else None
    config = st['config'] if st else dict(vocab_size=vocab.size, **(model_kw or {}))
    model = Builder(**config).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.01)
    scaler = torch.amp.GradScaler('cuda', enabled=dev == 'cuda')
    step, best, stale = 0, math.inf, 0
    if st:
        model.load_state_dict(st['model'])
        opt.load_state_dict(st['opt'])
        scaler.load_state_dict(st['scaler'])
        step, best, stale = st['step'], st['best'], st['stale']
    resumed = step
    warm = min(1000, max(1, steps // 20))

    def lr_at(s: int) -> float:
        if s < warm:
            return lr * (s + 1) / warm
        return lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, (s - warm) / max(1, steps - warm)))))

    def save() -> None:
        torch.save({'config': config, 'model': model.state_dict(), 'opt': opt.state_dict(),
                    'scaler': scaler.state_dict(), 'step': step, 'best': best, 'stale': stale,
                    'code': CODE_VERSION}, ckpt_path)

    log = {'resumed_from': resumed, 'tests': []}

    def check() -> None:
        nonlocal best, stale
        tl = test_loss(model, test, dev)
        log['tests'].append((step, tl))
        if tl < best:
            best, stale = tl, 0
            torch.save({'config': config, 'model': model.state_dict(), 'step': step, 'test_loss': tl},
                       work / 'lab.best.pt')
            (work / 'lab.best.json').write_text(json.dumps({'step': step, 'test_loss': tl}))
            print(f'lab test {step} {tl:.4f} (best)', flush=True)
        else:
            stale += 1
            print(f'lab test {step} {tl:.4f} (best {best:.4f}, {stale}/{patience} without better)', flush=True)
        save()

    start = time.time()
    it = batches(tr, batch, np.random.default_rng(seed + step))
    model.train()
    while step < steps and stale < patience:
        if minutes is not None and time.time() - start > minutes * 60:
            print('time limit reached', flush=True)
            break
        clip, tok = next(it)
        for g in opt.param_groups:
            g['lr'] = lr_at(step)
        with torch.autocast('cuda', dtype=torch.float16, enabled=dev == 'cuda'):
            loss = model.loss(clip.to(dev), tok.to(dev))
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt)
        scaler.update()
        step += 1
        if step % 100 == 0:
            print(f'lab step {step} loss {loss.item():.4f} lr {lr_at(step):.2e} {time.time() - start:.0f}s', flush=True)
        if step % every == 0 or step == steps:
            check()
    if not log['tests'] or log['tests'][-1][0] != step:
        check()  # a run stopped by its time limit still tests and keeps its best
    save()
    return log


def export(work: Path, out: Path) -> Path:
    best = torch.load(Path(work) / 'lab.best.pt', map_location='cpu', weights_only=False)
    vocab = json.loads((Path(work) / 'vocab.json').read_text())
    torch.save({'config': best['config'], 'model': {k: v.half() for k, v in best['model'].items()},
                'vocab': vocab, 'step': best['step'], 'test_loss': best['test_loss'], 'code': CODE_VERSION}, out)
    print(f'exported the best builder (step {best["step"]}, test loss {best["test_loss"]:.4f}) -> {out}')
    return Path(out)


def load_builder(path: Path, dev: str = 'cpu') -> tuple[Builder, Vocab]:
    st = torch.load(path, map_location='cpu', weights_only=True)  # tensors and plain values only: runs no code
    m = Builder(**st['config'])
    m.load_state_dict({k: v.float() for k, v in st['model'].items()})
    return m.to(dev).eval(), Vocab(st['vocab']['parts'], st['vocab']['colours'])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('stage', choices=['tokens', 'train', 'export'])
    ap.add_argument('work')
    ap.add_argument('arg', nargs='?')
    ap.add_argument('--minutes', type=float)
    ap.add_argument('--steps', type=int, default=100_000)
    ap.add_argument('--batch', type=int, default=32)
    a = ap.parse_args()
    work = Path(a.work)
    print('code version', CODE_VERSION, flush=True)
    if a.stage == 'tokens':
        build('sft', work, data=Path(a.arg))
        build('val', work, data=Path(a.arg))
    elif a.stage == 'train':
        train(work, steps=a.steps, batch=a.batch, minutes=a.minutes, data=Path(a.arg))
    else:
        export(work, Path(a.arg))


if __name__ == '__main__':
    main()
