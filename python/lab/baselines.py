"""Experiment 2's baselines, as (stems, colours, poses) for the renderer.

    real_model(i)   BrickNet val model i at its real poses (Kulits & Schmid, CVPR 2026; research use)
    Sketch().model  the app's Sketch shape model (public/data/ai/shape2.bin), sampled as the app does
                    (classifier-free guidance 3, temperature 0.9, top-40), each filled cell a 1x1
                    plate in its colour ("other" as light bluish grey 71)
"""
from __future__ import annotations

import json
import struct
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch

PY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PY / 'bricknet'))
sys.path.insert(0, str(PY / 'shape'))
import decode  # noqa: E402

from .dataset import D  # noqa: E402
from .world import upright  # noqa: E402

BIN = PY.parent / 'public' / 'data' / 'ai' / 'shape2.bin'
OTHER_COLOUR = 71


@lru_cache(maxsize=1)
def _val():
    return decode.load(D / 'val.npz'), decode.Catalog(D)


def real_model(i: int):
    arrs, cat = _val()
    pids, colors, edges = decode.model(arrs, i)
    order, poses = decode.realise(cat, pids, edges)
    return [cat.stems[pids[n]] for n in order], [int(colors[n]) for n in order], upright(list(poses))


class Sketch:
    def __init__(self, path: Path = BIN, device: str = 'cpu'):
        import shape2 as S
        self.S, self.dev = S, device
        f = Path(path).open('rb')
        n = struct.unpack('<I', f.read(4))[0]
        header = json.loads(f.read(n))
        blob = np.frombuffer(f.read(), dtype=np.float16)
        cfg = header['config']
        self.colours = cfg['colours']
        self.vq = S.VQ2(cfg['VW'], cfg['vqLayers'])
        self.gpt = S.GPT2()
        vq_sd, gpt_sd = {}, {}
        for k, t in header['tensors'].items():
            a = torch.from_numpy(blob[t['offset']:t['offset'] + int(np.prod(t['shape']))].astype(np.float32).reshape(t['shape']))
            (vq_sd if k.startswith('vq.') else gpt_sd)[k.split('.', 1)[1]] = a
        self.vq.load_state_dict(vq_sd, strict=False)  # the encoder is not shipped
        self.gpt.load_state_dict(gpt_sd)
        self.vq.to(device).eval()
        self.gpt.to(device).eval()

    @torch.no_grad()
    def codes(self, clip: np.ndarray, seed: int = 0, guidance: float = 3.0, temperature: float = 0.9,
              top_k: int = 40) -> torch.Tensor:
        g = torch.Generator().manual_seed(seed)
        c = torch.stack([torch.as_tensor(clip, dtype=torch.float32), self.gpt.null.detach().cpu()]).to(self.dev)
        seq = torch.zeros((2, 0), dtype=torch.long, device=self.dev)
        out = []
        for _ in range(self.S.SEQ):
            lg = self.gpt(c, seq)[:, -1].float().cpu()
            l = (lg[1] + guidance * (lg[0] - lg[1])) / temperature
            top = torch.topk(l, top_k)
            k = top.indices[torch.multinomial(torch.softmax(top.values, 0), 1, generator=g)].item()
            out.append(k)
            seq = torch.cat([seq, torch.full((2, 1), k, device=self.dev)], 1)
        return torch.tensor(out)

    @torch.no_grad()
    def model(self, clip: np.ndarray, seed: int = 0):
        codes = self.codes(clip, seed).to(self.dev)
        cls = self.vq.decode(self.vq.codes[codes][None]).argmax(-1)[0].cpu().numpy()  # (X, Z, Y)
        xs, zs, ys = np.nonzero(cls)
        stems, colours, poses = [], [], []
        for x, z, y in zip(xs, zs, ys):
            c = int(cls[x, z, y])
            m = np.eye(4)
            m[:3, 3] = [20.0 * x, -8.0 * y, 20.0 * z]
            stems.append('3024')
            colours.append(self.colours[c - 1] if 1 <= c <= len(self.colours) else OTHER_COLOUR)
            poses.append(m)
        return stems, colours, poses
