"""BrickMotion's shape model: a prompt's CLIP embedding -> a 20x20x20 brick shape.

Two networks, trained in order:

1. vq:  a 3D VQ-VAE that squeezes a 20^3 grid into 5x5x5 = 125 codes from a codebook of
        512, and turns codes back into a grid;
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
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'


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

class VQ(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.enc = nn.Sequential(
            nn.Conv3d(1, 64, 3, padding=1), nn.ReLU(),
            nn.Conv3d(64, 128, 4, stride=2, padding=1), nn.ReLU(),  # 10
            nn.Conv3d(128, 128, 3, padding=1), nn.ReLU(),
            nn.Conv3d(128, 256, 4, stride=2, padding=1), nn.ReLU(),  # 5
            nn.Conv3d(256, D, 1),
        )
        self.dec = nn.Sequential(
            nn.Conv3d(D, 256, 3, padding=1), nn.ReLU(),
            nn.ConvTranspose3d(256, 128, 4, stride=2, padding=1), nn.ReLU(),  # 10
            nn.Conv3d(128, 128, 3, padding=1), nn.ReLU(),
            nn.ConvTranspose3d(128, 64, 4, stride=2, padding=1), nn.ReLU(),  # 20
            nn.Conv3d(64, 1, 3, padding=1),
        )
        self.register_buffer('codes', torch.randn(K, D) * 0.1)
        self.register_buffer('ema_n', torch.ones(K))
        self.register_buffer('ema_sum', self.codes.clone())

    def quantise(self, z: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        flat = z.permute(0, 2, 3, 4, 1).reshape(-1, D)
        dist = flat.pow(2).sum(1, keepdim=True) - 2 * flat @ self.codes.t() + self.codes.pow(2).sum(1)[None]
        idx = dist.argmin(1)
        return idx.view(z.shape[0], L, L, L), flat

    def lookup(self, idx: torch.Tensor) -> torch.Tensor:
        return self.codes[idx].permute(0, 4, 1, 2, 3)

    def forward(self, x: torch.Tensor):
        z = self.enc(x)
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
        return self.dec(q), idx, commit


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
                out[s:s + len(x), v] = order(idx).cpu().numpy()
                if v == 0:
                    ious.append(iou(logits, xv))
            print(f'::progress {min(s + 256, len(occ))}/{len(occ)} tokens, mean IoU {np.mean(ious):.3f}', flush=True)
    np.save(data / 'tokens.npy', out)


def order(idx: torch.Tensor) -> torch.Tensor:
    """(B, X, Y, Z) codes -> (B, 125) written bottom-up: z, then y, then x."""
    return idx.permute(0, 3, 2, 1).reshape(idx.shape[0], SEQ)


def unorder(seq: torch.Tensor) -> torch.Tensor:
    return seq.view(-1, L, L, L).permute(0, 3, 2, 1)


# ---------------------------------------------------------------- transformer

W, LAYERS, HEADS, PREFIX = 320, 8, 8, 4


class Block(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(W)
        self.qkv = nn.Linear(W, 3 * W)
        self.proj = nn.Linear(W, W)
        self.ln2 = nn.LayerNorm(W)
        self.fc = nn.Linear(W, 4 * W)
        self.out = nn.Linear(4 * W, W)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, _ = x.shape
        q, k, v = self.qkv(self.ln1(x)).view(b, t, 3, HEADS, W // HEADS).permute(2, 0, 3, 1, 4)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        x = x + self.proj(a.transpose(1, 2).reshape(b, t, W))
        return x + self.out(F.gelu(self.fc(self.ln2(x)), approximate='tanh'))


class GPT(nn.Module):
    """[4 prompt tokens][BOS][code 1 … code 125] -> next code."""

    def __init__(self) -> None:
        super().__init__()
        self.cond = nn.Linear(512, PREFIX * W)
        self.null = nn.Parameter(torch.zeros(512))
        self.tok = nn.Embedding(K + 1, W)  # K = BOS
        self.pos = nn.Parameter(torch.randn(PREFIX + 1 + SEQ, W) * 0.02)
        self.blocks = nn.ModuleList(Block() for _ in range(LAYERS))
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
    g = vq.dec(vq.lookup(unorder(sample(gpt, e))))[0, 0] > 0
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
    tensors = {f'vq.{k}': v for k, v in vq.state_dict().items() if k.startswith(('dec', 'codes'))}
    tensors.update({f'gpt.{k}': v for k, v in gpt.state_dict().items()})
    header, blobs, offset = {'config': {'G': G, 'L': L, 'K': K, 'D': D, 'W': W, 'layers': LAYERS, 'heads': HEADS, 'prefix': PREFIX}, 'tensors': {}}, [], 0
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
