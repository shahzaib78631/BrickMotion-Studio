"""CoordNet dataset / model tests (CPU, under a minute)."""
from __future__ import annotations

import json

import cv2
import numpy as np
import pytest
import torch

import coordnet.data as data_mod
from coordnet.data import PairDataset
from coordnet.model import CoordNet, build_correlation_pyramid, lookup_correlation


# ------------------------------------------------------------------ synthetic shard


def _make_picture(rng: np.random.Generator, H: int, W: int) -> np.ndarray:
    img = np.full((H, W, 3), 137.0 / 255.0, np.float32)
    for _ in range(24):
        colour = rng.uniform(0.05, 0.95, size=3).astype(np.float32)
        x0, y0 = rng.integers(0, W - 12), rng.integers(0, H - 12)
        w, h = rng.integers(6, 28), rng.integers(6, 28)
        if rng.random() < 0.5:
            img[y0:y0 + h, x0:x0 + w] = colour
        else:
            cv2.circle(img, (int(x0), int(y0)), int(min(w, h) // 2),
                       tuple(float(c) for c in colour), -1)
    img += rng.normal(0.0, 0.01, img.shape).astype(np.float32)
    return np.clip(img, 0.0, 1.0)


def make_shard(root, dx: int, dy: int, n: int = 3, H: int = 120, W: int = 160) -> None:
    root.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1234)
    for i in range(n):
        pic = _make_picture(rng, H, W)
        ren = np.roll(pic, shift=(dy, dx), axis=(0, 1))
        cv2.imwrite(str(root / f"{i:05d}.picture.png"),
                    cv2.cvtColor((pic * 255).round().astype(np.uint8), cv2.COLOR_RGB2BGR))
        cv2.imwrite(str(root / f"{i:05d}.render.png"),
                    cv2.cvtColor((ren * 255).round().astype(np.uint8), cv2.COLOR_RGB2BGR))
        flow = np.zeros((2, H, W), np.int16)
        flow[0] = dx * 8
        flow[1] = dy * 8
        np.savez_compressed(
            str(root / f"{i:05d}.flow.npz"),
            flow=flow,
            valid=np.ones((H, W), np.uint8),
            new=np.zeros((H, W), np.uint8),
            cand=np.zeros((H, W), np.uint8),
        )
        (root / f"{i:05d}.json").write_text(json.dumps({"dx": dx, "dy": dy}))


def _warp_agrees(item: dict, margin: int = 8) -> bool:
    pic = item["picture"].numpy().transpose(1, 2, 0)
    ren = item["render"].numpy().transpose(1, 2, 0)
    fx = item["flow"][0].numpy()
    fy = item["flow"][1].numpy()
    h, w = fx.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    warped = cv2.remap(ren, xx + fx, yy + fy, cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_WRAP)
    inner = np.zeros((h, w), bool)
    inner[margin:h - margin, margin:w - margin] = True
    ok = inner & (item["valid"].numpy() > 0.5)
    return float(np.abs(warped - pic)[ok].mean()) < 1e-4


def test_pair_dataset_shapes_values_and_crop(tmp_path):
    make_shard(tmp_path / "shard-001", dx=5, dy=-3)
    ds = PairDataset([tmp_path / "shard-001"], crop=(100, 132), train=False)
    assert len(ds) == 3
    item = ds[0]
    assert item["picture"].shape == (3, 100, 132)
    assert item["render"].shape == (3, 100, 132)
    assert item["flow"].shape == (2, 100, 132)
    assert item["valid"].shape == (100, 132)
    assert item["new"].shape == (100, 132)
    assert item["picture"].dtype == torch.float32
    assert float(item["picture"].min()) >= 0.0 and float(item["picture"].max()) <= 1.0
    assert torch.allclose(item["flow"][0], torch.full((100, 132), 5.0))
    assert torch.allclose(item["flow"][1], torch.full((100, 132), -3.0))
    assert torch.all(item["valid"] == 1)
    assert _warp_agrees(item)


def test_pair_dataset_pads_small_images(tmp_path):
    make_shard(tmp_path / "shard-001", dx=2, dy=1, H=80, W=100)
    ds = PairDataset([tmp_path / "shard-001"], crop=(120, 160), train=False)
    item = ds[0]
    assert item["picture"].shape == (3, 120, 160)
    assert float(item["valid"][:80, :100].min()) == 1.0
    assert float(item["valid"][:, 100:].max()) == 0.0
    assert float(item["valid"][80:, :].max()) == 0.0


def test_horizontal_flip_negates_flow_and_stays_consistent(tmp_path, monkeypatch):
    make_shard(tmp_path / "shard-001", dx=5, dy=-3)
    monkeypatch.setattr(data_mod, "augment_image", lambda img, rng: img)

    flipped = None
    straight = None
    for seed in range(60):
        ds = PairDataset([tmp_path / "shard-001"], crop=(100, 132), train=True, seed=seed)
        item = ds[0]
        sign = float(item["flow"][0].mean())
        if sign < 0 and flipped is None:
            flipped = item
        if sign > 0 and straight is None:
            straight = item
        if flipped is not None and straight is not None:
            break
    assert flipped is not None and straight is not None

    assert torch.allclose(straight["flow"][0], torch.full((100, 132), 5.0))
    assert torch.allclose(straight["flow"][1], torch.full((100, 132), -3.0))
    assert torch.allclose(flipped["flow"][0], torch.full((100, 132), -5.0))
    assert torch.allclose(flipped["flow"][1], torch.full((100, 132), -3.0))
    assert _warp_agrees(straight)
    assert _warp_agrees(flipped)


# ------------------------------------------------------------------ model


def test_forward_shapes_finite_and_parameter_budget():
    model = CoordNet()
    n_params = sum(p.numel() for p in model.parameters())
    assert n_params < 6_000_000
    x = torch.rand(2, 3, 100, 132)
    out = model(x, x, iters=2)
    assert len(out["flows"]) == 2
    for f in out["flows"]:
        assert f.shape == (2, 2, 100, 132)
        assert torch.isfinite(f).all()
    assert out["conf"].shape == (2, 1, 100, 132)
    assert out["newmask"].shape == (2, 1, 100, 132)
    assert torch.isfinite(out["conf"]).all()
    assert torch.isfinite(out["newmask"]).all()


def test_correlation_lookup_peaks_at_zero_offset():
    f = torch.randn(1, 32, 10, 14)
    pyramid = build_correlation_pyramid(f, f, levels=4)
    coords = torch.zeros(1, 2, 10, 14)
    look = lookup_correlation(pyramid, coords, radius=4)
    centre = 4 * (2 * 4 + 1) + 4
    assert (look.argmax(dim=1) == centre).float().mean() > 0.99


def test_overfits_one_constant_flow_pair():
    torch.manual_seed(0)
    model = CoordNet()
    pic = torch.rand(1, 3, 64, 96)
    ren = torch.rand(1, 3, 64, 96)
    gt = torch.tensor([5.0, -3.0]).view(1, 2, 1, 1).expand(1, 2, 64, 96).contiguous()
    valid = torch.ones(1, 64, 96)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3)

    def epe() -> float:
        with torch.no_grad():
            out = model(pic, ren, iters=2)
            return float(torch.sqrt(((out["flows"][-1] - gt) ** 2).sum(dim=1)).mean())

    initial = epe()
    for _ in range(60):
        out = model(pic, ren, iters=2)
        loss = ((out["flows"][-1] - gt).abs().sum(dim=1) * valid).sum() / valid.sum()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    final = epe()
    assert final < 0.5 * initial, (initial, final)


def test_flip_keeps_a_varying_flow_consistent(tmp_path, monkeypatch):
    """Rows shift by different amounts, so mirroring the flow along the wrong axis cannot pass."""
    root = tmp_path / "shard-001"
    root.mkdir()
    rng = np.random.default_rng(7)
    H, W = 120, 160
    pic = _make_picture(rng, H, W)
    ren = np.zeros_like(pic)
    flow = np.zeros((2, H, W), np.int16)
    for y in range(H):
        dx = y // 20 - 3                          # -3 .. 2, changing down the image
        ren[y] = np.roll(pic[y], dx, axis=0)
        flow[0, y] = dx * 8
    for name, img in (("picture", pic), ("render", ren)):
        cv2.imwrite(str(root / f"00000.{name}.png"), cv2.cvtColor((img * 255).round().astype(np.uint8), cv2.COLOR_RGB2BGR))
    np.savez_compressed(str(root / "00000.flow.npz"), flow=flow, valid=np.ones((H, W), np.uint8),
                        new=np.zeros((H, W), np.uint8), cand=np.zeros((H, W), np.uint8))
    (root / "00000.json").write_text("{}")
    monkeypatch.setattr(data_mod, "augment_image", lambda img, rng: img)
    seen = set()
    for _ in range(40):
        item = PairDataset([root], crop=(H, W), train=True)[0]
        top_dx = float(item["flow"][0, 2].mean())
        seen.add(top_dx > 0)                      # unflipped: top rows shift by -3; flipped: +3
        assert _warp_agrees(item)
    assert seen == {True, False}
