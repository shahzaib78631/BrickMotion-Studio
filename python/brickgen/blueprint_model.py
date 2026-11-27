"""Stage-1 3D Blueprint Generator: Patchified 3D Diffusion Transformer (3D DiT) with Rectified Flow.

Generates a globally coherent, bilaterally symmetric 16x16x16x5 colored LEGO 3D silhouette
`[occ, R, G, B, trans]` + global physical proportions `(span_x, span_y, span_z, est_parts)`
directly from a text prompt (77-token CLIP cross-attention + pooled CLIP + source/scale).

Key design choices:
  1. Pure Matrix-Multiply + SDPA 3D DiT (zero `nn.Conv3d` -> blazing fast on BOTH Mac MPS
     and NVIDIA Colab A100 bf16 TensorCores!).
  2. Patch size 2x2x2 over 16x16x16 -> 8x8x8 = 512 spatial tokens + 1 global physical scale token.
  3. Rectified Flow (Optimal Transport Flow Matching) with logit-normal timestep weighting
     and 2nd-order Heun ODE sampling (~0.2s per 3D blueprint on M1 Pro MPS!).
  4. Native bilateral X-symmetry velocity averaging during sampling: guarantees razor-sharp,
     proportionally symmetric cars, starfighters, castles, houses, and BrickHeadz.
  5. Supports mixed color-labeled (BrickNet/OMR/MOC/BrickHeadz) and geometry-only
     (StableText2Brick 47k shapes) training via per-sample `has_color` loss masking!
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .blueprint import BP_CH, BP_G, decode_scale_token, keep_largest_component_3d
from .model import NUM_SCALES, NUM_SOURCES, CrossAttn, RMSNorm, SwiGLU

BP_PATCH = 2
BP_LAT = BP_G // BP_PATCH  # 8
BP_N_PATCHES = BP_LAT ** 3  # 512
BP_PATCH_DIM = BP_CH * (BP_PATCH ** 3)  # 40
BP_SCALE_DIM = 4


@dataclass
class BlueprintFlowConfig:
    width: int = 384
    layers: int = 10
    heads: int = 6
    clip_dim: int = 512
    dropout: float = 0.10
    grid_size: int = BP_G
    patch_size: int = BP_PATCH
    channels: int = BP_CH
    # Unbiased Rectified Flow loss weights (1.0 = exact unbiased velocity field, zero prior tilt!)
    occ_weight: float = 1.0
    col_pos_weight: float = 1.0
    col_neg_weight: float = 1.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "BlueprintFlowConfig":
        valid = {f.name for f in cls.__dataclass_fields__.values()}
        kw = {k: v for k, v in d.items() if k in valid}
        # Legacy v3.0 checkpoints omitted loss weights and were trained with (3.5, 3.0, 0.20)
        if "occ_weight" not in d:
            kw["occ_weight"] = 3.5
            kw["col_pos_weight"] = 3.0
            kw["col_neg_weight"] = 0.20
        return cls(**kw)


BP_PRESETS = {
    "small": dict(width=256, layers=6, heads=4, dropout=0.10),
    "base": dict(width=384, layers=10, heads=6, dropout=0.10),
    "large": dict(width=512, layers=12, heads=8, dropout=0.12),
}


def patchify_3d(grid: torch.Tensor, p: int = BP_PATCH) -> torch.Tensor:
    """`(B, C, G, G, G)` -> `(B, (G/p)^3, C * p^3)`."""
    b, c, gx, gy, gz = grid.shape
    lx, ly, lz = gx // p, gy // p, gz // p
    x = grid.view(b, c, lx, p, ly, p, lz, p)
    x = x.permute(0, 2, 4, 6, 1, 3, 5, 7).contiguous()
    return x.view(b, lx * ly * lz, c * p * p * p)


def unpatchify_3d(tokens: torch.Tensor, g: int = BP_G, p: int = BP_PATCH, c: int = BP_CH) -> torch.Tensor:
    """`(B, (G/p)^3, C * p^3)` -> `(B, C, G, G, G)`."""
    b = tokens.shape[0]
    l = g // p
    x = tokens.view(b, l, l, l, c, p, p, p)
    x = x.permute(0, 4, 1, 5, 2, 6, 3, 7).contiguous()
    return x.view(b, c, g, g, g)


def _sincos_3d_pos(lat: int, dim: int) -> torch.Tensor:
    """Deterministic 3D sinusoidal positional embedding `(lat^3, dim)`."""
    d_axis = dim // 3
    rem = dim - 3 * d_axis
    coords = torch.arange(lat, dtype=torch.float32)

    def _1d(d: int) -> torch.Tensor:
        half = d // 2
        omega = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32) / max(half, 1))
        ang = coords[:, None] * omega[None, :]
        emb = torch.cat([torch.sin(ang), torch.cos(ang)], dim=-1)
        if emb.shape[-1] < d:
            emb = F.pad(emb, (0, d - emb.shape[-1]))
        return emb  # (lat, d)

    ex = _1d(d_axis)[:, None, None, :].expand(lat, lat, lat, -1)
    ey = _1d(d_axis)[None, :, None, :].expand(lat, lat, lat, -1)
    ez = _1d(d_axis + rem)[None, None, :, :].expand(lat, lat, lat, -1)
    return torch.cat([ex, ey, ez], dim=-1).reshape(lat ** 3, dim)


class TimestepEmbedder(nn.Module):
    def __init__(self, dim: int, freq_dim: int = 128):
        super().__init__()
        self.freq_dim = freq_dim
        self.mlp = nn.Sequential(
            nn.Linear(freq_dim, dim),
            nn.SiLU(),
            nn.Linear(dim, dim),
        )

    def forward(self, t: torch.Tensor) -> torch.Tensor:
        # t in [0, 1], shape (B,)
        half = self.freq_dim // 2
        freqs = torch.exp(-math.log(10000.0) * torch.arange(half, device=t.device, dtype=torch.float32) / max(half, 1))
        args = (t.float() * 1000.0)[:, None] * freqs[None, :]
        emb = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
        return self.mlp(emb.to(self.mlp[0].weight.dtype))


class BiSelfAttn(nn.Module):
    """Bidirectional multi-head self-attention over all 3D patch tokens."""

    def __init__(self, dim: int, heads: int, dropout: float = 0.1):
        super().__init__()
        self.heads = heads
        self.head_dim = dim // heads
        self.qkv = nn.Linear(dim, dim * 3, bias=False)
        self.out = nn.Linear(dim, dim, bias=False)
        self.drop_p = dropout
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, n, c = x.shape
        q, k, v = self.qkv(x).chunk(3, dim=-1)
        q = q.view(b, n, self.heads, self.head_dim).transpose(1, 2)
        k = k.view(b, n, self.heads, self.head_dim).transpose(1, 2)
        v = v.view(b, n, self.heads, self.head_dim).transpose(1, 2)
        y = F.scaled_dot_product_attention(
            q, k, v, dropout_p=self.drop_p if self.training else 0.0, is_causal=False
        )
        return self.drop(self.out(y.transpose(1, 2).contiguous().view(b, n, c)))


class DiT3DBlock(nn.Module):
    """AdaLN-Zero 3D DiT block with bidirectional self-attention, CLIP text cross-attention, and SwiGLU."""

    def __init__(self, dim: int, heads: int, dropout: float = 0.1):
        super().__init__()
        self.n1 = RMSNorm(dim)
        self.self_attn = BiSelfAttn(dim, heads, dropout)
        self.n2 = RMSNorm(dim)
        self.cross_attn = CrossAttn(dim, heads, dropout)
        self.n3 = RMSNorm(dim)
        hidden = int(round((dim * 8 / 3) / 64)) * 64
        self.ff = SwiGLU(dim, hidden, dropout)
        # AdaLN-Zero: (shift1, scale1, gate1, shift3, scale3, gate3)
        self.ada = nn.Sequential(nn.SiLU(), nn.Linear(dim, 6 * dim))
        nn.init.zeros_(self.ada[1].weight)
        nn.init.zeros_(self.ada[1].bias)

    def forward(
        self,
        x: torch.Tensor,
        cond: torch.Tensor,
        mem: torch.Tensor,
        mem_mask: torch.Tensor | None = None,
    ) -> torch.Tensor:
        sh1, sc1, g1, sh3, sc3, g3 = self.ada(cond).unsqueeze(1).chunk(6, dim=-1)
        x = x + g1 * self.self_attn(self.n1(x) * (1.0 + sc1) + sh1)
        x = x + self.cross_attn(self.n2(x), mem, mem_mask)
        x = x + g3 * self.ff(self.n3(x) * (1.0 + sc3) + sh3)
        return x


class BlueprintFlow3D(nn.Module):
    """Stage-1 3D DiT Rectified Flow model predicting velocity `(v_grid, v_scale)`."""

    def __init__(self, cfg: BlueprintFlowConfig):
        super().__init__()
        self.cfg = cfg
        d = cfg.width
        lat = cfg.grid_size // cfg.patch_size
        pdim = cfg.channels * (cfg.patch_size ** 3)

        self.t_emb = TimestepEmbedder(d)
        self.text_pool_proj = nn.Sequential(nn.Linear(cfg.clip_dim, d), RMSNorm(d))
        self.text_tok_proj = nn.Sequential(nn.Linear(cfg.clip_dim, d), RMSNorm(d))
        self.null_text = nn.Parameter(torch.randn(1, 1, d) * 0.02)
        self.source_emb = nn.Embedding(NUM_SOURCES + 1, d)  # +1 for StableText2Brick (id=5)
        self.scale_emb = nn.Embedding(NUM_SCALES, d)

        self.patch_in = nn.Linear(pdim, d)
        self.scale_in = nn.Linear(BP_SCALE_DIM, d)
        self.scale_pos = nn.Parameter(torch.randn(1, 1, d) * 0.02)
        self.register_buffer("pos_3d", _sincos_3d_pos(lat, d).unsqueeze(0), persistent=False)

        self.blocks = nn.ModuleList([DiT3DBlock(d, cfg.heads, cfg.dropout) for _ in range(cfg.layers)])

        self.final_norm = RMSNorm(d)
        self.final_ada = nn.Sequential(nn.SiLU(), nn.Linear(d, 2 * d))
        self.patch_out = nn.Linear(d, pdim)
        self.scale_out = nn.Linear(d, BP_SCALE_DIM)

        self._init_weights()

    def _init_weights(self) -> None:
        scale = 1.0 / math.sqrt(2.0 * self.cfg.layers)
        for name, m in self.named_modules():
            if isinstance(m, nn.Linear):
                if ".ada." in name or name.startswith("final_ada") or name in ("patch_out", "scale_out"):
                    nn.init.zeros_(m.weight)
                    if m.bias is not None:
                        nn.init.zeros_(m.bias)
                else:
                    std = 0.02 * scale if (name.endswith(".out") or name.endswith(".w3")) else 0.02
                    nn.init.normal_(m.weight, mean=0.0, std=std)
                    if m.bias is not None:
                        nn.init.zeros_(m.bias)
            elif isinstance(m, nn.Embedding):
                nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def _build_cond(
        self,
        t: torch.Tensor,
        text_pooled: torch.Tensor,
        text_tokens: torch.Tensor | None,
        text_mask: torch.Tensor | None,
        source_id: torch.Tensor | None,
        scale_id: torch.Tensor | None,
        drop_text_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor | None]:
        b = t.shape[0]
        dev = t.device
        dtype = self.null_text.dtype

        pool_e = self.text_pool_proj(text_pooled.to(dtype))  # (B, D)
        if drop_text_mask is not None:
            pool_e = torch.where(drop_text_mask[:, None], self.null_text.squeeze(1).expand(b, -1), pool_e)

        src_e = self.source_emb(
            source_id.to(dev) if source_id is not None else torch.zeros(b, dtype=torch.long, device=dev)
        )
        scl_e = self.scale_emb(
            scale_id.to(dev) if scale_id is not None else torch.zeros(b, dtype=torch.long, device=dev)
        )
        cond = self.t_emb(t) + pool_e + src_e + scl_e

        if text_tokens is not None:
            tok_e = self.text_tok_proj(text_tokens.to(dtype))
            if drop_text_mask is not None:
                tok_e = torch.where(drop_text_mask[:, None, None], self.null_text.expand_as(tok_e), tok_e)
            mem = torch.cat([pool_e.unsqueeze(1), src_e.unsqueeze(1), scl_e.unsqueeze(1), tok_e], dim=1)
            if text_mask is not None:
                pref = torch.ones((b, 3), dtype=torch.bool, device=dev)
                tm = text_mask.to(dev, dtype=torch.bool)
                if drop_text_mask is not None:
                    tm = torch.where(drop_text_mask[:, None], torch.zeros_like(tm), tm)
                mem_mask = torch.cat([pref, tm], dim=1)
            else:
                mem_mask = None
        else:
            mem = torch.stack([pool_e, src_e, scl_e], dim=1)
            mem_mask = None
        return cond, mem, mem_mask

    def forward(
        self,
        x_grid: torch.Tensor,       # (B, 5, 16, 16, 16) in [-1, 1]
        x_scale: torch.Tensor,      # (B, 4) normalized log-scale
        t: torch.Tensor,            # (B,) in [0, 1]
        text_pooled: torch.Tensor,
        text_tokens: torch.Tensor | None = None,
        text_mask: torch.Tensor | None = None,
        source_id: torch.Tensor | None = None,
        scale_id: torch.Tensor | None = None,
        drop_text_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        cond, mem, mem_mask = self._build_cond(
            t, text_pooled, text_tokens, text_mask, source_id, scale_id, drop_text_mask
        )
        p_tok = self.patch_in(patchify_3d(x_grid, self.cfg.patch_size)) + self.pos_3d.to(x_grid.dtype)
        s_tok = self.scale_in(x_scale).unsqueeze(1) + self.scale_pos
        x = torch.cat([s_tok, p_tok], dim=1)  # (B, 1 + 512, D)

        for blk in self.blocks:
            x = blk(x, cond, mem, mem_mask)

        sh, sc = self.final_ada(cond).unsqueeze(1).chunk(2, dim=-1)
        x = self.final_norm(x) * (1.0 + sc) + sh

        v_scale = self.scale_out(x[:, 0])
        v_grid = unpatchify_3d(self.patch_out(x[:, 1:]), self.cfg.grid_size, self.cfg.patch_size, self.cfg.channels)
        return v_grid, v_scale

    def forward_loss(
        self,
        grid: torch.Tensor,          # (B, 5, 16, 16, 16) in [0, 1]
        norm_scale: torch.Tensor,    # (B, 4)
        has_color: torch.Tensor,     # (B,) bool (False for monochrome StableText2Brick)
        text_pooled: torch.Tensor,
        text_tokens: torch.Tensor | None = None,
        text_mask: torch.Tensor | None = None,
        source_id: torch.Tensor | None = None,
        scale_id: torch.Tensor | None = None,
        cfg_drop_prob: float = 0.15,
        meta_drop_prob: float = 0.30,
    ) -> tuple[torch.Tensor, dict[str, float]]:
        b = grid.shape[0]
        dev = grid.device

        drop_text = None
        if self.training and cfg_drop_prob > 0:
            drop_text = torch.rand(b, device=dev) < cfg_drop_prob
        if self.training and meta_drop_prob > 0 and source_id is not None and scale_id is not None:
            src_in = torch.where(torch.rand(b, device=dev) < meta_drop_prob, torch.zeros_like(source_id), source_id)
            scl_in = torch.where(torch.rand(b, device=dev) < meta_drop_prob, torch.zeros_like(scale_id), scale_id)
        else:
            src_in, scl_in = source_id, scale_id

        # Map [0, 1] -> [-1, 1]
        x1_g = grid.float() * 2.0 - 1.0
        x1_s = norm_scale.float()

        # Logit-normal timestep sampling (focuses capacity on structure-forming mid-t)
        if self.training:
            t = torch.sigmoid(torch.randn(b, device=dev))
        else:
            t = torch.linspace(0.05, 0.95, b, device=dev)

        z_g = torch.randn_like(x1_g)
        z_s = torch.randn_like(x1_s)
        t_g = t.view(b, 1, 1, 1, 1)
        t_s = t.view(b, 1)

        xt_g = (1.0 - t_g) * z_g + t_g * x1_g
        xt_s = (1.0 - t_s) * z_s + t_s * x1_s
        v_tgt_g = x1_g - z_g
        v_tgt_s = x1_s - z_s

        pred_g, pred_s = self.forward(
            xt_g.to(self.null_text.dtype),
            xt_s.to(self.null_text.dtype),
            t,
            text_pooled,
            text_tokens,
            text_mask,
            src_in,
            scl_in,
            drop_text_mask=drop_text,
        )
        pred_g = pred_g.float()
        pred_s = pred_s.float()

        # Occupancy loss (v3.5 default: unbiased w=1.0 so Rectified Flow velocity has ZERO prior tilt!)
        occ_mask = grid[:, 0] > 0.5  # (B, G, G, G)
        occ_err = (pred_g[:, 0] - v_tgt_g[:, 0]).pow(2)
        if abs(self.cfg.occ_weight - 1.0) > 1e-4:
            occ_w = torch.where(occ_mask, float(self.cfg.occ_weight), 1.0)
            loss_occ = (occ_err * occ_w).sum() / occ_w.sum().clamp(min=1.0)
        else:
            loss_occ = occ_err.mean()

        # Color + translucency loss (only supervised on color-labeled LEGO models; unbiased 1.0:1.0 by default!)
        hc = has_color.to(dev, dtype=torch.bool)
        if hc.any():
            col_err = (pred_g[hc, 1:5] - v_tgt_g[hc, 1:5]).pow(2)
            if abs(self.cfg.col_pos_weight - self.cfg.col_neg_weight) > 1e-4:
                cw = torch.where(
                    occ_mask[hc].unsqueeze(1), float(self.cfg.col_pos_weight), float(self.cfg.col_neg_weight)
                ).expand_as(col_err)
                loss_col = (col_err * cw).sum() / cw.sum().clamp(min=1.0)
            else:
                loss_col = col_err.mean()
        else:
            loss_col = torch.zeros((), device=dev)

        loss_scale = F.smooth_l1_loss(pred_s, v_tgt_s)
        total = 1.5 * loss_occ + 1.0 * loss_col + 0.5 * loss_scale

        # Implied one-step x1 reconstruction diagnostics
        with torch.no_grad():
            x1_hat_g = xt_g + (1.0 - t_g) * pred_g
            p_occ = x1_hat_g[:, 0] > 0.0
            inter = (p_occ & occ_mask).sum().float()
            union = (p_occ | occ_mask).sum().float().clamp(min=1.0)
            iou = float((inter / union).item())
            if hc.any() and occ_mask[hc].any():
                pred_rgb = ((x1_hat_g[hc, 1:4] + 1.0) * 0.5).clamp(0.0, 1.0)
                tgt_rgb = grid[hc, 1:4].float()
                m3 = occ_mask[hc].unsqueeze(1).expand_as(tgt_rgb)
                col_l1 = float((pred_rgb[m3] - tgt_rgb[m3]).abs().mean().item())
            else:
                col_l1 = 0.0

        return total, {
            "loss": float(total.item()),
            "occ": float(loss_occ.item()),
            "col": float(loss_col.item()),
            "scale": float(loss_scale.item()),
            "iou": iou,
            "col_l1": col_l1,
        }

    @torch.no_grad()
    def sample(
        self,
        text_pooled: torch.Tensor,
        text_tokens: torch.Tensor | None = None,
        text_mask: torch.Tensor | None = None,
        source_id: torch.Tensor | None = None,
        scale_id: torch.Tensor | None = None,
        n_steps: int = 32,
        cfg_scale: float = 3.2,
        symmetric: bool = True,
        occ_thresh: float = 0.50,
        debias_occ: float | None = None,
        debias_col_pos: float | None = None,
        debias_col_neg: float | None = None,
        seed: int = 0,
    ) -> tuple[np.ndarray, np.ndarray, list[int]]:
        """2nd-order Heun Rectified Flow ODE sampler with auto Bayesian debiasing -> `(grids, scales, est_parts)`."""
        self.eval()
        b = text_pooled.shape[0]
        dev = text_pooled.device
        dtype = self.null_text.dtype
        gen = torch.Generator(device="cpu").manual_seed(seed)

        d_occ = float(self.cfg.occ_weight if debias_occ is None else debias_occ)
        d_cpos = float(self.cfg.col_pos_weight if debias_col_pos is None else debias_col_pos)
        d_cneg = float(self.cfg.col_neg_weight if debias_col_neg is None else debias_col_neg)

        x_g = torch.randn((b, self.cfg.channels, self.cfg.grid_size, self.cfg.grid_size, self.cfg.grid_size), generator=gen).to(dev)
        x_s = torch.randn((b, BP_SCALE_DIM), generator=gen).to(dev)
        if symmetric:
            # Exact X-symmetric initial noise (variance-preserving)
            x_g = (x_g + torch.flip(x_g, dims=[2])) / math.sqrt(2.0)

        use_cfg = cfg_scale > 1.0 + 1e-4
        do_debias = (abs(d_occ - 1.0) > 1e-4) or (abs(d_cpos - d_cneg) > 1e-4)

        def _debias_joint(xg: torch.Tensor, vg: torch.Tensor, t_val: float) -> torch.Tensor:
            """Closed-form inversion of weighted-MSE posterior tilt for legacy checkpoints (no-op when unbiased w=1.0)."""
            if not do_debias or t_val >= 0.99:
                return vg
            omt = 1.0 - t_val
            m0_b = (xg[:, 0] + omt * vg[:, 0]).clamp(-0.999, 0.999)
            p0_b = (m0_b + 1.0) * 0.5
            p_true = p0_b / (p0_b + d_occ * (1.0 - p0_b))
            m0_true = 2.0 * p_true - 1.0

            mc_b = (xg[:, 1:5] + omt * vg[:, 1:5]).clamp(-1.0, 1.0)
            pt = p_true.unsqueeze(1)
            denom_c = d_cpos * pt + d_cneg * (1.0 - pt)
            pc_occ = ((mc_b * denom_c + d_cneg * (1.0 - pt)) / d_cpos).clamp(-pt, pt)
            mc_true = (pc_occ - (1.0 - pt)).clamp(-1.0, 1.0)
            m_true = torch.cat([m0_true.unsqueeze(1), mc_true], dim=1)
            return (m_true - xg) / omt

        def _vel(xg: torch.Tensor, xs: torch.Tensor, t_val: float) -> tuple[torch.Tensor, torch.Tensor]:
            t_t = torch.full((b,), t_val, device=dev, dtype=torch.float32)
            if use_cfg:
                xg2 = torch.cat([xg, xg], dim=0).to(dtype)
                xs2 = torch.cat([xs, xs], dim=0).to(dtype)
                t2 = torch.cat([t_t, t_t], dim=0)
                tp2 = torch.cat([text_pooled, text_pooled], dim=0)
                tt2 = torch.cat([text_tokens, text_tokens], dim=0) if text_tokens is not None else None
                tm2 = torch.cat([text_mask, text_mask], dim=0) if text_mask is not None else None
                src2 = torch.cat([source_id, torch.zeros_like(source_id)], dim=0) if source_id is not None else None
                scl2 = torch.cat([scale_id, torch.zeros_like(scale_id)], dim=0) if scale_id is not None else None
                drop = torch.cat([torch.zeros(b, dtype=torch.bool, device=dev), torch.ones(b, dtype=torch.bool, device=dev)])
                vg2, vs2 = self.forward(xg2, xs2, t2, tp2, tt2, tm2, src2, scl2, drop_text_mask=drop)
                vg_c = _debias_joint(xg, vg2[:b].float(), t_val)
                vg_u = _debias_joint(xg, vg2[b:].float(), t_val)
                vg = vg_u + cfg_scale * (vg_c - vg_u)
                vs = vs2[b:].float() + cfg_scale * (vs2[:b].float() - vs2[b:].float())
            else:
                vg, vs = self.forward(xg.to(dtype), xs.to(dtype), t_t, text_pooled, text_tokens, text_mask, source_id, scale_id)
                vg, vs = _debias_joint(xg, vg.float(), t_val), vs.float()
            if symmetric:
                vg = 0.5 * (vg + torch.flip(vg, dims=[2]))
            return vg, vs

        ts = torch.linspace(0.0, 1.0, n_steps + 1).tolist()
        for i in range(n_steps):
            t0, t1 = ts[i], ts[i + 1]
            dt = t1 - t0
            v1_g, v1_s = _vel(x_g, x_s, t0)
            if i + 1 < n_steps:
                # 2nd-order Heun predictor-corrector step
                x_mid_g = x_g + dt * v1_g
                x_mid_s = x_s + dt * v1_s
                v2_g, v2_s = _vel(x_mid_g, x_mid_s, t1)
                x_g = x_g + 0.5 * dt * (v1_g + v2_g)
                x_s = x_s + 0.5 * dt * (v1_s + v2_s)
            else:
                x_g = x_g + dt * v1_g
                x_s = x_s + dt * v1_s

        # Decode [-1, 1] -> clean binary occupancy + clamped RGB/trans
        raw_g = ((x_g + 1.0) * 0.5).clamp(0.0, 1.0).cpu().numpy()
        raw_s = x_s.cpu().numpy()

        out_grids = np.zeros_like(raw_g, dtype=np.float32)
        out_scales = np.zeros((b, 4), dtype=np.float32)
        est_parts: list[int] = []
        for i in range(b):
            occ = raw_g[i, 0] > occ_thresh
            if occ.sum() < 8:
                # Fallback to top-k occupied voxels so we never return an empty grid
                flat = raw_g[i, 0].reshape(-1)
                thr = float(np.partition(flat, -24)[-24])
                occ = raw_g[i, 0] >= thr
            occ = keep_largest_component_3d(occ)
            if symmetric:
                occ = occ | occ[::-1, :, :]
            # Ground the shape at iy=0 if floating
            ys = np.where(occ)[1]
            if len(ys) > 0 and ys.min() > 0:
                dy = int(ys.min())
                occ_s = np.zeros_like(occ)
                occ_s[:, :-dy, :] = occ[:, dy:, :]
                occ = occ_s
                rgb_tr = np.zeros_like(raw_g[i, 1:5])
                rgb_tr[:, :, :-dy, :] = raw_g[i, 1:5, :, dy:, :]
            else:
                rgb_tr = raw_g[i, 1:5]
            if symmetric:
                rgb_tr = 0.5 * (rgb_tr + rgb_tr[:, ::-1, :, :])

            out_grids[i, 0] = occ.astype(np.float32)
            out_grids[i, 1:5] = np.where(occ[None], np.clip(rgb_tr, 0.0, 1.0), 0.0)
            sc, ep = decode_scale_token(raw_s[i])
            out_scales[i] = sc
            est_parts.append(ep)
        return out_grids, out_scales, est_parts
