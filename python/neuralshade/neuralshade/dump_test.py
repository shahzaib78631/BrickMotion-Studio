"""Dumps one crop as raw RGBA8 buffers (what the browser exporter writes) plus PyTorch's output,
so the WebGL runtime can be checked against the reference implementation."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

from .data import _raw, load_scene
from .model import ShadeNet

ROOT = Path(__file__).resolve().parents[3]


def main() -> None:
    ck_path = Path(sys.argv[1]); scene = ROOT / "data/neuralshade" / sys.argv[2]
    top, left, size = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    out = ROOT / "data/neuralshade/nstest"; out.mkdir(parents=True, exist_ok=True)
    ck = torch.load(ck_path, map_location="cpu")
    net = ShadeNet(widths=tuple(ck["widths"]), levels=len(ck["widths"]) - 1, mode=ck.get("mode", "residual"), half=bool(ck.get("half", False)), detail=bool(ck.get("detail", False))); net.load_state_dict(ck["state"]); net.eval()
    import gzip
    for name in ("frame", "albedo", "normal"):
        raw = _raw(scene / f"{name}.bin.gz", 3200, 2400)[top:top + size, left:left + size]  # top row first
        np.ascontiguousarray(raw[::-1]).tofile(out / f"{name}.bin")  # back to bottom row first, as GL reads it
    pos = np.frombuffer(gzip.decompress((scene / "pos.bin.gz").read_bytes()), dtype=np.float16).reshape(2400, 3200, 4)[::-1]  # top row first
    np.ascontiguousarray(pos[top:top + size, left:left + size][::-1]).tofile(out / "pos.bin")
    full = load_scene(scene)["x"]
    # the extra inputs as the browser gets them: dome visibility (r) and the shine buffer (rgb), RGBA8, bottom row first
    vis = (np.clip(full[12, top:top + size, left:left + size], 0, 1) * 255 + 0.5).astype(np.uint8)
    rgba = np.zeros((size, size, 4), np.uint8); rgba[..., 0] = vis; rgba[..., 3] = 255
    np.ascontiguousarray(rgba[::-1]).tofile(out / "vis.bin")
    sp = np.zeros((size, size, 4), np.uint8); sp[..., :3] = (np.clip(full[13:16, top:top + size, left:left + size], 0, 1).transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8); sp[..., 3] = 255
    np.ascontiguousarray(sp[::-1]).tofile(out / "spec.bin")
    x = full[:, top:top + size, left:left + size]
    with torch.no_grad():
        y = net(torch.from_numpy(x[None]))[0].numpy()
    y.astype(np.float32).tofile(out / "expected.f32")
    print("dumped", size, "px crop; expected mean", float(y.mean()))


if __name__ == "__main__":
    main()
