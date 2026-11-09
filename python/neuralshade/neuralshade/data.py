"""Loads a training scene: the viewport's buffers (inputs) and EyeSight's render (target)."""
from __future__ import annotations

import gzip
from pathlib import Path

import numpy as np
from PIL import Image

HEIGHT_RANGE = 64.0  # studs, matches src/dev/neuralExport.ts
FAR = 2000.0


def _raw(path: Path, w: int, h: int) -> np.ndarray:
    """Raw gzipped RGBA8, bottom row first -> (h, w, 4) uint8 top row first."""
    data = np.frombuffer(gzip.decompress(path.read_bytes()), dtype=np.uint8)
    return data.reshape(h, w, 4)[::-1]


def load_scene(directory: Path, width: int = 3200, height: int = 2400) -> dict[str, np.ndarray]:
    """Returns float32 channels-first arrays: x (C,H,W) network input, y (3,H,W) target in 0..1."""
    frame = _raw(directory / "frame.bin.gz", width, height)[..., :3] / 255.0
    albedo = _raw(directory / "albedo.bin.gz", width, height)[..., :3] / 255.0
    normal = _raw(directory / "normal.bin.gz", width, height)
    pos = np.frombuffer(gzip.decompress((directory / "pos.bin.gz").read_bytes()), dtype=np.float16).reshape(height, width, 4)[::-1].astype(np.float32)
    covered = (normal[..., 3:4] > 127).astype(np.float32)
    n = normal[..., :3].astype(np.float32) / 255.0 * 2.0 - 1.0
    n = n * covered  # background: no normal
    depth = pos[..., 0]  # view distance / far
    height_a = pos[..., 1]  # height above the floor / 64 studs
    # dome visibility: 1 = sees the whole sky; missing in older scenes
    vis_path = directory / "vis.bin.gz"
    if vis_path.exists():
        vis = np.frombuffer(gzip.decompress(vis_path.read_bytes()), dtype=np.uint8).reshape(height, width)[::-1].astype(np.float32) / 255.0
    else:
        vis = np.ones((height, width), np.float32)
    # shine inputs (view dependent): fresnel, specular response to the BUILD_FL rig, mirror direction height; zeros in older scenes
    spec_path = directory / "spec.bin.gz"
    if spec_path.exists():
        spec = np.frombuffer(gzip.decompress(spec_path.read_bytes()), dtype=np.uint8).reshape(height, width, 4)[::-1, :, :3].astype(np.float32) / 255.0
    else:
        spec = np.zeros((height, width, 3), np.float32)
    # inputs: frame(3) albedo(3) normal(3) mask(1) depth(1) height-above-floor(1) dome-visibility(1) shine(3) = 16 channels
    x = np.concatenate([frame, albedo, n, covered, depth[..., None], height_a[..., None], vis[..., None], spec], axis=-1)
    out = {"x": np.ascontiguousarray(x.transpose(2, 0, 1)).astype(np.float32)}
    target = directory / "target.png"
    if not target.exists() and (directory / "target_blender.png").exists():
        target = directory / "target_blender.png"  # a Blender Cycles stand-in for EyeSight (see scripts/neural/blender)
    if target.exists():
        t = np.asarray(Image.open(target).convert("RGB"), dtype=np.float32) / 255.0
        out["y"] = np.ascontiguousarray(t.transpose(2, 0, 1))
    return out


def preview(directory: Path, width: int = 3200, height: int = 2400, scale: int = 4) -> None:
    """Writes small PNG previews of every buffer so alignment can be checked by eye."""
    s = load_scene(directory, width, height)
    x = s["x"]
    names = {"frame": slice(0, 3), "albedo": slice(3, 6), "normal": slice(6, 9)}
    for name, sl in names.items():
        img = x[sl].transpose(1, 2, 0)
        if name == "normal":
            img = img * 0.5 + 0.5
        Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((width // scale, height // scale)).save(directory / f"preview_{name}.png")
    for name, ch in {"depth": 10, "height": 11}.items():
        Image.fromarray((np.clip(x[ch], 0, 1) * 255).astype(np.uint8)).resize((width // scale, height // scale)).save(directory / f"preview_{name}.png")
    if "y" in s:
        Image.fromarray((np.clip(s["y"].transpose(1, 2, 0), 0, 1) * 255).astype(np.uint8)).resize((width // scale, height // scale)).save(directory / "preview_target.png")
