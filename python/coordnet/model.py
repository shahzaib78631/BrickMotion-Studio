"""CoordNet: RAFT-style dense correspondence between a booklet picture and an estimate render.

The feature encoder is shared by both images and runs at 1/8 resolution (128 channels).
A context encoder (picture only) produces the GRU's initial hidden state and context input.
An all-pairs correlation pyramid (4 levels, radius-4 lookup) feeds a separable ConvGRU that
iteratively refines the 1/8 flow. Convex upsampling brings the flow to full resolution.

Extra heads read the final hidden state:
  conf     [B,1,H,W] logit: predicted flow is within 1 px of the truth and visible
  newmask  [B,1,H,W] logit: picture pixel belongs to a part that is new in this step
Both are upsampled bilinearly from 1/8 to full resolution (the flow uses convex upsampling).
"""
from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


# ------------------------------------------------------------------ building blocks


def _conv(inp: int, out: int, k: int = 3, s: int = 1, p: int | None = None) -> nn.Conv2d:
    return nn.Conv2d(inp, out, k, s, k // 2 if p is None else p, bias=False)


def _norm(c: int, kind: str) -> nn.Module:
    if kind == "in":
        return nn.InstanceNorm2d(c, affine=True, track_running_stats=False)
    if kind == "bn":
        return nn.BatchNorm2d(c)
    return nn.Identity()


class ResidualBlock(nn.Module):
    def __init__(self, c: int, norm: str = "in"):
        super().__init__()
        self.conv1 = _conv(c, c)
        self.conv2 = _conv(c, c)
        self.norm1 = _norm(c, norm)
        self.norm2 = _norm(c, norm)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = F.relu(self.norm1(self.conv1(x)), inplace=True)
        y = self.norm2(self.conv2(y))
        return F.relu(x + y, inplace=True)


class Encoder(nn.Module):
    """conv7x7/2 -> residual blocks at 1/2, 1/4, 1/8; ``out_ch`` channels at 1/8."""

    def __init__(self, norm: str = "in", out_ch: int = 128):
        super().__init__()
        self.stem = nn.Sequential(_conv(3, 64, 7, 2, 3), _norm(64, norm), nn.ReLU(inplace=True))
        self.layer1 = nn.Sequential(ResidualBlock(64, norm), ResidualBlock(64, norm))
        self.layer2 = nn.Sequential(
            _conv(64, 96, 3, 2, 1), _norm(96, norm), nn.ReLU(inplace=True),
            ResidualBlock(96, norm), ResidualBlock(96, norm),
        )
        self.layer3 = nn.Sequential(
            _conv(96, out_ch, 3, 2, 1), _norm(out_ch, norm), nn.ReLU(inplace=True),
            ResidualBlock(out_ch, norm), ResidualBlock(out_ch, norm),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.layer3(self.layer2(self.layer1(self.stem(x))))


class SepConv(nn.Module):
    """1x5 followed by 5x1, as in RAFT's update block."""

    def __init__(self, inp: int, out: int):
        super().__init__()
        self.conv1 = nn.Conv2d(inp, out, (1, 5), padding=(0, 2), bias=False)
        self.conv2 = nn.Conv2d(out, out, (5, 1), padding=(2, 0), bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv2(F.relu(self.conv1(x), inplace=True))


# ------------------------------------------------------------------ correlation


def build_correlation_pyramid(f1: torch.Tensor, f2: torch.Tensor, levels: int = 4) -> list[torch.Tensor]:
    """All-pairs correlation at 1/8, then average-pooled over the render dimensions.

    Returns ``levels`` tensors of shape [B, h1, w1, h2_k, w2_k].
    """
    B, C, h, w = f1.shape
    a = f1.flatten(2).transpose(1, 2)                 # [B, h*w, C]
    b = f2.flatten(2)                                 # [B, C, h*w]
    corr = torch.bmm(a, b) / math.sqrt(C)             # [B, h1*w1, h2*w2]
    corr = corr.view(B, h, w, f2.shape[-2], f2.shape[-1])
    pyramid = [corr]
    for _ in range(levels - 1):
        b_, h1, w1, h2, w2 = corr.shape
        c = corr.reshape(b_ * h1 * w1, 1, h2, w2)
        c = F.avg_pool2d(c, 2, 2, ceil_mode=True)
        corr = c.view(b_, h1, w1, c.shape[-2], c.shape[-1])
        pyramid.append(corr)
    return pyramid


def lookup_correlation(pyramid: list[torch.Tensor], flow: torch.Tensor,
                       radius: int = 4) -> torch.Tensor:
    """Sample an (2r+1)^2 window from every pyramid level.

    ``flow`` is [B,2,h,w] in (x,y) pixels at 1/8 resolution, relative to each query
    pixel. Output is [B, levels*(2r+1)^2, h, w] (channel order: level, dy, dx).
    """
    out = []
    r = radius
    g = 2 * r + 1
    B, _, h, w = flow.shape
    ys = torch.arange(h, device=flow.device, dtype=flow.dtype)
    xs = torch.arange(w, device=flow.device, dtype=flow.dtype)
    base_y, base_x = torch.meshgrid(ys, xs, indexing="ij")
    base_x = base_x.view(1, 1, h, w)
    base_y = base_y.view(1, 1, h, w)
    for level, corr in enumerate(pyramid):
        _, h1, w1, h2, w2 = corr.shape
        c = corr.reshape(B * h1 * w1, 1, h2, w2)
        cx = (base_x + flow[:, 0:1]) / (2 ** level)
        cy = (base_y + flow[:, 1:2]) / (2 ** level)
        sx = max(w2 - 1, 1)
        sy = max(h2 - 1, 1)
        gx = (2.0 * cx / sx - 1.0).reshape(B * h1 * w1, 1, 1)
        gy = (2.0 * cy / sy - 1.0).reshape(B * h1 * w1, 1, 1)
        base = torch.stack([gx, gy], dim=-1)          # [B*h1*w1, 1, 1, 2]

        off = torch.arange(-r, r + 1, device=flow.device, dtype=flow.dtype)
        dy, dx = torch.meshgrid(off, off, indexing="ij")
        delta = torch.stack([dx * (2.0 / sx), dy * (2.0 / sy)], dim=-1)
        grid = base + delta.view(1, g, g, 2)          # [B*h1*w1, g, g, 2]

        sampled = F.grid_sample(c, grid, mode="bilinear", padding_mode="zeros",
                                align_corners=True)
        sampled = sampled.view(B, h1, w1, g * g).permute(0, 3, 1, 2)
        out.append(sampled)
    return torch.cat(out, dim=1)


# ------------------------------------------------------------------ update block


class MotionEncoder(nn.Module):
    def __init__(self, corr_ch: int, hidden: int = 64):
        super().__init__()
        self.convc = SepConv(corr_ch, hidden)
        self.convf = nn.Conv2d(2, hidden, 7, padding=3, bias=False)
        self.out = SepConv(2 * hidden, hidden)

    def forward(self, corr: torch.Tensor, flow: torch.Tensor) -> torch.Tensor:
        c = F.relu(self.convc(corr), inplace=True)
        f = F.relu(self.convf(flow), inplace=True)
        return self.out(torch.cat([c, f], dim=1))


class ConvGRU(nn.Module):
    def __init__(self, hidden: int = 64, input_dim: int = 128):
        super().__init__()
        self.convz = SepConv(hidden + input_dim, hidden)
        self.convr = SepConv(hidden + input_dim, hidden)
        self.convq = SepConv(hidden + input_dim, hidden)

    def forward(self, h: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
        hx = torch.cat([h, x], dim=1)
        z = torch.sigmoid(self.convz(hx))
        r = torch.sigmoid(self.convr(hx))
        q = torch.tanh(self.convq(torch.cat([r * h, x], dim=1)))
        return (1.0 - z) * h + z * q


def upsample_flow(flow: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """RAFT convex upsampling by 8. ``flow`` is [B,2,h,w] in original pixels / 8."""
    B, _, H, W = flow.shape
    mask = torch.softmax(mask.view(B, 9, 64, H * W), dim=1)
    up = F.unfold(8.0 * flow, [3, 3], padding=1).view(B, 2, 9, H * W)
    up = torch.einsum("bkph,bckh->bcph", mask, up)          # [B,2,64,HW]
    up = up.view(B, 2, 8, 8, H, W).permute(0, 1, 4, 2, 5, 3)
    return up.reshape(B, 2, 8 * H, 8 * W)


# ------------------------------------------------------------------ network


class CoordNet(nn.Module):
    def __init__(self, hidden: int = 64, context_dim: int = 64, radius: int = 4,
                 levels: int = 4, feature_dim: int = 128):
        super().__init__()
        self.hidden = hidden
        self.radius = radius
        self.levels = levels
        self.fnet = Encoder("in", feature_dim)
        self.cnet = Encoder("none", 2 * context_dim)
        corr_ch = levels * (2 * radius + 1) ** 2
        self.motion = MotionEncoder(corr_ch, hidden)
        self.gru = ConvGRU(hidden, hidden + context_dim)
        self.flow_head = nn.Sequential(
            nn.Conv2d(hidden, hidden, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(hidden, 2, 3, padding=1),
        )
        self.mask_head = nn.Sequential(
            nn.Conv2d(hidden, 64, 3, padding=1), nn.ReLU(inplace=True),
            nn.Conv2d(64, 9 * 8 * 8, 1),
        )
        self.conf_head = nn.Conv2d(hidden, 1, 1)
        self.new_head = nn.Conv2d(hidden, 1, 1)

    def forward(self, picture: torch.Tensor, render: torch.Tensor, iters: int = 8,
                flow_init: torch.Tensor | None = None) -> dict:
        if picture.shape != render.shape:
            raise ValueError("picture and render must have the same shape")
        B, _, H, W = picture.shape
        ph, pw = (-H) % 8, (-W) % 8
        if ph or pw:
            picture = F.pad(picture, (0, pw, 0, ph), mode="replicate")
            render = F.pad(render, (0, pw, 0, ph), mode="replicate")
        Hp, Wp = picture.shape[-2:]

        f1 = self.fnet(picture * 2.0 - 1.0)
        f2 = self.fnet(render * 2.0 - 1.0)
        ctx_all = self.cnet(picture * 2.0 - 1.0)
        hidden = torch.tanh(ctx_all[:, : self.hidden])
        ctx = F.relu(ctx_all[:, self.hidden:])

        corr = build_correlation_pyramid(f1, f2, self.levels)
        h8, w8 = f1.shape[-2:]
        if flow_init is None:
            flow = torch.zeros(B, 2, h8, w8, device=picture.device, dtype=picture.dtype)
        else:
            fi = flow_init
            sy = h8 / fi.shape[-2]
            sx = w8 / fi.shape[-1]
            fi = F.interpolate(fi, size=(h8, w8), mode="bilinear", align_corners=False)
            scale = torch.tensor([sx, sy], device=fi.device, dtype=fi.dtype).view(1, 2, 1, 1)
            flow = fi * scale

        flows = []
        for _ in range(iters):
            flow = flow.detach()                      # RAFT: each update is learned from the current estimate
            feat = lookup_correlation(corr, flow, self.radius)
            motion = self.motion(feat, flow)
            hidden = self.gru(hidden, torch.cat([ctx, motion], dim=1))
            flow = flow + self.flow_head(hidden)
            flows.append(flow)
        # intermediate estimates only feed the training loss: bilinear x8 is enough there (convex upsampling at
        # full resolution for every iteration cost 2/3 of a training step); the final one is convex-upsampled
        mask = 0.25 * self.mask_head(hidden)          # RAFT scales the mask logits to balance gradients
        flows = [8.0 * F.interpolate(f, size=(Hp, Wp), mode="bilinear", align_corners=False)[..., :H, :W]
                 for f in flows[:-1]] + [upsample_flow(flows[-1], mask)[..., :H, :W]]
        conf = F.interpolate(self.conf_head(hidden), size=(Hp, Wp), mode="bilinear",
                             align_corners=False)[..., :H, :W]
        newmask = F.interpolate(self.new_head(hidden), size=(Hp, Wp), mode="bilinear",
                                align_corners=False)[..., :H, :W]
        return {"flows": flows, "conf": conf, "newmask": newmask}
