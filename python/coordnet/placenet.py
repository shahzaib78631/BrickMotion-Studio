"""Placement network v2: per-pixel new-part mask and the offset to where the pixel's part centre is drawn.

Input: picture, CoordNet-aligned render of the model so far, change evidence (7 channels, full resolution), and
the camera (`labels.camera_channels`, 6 values broadcast as constant planes). Output at half resolution (labels are
sampled at full-res pixel 2x, centre 2x + 0.5): new [B,1] logit, offset [B,2] in px / cam.scale (see
`labels.centre_targets`), conf [B,1] logit (offset error under 2 px / scale). The offset is instance grouping, not
part recognition: v1 asked for part-local catalogue coordinates, which the picture does not show (it collapsed).
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

OFFSET = 64.0        # network units: offsets are predicted / 64
CAMERA = 6
CONF_PX = 2.0        # conf target: predicted centre within this many px / scale


def _block(cin: int, cout: int, stride: int = 1) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, stride, 1, bias=False), nn.GroupNorm(8, cout), nn.ReLU(inplace=True),
                         nn.Conv2d(cout, cout, 3, 1, 1, bias=False), nn.GroupNorm(8, cout), nn.ReLU(inplace=True))


class PlaceNet(nn.Module):
    def __init__(self, width: int = 32):
        super().__init__()
        c = [width, width * 2, width * 4, width * 6, width * 8]
        self.e1 = _block(7 + CAMERA, c[0], 2)    # 1/2
        self.e2 = _block(c[0], c[1], 2)          # 1/4
        self.e3 = _block(c[1], c[2], 2)          # 1/8
        self.e4 = _block(c[2], c[3], 2)          # 1/16
        self.e5 = _block(c[3], c[4], 2)          # 1/32
        self.d4 = _block(c[4] + c[3], c[3])
        self.d3 = _block(c[3] + c[2], c[2])
        self.d2 = _block(c[2] + c[1], c[1])
        self.d1 = _block(c[1] + c[0], c[0])
        self.head = nn.Conv2d(c[0], 1 + 2 + 1, 1)

    @staticmethod
    def _up(x: torch.Tensor, ref: torch.Tensor) -> torch.Tensor:
        return F.interpolate(x, size=ref.shape[-2:], mode="bilinear", align_corners=False)

    def forward(self, x: torch.Tensor, camera: torch.Tensor) -> dict:
        B, _C, H, W = x.shape
        x = torch.cat([x, camera.view(B, CAMERA, 1, 1).expand(B, CAMERA, H, W).to(x)], 1)
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
        return dict(new=h[:, :1], offset=h[:, 1:3] * OFFSET, conf=h[:, 3:4])


def offset_error(pred: torch.Tensor, offset: torch.Tensor) -> torch.Tensor:
    """Per-pixel Euclidean error of the offset (px / scale), [B,H,W]."""
    return (pred - offset).norm(dim=1)


def placenet_loss(out: dict, batch: dict) -> dict:
    """Labels are full resolution; outputs half. Labels are sampled at the half-res grid (full-res pixel 2x)."""
    h = lambda t: t[..., ::2, ::2]
    new = h(batch["new"]).float()
    offset = h(batch["offset"])
    l_new = F.binary_cross_entropy_with_logits(out["new"][:, 0], new)
    m = new > 0.5
    n = m.sum().clamp(min=1)
    err = offset_error(out["offset"], offset)
    l_off = (F.smooth_l1_loss(out["offset"], offset, reduction="none").sum(1) * m).sum() / n
    target = (err.detach() < CONF_PX).float()
    l_conf = (F.binary_cross_entropy_with_logits(out["conf"][:, 0], target, reduction="none") * m).sum() / n
    total = l_new + l_off / 10.0 + l_conf
    return dict(total=total, new=l_new, offset=l_off, conf=l_conf)
