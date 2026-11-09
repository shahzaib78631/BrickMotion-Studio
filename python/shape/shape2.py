"""BrickMotion's detailed shape model (v2): CLIP embedding -> coloured shape on the stud grid.

The grid is 32 x 32 studs and 64 plates high, the app's own grid, and every cell is
empty, one of the 32 most used LDraw colours, or "other". Trained on:

* every OMR model, voxelised from real part geometry (python/omr/voxelise.py), steered by
  CLIP text of the set's name, theme and submodel, or CLIP image of a render of it
  (python/shape/render.py), so a picture can be a prompt;
* StableText2Brick's 47k captioned shapes (no colour: only whether a cell is filled is
  learned from them), scaled to plates.

Same two networks as v1 (python/shape/shape.py), larger: a patch-transformer VQ-VAE
(4 x 4 studs x 8 plates per code: 8 x 8 x 8 = 512 codes) and a GPT that writes them.

    python -I shape2.py data   SHAPE_DIR SHAPE2_DIR
    python -I shape2.py vq     SHAPE2_DIR [--minutes 60]
    python -I shape2.py tokens SHAPE2_DIR
    python -I shape2.py gpt    SHAPE2_DIR [--minutes 180]
    python -I shape2.py export SHAPE2_DIR OUT.bin
"""
from __future__ import annotations

import argparse
import json
import math
import re
import struct
import time
from pathlib import Path

import sys

import numpy as np

# shown by the Kaggle notebook, so a run says which code it trains with
CODE_VERSION = '2026-11-07c GPT dropout, keeps the best test loss, stops early'
GPT_DROPOUT = 0.1  # training only; the exported weights and the browser model are unchanged
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shape import DEV, Block, unpack  # noqa: E402

X, Z, Y = 32, 32, 64  # studs, studs, plates
PX, PZ, PY = 4, 4, 8
LX, LZ, LY = X // PX, Z // PZ, Y // PY
SEQ = LX * LZ * LY  # 512
CELLS = PX * PZ * PY  # 128
NCOL = 32
EMPTY, OTHER, UNKNOWN = 0, NCOL + 1, NCOL + 2  # classes: 0 empty, 1..32 colours, 33 other, 34 unknown (input only)
NOUT = NCOL + 2  # what the decoder predicts: empty, 32 colours, other
K, D = 1024, 64
VW, VLAYERS, VHEADS = 256, 4, 8
W, LAYERS, HEADS, PREFIX = 320, 8, 8, 4


# ---------------------------------------------------------------- data

def caption_variants(m: dict) -> list[str]:
    name = m['name']
    theme = m['theme'].split('>')[-1].strip()
    part = re.sub(r'^\d+(-\d+)?\s+', '', m['part']).strip()
    if part and not re.search(r'(^|\s)(step|sub|submodel|model|main|part)\s*\d*', part, re.I):
        return [f'{part} from the LEGO set {name}', f'a LEGO {part}', f'{part}, {theme}']
    if part:
        return [f'part of the LEGO set {name}', f'a section of {name}']
    return [f'{name}', f'a LEGO {name}', f'{name}, a LEGO {theme} set']


def data_cmd(src: Path, out: Path) -> None:
    z = np.load(out / 'omr_voxels.npz')
    cells, offsets = z['cells'], z['offsets']
    meta = [json.loads(l) for l in (out / 'omr_samples.jsonl').read_text().splitlines()]
    counts = np.bincount(cells[:, 3].astype(np.int64))
    top = [int(c) for c in np.argsort(-counts)[:NCOL]]
    lut = np.full(max(512, len(counts)), OTHER, dtype=np.uint8)
    for i, c in enumerate(top):
        lut[c] = i + 1
    grids = np.zeros((len(meta), X, Z, Y), dtype=np.uint8)
    for i in range(len(meta)):
        c = cells[offsets[i]:offsets[i + 1]].astype(np.int64)
        grids[i, c[:, 0], c[:, 2], c[:, 1]] = lut[np.minimum(c[:, 3], len(lut) - 1)]
    np.save(out / 'omr_grids.npy', grids)
    (out / 'colours.json').write_text(json.dumps(top))

    from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast
    tok = CLIPTokenizerFast.from_pretrained('openai/clip-vit-base-patch32')
    model = CLIPTextModelWithProjection.from_pretrained('openai/clip-vit-base-patch32').eval()
    caps, owner = [], []
    for i, m in enumerate(meta):
        for c in caption_variants(m):
            caps.append(c)
            owner.append(i)
    embs = []
    with torch.no_grad():
        for s in range(0, len(caps), 256):
            e = model(**tok(caps[s:s + 256], padding=True, truncation=True, max_length=77, return_tensors='pt')).text_embeds
            embs.append((e / e.norm(dim=-1, keepdim=True)).half().numpy())
            print(f'::progress {min(s + 256, len(caps))}/{len(caps)} captions', flush=True)
    np.save(out / 'omr_text_clip.npy', np.concatenate(embs))
    np.save(out / 'omr_text_owner.npy', np.array(owner, dtype=np.int32))
    (out / 'omr_captions.json').write_text(json.dumps(caps))
    # StableText2Brick, from v1's folder
    for f in ['occ.npy', 'split.npy', 'clip.npy', 'caption_shape.npy']:
        (out / f'stb_{f}').write_bytes((src / f).read_bytes())
    print(f'{len(meta)} OMR samples, {len(caps)} OMR captions, colours {top}', flush=True)


class Data:
    """Batches of (grid of classes, CLIP embedding) from both sources, augmented."""

    def __init__(self, d: Path) -> None:
        self.omr = np.load(d / 'omr_grids.npy', mmap_mode='r')
        self.meta = [json.loads(l) for l in (d / 'omr_samples.jsonl').read_text().splitlines()]
        self.text = np.load(d / 'omr_text_clip.npy').astype(np.float32)
        self.text_owner = np.load(d / 'omr_text_owner.npy')
        f = d / 'omr_image_clip.npy'
        self.image = np.load(f).astype(np.float32) if f.exists() else None  # renders not embedded yet: text only
        self.stb = np.load(d / 'stb_occ.npy')
        self.stb_split = np.load(d / 'stb_split.npy')
        self.stb_clip = np.load(d / 'stb_clip.npy', mmap_mode='r')
        self.stb_owner = np.load(d / 'stb_caption_shape.npy')
        rng = np.random.default_rng(0)
        sets = sorted({m['set'] for m in self.meta})
        test_sets = set(rng.choice(sets, max(1, len(sets) // 20), replace=False))
        self.omr_test = np.array([i for i, m in enumerate(self.meta) if m['set'] in test_sets])
        self.omr_train = np.array([i for i, m in enumerate(self.meta) if m['set'] not in test_sets])
        w = np.array([0.5 if 'Technic' in self.meta[i]['theme'] else 1.0 for i in self.omr_train])
        self.omr_w = w / w.sum()
        self.text_by = {}
        for j, o in enumerate(self.text_owner):
            self.text_by.setdefault(int(o), []).append(j)
        self.stb_train_caps = np.where(self.stb_split[self.stb_owner] == 0)[0]
        self.stb_test_caps = np.where(self.stb_split[self.stb_owner] == 1)[0]

    def stb_grid(self, shapes: np.ndarray) -> np.ndarray:
        """20^3 brick grids -> (B, X, Z, Y) classes: unknown colour, 3 plates per brick, centred."""
        g = unpack(self.stb[shapes]).numpy()[:, 0] > 0.5  # B, x, y, z(up)
        g = np.repeat(g, 3, axis=3)  # bricks -> plates
        out = np.zeros((len(shapes), X, Z, Y), dtype=np.uint8)
        out[:, 6:26, 6:26, :60] = np.where(g, UNKNOWN, EMPTY)
        return out

    def batch(self, n: int, omr_share=0.5, test=False, augment=True):
        no = int(round(n * omr_share))
        if test:
            oi = self.omr_test[np.arange(no) % len(self.omr_test)]
            caps = self.stb_test_caps[np.arange(n - no) % len(self.stb_test_caps)]
        else:
            oi = np.random.choice(self.omr_train, no, p=self.omr_w)
            caps = np.random.choice(self.stb_train_caps, n - no)
        g = np.concatenate([self.omr[np.sort(oi)][np.argsort(np.argsort(oi))] if no else np.zeros((0, X, Z, Y), np.uint8),
                            self.stb_grid(self.stb_owner[caps])])
        clip = np.zeros((n, 512), dtype=np.float32)
        for k, i in enumerate(oi):
            if test or self.image is None or np.random.rand() < 0.5:
                clip[k] = self.text[np.random.choice(self.text_by[int(i)]) if not test else self.text_by[int(i)][0]]
            else:
                clip[k] = self.image[i, np.random.randint(self.image.shape[1])]
        clip[no:] = self.stb_clip[caps].astype(np.float32)
        g = torch.from_numpy(g)
        if augment:
            for k in range(n):
                v = np.random.randint(8)
                t = torch.rot90(g[k], v % 4, dims=(0, 1))
                g[k] = torch.flip(t, dims=(0,)) if v >= 4 else t
            g = settle(g)
        return g, torch.from_numpy(clip)


def settle(g: torch.Tensor) -> torch.Tensor:
    """Centre each shape across (turns can shift it) and drop it to the ground."""
    out = torch.zeros_like(g)
    for i in range(g.shape[0]):
        occ = (g[i] > 0).nonzero()
        if len(occ) == 0:
            continue
        lo, hi = occ.min(0).values, occ.max(0).values
        size = hi - lo + 1
        sx, sz = (X - size[0]) // 2, (Z - size[1]) // 2
        out[i, sx:sx + size[0], sz:sz + size[1], :size[2]] = g[i, lo[0]:hi[0] + 1, lo[1]:hi[1] + 1, lo[2]:hi[2] + 1]
    return out


# ---------------------------------------------------------------- VQ-VAE

def patchify(g: torch.Tensor) -> torch.Tensor:
    """(B, X, Z, Y) -> (B, 512, 128): patches bottom-up (y, then z, then x); cells x, z, y inside."""
    b = g.shape[0]
    return g.reshape(b, LX, PX, LZ, PZ, LY, PY).permute(0, 5, 3, 1, 2, 4, 6).reshape(b, SEQ, CELLS)


def unpatchify(p: torch.Tensor) -> torch.Tensor:
    """(B, 512, 128, ...) -> (B, X, Z, Y, ...)."""
    b, rest = p.shape[0], p.shape[3:]
    p = p.reshape(b, LY, LZ, LX, PX, PZ, PY, *rest)
    return p.permute(0, 3, 4, 2, 5, 1, 6, *range(7, 7 + len(rest))).reshape(b, X, Z, Y, *rest)


class VQ2(nn.Module):
    def __init__(self, width: int = VW, layers: int = VLAYERS) -> None:
        super().__init__()
        self.width, self.layers = width, layers
        self.cell = nn.Embedding(NOUT + 1, 8)  # classes incl. unknown
        self.enc_in = nn.Linear(CELLS * 8, width)
        self.enc_pos = nn.Parameter(torch.randn(SEQ, width) * 0.02)
        self.enc_blocks = nn.ModuleList(Block(width, VHEADS, False) for _ in range(layers))
        self.enc_ln = nn.LayerNorm(width)
        self.enc_out = nn.Linear(width, D)
        self.dec_in = nn.Linear(D, width)
        self.dec_pos = nn.Parameter(torch.randn(SEQ, width) * 0.02)
        self.dec_blocks = nn.ModuleList(Block(width, VHEADS, False) for _ in range(layers))
        self.dec_ln = nn.LayerNorm(width)
        self.dec_out = nn.Linear(width, CELLS * NOUT)
        self.register_buffer('codes', torch.randn(K, D) * 0.1)
        self.register_buffer('ema_n', torch.ones(K))
        self.register_buffer('ema_sum', self.codes.clone())

    def encode(self, g: torch.Tensor) -> torch.Tensor:
        # one-hot @ table rather than an embedding lookup: same result, but the lookup's
        # backward pass (a scatter over a million cells) is ~10x slower on Apple GPUs
        p = (F.one_hot(patchify(g).long(), NOUT + 1).to(self.cell.weight.dtype) @ self.cell.weight).flatten(2)
        h = self.enc_in(p) + self.enc_pos
        for blk in self.enc_blocks:
            h = blk(h)
        return self.enc_out(self.enc_ln(h))

    def decode_hidden(self, q: torch.Tensor) -> torch.Tensor:
        h = self.dec_in(q) + self.dec_pos
        for blk in self.dec_blocks:
            h = blk(h)
        return self.dec_ln(h)

    def decode(self, q: torch.Tensor) -> torch.Tensor:
        """(B, 512, D) -> (B, X, Z, Y, NOUT) logits."""
        return unpatchify(self.dec_out(self.decode_hidden(q)).view(q.shape[0], SEQ, CELLS, NOUT))

    def quantise(self, z: torch.Tensor):
        flat = z.float().reshape(-1, D)
        dist = flat.pow(2).sum(1, keepdim=True) - 2 * flat @ self.codes.t() + self.codes.pow(2).sum(1)[None]
        return dist.argmin(1).view(z.shape[0], SEQ), flat

    def forward(self, g: torch.Tensor, hidden: bool = False):
        """-> (logits (B, X, Z, Y, NOUT), or the decoder's patch states with `hidden`), codes, commitment."""
        z = self.encode(g).float()
        # the codebook in full precision: in half precision its running sums over tens of
        # thousands of patches overflow (max 65504) and everything turns to NaN
        with torch.autocast(z.device.type, enabled=False):
            idx, q, commit = self._quantise_ema(g, z)
        st = z + (q - z).detach()
        return (self.decode_hidden(st) if hidden else self.decode(st)), idx, commit

    def _quantise_ema(self, g: torch.Tensor, z: torch.Tensor):
        idx, flat = self.quantise(z)
        q = self.codes[idx]
        if self.training:
            with torch.no_grad():
                one = F.one_hot(idx.view(-1), K).float()
                self.ema_n.mul_(0.99).add_(one.sum(0), alpha=0.01)
                self.ema_sum.mul_(0.99).add_(one.t() @ flat, alpha=0.01)
                n = self.ema_n.sum()
                norm = (self.ema_n + 1e-5) / (n + K * 1e-5) * n
                self.codes.copy_(self.ema_sum / norm[:, None])
                dead = self.ema_n < 0.03
                if dead.any():
                    # restart unused codes from patches with something in them: ~99% of patches
                    # are empty, and codes copied from those would all mean "nothing here"
                    busy = (patchify(g) > 0).any(-1).view(-1)
                    pool = flat[busy] if busy.sum() >= 1 else flat
                    pick = pool[torch.randint(0, len(pool), (int(dead.sum()),), device=flat.device)]
                    self.codes[dead] = pick
                    self.ema_sum[dead] = pick
                    self.ema_n[dead] = 1.0
        return idx, q, F.mse_loss(z, q.detach())


def save_vq(m: VQ2, d: Path) -> None:
    torch.save(m.state_dict(), d / 'vq2.pt')
    (d / 'vq2.json').write_text(json.dumps({'width': m.width, 'layers': m.layers}))


def load_vq(d: Path, device=DEV) -> VQ2:
    f = d / 'vq2.json'
    m = VQ2(**json.loads(f.read_text())) if f.exists() else VQ2()
    m.load_state_dict(torch.load(d / 'vq2.pt', map_location=device))
    return m.to(device)


def recon_loss(logits: torch.Tensor, g: torch.Tensor, fill_weight: float = 3.0, cell_weight: torch.Tensor | None = None) -> torch.Tensor:
    """Cross-entropy per cell; cells of unknown colour only need to be filled (any colour)."""
    lp = F.log_softmax(logits.float(), -1)
    g = g.long()
    known = g < UNKNOWN
    tgt = torch.where(known, g, torch.zeros_like(g))
    l_known = -lp.gather(-1, tgt[..., None])[..., 0]
    l_filled = -torch.logsumexp(lp[..., 1:], -1)
    loss = torch.where(known, l_known, l_filled)
    weight = torch.where(g == EMPTY, 1.0, fill_weight)
    if cell_weight is not None:
        weight = weight * cell_weight
    return (loss * weight).sum() / weight.sum()


def patch_loss(m: VQ2, h: torch.Tensor, g: torch.Tensor, fill_weight: float, empty_keep: float) -> torch.Tensor:
    """The reconstruction loss on every patch with something in it and a random share of the
    empty ones (weighted up to stand for the rest): shapes fill ~1% of the grid, so this skips
    most of the work on empty space without changing what is learned."""
    tp = patchify(g)  # B, SEQ, CELLS
    busy = (tp > 0).any(-1)
    keep = busy | (torch.rand(busy.shape, device=g.device) < empty_keep)
    hs, ts = h[keep], tp[keep]  # P, width / P, CELLS
    w = torch.where(busy[keep], 1.0, 1.0 / empty_keep)[:, None].expand_as(ts)
    return recon_loss(m.dec_out(hs).view(-1, CELLS, NOUT), ts, fill_weight, w)


def metrics(logits: torch.Tensor, g: torch.Tensor) -> tuple[float, float]:
    return metrics_pred(logits.argmax(-1), g)


def metrics_pred(pred: torch.Tensor, g: torch.Tensor) -> tuple[float, float]:
    """Occupancy IoU, and colour accuracy on filled cells of known colour."""
    pred = pred.long()
    p, t = pred > 0, g > 0
    iou = float((p & t).sum() / (p | t).sum().clamp(min=1))
    known = (g > 0) & (g < UNKNOWN)
    acc = float(((pred == g.long()) & known).sum() / known.sum().clamp(min=1))
    return iou, acc


class Trainer:
    """One optimiser step at a time, with half precision on NVIDIA GPUs and a checkpoint that
    lets a stopped run (a cloud session that ended) carry on where it left off."""

    def __init__(self, m: nn.Module, opt: torch.optim.Optimizer, ckpt: Path, minutes: float, clip: float = 0.0):
        self.m, self.opt, self.ckpt, self.clip = m, opt, ckpt, clip
        self.total = minutes * 60
        self.amp = DEV == 'cuda'
        self.scaler = torch.amp.GradScaler('cuda', enabled=self.amp)
        self.step, self.spent, self.t0 = 0, 0.0, time.time()
        if ckpt.exists():
            st = torch.load(ckpt, map_location=DEV, weights_only=False)
            m.load_state_dict(st['model'])
            opt.load_state_dict(st['opt'])
            self.scaler.load_state_dict(st['scaler'])
            self.step, self.spent = st['step'], st['spent']
            print(f'resuming at step {self.step} ({self.spent / 60:.1f} of {minutes:.1f} minutes done)', flush=True)

    def elapsed(self) -> float:
        return self.spent + time.time() - self.t0

    def running(self) -> bool:
        return self.elapsed() < self.total

    def frac(self) -> float:
        return min(1.0, self.elapsed() / self.total)

    def autocast(self):
        return torch.autocast('cuda', dtype=torch.float16, enabled=self.amp)

    def backward(self, loss: torch.Tensor) -> None:
        # stop early rather than burn hours of GPU time on a run that has gone to NaN
        if not torch.isfinite(loss):
            self.bad = getattr(self, 'bad', 0) + 1
            if self.bad >= 20:
                raise RuntimeError(f'loss is {loss.item()} for 20 steps in a row at step {self.step}: stopping')
            self.opt.zero_grad()
            return
        self.bad = 0
        self.opt.zero_grad()
        self.scaler.scale(loss).backward()
        if self.clip:
            self.scaler.unscale_(self.opt)
            torch.nn.utils.clip_grad_norm_(self.m.parameters(), self.clip)
        self.scaler.step(self.opt)
        self.scaler.update()
        self.step += 1

    def save(self) -> None:
        tmp = self.ckpt.with_suffix('.tmp')
        torch.save({'model': self.m.state_dict(), 'opt': self.opt.state_dict(), 'scaler': self.scaler.state_dict(),
                    'step': self.step, 'spent': self.elapsed()}, tmp)
        tmp.replace(self.ckpt)


def train_vq(d: Path, minutes: float, batch: int = 16, max_steps: int = 0, width: int = VW, layers: int = VLAYERS,
             fill_weight: float = 3.0, omr_share: float = 0.5, empty_keep: float = 1.0, lr: float = 3e-4) -> None:
    data = Data(d)
    m = VQ2(width, layers).to(DEV)
    print(f'code version {CODE_VERSION}', flush=True)
    print(f'VQ {sum(p.numel() for p in m.parameters()) / 1e6:.1f}M parameters, width {width}, layers {layers}, '
          f'fill weight {fill_weight}, OMR share {omr_share}, empty patches kept {empty_keep}', flush=True)
    opt = torch.optim.AdamW(m.parameters(), lr=lr)
    tr = Trainer(m, opt, d / 'vq2.ckpt', minutes)
    gt, _ = data.batch(128, test=True, augment=False)
    gt = gt.to(DEV)
    while tr.running():
        frac = tr.frac()
        for grp in opt.param_groups:  # cosine down to 10% at the end
            grp['lr'] = lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * frac)))
        g, _ = data.batch(batch, omr_share)  # small batches: logits are batch x 65536 cells x 34 classes
        g = g.to(DEV)
        m.train()
        with tr.autocast():
            h, _, commit = m(g, hidden=True)
            loss = patch_loss(m, h, g, fill_weight, empty_keep) + 0.25 * commit
        tr.backward(loss)
        step = tr.step
        if max_steps and step >= max_steps:
            break
        if step % 200 == 0:
            m.eval()
            with torch.no_grad():  # in chunks, to keep memory low
                with tr.autocast():
                    outs = [m(gt[i:i + 16]) for i in range(0, len(gt), 16)]
                pred = torch.cat([o[0].argmax(-1) for o in outs]).to(torch.uint8)
                idx = torch.cat([o[1] for o in outs])
                iou_o, acc_o = metrics_pred(pred[:64], gt[:64])
                iou_s, _ = metrics_pred(pred[64:], gt[64:])
            print(f'::progress {int(frac * 1000)}/1000 vq step {step} loss {loss.item():.4f} '
                  f'test IoU omr {iou_o:.3f} stb {iou_s:.3f} colour {acc_o:.3f} codes used {len(torch.unique(idx))}', flush=True)
            save_vq(m, d)
            tr.save()
    save_vq(m, d)
    tr.save()


def tokens_cmd(d: Path) -> None:
    """Codes for every OMR sample and every StableText2Brick shape, in all 8 turns/mirrors."""
    data = Data(d)
    m = load_vq(d)
    m.eval()

    def encode(g: torch.Tensor) -> np.ndarray:
        out = np.zeros((len(g), 8, SEQ), dtype=np.int16)
        for v in range(8):
            t = torch.rot90(g, v % 4, dims=(1, 2))
            t = settle(torch.flip(t, dims=(1,)) if v >= 4 else t)
            with torch.no_grad():
                out[:, v] = m(t.to(DEV))[1].cpu().numpy()
        return out

    omr = np.concatenate([encode(torch.from_numpy(np.array(data.omr[s:s + 64]))) for s in range(0, len(data.meta), 64)])
    np.save(d / 'omr_tokens.npy', omr)
    print(f'::progress 1/2 tokens: {len(omr)} OMR samples', flush=True)
    stb = []
    for s in range(0, len(data.stb), 64):
        stb.append(encode(torch.from_numpy(data.stb_grid(np.arange(s, min(s + 64, len(data.stb)))))))
        print(f'::progress {min(s + 64, len(data.stb))}/{len(data.stb)} StableText2Brick tokens', flush=True)
    np.save(d / 'stb_tokens.npy', np.concatenate(stb))


# ---------------------------------------------------------------- transformer

class GPT2(nn.Module):
    """[4 prompt tokens][BOS][code 1 … code 512] -> next code."""

    def __init__(self) -> None:
        super().__init__()
        self.cond = nn.Linear(512, PREFIX * W)
        self.null = nn.Parameter(torch.zeros(512))
        self.tok = nn.Embedding(K + 1, W)
        self.pos = nn.Parameter(torch.randn(PREFIX + 1 + SEQ, W) * 0.02)
        self.blocks = nn.ModuleList(Block(W, HEADS, True, GPT_DROPOUT) for _ in range(LAYERS))
        self.ln = nn.LayerNorm(W)
        self.head = nn.Linear(W, K)

    def forward(self, clip: torch.Tensor, seq: torch.Tensor) -> torch.Tensor:
        b = clip.shape[0]
        pre = self.cond(clip).view(b, PREFIX, W)
        bos = torch.full((b, 1), K, device=seq.device, dtype=torch.long)
        x = torch.cat([pre, self.tok(torch.cat([bos, seq], 1))], 1)
        x = x + self.pos[: x.shape[1]]
        for blk in self.blocks:
            x = blk(x)
        return self.head(self.ln(x))[:, PREFIX:]


def train_gpt(d: Path, minutes: float, batch_size: int = 32, patience: int = 12) -> None:
    data = Data(d)
    omr_tok = torch.from_numpy(np.load(d / 'omr_tokens.npy').astype(np.int64))
    stb_tok = torch.from_numpy(np.load(d / 'stb_tokens.npy').astype(np.int64))
    m = GPT2().to(DEV)
    print(f'{sum(p.numel() for p in m.parameters()) / 1e6:.1f}M parameters', flush=True)
    opt = torch.optim.AdamW(m.parameters(), lr=4e-4, weight_decay=0.05, betas=(0.9, 0.95))

    def batch(n: int, test: bool):
        no = n // 2
        if test:
            oi = data.omr_test[np.arange(no) % len(data.omr_test)]
            caps = data.stb_test_caps[np.arange(n - no) % len(data.stb_test_caps)]
            v = np.zeros(n, dtype=int)
        else:
            oi = np.random.choice(data.omr_train, no, p=data.omr_w)
            caps = np.random.choice(data.stb_train_caps, n - no)
            v = np.random.randint(0, 8, n)
        seq = torch.cat([omr_tok[oi, v[:no]], stb_tok[data.stb_owner[caps], v[no:]]])
        clip = np.zeros((n, 512), dtype=np.float32)
        for k, i in enumerate(oi):
            if test or data.image is None or np.random.rand() < 0.5:
                clip[k] = data.text[data.text_by[int(i)][0] if test else np.random.choice(data.text_by[int(i)])]
            else:
                clip[k] = data.image[i, np.random.randint(data.image.shape[1])]
        clip[no:] = data.stb_clip[caps].astype(np.float32)
        c = torch.from_numpy(clip)
        if not test:  # drop the prompt 10% of the time for classifier-free guidance
            c[torch.rand(n) < 0.1] = 0
        return c.to(DEV), seq.to(DEV)

    def loss_of(c, seq):
        null = (c.abs().sum(1, keepdim=True) == 0).float()
        c = c * (1 - null) + m.null[None] * null
        return F.cross_entropy(m(c, seq[:, :-1]).reshape(-1, K), seq.reshape(-1))

    tr = Trainer(m, opt, d / 'gpt2.ckpt', minutes, clip=1.0)
    # the transformer overfits once it has seen the data a few times (a 4-hour run's test loss
    # was best at step 4000, then rose 60%): keep the weights with the best test loss, and stop
    # after `patience` checks without a new best
    best_file = d / 'gpt2.best.json'
    best = json.loads(best_file.read_text()) if best_file.exists() else {'loss': float('inf'), 'step': 0}
    stale = 0

    def test_loss() -> float:
        m.eval()
        with torch.no_grad(), tr.autocast():
            # the same 256 test samples every time (no prompt dropout, first caption, first view)
            out = []
            for k in range(4):
                c, seq = batch(256, True)
                out.append(loss_of(c[k * 64:(k + 1) * 64], seq[k * 64:(k + 1) * 64]).item())
        return float(np.mean(out))

    while tr.running():
        frac, step = tr.frac(), tr.step
        for grp in opt.param_groups:
            grp['lr'] = 4e-4 * min(1.0, step / 500) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * frac)))
        m.train()
        with tr.autocast():
            loss = loss_of(*batch(batch_size, False))
        tr.backward(loss)
        step = tr.step
        if step % 250 == 0:
            tl = test_loss()
            mark = ''
            if tl < best['loss']:
                best, stale, mark = {'loss': tl, 'step': step}, 0, ' (best)'
                torch.save(m.state_dict(), d / 'gpt2.best.pt')
                best_file.write_text(json.dumps(best))
            else:
                stale += 1
            print(f'::progress {int(frac * 1000)}/1000 gpt step {step} loss {loss.item():.3f} test {tl:.3f}{mark}', flush=True)
            torch.save(m.state_dict(), d / 'gpt2.pt')
            tr.save()
            if stale >= patience:
                print(f'test loss has not improved for {patience} checks: stopping. Best {best["loss"]:.3f} at step {best["step"]}', flush=True)
                break
    torch.save(m.state_dict(), d / 'gpt2.pt')
    tr.save()


# ---------------------------------------------------------------- export

def export(d: Path, out: Path) -> None:
    vq, gpt = load_vq(d, 'cpu'), GPT2()
    # the weights with the best test loss, when training kept them
    best = d / 'gpt2.best.pt'
    gpt.load_state_dict(torch.load(best if best.exists() else d / 'gpt2.pt', map_location='cpu'))
    if best.exists():
        print(f'exporting the best transformer: {(d / "gpt2.best.json").read_text()}', flush=True)
    tensors = {f'vq.{k}': v for k, v in vq.state_dict().items() if k.startswith(('dec_', 'codes'))}
    tensors.update({f'gpt.{k}': v for k, v in gpt.state_dict().items()})
    config = {'version': 2, 'X': X, 'Z': Z, 'Y': Y, 'PX': PX, 'PZ': PZ, 'PY': PY, 'K': K, 'D': D, 'W': W,
              'layers': LAYERS, 'heads': HEADS, 'prefix': PREFIX, 'VW': vq.width, 'vqLayers': vq.layers, 'vqHeads': VHEADS,
              'classes': NOUT, 'colours': json.loads((d / 'colours.json').read_text())}
    header, blobs, offset = {'config': config, 'tensors': {}}, [], 0
    for k, v in tensors.items():
        a = v.detach().float().numpy().astype(np.float16)
        header['tensors'][k] = {'shape': list(a.shape), 'offset': offset}
        blobs.append(a.tobytes())
        offset += a.size
    h = json.dumps(header).encode()
    h += b' ' * ((-len(h) - 4) % 2)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('wb') as f:
        f.write(struct.pack('<I', len(h)))
        f.write(h)
        for b in blobs:
            f.write(b)
    print(f'{offset / 1e6:.1f}M weights -> {out} ({out.stat().st_size / 1e6:.1f} MB)', flush=True)
    # a PyTorch reference for tests/ai/shapeModel2.test.ts
    vq.half().float().eval()
    gpt.half().float().eval()
    data = Data(d)
    toks = torch.from_numpy(np.load(d / 'omr_tokens.npy')[data.omr_test[0], 0].astype(np.int64))[None]
    clip = torch.from_numpy(data.text[data.text_by[int(data.omr_test[0])][0]])
    with torch.no_grad():
        logits = gpt(clip[None], toks[:, :3])[0]
        cls = vq.decode(vq.codes[toks]).argmax(-1)[0].flatten().tolist()
    ref = {'clip': clip.tolist(), 'codes': toks[0].tolist(), 'logits': logits.tolist(), 'classes': cls}
    (out.parent / f'{out.stem}.reference.json').write_text(json.dumps(ref))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['data', 'vq', 'tokens', 'gpt', 'export'])
    ap.add_argument('dir')
    ap.add_argument('arg', nargs='?')
    ap.add_argument('--minutes', type=float, default=None)
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--steps', type=int, default=0, help='stop after this many steps (for timing)')
    ap.add_argument('--width', type=int, default=VW)
    ap.add_argument('--layers', type=int, default=VLAYERS)
    ap.add_argument('--fill-weight', type=float, default=3.0)
    ap.add_argument('--omr-share', type=float, default=0.5)
    ap.add_argument('--empty-keep', type=float, default=1.0, help='share of empty patches scored in the VQ loss')
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--gpt-batch', type=int, default=32)
    a = ap.parse_args()
    d = Path(a.dir)
    if a.cmd == 'data':
        data_cmd(d, Path(a.arg))
    elif a.cmd == 'vq':
        train_vq(d, a.minutes or 60, a.batch, a.steps, a.width, a.layers, a.fill_weight, a.omr_share, a.empty_keep, a.lr)
    elif a.cmd == 'tokens':
        tokens_cmd(d)
    elif a.cmd == 'gpt':
        train_gpt(d, a.minutes or 180, a.gpt_batch)
    else:
        export(d, Path(a.arg))


if __name__ == '__main__':
    main()
