"""A small U-Net that turns the viewport's G-buffers into EyeSight-looking pixels."""
from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F

IN_CHANNELS = 16  # frame(3) albedo(3) normal(3) mask(1) depth(1) height(1) dome visibility(1) shine(3)


def srgb_to_linear(x: torch.Tensor) -> torch.Tensor:
    return torch.where(x <= 0.04045, x / 12.92, ((x.clamp_min(1e-6) + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: torch.Tensor) -> torch.Tensor:
    return torch.where(x <= 0.0031308, x * 12.92, 1.055 * x.clamp_min(1e-6) ** (1 / 2.4) - 0.055)


EDGE_DEPTH_TOL = 0.0002  # depth is distance/2000: 0.4 studs. Neighbours further apart than this are separate surfaces (silhouettes), not a shared edge.


def edge_map(x: torch.Tensor) -> torch.Tensor:
    """Where two faces of the same part meet at an angle, from the full-resolution normal/coverage/depth inputs: 0 on flat
    faces and silhouettes, up to 1 at a right-angle corner. Rounded edges catch a thin highlight there (EyeSight bevels every edge).
    The same formula runs in the WebGL final pass (neuralShade.ts); keep them identical."""
    n, cov, d = x[:, 6:9], x[:, 9:10], x[:, 10:11]
    pad = lambda t: F.pad(t, (1, 1, 1, 1), mode="replicate")
    pn, pc, pd = pad(n), pad(cov), pad(d)
    h, w = n.shape[-2:]
    best = torch.zeros_like(cov)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        sl = (slice(None), slice(None), slice(1 + dy, 1 + dy + h), slice(1 + dx, 1 + dx + w))
        nq, cq, dq = pn[sl], pc[sl], pd[sl]
        bend = (1.0 - (n * nq).sum(1, keepdim=True)).clamp(0, 1)
        near = ((d - dq).abs() < EDGE_DEPTH_TOL).float()
        best = torch.maximum(best, bend * cov * cq * near)
    return best


JBU_DEPTH_SIGMA = 0.0006


def jbu_upsample(o: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
    """Edge-aware (joint bilateral) 2x upsample of the half-resolution outputs `o`, guided by the full-resolution input `x`.
    Plain bilinear smears a correction across brick edges (halos, wavy outlines); here a full-resolution pixel only takes
    values from half-resolution texels that look like it: same coverage, same facing, same depth.
    The same formula runs in the WebGL final pass (neuralShade.ts, FINAL_DETAIL): keep them identical."""
    H, W = x.shape[-2:]
    h, w = o.shape[-2:]
    if H != 2 * h or W != 2 * w:  # odd sizes: fall back to bilinear
        return F.interpolate(o, size=(H, W), mode="bilinear", align_corners=False)
    xh = F.avg_pool2d(x, 2)  # the guide at half resolution = what the network saw
    n, cov, d = x[:, 6:9], x[:, 9:10], x[:, 10:11]
    pad = lambda t: F.pad(t, (1, 1, 1, 1), mode="replicate")
    po, pn, pc, pd = pad(o), pad(xh[:, 6:9]), pad(xh[:, 9:10]), pad(xh[:, 10:11])
    up = lambda t: t.repeat_interleave(2, dim=-2).repeat_interleave(2, dim=-1)
    yy = torch.arange(H, device=x.device).view(1, 1, H, 1) % 2
    xx = torch.arange(W, device=x.device).view(1, 1, 1, W) % 2
    wy = {-1: 0.25 * (yy == 0).float(), 0: torch.full_like(yy, 0.75, dtype=torch.float32), 1: 0.25 * (yy == 1).float()}
    wx = {-1: 0.25 * (xx == 0).float(), 0: torch.full_like(xx, 0.75, dtype=torch.float32), 1: 0.25 * (xx == 1).float()}
    num, den = 0.0, 0.0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            sl = (slice(None), slice(None), slice(1 + dy, 1 + dy + h), slice(1 + dx, 1 + dx + w))
            ov, nv, cv, dv = up(po[sl]), up(pn[sl]), up(pc[sl]), up(pd[sl])
            sc = 1.0 - (cov - cv).abs()
            nd = torch.where(cov > 0.5, ((n * nv).sum(1, keepdim=True) / cv.clamp_min(1e-3)).clamp(0, 1), torch.ones_like(cov))
            dd = torch.where((cov > 0.5) & (cv > 0.99), torch.exp(-(d - dv).abs() / JBU_DEPTH_SIGMA), torch.ones_like(cov))
            wgt = wy[dy] * wx[dx] * (0.01 + sc * sc * nd * dd)
            num = num + wgt * ov
            den = den + wgt
    return num / den


def block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1), nn.ReLU(inplace=True), nn.Conv2d(cout, cout, 3, padding=1), nn.ReLU(inplace=True))


class ShadeNet(nn.Module):
    """Encoder/decoder with `levels` 2x downsamples: the deepest layer sees the whole neighbourhood
    of a model, which is what dome-light occlusion and bounce light need."""

    def __init__(self, widths=(16, 24, 32, 48, 64), levels: int = 4, mode: str = "residual", half: bool = False, detail: bool = False):
        super().__init__()
        self.detail = detail  # full-resolution shine: gains predicted by the net times exact specular and edge maps
        self.mode = mode
        self.half = half  # run the network at half resolution, upsample its output onto the full-resolution frame
        assert len(widths) == levels + 1
        self.enc = nn.ModuleList()
        c = IN_CHANNELS
        for w in widths:
            self.enc.append(block(c, w))
            c = w
        self.dec = nn.ModuleList()
        for i in range(levels - 1, -1, -1):
            self.dec.append(block(widths[i + 1] + widths[i], widths[i]))
        self.out = nn.Conv2d(widths[0], (12 if detail else 6) if mode == "mul" else 3, 1)
        if mode == "mul":  # start as the identity: scale 1, nothing added
            nn.init.zeros_(self.out.weight); nn.init.zeros_(self.out.bias)
        self.levels = levels

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        frame = x[:, :3]
        skips = []
        h = F.avg_pool2d(x, 2) if self.half else x
        for i, enc in enumerate(self.enc):
            h = enc(h)
            if i < self.levels:
                skips.append(h)
                h = F.avg_pool2d(h, 2)
        for dec, skip in zip(self.dec, reversed(skips)):
            h = F.interpolate(h, size=skip.shape[-2:], mode="bilinear", align_corners=False)
            h = dec(torch.cat([h, skip], dim=1))
        o = self.out(h)
        if self.half:
            o = jbu_upsample(o, x) if self.detail else F.interpolate(o, size=frame.shape[-2:], mode="bilinear", align_corners=False)
        if self.mode == "mul":
            # in linear light: the viewport's lighting scaled and topped up. A smooth scale cannot erase the
            # frame's brick detail, which an additive correction learned under L1 tends to do.
            scale = F.softplus(o[:, :3] + 0.5413)  # softplus(0.5413) = 1
            lin = srgb_to_linear(frame) * scale + 0.1 * o[:, 3:6]
            if self.detail:
                # sharp pixels come from full-resolution geometry, brightness from the (smooth) prediction
                lin = lin + o[:, 6:9] * x[:, 14:15] + o[:, 9:12] * edge_map(x)
            return linear_to_srgb(lin.clamp(0, 1))
        return (frame + o).clamp(0, 1)  # a correction on top of the viewport's own frame
