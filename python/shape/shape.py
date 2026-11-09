"""BrickMotion's shape model: a prompt's CLIP embedding -> a 20x20x20 brick shape.

Two networks, trained in order:

1. vq:  a VQ-VAE that squeezes a 20^3 grid into 5x5x5 = 125 codes (one per 4x4x4 patch)
        from a codebook of 512, and turns codes back into a grid;
2. gpt: a small transformer that writes those 125 codes bottom-up, conditioned on CLIP
        (with a "no prompt" token, for classifier-free guidance).

Both are small enough to run in the browser in plain TypeScript (src/ai/shapeModel.ts),
so `export` writes their weights as one float16 file with a JSON header.

    python -I shape.py vq     DATA [--minutes 40]
    python -I shape.py tokens DATA
    python -I shape.py gpt    DATA [--minutes 120]
    python -I shape.py export DATA OUT.bin
    python -I shape.py sample DATA "a red chair"

DATA is the folder python/shape/prepare.py wrote.
"""
from __future__ import annotations

import argparse
import os
import json
import math
import struct
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

G = 20
L = 5  # latent side
K = 512  # codebook size
D = 64  # code width
SEQ = L * L * L
DEV = os.environ.get('SHAPE_DEVICE') or ('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')


# ---------------------------------------------------------------- data

def unpack(packed: np.ndarray) -> torch.Tensor:
    """(B, 1000) packed bits -> (B, 1, X, Y, Z) float."""
    g = np.unpackbits(packed, axis=1)[:, :G * G * G].reshape(-1, 1, G, G, G)
    return torch.from_numpy(g.astype(np.float32))


def variant(x: torch.Tensor, v: int) -> torch.Tensor:
    """One of 8 variants: 4 turns about the up axis (z), mirrored or not."""
    x = torch.rot90(x, v % 4, dims=(2, 3))
    return torch.flip(x, dims=(2,)) if v >= 4 else x


def settle(x: torch.Tensor) -> torch.Tensor:
    """Drop the shape onto the ground and centre it across (after a turn the grid can shift)."""
    out = torch.zeros_like(x)
    for i in range(x.shape[0]):
        occ = x[i, 0].nonzero()
        if len(occ) == 0:
            continue
        lo, hi = occ.min(0).values, occ.max(0).values
        size = hi - lo + 1
        start = torch.tensor([(G - size[0]) // 2, (G - size[1]) // 2, 0], device=x.device)
        sl = x[i, 0, lo[0]:hi[0] + 1, lo[1]:hi[1] + 1, lo[2]:hi[2] + 1]
        out[i, 0, start[0]:start[0] + size[0], start[1]:start[1] + size[1], :size[2]] = sl
    return out


# ---------------------------------------------------------------- VQ-VAE

class Block(nn.Module):
    """A pre-norm transformer block (causal for the GPT, open for the VQ-VAE)."""

    def __init__(self, width: int, heads: int, causal: bool, dropout: float = 0.0) -> None:
        super().__init__()
        self.heads, self.causal, self.dropout = heads, causal, dropout
        self.ln1 = nn.LayerNorm(width)
        self.qkv = nn.Linear(width, 3 * width)
        self.proj = nn.Linear(width, width)
        self.ln2 = nn.LayerNorm(width)
        self.fc = nn.Linear(width, 4 * width)
        self.out = nn.Linear(4 * width, width)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, w = x.shape
        q, k, v = self.qkv(self.ln1(x)).view(b, t, 3, self.heads, w // self.heads).permute(2, 0, 3, 1, 4)
        p = self.dropout if self.training else 0.0
        a = F.scaled_dot_product_attention(q, k, v, is_causal=self.causal, dropout_p=p)
        x = x + F.dropout(self.proj(a.transpose(1, 2).reshape(b, t, w)), p, self.training)
        return x + F.dropout(self.out(F.gelu(self.fc(self.ln2(x)), approximate='tanh')), p, self.training)


P = G // L  # patch side: each code stands for a 4x4x4 block of the grid
VW, VLAYERS, VHEADS = 256, 4, 8


def patchify(x: torch.Tensor) -> torch.Tensor:
    """(B, 1, X, Y, Z) -> (B, 125, 64): patches written bottom-up (z, then y, then x)."""
    b = x.shape[0]
    return x.view(b, L, P, L, P, L, P).permute(0, 5, 3, 1, 2, 4, 6).reshape(b, SEQ, P ** 3)


def unpatchify(p: torch.Tensor) -> torch.Tensor:
    b = p.shape[0]
    return p.view(b, L, L, L, P, P, P).permute(0, 3, 4, 2, 5, 1, 6).reshape(b, 1, G, G, G)


class VQ(nn.Module):
    """A patch transformer VQ-VAE (as ViT-VQGAN): every op is a matrix multiply, which the
    M1's GPU runs fast (its 3D convolutions are ~50x slower) and TypeScript runs simply."""

    def __init__(self) -> None:
        super().__init__()
        self.enc_in = nn.Linear(P ** 3, VW)
        self.enc_pos = nn.Parameter(torch.randn(SEQ, VW) * 0.02)
        self.enc_blocks = nn.ModuleList(Block(VW, VHEADS, False) for _ in range(VLAYERS))
        self.enc_ln = nn.LayerNorm(VW)
        self.enc_out = nn.Linear(VW, D)
        self.dec_in = nn.Linear(D, VW)
        self.dec_pos = nn.Parameter(torch.randn(SEQ, VW) * 0.02)
        self.dec_blocks = nn.ModuleList(Block(VW, VHEADS, False) for _ in range(VLAYERS))
        self.dec_ln = nn.LayerNorm(VW)
        self.dec_out = nn.Linear(VW, P ** 3)
        self.register_buffer('codes', torch.randn(K, D) * 0.1)
        self.register_buffer('ema_n', torch.ones(K))
        self.register_buffer('ema_sum', self.codes.clone())

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        h = self.enc_in(patchify(x)) + self.enc_pos
        for blk in self.enc_blocks:
            h = blk(h)
        return self.enc_out(self.enc_ln(h))

    def decode(self, q: torch.Tensor) -> torch.Tensor:
        """(B, 125, D) code vectors -> (B, 1, X, Y, Z) occupancy logits."""
        h = self.dec_in(q) + self.dec_pos
        for blk in self.dec_blocks:
            h = blk(h)
        return unpatchify(self.dec_out(self.dec_ln(h)))

    def quantise(self, z: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        flat = z.reshape(-1, D)
        dist = flat.pow(2).sum(1, keepdim=True) - 2 * flat @ self.codes.t() + self.codes.pow(2).sum(1)[None]
        return dist.argmin(1).view(z.shape[0], SEQ), flat

    def lookup(self, idx: torch.Tensor) -> torch.Tensor:
        return self.codes[idx]

    def forward(self, x: torch.Tensor):
        z = self.encode(x)
        idx, flat = self.quantise(z)
        q = self.lookup(idx)
        if self.training:  # EMA codebook, restart unused codes from the batch
            with torch.no_grad():
                one = F.one_hot(idx.view(-1), K).float()
                self.ema_n.mul_(0.99).add_(one.sum(0), alpha=0.01)
                self.ema_sum.mul_(0.99).add_(one.t() @ flat, alpha=0.01)
                n = self.ema_n.sum()
                norm = (self.ema_n + 1e-5) / (n + K * 1e-5) * n
                self.codes.copy_(self.ema_sum / norm[:, None])
                dead = self.ema_n < 0.03
                if dead.any():
                    pick = flat[torch.randint(0, len(flat), (int(dead.sum()),), device=flat.device)]
                    self.codes[dead] = pick
                    self.ema_sum[dead] = pick
                    self.ema_n[dead] = 1.0
        commit = F.mse_loss(z, q.detach())
        q = z + (q - z).detach()
        return self.decode(q), idx, commit


def iou(logits: torch.Tensor, x: torch.Tensor) -> float:
    p = logits > 0
    t = x > 0.5
    return float((p & t).sum() / (p | t).sum().clamp(min=1))


def train_vq(data: Path, minutes: float) -> None:
    occ = np.load(data / 'occ.npy')
    split = np.load(data / 'split.npy')
    train, test = np.where(split == 0)[0], np.where(split == 1)[0][:512]
    m = VQ().to(DEV)
    opt = torch.optim.AdamW(m.parameters(), lr=3e-4)
    xt = settle(unpack(occ[test])).to(DEV)
    t0, step = time.time(), 0
    while time.time() - t0 < minutes * 60:
        b = np.random.choice(train, 128)
        x = unpack(occ[b])
        x = settle(torch.cat([variant(x[i:i + 1], np.random.randint(8)) for i in range(len(x))])).to(DEV)
        m.train()
        logits, _, commit = m(x)
        loss = F.binary_cross_entropy_with_logits(logits, x, pos_weight=torch.tensor(3.0, device=DEV)) + 0.25 * commit
        opt.zero_grad()
        loss.backward()
        opt.step()
        step += 1
        if step % 200 == 0:
            m.eval()
            with torch.no_grad():
                lt, idx, _ = m(xt)
            used = len(torch.unique(idx))
            done = min(1.0, (time.time() - t0) / (minutes * 60))
            print(f'::progress {int(done * 1000)}/1000 vq step {step} loss {loss.item():.4f} test IoU {iou(lt, xt):.3f} codes used {used}', flush=True)
            torch.save(m.state_dict(), data / 'vq.pt')
    torch.save(m.state_dict(), data / 'vq.pt')


def tokens(data: Path) -> None:
    occ = np.load(data / 'occ.npy')
    m = VQ().to(DEV)
    m.load_state_dict(torch.load(data / 'vq.pt', map_location=DEV))
    m.eval()
    out = np.zeros((len(occ), 8, SEQ), dtype=np.int16)
    ious = []
    with torch.no_grad():
        for s in range(0, len(occ), 256):
            x = unpack(occ[s:s + 256])
            for v in range(8):
                xv = settle(variant(x, v)).to(DEV)
                logits, idx, _ = m(xv)
                out[s:s + len(x), v] = idx.cpu().numpy()
                if v == 0:
                    ious.append(iou(logits, xv))
            print(f'::progress {min(s + 256, len(occ))}/{len(occ)} tokens, mean IoU {np.mean(ious):.3f}', flush=True)
    np.save(data / 'tokens.npy', out)


# ---------------------------------------------------------------- transformer

W, LAYERS, HEADS, PREFIX = 320, 8, 8, 4


class GPT(nn.Module):
    """[4 prompt tokens][BOS][code 1 … code 125] -> next code."""

    def __init__(self) -> None:
        super().__init__()
        self.cond = nn.Linear(512, PREFIX * W)
        self.null = nn.Parameter(torch.zeros(512))
        self.tok = nn.Embedding(K + 1, W)  # K = BOS
        self.pos = nn.Parameter(torch.randn(PREFIX + 1 + SEQ, W) * 0.02)
        self.blocks = nn.ModuleList(Block(W, HEADS, True) for _ in range(LAYERS))
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
        return self.head(self.ln(x))[:, PREFIX:]  # position i predicts code i


def train_gpt(data: Path, minutes: float) -> None:
    toks = torch.from_numpy(np.load(data / 'tokens.npy').astype(np.int64))
    clip = torch.from_numpy(np.load(data / 'clip.npy').astype(np.float32))
    owner = np.load(data / 'caption_shape.npy')
    split = np.load(data / 'split.npy')
    train = np.where(split[owner] == 0)[0]
    test = np.where(split[owner] == 1)[0][:1024]
    m = GPT().to(DEV)
    print(f'{sum(p.numel() for p in m.parameters()) / 1e6:.1f}M parameters, {len(train)} training captions', flush=True)
    opt = torch.optim.AdamW(m.parameters(), lr=4e-4, weight_decay=0.05, betas=(0.9, 0.95))
    total = minutes * 60
    t0, step = time.time(), 0

    def batch(rows: np.ndarray, aug: bool):
        v = np.random.randint(0, 8, len(rows)) if aug else np.zeros(len(rows), dtype=int)
        seq = toks[owner[rows], v]
        c = clip[rows]
        if aug:  # drop the prompt 10% of the time for classifier-free guidance
            drop = torch.rand(len(rows)) < 0.1
            c = torch.where(drop[:, None], torch.zeros_like(c), c)
        return c.to(DEV), seq.to(DEV), torch.from_numpy(np.asarray(rows)).to(DEV)

    def loss_of(c, seq):
        null = (c.abs().sum(1, keepdim=True) == 0).float()
        c = c * (1 - null) + m.null[None] * null
        logits = m(c, seq[:, :-1])
        return F.cross_entropy(logits.reshape(-1, K), seq.reshape(-1))

    while time.time() - t0 < total:
        frac = (time.time() - t0) / total
        for g in opt.param_groups:  # warm up, then cosine down
            g['lr'] = 4e-4 * min(1.0, step / 500) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * frac)))
        m.train()
        c, seq, _ = batch(np.random.choice(train, 96), True)
        loss = loss_of(c, seq)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
        opt.step()
        step += 1
        if step % 250 == 0:
            m.eval()
            with torch.no_grad():
                c, seq, _ = batch(test, False)
                tl = loss_of(c, seq).item()
            print(f'::progress {int(frac * 1000)}/1000 gpt step {step} loss {loss.item():.3f} test {tl:.3f}', flush=True)
            torch.save(m.state_dict(), data / 'gpt.pt')
    torch.save(m.state_dict(), data / 'gpt.pt')


@torch.no_grad()
def sample(m: GPT, clip: torch.Tensor, guidance=3.0, temperature=0.9, top_k=40) -> torch.Tensor:
    seq = torch.zeros((1, 0), dtype=torch.long, device=clip.device)
    both = torch.cat([clip[None], m.null[None]])
    for _ in range(SEQ):
        logits = m(both, seq.expand(2, -1))[:, -1]
        l = logits[1] + guidance * (logits[0] - logits[1])
        l = l / temperature
        v, _ = l.topk(top_k)
        l[l < v[-1]] = -float('inf')
        seq = torch.cat([seq, torch.multinomial(F.softmax(l, -1), 1)[None]], 1)
    return seq


def sample_cmd(data: Path, prompt: str) -> None:
    from transformers import CLIPTextModelWithProjection, CLIPTokenizer
    tok = CLIPTokenizer.from_pretrained('openai/clip-vit-base-patch32')
    cm = CLIPTextModelWithProjection.from_pretrained('openai/clip-vit-base-patch32').eval()
    with torch.no_grad():
        e = cm(**tok([prompt], return_tensors='pt')).text_embeds
    e = (e / e.norm(dim=-1, keepdim=True))[0].to(DEV)
    vq, gpt = VQ().to(DEV).eval(), GPT().to(DEV).eval()
    vq.load_state_dict(torch.load(data / 'vq.pt', map_location=DEV))
    gpt.load_state_dict(torch.load(data / 'gpt.pt', map_location=DEV))
    g = vq.decode(vq.lookup(sample(gpt, e)))[0, 0] > 0
    for z in range(G):
        layer = g[:, :, z].cpu().numpy()
        if layer.any():
            print(f'z={z}')
            print('\n'.join(''.join('#' if c else '.' for c in row) for row in layer))


# ---------------------------------------------------------------- export

def export(data: Path, out: Path) -> None:
    """All weights as float16 in one file: u32 header length, JSON header, then data."""
    vq, gpt = VQ(), GPT()
    vq.load_state_dict(torch.load(data / 'vq.pt', map_location='cpu'))
    gpt.load_state_dict(torch.load(data / 'gpt.pt', map_location='cpu'))
    tensors = {f'vq.{k}': v for k, v in vq.state_dict().items() if k.startswith(('dec_', 'codes'))}
    tensors.update({f'gpt.{k}': v for k, v in gpt.state_dict().items()})
    header, blobs, offset = {'config': {'G': G, 'L': L, 'K': K, 'D': D, 'W': W, 'layers': LAYERS, 'heads': HEADS, 'prefix': PREFIX, 'VW': VW, 'vqLayers': VLAYERS, 'vqHeads': VHEADS}, 'tensors': {}}, [], 0
    for k, v in tensors.items():
        a = v.detach().float().numpy().astype(np.float16)
        header['tensors'][k] = {'shape': list(a.shape), 'offset': offset}
        blobs.append(a.tobytes())
        offset += a.size
    h = json.dumps(header).encode()
    h += b' ' * ((-len(h) - 4) % 2)  # keep the float16 data 2-byte aligned
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('wb') as f:
        f.write(struct.pack('<I', len(h)))
        f.write(h)
        for b in blobs:
            f.write(b)
    print(f'{offset / 1e6:.1f}M weights -> {out} ({out.stat().st_size / 1e6:.1f} MB)', flush=True)

    # what PyTorch computes for one test caption, so the TypeScript port can be checked
    # against it (tests/ai/shapeModel.test.ts), with the float16 weights the app uses
    vq.half().float().eval()
    gpt.half().float().eval()
    clip = torch.from_numpy(np.load(data / 'clip.npy')[-1].astype(np.float32))
    toks = torch.from_numpy(np.load(data / 'tokens.npy')[-1, 0].astype(np.int64))[None]
    with torch.no_grad():
        logits = gpt(clip[None], toks[:, :3])[0]  # first 4 positions
        occ = (vq.decode(vq.lookup(toks))[0, 0] > 0).flatten().int().tolist()
    ref = {'clip': clip.tolist(), 'codes': toks[0].tolist(), 'logits': logits.tolist(), 'occ': ''.join(map(str, occ))}
    (out.parent / 'shape.reference.json').write_text(json.dumps(ref))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['vq', 'tokens', 'gpt', 'export', 'sample'])
    ap.add_argument('data')
    ap.add_argument('arg', nargs='?')
    ap.add_argument('--minutes', type=float, default=None)
    a = ap.parse_args()
    data = Path(a.data)
    if a.cmd == 'vq':
        train_vq(data, a.minutes or 40)
    elif a.cmd == 'tokens':
        tokens(data)
    elif a.cmd == 'gpt':
        train_gpt(data, a.minutes or 120)
    elif a.cmd == 'export':
        export(data, Path(a.arg))
    else:
        sample_cmd(data, a.arg)


if __name__ == '__main__':
    main()
