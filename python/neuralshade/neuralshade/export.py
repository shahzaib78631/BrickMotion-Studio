"""Writes a trained ShadeNet as shadenet.json + shadenet.bin for the WebGL runtime (src/render/neuralShade.ts).

Every conv is stored as 4x4 blocks so the shader can do `mat4 * vec4`: for each output group (4 channels),
input group, and 3x3 tap, four texels hold one column each (the weights of one input channel for the 4
outputs), then one bias texel per output group. All values float32, 4 per texel.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from .model import IN_CHANNELS, ShadeNet


def pack_conv(weight: torch.Tensor, bias: torch.Tensor) -> tuple[np.ndarray, int, int, int]:
    w = weight.detach().cpu().numpy()  # (out, in, k, k)
    b = bias.detach().cpu().numpy()
    cout, cin, k, _ = w.shape
    og, ig = -(-cout // 4), -(-cin // 4)
    wp = np.zeros((og * 4, ig * 4, k, k), np.float32); wp[:cout, :cin] = w
    bp = np.zeros(og * 4, np.float32); bp[:cout] = b
    out = []
    for o in range(og):
        for i in range(ig):
            for ky in range(k):
                for kx in range(k):
                    block = wp[o * 4:(o + 1) * 4, i * 4:(i + 1) * 4, ky, kx]  # (4 out, 4 in)
                    for col in range(4):  # one texel per input channel: its weights for the 4 outputs
                        out.append(block[:, col])
    for o in range(og):
        out.append(bp[o * 4:(o + 1) * 4])
    return np.concatenate(out).astype(np.float32), og, ig, k


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("--out", default="public/models/shadenet")
    a = ap.parse_args()
    ck = torch.load(a.checkpoint, map_location="cpu")
    widths = tuple(ck["widths"])
    mode = ck.get("mode", "residual")
    half = bool(ck.get("half", False))
    detail = bool(ck.get("detail", False))
    net = ShadeNet(widths=widths, levels=len(widths) - 1, mode=mode, half=half, detail=detail)
    net.load_state_dict(ck["state"])
    ops, blobs, offset = [], [], 0

    def conv(name: str, m: torch.nn.Conv2d, relu: bool):
        nonlocal offset
        data, og, ig, k = pack_conv(m.weight, m.bias)
        ops.append({"op": "conv", "name": name, "outGroups": og, "inGroups": ig, "k": k, "relu": relu, "offset": offset})
        blobs.append(data); offset += data.size

    levels = len(widths) - 1
    for i, block in enumerate(net.enc):
        conv(f"enc{i}a", block[0], True); conv(f"enc{i}b", block[2], True)
        if i < levels:
            ops.append({"op": "skip", "level": i})
            ops.append({"op": "pool"})
    for j, block in enumerate(net.dec):
        level = levels - 1 - j
        ops.append({"op": "up", "level": level})  # upsample to that level's size, concat with its skip
        conv(f"dec{level}a", block[0], True); conv(f"dec{level}b", block[2], True)
    conv("out", net.out, False)
    ops.append({"op": "residual", "mode": mode})
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.concatenate(blobs).tofile(out.with_suffix(".bin"))
    out.with_suffix(".json").write_text(json.dumps({"inChannels": IN_CHANNELS, "half": half, "spec": bool(ck.get("spec", False)), "detail": detail, "widths": widths, "floats": offset, "ops": ops}))
    print("wrote", out.with_suffix(".bin"), offset, "floats;", len(ops), "ops")


if __name__ == "__main__":
    main()
