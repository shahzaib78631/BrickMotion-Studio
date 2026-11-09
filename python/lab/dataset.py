"""Training data for the builder: every BrickNet model as step tokens (from a few random roots), plus the
CLIP text vector of each of its captions.

    python -m lab.dataset sft|val [OUT_DIR]   (from python/)

Writes OUT_DIR/tokens_SPLIT.npz (tokens int16 concatenated, ptr int64, model int32), OUT_DIR/vocab.json
(always built from the sft split, so every split shares it), OUT_DIR/clip_SPLIT_model.npy (the model of
each CLIP row) and, for val, OUT_DIR/clip_val.npy. The sft CLIP rows are BrickNet's own
captions_sft_clip.npy, read in place.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bricknet'))
import decode  # noqa: E402

from .connectors import Connectors
from .sequence import Vocab, encode, poses, to_steps

D = Path('/Users/mac/Projects/BrickMotion-Data/bricknet')
LAB = Path('/Users/mac/Projects/BrickMotion-Data/lab')


def embed_texts(texts: list[str], batch: int = 256) -> np.ndarray:
    """CLIP ViT-B/32 text vectors, unit length (the same model the app and BrickNet's vectors use)."""
    import torch
    from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast
    dev = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
    tok = CLIPTokenizerFast.from_pretrained('openai/clip-vit-base-patch32')
    model = CLIPTextModelWithProjection.from_pretrained('openai/clip-vit-base-patch32').to(dev).eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(texts), batch):
            t = tok(texts[i:i + batch], padding=True, truncation=True, max_length=77, return_tensors='pt').to(dev)
            e = model(**t).text_embeds
            out.append((e / e.norm(dim=-1, keepdim=True)).float().cpu().numpy())
    return np.concatenate(out).astype(np.float32)


def caption_ids(split: str, data: Path = D) -> tuple[list[int], list[str]]:
    ids, texts = [], []
    for line in (data / f'captions_{split}.jsonl').read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            ids.append(int(r['id']))
            texts.append(r['caption'])
    return ids, texts


def build(split: str, out_dir: Path = LAB, roots: int = 4, seed: int = 0, data: Path = D) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = Connectors(decode.Catalog(data))
    vocab_path = out_dir / 'vocab.json'
    if vocab_path.exists():
        vocab = Vocab.load(vocab_path)
    else:
        vocab = Vocab.from_arrays(decode.load(data / 'sft.npz'))
        vocab.save(vocab_path)
    arrs = decode.load(data / f'{split}.npz')
    rng = np.random.default_rng(seed)
    toks, ptr, model = [], [0], []
    skipped = 0
    n = len(arrs['node_ptr']) - 1
    for i in range(n):
        pids, colors, edges = decode.model(arrs, i)
        if not all(vocab.has_part(p) for p in pids) or not set(colors) <= set(vocab.colours):
            skipped += 1
            continue
        try:
            order, _ = decode.realise(conn.cat, pids, edges)
        except (KeyError, IndexError):
            skipped += 1
            continue
        for root in rng.choice(order, size=min(roots, len(order)), replace=False):
            steps = to_steps(pids, colors, edges, int(root), conn)
            if len(steps) < 2:
                continue
            poses(steps, conn)
            t = encode(steps, vocab)
            toks.append(t.astype(np.int16))
            ptr.append(ptr[-1] + len(t))
            model.append(i)
        if i % 5000 == 0:
            print(f'::progress {i}/{n} {split} models', flush=True)
    path = out_dir / f'tokens_{split}.npz'
    np.savez(path, tokens=np.concatenate(toks), ptr=np.array(ptr, dtype=np.int64), model=np.array(model, dtype=np.int32))
    ids, texts = caption_ids(split, data)
    np.save(out_dir / f'clip_{split}_model.npy', np.array(ids, dtype=np.int32))
    if split != 'sft' and not (out_dir / f'clip_{split}.npy').exists():
        np.save(out_dir / f'clip_{split}.npy', embed_texts(texts))
    print(f'{split}: {len(model)} sequences from {n - skipped} of {n} models ({skipped} skipped) -> {path}')
    return path


class SeqData:
    """Torch-style dataset: (clip[512] float32, tokens int64) for each sequence; the caption is one of
    the model's captions, picked at random each time."""

    def __init__(self, npz: Path, clip: np.ndarray, clip_model: np.ndarray, seed: int = 0):
        d = np.load(npz)
        self.tokens, self.ptr, self.model = d['tokens'], d['ptr'], d['model']
        self.clip = clip
        rows: dict[int, list[int]] = {}
        for r, m in enumerate(clip_model.tolist()):
            rows.setdefault(m, []).append(r)
        self.rows = rows
        self.rng = np.random.default_rng(seed)

    def __len__(self) -> int:
        return len(self.model)

    def __getitem__(self, i: int):
        import torch
        m = int(self.model[i])
        rs = self.rows.get(m)
        clip = np.asarray(self.clip[int(self.rng.choice(rs))], dtype=np.float32) if rs else np.zeros(512, np.float32)
        t = self.tokens[self.ptr[i]:self.ptr[i + 1]].astype(np.int64)
        return torch.from_numpy(clip), torch.from_numpy(t)


def collate(items):
    import torch
    from .sequence import Vocab
    n = max(len(t) for _, t in items)
    tok = torch.full((len(items), n), Vocab.PAD, dtype=torch.long)
    for k, (_, t) in enumerate(items):
        tok[k, :len(t)] = t
    return torch.stack([c for c, _ in items]), tok


if __name__ == '__main__':
    build(sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else LAB)
