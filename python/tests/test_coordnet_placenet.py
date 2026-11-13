"""Placement network: shapes, parameter budget, symmetric loss, and that it can learn."""
import math

import torch

from coordnet.placenet import PlaceNet, placenet_loss


def _batch(B=1, H=64, W=80, sym=1):
    torch.manual_seed(0)
    new = torch.zeros(B, H, W)
    new[:, 16:48, 20:60] = 1
    yy, xx = torch.meshgrid(torch.linspace(-40, 40, H), torch.linspace(-60, 60, W), indexing="ij")
    local = torch.stack([xx, torch.full_like(xx, -4.0), yy])[None].repeat(B, 1, 1, 1) * new[:, None]
    size = torch.tensor([80.0, 12.0, 40.0]).view(1, 3, 1, 1).repeat(B, 1, H, W) * new[:, None]
    pic = torch.rand(B, 3, H, W) * 0.2 + new[:, None] * 0.6
    return dict(picture=pic, base=torch.full((B, 3, H, W), 0.5), evidence=new[:, None].clone(), new=new,
                local=local, size=size, sym=torch.full((B, H, W), sym, dtype=torch.long))


def _inputs(b):
    return torch.cat([b["picture"], b["base"], b["evidence"]], 1)


def test_placenet_shapes_and_budget():
    net = PlaceNet()
    out = net(torch.rand(2, 7, 128, 160))
    assert out["local"].shape == (2, 3, 64, 80) and out["size"].shape == (2, 3, 64, 80)
    assert out["new"].shape == (2, 1, 64, 80) and out["conf"].shape == (2, 1, 64, 80)
    assert sum(p.numel() for p in net.parameters()) < 4_000_000


def test_symmetric_loss_ignores_symmetric_flip():
    b = _batch(sym=2)
    half = lambda t: t[..., ::2, ::2]
    flipped = half(b["local"]) * torch.tensor([-1.0, 1.0, -1.0]).view(1, 3, 1, 1)
    out = dict(new=half(b["new"])[:, None] * 40 - 20, local=flipped, size=half(b["size"]),
               conf=torch.full_like(half(b["new"])[:, None], 20.0))
    loss = placenet_loss(out, b)
    assert loss["local"].item() < 1e-4
    b1 = _batch(sym=1)
    assert placenet_loss(out, b1)["local"].item() > 1.0          # not symmetric: the flip is wrong


def test_placenet_overfits_one_sample():
    torch.manual_seed(0)
    net = PlaceNet()
    b = _batch()
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3)
    first = None
    for _ in range(80):
        loss = placenet_loss(net(_inputs(b)), b)
        first = first or loss["local"].item()
        opt.zero_grad()
        loss["total"].backward()
        opt.step()
    assert math.isfinite(first) and loss["local"].item() < 0.5 * first, (first, loss["local"].item())


def test_placetrain_smoke(tmp_path):
    from coordnet import datagen, placedata, placetrain
    files = datagen.model_files()[:40]
    s = next(x for x in (placedata.sample(seed, files) for seed in range(30)) if x is not None)
    for shard in ("shard-000", "shard-001"):
        placedata.write(tmp_path / "data" / shard, 0, s)
    out = tmp_path / "ckpt"
    placetrain.main(["--data", str(tmp_path / "data"), "--out", str(out), "--steps", "3", "--batch", "1",
                     "--crop", "128,160", "--val-every", "3", "--device", "cpu"])
    assert (out / "best.pt").exists() and (out / "last.pt").exists()
