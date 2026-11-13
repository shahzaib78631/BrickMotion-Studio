"""PlaceNet v2: new-part mask and per-pixel offset to the part's drawn centre."""
import math

import pytest
import torch

from coordnet.placenet import PlaceNet, placenet_loss


def _batch(B=1, H=64, W=80):
    torch.manual_seed(0)
    new = torch.zeros(B, H, W)
    new[:, 16:48, 20:60] = 1
    ys, xs = torch.meshgrid(torch.arange(H) + 0.5, torch.arange(W) + 0.5, indexing="ij")
    cx, cy, scale = 40.0, 32.0, 2.0
    offset = torch.stack([(cx - xs) / scale, (cy - ys) / scale])[None].repeat(B, 1, 1, 1) * new[:, None]
    pic = torch.rand(B, 3, H, W) * 0.2 + new[:, None] * 0.6
    return dict(picture=pic, base=torch.full((B, 3, H, W), 0.5), evidence=new[:, None].clone(), new=new,
                offset=offset, camera=torch.tensor([[0.8, 0.4, -0.6, 0.5, 0.7, 0.24]]).repeat(B, 1))


def test_placenet_shapes_and_budget():
    net = PlaceNet()
    out = net(torch.rand(2, 7, 128, 160), torch.rand(2, 6))
    assert out["offset"].shape == (2, 2, 64, 80)
    assert out["new"].shape == (2, 1, 64, 80) and out["conf"].shape == (2, 1, 64, 80)
    assert sum(p.numel() for p in net.parameters()) < 4_000_000


def test_loss_is_zero_for_the_answer():
    b = _batch()
    h = lambda t: t[..., ::2, ::2]
    out = dict(new=h(b["new"])[:, None] * 40 - 20, offset=h(b["offset"]),
               conf=torch.full_like(h(b["new"])[:, None], 20.0))
    loss = placenet_loss(out, b)
    assert loss["offset"].item() < 1e-6 and loss["new"].item() < 1e-6


def test_placenet_overfits_one_sample():
    torch.manual_seed(0)
    net = PlaceNet()
    b = _batch()
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3)
    first = None
    for _ in range(120):
        loss = placenet_loss(net(torch.cat([b["picture"], b["base"], b["evidence"]], 1), b["camera"]), b)
        first = first or loss["offset"].item()
        opt.zero_grad()
        loss["total"].backward()
        opt.step()
    assert math.isfinite(first) and loss["offset"].item() < 0.3 * first, (first, loss["offset"].item())


def test_placetrain_smoke(tmp_path):
    from coordnet import datagen, placedata, placetrain
    files = datagen.model_files()[:40]
    s = next(x for x in (placedata.sample(seed, files) for seed in range(30)) if x is not None)
    for shard in ("shard-000", "shard-001"):
        placedata.write(tmp_path / "data" / shard, 0, s)
    out = tmp_path / "ckpt"
    placetrain.main(["--data", str(tmp_path / "data"), "--out", str(out), "--steps", "3", "--batch", "1",
                     "--crop", "128,160", "--val-every", "3", "--device", "cpu", "--workers", "0"])
    assert (out / "best.pt").exists() and (out / "last.pt").exists()
