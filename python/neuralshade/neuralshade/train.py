"""Trains ShadeNet on scenes in data/neuralshade (inputs from the viewport, target from EyeSight)."""
from __future__ import annotations

import argparse
import random
import time
from pathlib import Path

import numpy as np
import torch

from .data import load_scene
from .model import ShadeNet

ROOT = Path(__file__).resolve().parents[3]


def pick_crop(x: np.ndarray, y: np.ndarray, size: int, rng: random.Random):
    _, h, w = x.shape
    mask = x[9]  # brick coverage
    for _ in range(8):
        if rng.random() < 0.8:  # mostly crops that contain a model (and its shadow around it)
            ys, xs = np.nonzero(mask[:: 8, :: 8])
            if len(ys):
                i = rng.randrange(len(ys))
                cy, cx = ys[i] * 8, xs[i] * 8
                top = int(np.clip(cy - size // 2 + rng.randint(-size // 3, size // 3), 0, h - size))
                left = int(np.clip(cx - size // 2 + rng.randint(-size // 3, size // 3), 0, w - size))
            else:
                top, left = rng.randrange(h - size), rng.randrange(w - size)
        else:
            top, left = rng.randrange(h - size), rng.randrange(w - size)
        return x[:, top:top + size, left:left + size], y[:, top:top + size, left:left + size]


def scene_size(d: Path) -> tuple[int, int]:
    import json
    j = json.loads((d / "scene.json").read_text())
    return int(j["width"]), int(j["height"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data/neuralshade"))
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--crop", type=int, default=256)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--widths", default="16,24,32,48,64", help="channels per level; one more level than downsamples")
    ap.add_argument("--blender", type=float, default=0.0, help="share of training scenes drawn from Blender-only targets (0 = EyeSight scenes only)")
    ap.add_argument("--init", default="", help="start from this checkpoint (fine-tuning)")
    ap.add_argument("--highlight-weight", type=float, default=6.0, help="extra loss weight on pixels brighter than their surroundings in the target")
    ap.add_argument("--detail", action="store_true", help="full-resolution specular + edge gains (needs --spec, mode mul)")
    ap.add_argument("--spec", action="store_true", help="use the view-dependent shine inputs (needs spec.bin.gz in every scene)")
    ap.add_argument("--no-vis", action="store_true", help="hide the dome-visibility input (control run)")
    ap.add_argument("--half", action="store_true", help="run the network at half resolution (about 4x faster in the browser)")
    ap.add_argument("--mode", default="residual", choices=["residual", "mul"])
    ap.add_argument("--scale-aug", type=float, default=0.5, help="random zoom range: crops are resampled by 1/(1+a)..(1+a)")
    ap.add_argument("--cache", type=int, default=8, help="scenes kept in memory")
    ap.add_argument("--holdout", type=int, default=1, help="scenes kept out for evaluation")
    ap.add_argument("--out", default=str(ROOT / "data/neuralshade/shadenet.pt"))
    a = ap.parse_args()

    root = Path(a.data)
    has_inputs = lambda d: (d / "pos.bin.gz").exists() and (d / "vis.bin.gz").exists() and (not a.spec or (d / "spec.bin.gz").exists())
    eye = sorted(d for d in root.glob("scene_*") if (d / "target.png").exists() and has_inputs(d))
    blend = sorted(d for d in root.glob("scene_*") if not (d / "target.png").exists() and (d / "target_blender.png").exists() and has_inputs(d)) if a.blender > 0 else []
    if len(eye) < 2:
        raise SystemExit(f"need at least 2 EyeSight scenes, found {len(eye)}")
    # scenes are loaded on demand and a few kept (each is ~150-250 MB as float16)
    cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    order: list[str] = []

    def scene(d: Path):
        if d.name not in cache:
            s = load_scene(d, *scene_size(d))
            cache[d.name] = (s["x"].astype(np.float16), s["y"].astype(np.float16))
            order.append(d.name)
            while len(order) > a.cache:
                cache.pop(order.pop(0), None)
        return cache[d.name]

    train_eye, test = eye[: -a.holdout], eye[-a.holdout:]  # held-out scenes are always real EyeSight renders
    train = train_eye + blend
    print(f"{len(train_eye)} EyeSight + {len(blend)} Blender training scenes, {len(test)} held out", flush=True)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    widths = tuple(int(v) for v in a.widths.split(","))
    net = ShadeNet(widths=widths, levels=len(widths) - 1, mode=a.mode, half=a.half, detail=a.detail).to(device)
    if a.init:
        state = torch.load(a.init, map_location=device)["state"]
        own = net.state_dict()
        for k, v in state.items():  # an older checkpoint may have fewer output channels: copy what overlaps, the rest starts at zero
            if k in own and own[k].shape != v.shape:
                keep = own[k].clone(); keep[: v.shape[0]] = v; state[k] = keep
        net.load_state_dict(state)
        print("initialised from", a.init, flush=True)
    print("params", sum(p.numel() for p in net.parameters()), "device", device, flush=True)
    opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.steps, pct_start=0.1)
    rng = random.Random(0)

    # train on a rotating subset that fits the cache; swap one scene for another every 50 steps
    def pick_new(exclude=()):
        pool = blend if (blend and rng.random() < a.blender) else train_eye
        pool = [d for d in pool if d not in exclude] or [d for d in train if d not in exclude]
        return rng.choice(pool) if pool else None

    active = []
    while len(active) < min(len(train), a.cache):
        d = pick_new(active)
        if d is None: break
        active.append(d)

    def rotate():
        if len(train) > len(active):
            d = pick_new(active)
            if d is not None: active[rng.randrange(len(active))] = d

    def batch(pool):
        xs, ys = [], []
        picks = [rng.choice(active) for _ in range(max(1, a.batch // 4))]  # a few scenes per batch, several crops of each
        for i in range(a.batch):
            x, y = scene(picks[i % len(picks)])
            zoom = 1.0 + rng.uniform(-a.scale_aug, a.scale_aug) if a.scale_aug > 0 else 1.0  # >1: sees a smaller area, magnified
            src = int(round(a.crop / zoom))
            src = max(64, min(src, min(x.shape[1], x.shape[2]) - 1))
            cx, cy = pick_crop(x, y, src, rng)
            if src != a.crop:
                tx = torch.nn.functional.interpolate(torch.from_numpy(cx.astype(np.float32))[None], size=(a.crop, a.crop), mode="bilinear", align_corners=False)[0].numpy()
                ty = torch.nn.functional.interpolate(torch.from_numpy(cy.astype(np.float32))[None], size=(a.crop, a.crop), mode="bilinear", align_corners=False)[0].numpy()
                cx, cy = tx, ty
            if a.no_vis:
                cx = cx.copy(); cx[12] = 1.0
            if not a.spec:
                cx = cx.copy(); cx[13:16] = 0.0
            xs.append(cx); ys.append(cy)
        return torch.from_numpy(np.stack(xs).astype(np.float32)).to(device), torch.from_numpy(np.stack(ys).astype(np.float32)).to(device)

    def evaluate():
        net.eval(); tot = base = 0.0; n = 0; hf_p = hf_t = hf_f = 0.0
        def lap(t):
            k = torch.tensor([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=torch.float32, device=t.device).view(1, 1, 3, 3).repeat(3, 1, 1, 1)
            return torch.nn.functional.conv2d(t, k, groups=3).abs().mean().item()
        with torch.no_grad():
            for d in test:
                x, y = scene(d)
                for _ in range(12):
                    cx, cy = pick_crop(x, y, a.crop * 2, rng)
                    if a.no_vis:
                        cx = cx.copy(); cx[12] = 1.0
                    if not a.spec:
                        cx = cx.copy(); cx[13:16] = 0.0
                    xt = torch.from_numpy(cx.astype(np.float32))[None].to(device)
                    yt = torch.from_numpy(cy.astype(np.float32))[None].to(device)
                    tot += (net(xt) - yt).abs().mean().item() * 255
                    base += (xt[:, :3] - yt).abs().mean().item() * 255
                    out = net(xt); hf_p += lap(out); hf_t += lap(yt); hf_f += lap(xt[:, :3])
                    n += 1
        net.train()
        evaluate.hf = (hf_p / hf_t, hf_f / hf_t)  # sharpness vs EyeSight: 1.0 matches
        return tot / n, base / n

    t0 = time.time()
    for step in range(1, a.steps + 1):
        if step % 50 == 0: rotate()
        x, y = batch(train)
        pred = net(x)
        gx = ((pred[..., 1:] - pred[..., :-1]) - (y[..., 1:] - y[..., :-1])).abs().mean()
        gy = ((pred[..., 1:, :] - pred[..., :-1, :]) - (y[..., 1:, :] - y[..., :-1, :])).abs().mean()
        # highlights are a few bright pixels: a plain L1 loss barely notices missing them. Weight each pixel by how far the
        # target stands above its 7x7 neighbourhood (glints, rim light), and match the local-contrast energy directly.
        ly = 0.2126 * y[:, 0:1] + 0.7152 * y[:, 1:2] + 0.0722 * y[:, 2:3]
        lp = 0.2126 * pred[:, 0:1] + 0.7152 * pred[:, 1:2] + 0.0722 * pred[:, 2:3]
        hy = ly - torch.nn.functional.avg_pool2d(ly, 7, 1, 3, count_include_pad=False)
        hp = lp - torch.nn.functional.avg_pool2d(lp, 7, 1, 3, count_include_pad=False)
        w = 1.0 + a.highlight_weight * (hy / 0.2).clamp(0, 1)
        weighted = (w * (pred - y).abs()).mean() / w.mean()
        energy = (hp.abs().mean() - hy.abs().mean()).abs()
        loss = weighted + 0.5 * (gx + gy) + 2.0 * energy
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step()
        if step % 100 == 0 or step == 1:
            msg = f"step {step}/{a.steps} loss {loss.item():.4f} ({time.time() - t0:.0f}s)"
            if step % 500 == 0 or step == a.steps:
                got, base = evaluate()
                msg += f"  held-out L1: net {got:.2f} vs viewport {base:.2f} (0-255); sharpness net {evaluate.hf[0]:.2f} viewport {evaluate.hf[1]:.2f} (EyeSight=1)"
            print(msg, flush=True)
    torch.save({"state": net.state_dict(), "widths": widths, "mode": a.mode, "half": a.half, "spec": a.spec, "detail": a.detail}, a.out)
    print("saved", a.out)


if __name__ == "__main__":
    main()
