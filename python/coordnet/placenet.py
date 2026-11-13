"""Placement network: per-pixel new-part mask, part-local coordinates, part box size and confidence.

Input: picture, CoordNet-aligned render of the model so far, change evidence (7 channels, full resolution).
Output at half resolution (a stud is ~34 px at book-1 scale; 1/8 would be too coarse):
  new [B,1] logit, local [B,3] LDU (part frame), size [B,3] LDU, conf [B,1] logit (local error < 4 LDU).
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

LDU = 100.0          # network units: local and size are predicted / 100


def _block(cin: int, cout: int, stride: int = 1) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, stride, 1, bias=False), nn.GroupNorm(8, cout), nn.ReLU(inplace=True),
                         nn.Conv2d(cout, cout, 3, 1, 1, bias=False), nn.GroupNorm(8, cout), nn.ReLU(inplace=True))


class PlaceNet(nn.Module):
    def __init__(self, width: int = 32):
        super().__init__()
        c = [width, width * 2, width * 4, width * 6, width * 8]
        self.e1 = _block(7, c[0], 2)        # 1/2
        self.e2 = _block(c[0], c[1], 2)     # 1/4
        self.e3 = _block(c[1], c[2], 2)     # 1/8
        self.e4 = _block(c[2], c[3], 2)     # 1/16
        self.e5 = _block(c[3], c[4], 2)     # 1/32
        self.d4 = _block(c[4] + c[3], c[3])
        self.d3 = _block(c[3] + c[2], c[2])
        self.d2 = _block(c[2] + c[1], c[1])
        self.d1 = _block(c[1] + c[0], c[0])
        self.head = nn.Conv2d(c[0], 1 + 3 + 3 + 1, 1)

    @staticmethod
    def _up(x: torch.Tensor, ref: torch.Tensor) -> torch.Tensor:
        return F.interpolate(x, size=ref.shape[-2:], mode="bilinear", align_corners=False)

    def forward(self, x: torch.Tensor) -> dict:
        e1 = self.e1(x)
        e2 = self.e2(e1)
        e3 = self.e3(e2)
        e4 = self.e4(e3)
        e5 = self.e5(e4)
        d = self.d4(torch.cat([self._up(e5, e4), e4], 1))
        d = self.d3(torch.cat([self._up(d, e3), e3], 1))
        d = self.d2(torch.cat([self._up(d, e2), e2], 1))
        d = self.d1(torch.cat([self._up(d, e1), e1], 1))
        h = self.head(d)
        return dict(new=h[:, :1], local=h[:, 1:4] * LDU, size=F.softplus(h[:, 4:7]) * LDU, conf=h[:, 7:8])


def _turns(device) -> torch.Tensor:
    """Rotations about local Y by 0, 90, 180, 270 degrees: [4,3,3] (same sense as labels._yaw)."""
    out = []
    for k in range(4):
        a = torch.tensor(k * torch.pi / 2)
        c, s = torch.cos(a).item(), torch.sin(a).item()
        out.append(torch.tensor([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]))
    return torch.stack(out).to(device)


def local_error(pred: torch.Tensor, local: torch.Tensor, sym: torch.Tensor) -> torch.Tensor:
    """Per-pixel L1 (LDU) between prediction and the closest symmetry-equivalent label. [B,H,W]."""
    R = _turns(pred.device)
    lab = torch.einsum("kij,bjhw->kbihw", R, local)                     # label turned k * 90
    err = (pred[None] - lab).abs().sum(2)                               # [4,B,H,W]
    allowed = torch.stack([(k * sym) % 4 == 0 for k in range(4)])      # turn k*90 is a symmetry iff k*sym % 4 == 0
    err = torch.where(allowed, err, torch.full_like(err, float("inf")))
    return err.min(0).values


def placenet_loss(out: dict, batch: dict) -> dict:
    """Labels are full resolution; the outputs half. Labels are sampled at the half-res pixel grid."""
    h = lambda t: t[..., ::2, ::2]
    new = h(batch["new"]).float()
    local, size, sym = h(batch["local"]), h(batch["size"]), h(batch["sym"])
    l_new = F.binary_cross_entropy_with_logits(out["new"][:, 0], new)
    m = new > 0.5
    n = m.sum().clamp(min=1)
    err = local_error(out["local"], local, sym)
    l_local = (err * m).sum() / n / 3.0
    l_size = ((out["size"] - size).abs().sum(1) * m).sum() / n / 3.0
    target = (err < 4.0 * 3).float()                                    # mean axis error under 4 LDU
    l_conf = (F.binary_cross_entropy_with_logits(out["conf"][:, 0], target, reduction="none") * m).sum() / n
    total = l_new + l_local / 10.0 + l_size / 10.0 + l_conf
    return dict(total=total, new=l_new, local=l_local, size=l_size, conf=l_conf)
