"""Train CoordNet on the synthetic booklet picture/render pairs.

    cd python && .venv/bin/python -m coordnet.train --steps 60000 --batch 6

Checkpoints and logs live in ``.cache/coordnet/ckpt``. Validation runs every 1000 steps
and prints one JSON line; ``::progress`` lines are emitted every 50 steps for jobwatch.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Subset

from .data import PairDataset, default_roots
from .model import CoordNet


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def resolve_cache(cache: str) -> Path:
    root = Path(__file__).resolve().parents[2]
    p = Path(cache)
    return p if p.is_absolute() else root / p


def count_samples(dirs: list[Path]) -> int:
    return sum(len(list(d.glob("*.json"))) for d in dirs if d.is_dir())


def sequence_loss(flows, gt, valid, new, conf, newmask):
    n = len(flows)
    gt_mag = torch.sqrt((gt * gt).sum(dim=1))
    mask = valid * (gt_mag <= 400.0)
    denom = mask.sum().clamp(min=1.0)
    total = 0.0
    for i, f in enumerate(flows):
        w = 0.8 ** (n - 1 - i)
        err = (f - gt).abs().sum(dim=1)
        total = total + w * (err * mask).sum() / denom

    final = flows[-1].detach()
    epe = torch.sqrt(((final - gt) ** 2).sum(dim=1))
    target = ((valid > 0.5) & (epe < 1.0)).float()
    # every pixel: the solver needs conf to say "no usable match" where the render has no counterpart
    # (new parts, occlusion, background), not only to rank the valid pixels
    conf_loss = F.binary_cross_entropy_with_logits(conf[:, 0], target)

    new_loss = F.binary_cross_entropy_with_logits(newmask[:, 0], (new > 0.5).float())
    total = total + 0.5 * conf_loss + 0.3 * new_loss

    with torch.no_grad():
        train_epe = ((epe * valid).sum() / valid.sum().clamp(min=1.0)).item()
    return total, train_epe


@torch.no_grad()
def validate(model: CoordNet, ds: PairDataset, device: torch.device, iters: int,
             step: int, max_samples: int = 300, batch_size: int = 4) -> dict:
    model.eval()
    n = min(len(ds), max_samples)
    loader = DataLoader(Subset(ds, list(range(n))), batch_size=batch_size, shuffle=False,
                        num_workers=0, pin_memory=False)
    epe_sum = 0.0
    valid_count = 0.0
    acc1 = 0.0
    acc3 = 0.0
    conf_tp = 0.0
    conf_pred = 0.0
    inter = 0.0
    union = 0.0
    for batch in loader:
        pic = batch["picture"].to(device)
        ren = batch["render"].to(device)
        gt = batch["flow"].to(device)
        valid = batch["valid"].to(device)
        new = batch["new"].to(device)
        out = model(pic, ren, iters=iters)
        final = out["flows"][-1]
        err = torch.sqrt(((final - gt) ** 2).sum(dim=1))
        v = valid > 0.5
        epe_sum += (err * valid).sum().item()
        valid_count += valid.sum().item()
        acc1 += ((err < 1.0) & v).sum().item()
        acc3 += ((err < 3.0) & v).sum().item()
        pred = (out["conf"][:, 0] > 0.0) & v
        truth = (err < 1.0) & v
        conf_tp += (pred & truth).sum().item()
        conf_pred += pred.sum().item()
        pn = out["newmask"][:, 0] > 0.0
        tn = new > 0.5
        inter += (pn & tn).sum().item()
        union += (pn | tn).sum().item()
    model.train()
    vc = max(valid_count, 1.0)
    return {
        "step": step,
        "n": n,
        "epe": epe_sum / vc,
        "acc1": 100.0 * acc1 / vc,
        "acc3": 100.0 * acc3 / vc,
        "conf_precision": conf_tp / max(conf_pred, 1.0),
        "new_iou": inter / max(union, 1.0),
    }


def save_checkpoint(path: Path, model, opt, sched, step: int, best_epe: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    torch.save({
        "model": model.state_dict(),
        "optimizer": opt.state_dict(),
        "scheduler": sched.state_dict(),
        "step": step,
        "best_epe": best_epe,
    }, tmp)
    tmp.replace(path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Train CoordNet")
    ap.add_argument("--steps", type=int, default=60000)
    ap.add_argument("--batch", type=int, default=6)
    ap.add_argument("--lr", type=float, default=4e-4)
    ap.add_argument("--iters", type=int, default=8)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--device", type=str, default="mps")
    ap.add_argument("--cache", type=str, default=".cache/coordnet")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--min-samples", type=int, default=200)
    ap.add_argument("--val-every", type=int, default=1000)
    ap.add_argument("--crop", type=int, nargs=2, default=[288, 384], metavar=("H", "W"))
    args = ap.parse_args()

    set_seed(args.seed)
    cache = resolve_cache(args.cache)
    ckpt_dir = cache / "ckpt"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    log_path = ckpt_dir / "log.jsonl"

    if args.device == "mps" and not torch.backends.mps.is_available():
        print("MPS not available, using CPU", flush=True)
        args.device = "cpu"
    device = torch.device(args.device)

    while True:
        train_dirs, val_dirs = default_roots(args.cache)
        train_ds = PairDataset(train_dirs, crop=tuple(args.crop), train=True, seed=args.seed)
        if len(train_ds) >= args.min_samples:
            break
        print(f"waiting for training samples: {len(train_ds)}/{args.min_samples}", flush=True)
        time.sleep(60)
    val_ds = PairDataset(val_dirs, crop=tuple(args.crop), train=False, seed=args.seed)
    print(f"train={len(train_ds)} val={len(val_ds)} device={device}", flush=True)

    model = CoordNet().to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"parameters={n_params}", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=args.steps, pct_start=0.05)
    start_step = 0
    best_epe = math.inf
    last_path = ckpt_dir / "last.pt"
    best_path = ckpt_dir / "best.pt"
    if args.resume and last_path.exists():
        ck = torch.load(last_path, map_location=device, weights_only=False)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["optimizer"])
        sched.load_state_dict(ck["scheduler"])
        start_step = int(ck.get("step", 0))
        best_epe = float(ck.get("best_epe", math.inf))
        print(f"resumed at step {start_step}", flush=True)

    bs = min(args.batch, len(train_ds))
    loader = DataLoader(
        train_ds, batch_size=bs, shuffle=True, num_workers=args.workers,
        persistent_workers=args.workers > 0, pin_memory=False,
        drop_last=len(train_ds) >= bs,
    )
    it = iter(loader)
    model.train()
    step = start_step
    run_loss = 0.0
    run_epe = 0.0
    run_n = 0
    while step < args.steps:
        try:
            batch = next(it)
        except StopIteration:
            # pick up shards written since the last pass (datagen may still be running)
            train_dirs, _ = default_roots(args.cache)
            fresh = PairDataset(train_dirs, crop=tuple(args.crop), train=True, seed=args.seed)
            if len(fresh) > len(train_ds):
                train_ds = fresh
                loader = DataLoader(train_ds, batch_size=bs, shuffle=True, num_workers=args.workers,
                                    persistent_workers=args.workers > 0, pin_memory=False, drop_last=True)
                print(f"re-indexed: train={len(train_ds)}", flush=True)
            it = iter(loader)
            batch = next(it)
        pic = batch["picture"].to(device)
        ren = batch["render"].to(device)
        gt = batch["flow"].to(device)
        valid = batch["valid"].to(device)
        new = batch["new"].to(device)

        out = model(pic, ren, iters=args.iters)
        loss, epe = sequence_loss(out["flows"], gt, valid, new, out["conf"], out["newmask"])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()

        step += 1
        run_loss += float(loss.detach())
        run_epe += epe
        run_n += 1
        if step % 50 == 0 or step == args.steps:
            print(f"::progress {step}/{args.steps} loss={run_loss / run_n:.4f} "
                  f"epe={run_epe / run_n:.3f}", flush=True)
            run_loss = run_epe = 0.0
            run_n = 0

        if step % args.val_every == 0:
            if len(val_ds):
                metrics = validate(model, val_ds, device, args.iters, step)
                print(json.dumps(metrics), flush=True)
                with log_path.open("a") as fh:
                    fh.write(json.dumps(metrics) + "\n")
                if metrics["epe"] < best_epe:
                    best_epe = metrics["epe"]
                    save_checkpoint(best_path, model, opt, sched, step, best_epe)
            save_checkpoint(last_path, model, opt, sched, step, best_epe)

    if step % args.val_every != 0:
        save_checkpoint(last_path, model, opt, sched, step, best_epe)


if __name__ == "__main__":
    main()
