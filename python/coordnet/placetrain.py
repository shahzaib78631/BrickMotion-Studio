"""Train the placement network on synthetic shards plus real booklet train-set pages.

    python -m coordnet.placetrain --steps 30000

Data: `<data>/shard-000` is validation (synthetic), other `shard-*` are training, `real-*` (booklet_mpd train sets,
from `coordnet.realdata`) are training too, drawn with total probability `--real-weight`. Validation reports the
new-pixel IoU and the share of new pixels whose part-local coordinate is within 4 LDU (mean per axis), and
`best.pt` keeps the best of the latter.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, WeightedRandomSampler

from .placedata import OUT, PlaceDataset
from .placenet import PlaceNet, local_error, placenet_loss

ROOT = Path(__file__).resolve().parents[2]


def _inputs(b: dict, dev) -> torch.Tensor:
    return torch.cat([b["picture"], b["base"], b["evidence"]], 1).to(dev)


@torch.no_grad()
def validate(model, ds, dev, limit: int = 300) -> dict:
    model.eval()
    inter = union = good = total = 0.0
    for i in range(min(len(ds), limit)):
        b = {k: v[None] for k, v in ds[i].items()}
        out = model(_inputs(b, dev))
        h = lambda t: t[..., ::2, ::2].to(dev)
        new = h(b["new"]) > 0.5
        pred = out["new"][:, 0] > 0
        inter += float((pred & new).sum())
        union += float((pred | new).sum())
        err = local_error(out["local"], h(b["local"]), h(b["sym"]))
        good += float(((err / 3.0 < 4.0) & new).sum())
        total += float(new.sum())
    model.train()
    return dict(new_iou=inter / max(union, 1), local_acc4=good / max(total, 1))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=OUT)
    ap.add_argument("--out", type=Path, default=ROOT / ".cache/coordnet/placenet")
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=6)
    ap.add_argument("--crop", default="384,512")
    ap.add_argument("--lr", type=float, default=6e-4)
    ap.add_argument("--real-weight", type=float, default=0.3)
    ap.add_argument("--val-every", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    a = ap.parse_args(argv)
    crop = tuple(int(x) for x in a.crop.split(","))
    dev = torch.device(a.device)
    syn = sorted(p for p in a.data.glob("shard-*") if p.is_dir() and p.name != "shard-000")
    real = sorted(p for p in a.data.glob("real-*") if p.is_dir())
    val_dirs = [a.data / "shard-000"]
    train_ds = PlaceDataset(syn + real, crop=crop, train=True)
    val_ds = PlaceDataset(val_dirs, crop=crop, train=False)
    is_real = np.array(["/real-" in s for s in train_ds.items])
    w = np.ones(len(train_ds))
    if is_real.any() and (~is_real).any():
        w[is_real] = a.real_weight / is_real.sum()
        w[~is_real] = (1 - a.real_weight) / (~is_real).sum()
    sampler = WeightedRandomSampler(torch.as_tensor(w, dtype=torch.double), num_samples=10 ** 7, replacement=True)
    loader = DataLoader(train_ds, batch_size=a.batch, sampler=sampler, num_workers=a.workers,
                        persistent_workers=a.workers > 0, drop_last=False)
    model = PlaceNet().to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.steps + 1, pct_start=0.05)
    a.out.mkdir(parents=True, exist_ok=True)
    step, best = 0, -1.0
    if a.resume and (a.out / "last.pt").exists():
        ck = torch.load(a.out / "last.pt", map_location="cpu", weights_only=False)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["optimizer"])
        sched.load_state_dict(ck["scheduler"])
        step, best = ck["step"], ck["best"]
    save = lambda path: torch.save(dict(model=model.state_dict(), optimizer=opt.state_dict(),
                                        scheduler=sched.state_dict(), step=step, best=best), path)
    print(json.dumps(dict(train=len(train_ds), real=int(is_real.sum()), val=len(val_ds))), flush=True)
    t0 = time.time()
    it = iter(loader)
    while step < a.steps:
        b = next(it)
        loss = placenet_loss(model(_inputs(b, dev)), {k: v.to(dev) for k, v in b.items()})
        opt.zero_grad(set_to_none=True)
        loss["total"].backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        step += 1
        if step % 50 == 0 or step == a.steps:
            print(f"::progress {step}/{a.steps} " + " ".join(f"{k}={v.item():.3f}" for k, v in loss.items())
                  + f" {time.time() - t0:.0f}s", flush=True)
        if step % a.val_every == 0 or step == a.steps:
            v = validate(model, val_ds, dev)
            row = dict(step=step, **v, **{k: float(x.item()) for k, x in loss.items()})
            with (a.out / "log.jsonl").open("a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(json.dumps(row), flush=True)
            if v["local_acc4"] > best:
                best = v["local_acc4"]
                save(a.out / "best.pt")
            save(a.out / "last.pt")


if __name__ == "__main__":
    main()
