"""BrickGen: 3D Pose-Grounded Autoregressive Brick Transformer.

Key architectural properties:
  1. 1 transformer token per placed brick (10x shorter context than BrickNet's 10 tokens/brick),
     scaling cleanly up to 384+ parts (OMR & MOC scale).
  2. Every brick token carries explicit 3D geometry: multi-scale LEGO-harmonic Fourier (x, y_up, z),
     discrete stud/plate grid embeddings, discrete rot24 + continuous 6D rotation, and 3D world bbox.
  3. Full 77-token CLIP text cross-attention (+ pooled CLIP + source/style + scale tokens) with
     Classifier-Free Guidance (CFG) dropout for crisp prompt adherence and attribute binding.
  4. Factorized causal intra-brick prediction heads:
       part (with EOS) -> color | part -> parent pointer attention | (part, color)
       -> target 3D pose (rel dxyz, abs xyz, rot24, rot6d) | (part, color, parent)
     allowing vectorized exact scoring of all collision-free native C++ connector candidates in <1ms.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from .blueprint import BP_CH, BP_G, FRONTIER_DIM
from .geometry import ABS_XZ_BINS, ABS_Y_BINS, REL_BINS

PAD_ID = 0
BOS_ID = 1
EOS_ID = 2
PART_OFFSET = 3  # real part ids start at 3

NUM_SOURCES = 5  # 0=any/uncond, 1=bricknet, 2=omr, 3=moc, 4=brickheadz
NUM_SCALES = 6   # 0=any/uncond, 1=tiny(<=16), 2=small(17-40), 3=med(41-90), 4=large(91-180), 5=xl(181+)
NUM_ROT24 = 24
ROT24_NONE = 24


def scale_bucket(n_parts: int) -> int:
    if n_parts <= 16:
        return 1
    if n_parts <= 40:
        return 2
    if n_parts <= 90:
        return 3
    if n_parts <= 180:
        return 4
    return 5


@dataclass
class BrickGenConfig:
    n_parts: int             # number of real LEGO part classes (vocab = PART_OFFSET + n_parts)
    n_colors: int            # number of real LDraw color classes (vocab = 1 + n_colors, 0=PAD)
    width: int = 384
    layers: int = 8
    heads: int = 6
    max_bricks: int = 256
    clip_dim: int = 512
    dropout: float = 0.1
    ptr_dim: int = 192
    use_token_cross_attn: bool = True
    use_blueprint: bool = False
    bp_grid_size: int = BP_G
    bp_patch_size: int = 4
    bp_channels: int = BP_CH
    bp_layers: int = 2

    @property
    def part_vocab(self) -> int:
        return PART_OFFSET + self.n_parts

    @property
    def color_vocab(self) -> int:
        return 1 + self.n_colors

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "BrickGenConfig":
        valid = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in d.items() if k in valid})


PRESETS = {
    "small": dict(width=256, layers=6, heads=4, ptr_dim=128, max_bricks=256, dropout=0.10),
    "base": dict(width=384, layers=8, heads=6, ptr_dim=192, max_bricks=256, dropout=0.15),
    "large": dict(width=640, layers=12, heads=10, ptr_dim=256, max_bricks=384, dropout=0.20),
    "xl": dict(width=768, layers=16, heads=12, ptr_dim=256, max_bricks=384, dropout=0.20),
}


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        norm = x.float().pow(2).mean(dim=-1, keepdim=True).add(self.eps).rsqrt()
        return (x.float() * norm).to(x.dtype) * self.weight


class SwiGLU(nn.Module):
    def __init__(self, dim: int, hidden: int, dropout: float = 0.1):
        super().__init__()
        self.w12 = nn.Linear(dim, hidden * 2, bias=False)
        self.w3 = nn.Linear(hidden, dim, bias=False)
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        a, b = self.w12(x).chunk(2, dim=-1)
        return self.drop(self.w3(F.silu(a) * b))


class CausalSelfAttn(nn.Module):
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
            q, k, v, dropout_p=self.drop_p if self.training else 0.0, is_causal=True
        )
        return self.drop(self.out(y.transpose(1, 2).contiguous().view(b, n, c)))


class CrossAttn(nn.Module):
    def __init__(self, dim: int, heads: int, dropout: float = 0.1):
        super().__init__()
        self.heads = heads
        self.head_dim = dim // heads
        self.q = nn.Linear(dim, dim, bias=False)
        self.kv = nn.Linear(dim, dim * 2, bias=False)
        self.out = nn.Linear(dim, dim, bias=False)
        self.drop_p = dropout
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, mem: torch.Tensor, mem_mask: torch.Tensor | None = None) -> torch.Tensor:
        b, n, c = x.shape
        m = mem.shape[1]
        q = self.q(x).view(b, n, self.heads, self.head_dim).transpose(1, 2)
        k, v = self.kv(mem).chunk(2, dim=-1)
        k = k.view(b, m, self.heads, self.head_dim).transpose(1, 2)
        v = v.view(b, m, self.heads, self.head_dim).transpose(1, 2)
        attn_mask = None
        if mem_mask is not None:
            # mem_mask: (B, M) bool, True = keep -> (B, 1, 1, M) additive or bool mask
            attn_mask = mem_mask[:, None, None, :]
        y = F.scaled_dot_product_attention(
            q, k, v, attn_mask=attn_mask, dropout_p=self.drop_p if self.training else 0.0, is_causal=False
        )
        return self.drop(self.out(y.transpose(1, 2).contiguous().view(b, n, c)))


class DecoderBlock(nn.Module):
    def __init__(self, dim: int, heads: int, dropout: float = 0.1):
        super().__init__()
        self.n1 = RMSNorm(dim)
        self.self_attn = CausalSelfAttn(dim, heads, dropout)
        self.n2 = RMSNorm(dim)
        self.cross_attn = CrossAttn(dim, heads, dropout)
        self.n3 = RMSNorm(dim)
        hidden = int(round((dim * 8 / 3) / 64)) * 64
        self.ff = SwiGLU(dim, hidden, dropout)

    def forward(self, x: torch.Tensor, mem: torch.Tensor, mem_mask: torch.Tensor | None = None) -> torch.Tensor:
        x = x + self.self_attn(self.n1(x))
        x = x + self.cross_attn(self.n2(x), mem, mem_mask)
        x = x + self.ff(self.n3(x))
        return x


class Fourier3DEncoder(nn.Module):
    """Multi-scale sinusoidal 3D coordinate encoder tuned to LEGO LDU harmonics (20 LDU stud, 8 LDU plate)."""

    def __init__(self, out_dim: int):
        super().__init__()
        # Wavelengths in LDU: 400, 200, 80 (4 studs), 40 (2 studs), 20 (1 stud), 16 (2 plates), 8 (1 plate), 4 (half plate)
        wavelengths = torch.tensor([400.0, 200.0, 80.0, 40.0, 20.0, 16.0, 8.0, 4.0], dtype=torch.float32)
        freqs = (2.0 * math.pi) / wavelengths
        self.register_buffer("freqs", freqs, persistent=False)
        # 3 coords * 8 freqs * 2 (sin/cos) + 3 normalized raw xyz + 6 rot6d + 6 normalized bbox = 63 dims
        in_dim = 3 * len(wavelengths) * 2 + 3 + 6 + 6
        self.proj = nn.Sequential(
            nn.Linear(in_dim, out_dim),
            nn.SiLU(),
            nn.Linear(out_dim, out_dim),
        )

    def forward(self, xyz: torch.Tensor, rot6d: torch.Tensor, bbox: torch.Tensor) -> torch.Tensor:
        # xyz: (..., 3) in LDU, rot6d: (..., 6), bbox: (..., 6) in LDU
        angles = xyz.unsqueeze(-1) * self.freqs  # (..., 3, F)
        fourier = torch.cat([torch.sin(angles), torch.cos(angles)], dim=-1).flatten(-2)
        raw = torch.cat([xyz / 200.0, rot6d, bbox / 200.0], dim=-1)
        return self.proj(torch.cat([fourier, raw], dim=-1))


class Blueprint3DEncoder(nn.Module):
    """Pure-matmul 3D Patch Transformer encoding `(B, 5, 16, 16, 16)` colored blueprint + scale -> 65 tokens."""

    def __init__(
        self,
        dim: int,
        heads: int,
        layers: int = 2,
        dropout: float = 0.1,
        grid_size: int = BP_G,
        patch_size: int = 4,
        channels: int = BP_CH,
    ):
        super().__init__()
        self.grid_size = grid_size
        self.patch_size = patch_size
        self.channels = channels
        lat = grid_size // patch_size
        pdim = channels * (patch_size ** 3)

        self.patch_proj = nn.Sequential(nn.Linear(pdim, dim), RMSNorm(dim))
        self.scale_proj = nn.Sequential(nn.Linear(4, dim), RMSNorm(dim))
        self.scale_pos = nn.Parameter(torch.randn(1, 1, dim) * 0.02)
        self.null_bp = nn.Parameter(torch.randn(1, 1, dim) * 0.02)

        # Deterministic 3D sinusoidal position embedding over (lat, lat, lat)
        d_axis = dim // 3
        rem = dim - 3 * d_axis
        coords = torch.arange(lat, dtype=torch.float32)

        def _1d(d: int) -> torch.Tensor:
            half = d // 2
            omega = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32) / max(half, 1))
            ang = coords[:, None] * omega[None, :]
            emb = torch.cat([torch.sin(ang), torch.cos(ang)], dim=-1)
            return F.pad(emb, (0, d - emb.shape[-1])) if emb.shape[-1] < d else emb

        ex = _1d(d_axis)[:, None, None, :].expand(lat, lat, lat, -1)
        ey = _1d(d_axis)[None, :, None, :].expand(lat, lat, lat, -1)
        ez = _1d(d_axis + rem)[None, None, :, :].expand(lat, lat, lat, -1)
        self.register_buffer("pos_3d", torch.cat([ex, ey, ez], dim=-1).reshape(1, lat ** 3, dim), persistent=False)

        self.blocks = nn.ModuleList()
        hidden = int(round((dim * 8 / 3) / 64)) * 64
        for _ in range(layers):
            self.blocks.append(
                nn.ModuleDict(
                    {
                        "n1": RMSNorm(dim),
                        "qkv": nn.Linear(dim, dim * 3, bias=False),
                        "out": nn.Linear(dim, dim, bias=False),
                        "n2": RMSNorm(dim),
                        "ff": SwiGLU(dim, hidden, dropout),
                    }
                )
            )
        self.heads = heads
        self.head_dim = dim // heads
        self.drop_p = dropout
        self.drop = nn.Dropout(dropout)
        self.final_norm = RMSNorm(dim)

    def forward(
        self,
        bp_grid: torch.Tensor | None,
        bp_scale: torch.Tensor | None,
        batch_size: int,
        device: torch.device,
        drop_bp_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        dtype = self.null_bp.dtype
        if bp_grid is None:
            return self.null_bp.expand(batch_size, 1, -1), torch.ones((batch_size, 1), dtype=torch.bool, device=device)

        b, c, gx, gy, gz = bp_grid.shape
        p = self.patch_size
        lx, ly, lz = gx // p, gy // p, gz // p
        patches = (
            bp_grid.to(dtype)
            .view(b, c, lx, p, ly, p, lz, p)
            .permute(0, 2, 4, 6, 1, 3, 5, 7)
            .contiguous()
            .view(b, lx * ly * lz, c * p * p * p)
        )
        pt = self.patch_proj(patches) + self.pos_3d.to(dtype)
        sc = bp_scale.to(dtype) if bp_scale is not None else torch.zeros((b, 4), dtype=dtype, device=device)
        st = self.scale_proj(sc).unsqueeze(1) + self.scale_pos
        x = torch.cat([st, pt], dim=1)  # (B, 1 + 64, D)

        for blk in self.blocks:
            h = blk["n1"](x)
            q, k, v = blk["qkv"](h).chunk(3, dim=-1)
            q = q.view(b, -1, self.heads, self.head_dim).transpose(1, 2)
            k = k.view(b, -1, self.heads, self.head_dim).transpose(1, 2)
            v = v.view(b, -1, self.heads, self.head_dim).transpose(1, 2)
            y = F.scaled_dot_product_attention(q, k, v, dropout_p=self.drop_p if self.training else 0.0, is_causal=False)
            x = x + self.drop(blk["out"](y.transpose(1, 2).contiguous().view(b, -1, self.heads * self.head_dim)))
            x = x + blk["ff"](blk["n2"](x))
        x = self.final_norm(x)

        bp_mask = torch.ones((b, x.shape[1]), dtype=torch.bool, device=device)
        if drop_bp_mask is not None and drop_bp_mask.any():
            dm = drop_bp_mask.to(device=device, dtype=torch.bool)
            # Dropped rows see ONLY slot 0 = null_bp (exact match to bp_grid=None inference!)
            null_seq = torch.zeros_like(x)
            null_seq[:, :1] = self.null_bp.expand(b, 1, -1)
            x = torch.where(dm[:, None, None], null_seq, x)
            drop_m = torch.zeros_like(bp_mask)
            drop_m[:, 0] = True
            bp_mask = torch.where(dm[:, None], drop_m, bp_mask)
        return x, bp_mask


class BrickGen(nn.Module):
    """3D Pose-Grounded + Coarse 3D Blueprint-Conditioned Autoregressive LEGO Transformer."""

    def __init__(self, cfg: BrickGenConfig):
        super().__init__()
        self.cfg = cfg
        d = cfg.width

        # ---- Conditioning projections ----
        self.text_tok_proj = nn.Sequential(nn.Linear(cfg.clip_dim, d), RMSNorm(d))
        self.text_pool_proj = nn.Sequential(nn.Linear(cfg.clip_dim, d), RMSNorm(d))
        self.null_text = nn.Parameter(torch.randn(1, 1, d) * 0.02)
        self.source_emb = nn.Embedding(NUM_SOURCES, d)
        self.scale_emb = nn.Embedding(NUM_SCALES, d)
        if cfg.use_blueprint:
            self.bp_encoder = Blueprint3DEncoder(
                dim=d,
                heads=cfg.heads,
                layers=cfg.bp_layers,
                dropout=cfg.dropout,
                grid_size=cfg.bp_grid_size,
                patch_size=cfg.bp_patch_size,
                channels=cfg.bp_channels,
            )
            self.frontier_enc = nn.Sequential(
                nn.Linear(FRONTIER_DIM, d),
                nn.SiLU(),
                nn.Linear(d, d),
            )
        else:
            self.bp_encoder = None
            self.frontier_enc = None

        # ---- Brick input embeddings (1 token per brick) ----
        self.part_emb = nn.Embedding(cfg.part_vocab, d, padding_idx=PAD_ID)
        self.color_emb = nn.Embedding(cfg.color_vocab, d, padding_idx=PAD_ID)
        self.rot24_emb = nn.Embedding(NUM_ROT24 + 1, d)
        self.abs_x_emb = nn.Embedding(ABS_XZ_BINS + 1, d)  # last idx = NONE (for BOS/PAD)
        self.abs_y_emb = nn.Embedding(ABS_Y_BINS + 1, d)
        self.abs_z_emb = nn.Embedding(ABS_XZ_BINS + 1, d)
        self.geom_enc = Fourier3DEncoder(d)
        self.step_emb = nn.Embedding(cfg.max_bricks + 2, d)
        self.in_norm = RMSNorm(d)
        self.in_drop = nn.Dropout(cfg.dropout)

        # ---- Transformer Decoder ----
        self.blocks = nn.ModuleList([DecoderBlock(d, cfg.heads, cfg.dropout) for _ in range(cfg.layers)])
        self.final_norm = RMSNorm(d)

        # ---- Factorized Intra-Brick Prediction Heads ----
        # 1. Part (including EOS)
        self.head_part = nn.Linear(d, cfg.part_vocab, bias=False)

        # 2. Color | part
        self.cond_part = nn.Linear(d, d, bias=False)
        self.color_norm = RMSNorm(d)
        self.head_color = nn.Linear(d, cfg.color_vocab, bias=False)

        # 3. Parent Pointer Attention | part, color
        self.cond_color = nn.Linear(d, d, bias=False)
        self.ptr_norm = RMSNorm(d)
        self.ptr_q = nn.Linear(d, cfg.ptr_dim, bias=False)
        self.ptr_k = nn.Linear(d, cfg.ptr_dim, bias=False)

        # 4. Target 3D Pose | part, color, parent
        self.root_anchor = nn.Parameter(torch.randn(1, 1, d) * 0.02)
        self.pose_fuse = nn.Sequential(
            nn.Linear(d * 2, d),
            RMSNorm(d),
            nn.SiLU(),
            nn.Linear(d, d),
            RMSNorm(d),
            nn.SiLU(),
        )
        self.head_dx = nn.Linear(d, REL_BINS)
        self.head_dy = nn.Linear(d, REL_BINS)
        self.head_dz = nn.Linear(d, REL_BINS)
        self.head_ax = nn.Linear(d, ABS_XZ_BINS)
        self.head_ay = nn.Linear(d, ABS_Y_BINS)
        self.head_az = nn.Linear(d, ABS_XZ_BINS)
        self.head_rot24 = nn.Linear(d, NUM_ROT24)
        self.head_rot6d = nn.Linear(d, 6)

        self._init_weights()

    def _init_weights(self) -> None:
        scale = 1.0 / math.sqrt(2.0 * self.cfg.layers)
        for name, m in self.named_modules():
            if isinstance(m, nn.Linear):
                std = 0.02 * scale if (name.endswith(".out") or name.endswith(".w3")) else 0.02
                nn.init.normal_(m.weight, mean=0.0, std=std)
                if m.bias is not None:
                    nn.init.zeros_(m.bias)
            elif isinstance(m, nn.Embedding):
                nn.init.normal_(m.weight, mean=0.0, std=0.02)
                if m.padding_idx is not None:
                    with torch.no_grad():
                        m.weight[m.padding_idx].zero_()

    def build_memory(
        self,
        text_pooled: torch.Tensor,
        text_tokens: torch.Tensor | None = None,
        text_mask: torch.Tensor | None = None,
        source_id: torch.Tensor | None = None,
        scale_id: torch.Tensor | None = None,
        drop_text_mask: torch.Tensor | None = None,
        bp_grid: torch.Tensor | None = None,
        bp_scale: torch.Tensor | None = None,
        drop_bp_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor | None]:
        """Construct cross-attention conditioning memory (B, M, D) and bool keep-mask (B, M)."""
        b = text_pooled.shape[0]
        dev = text_pooled.device
        dtype = self.null_text.dtype

        pool_emb = self.text_pool_proj(text_pooled.to(dtype)).unsqueeze(1)  # (B, 1, D)
        if drop_text_mask is not None:
            dm = drop_text_mask.view(b, 1, 1)
            pool_emb = torch.where(dm, self.null_text.expand(b, 1, -1), pool_emb)

        src = self.source_emb(
            source_id.to(dev) if source_id is not None else torch.zeros(b, dtype=torch.long, device=dev)
        ).unsqueeze(1)
        scl = self.scale_emb(
            scale_id.to(dev) if scale_id is not None else torch.zeros(b, dtype=torch.long, device=dev)
        ).unsqueeze(1)

        if self.cfg.use_token_cross_attn and text_tokens is not None:
            tok_emb = self.text_tok_proj(text_tokens.to(dtype))  # (B, L, D)
            if drop_text_mask is not None:
                dm = drop_text_mask.view(b, 1, 1)
                tok_emb = torch.where(dm, self.null_text.expand_as(tok_emb), tok_emb)
            mem = torch.cat([pool_emb, src, scl, tok_emb], dim=1)
            if text_mask is not None:
                prefix_ok = torch.ones((b, 3), dtype=torch.bool, device=dev)
                tm = text_mask.to(dev, dtype=torch.bool)
                if drop_text_mask is not None:
                    tm = torch.where(drop_text_mask[:, None], torch.zeros_like(tm), tm)
                mem_mask = torch.cat([prefix_ok, tm], dim=1)
            else:
                mem_mask = torch.ones((b, mem.shape[1]), dtype=torch.bool, device=dev)
        else:
            mem = torch.cat([pool_emb, src, scl], dim=1)
            mem_mask = torch.ones((b, mem.shape[1]), dtype=torch.bool, device=dev)

        if self.bp_encoder is not None:
            bp_toks, bp_mask = self.bp_encoder(bp_grid, bp_scale, b, dev, drop_bp_mask=drop_bp_mask)
            mem = torch.cat([mem, bp_toks], dim=1)
            mem_mask = torch.cat([mem_mask, bp_mask], dim=1)
        elif text_mask is None:
            mem_mask = None
        return mem, mem_mask

    def embed_placed(
        self,
        part_ids: torch.Tensor,   # (B, T) [BOS, p_0, p_1, ...]
        color_ids: torch.Tensor,  # (B, T) [0, c_0, c_1, ...]
        rot24: torch.Tensor,      # (B, T) [ROT24_NONE, r_0, r_1, ...]
        ax: torch.Tensor,         # (B, T) [ABS_XZ_BINS, ax_0, ...]
        ay: torch.Tensor,         # (B, T) [ABS_Y_BINS, ay_0, ...]
        az: torch.Tensor,         # (B, T) [ABS_XZ_BINS, az_0, ...]
        xyz: torch.Tensor,        # (B, T, 3) float (0 at BOS)
        rot6d: torch.Tensor,      # (B, T, 6) float (0 at BOS)
        bbox: torch.Tensor,       # (B, T, 6) float (0 at BOS)
        frontier: torch.Tensor | None = None,  # (B, T, FRONTIER_DIM) causal blueprint progress
    ) -> torch.Tensor:
        b, T = part_ids.shape
        steps = torch.arange(T, device=part_ids.device).clamp(max=self.cfg.max_bricks + 1)
        dtype = self.null_text.dtype
        is_brick = (part_ids >= PART_OFFSET).unsqueeze(-1).to(dtype)
        geom = self.geom_enc(xyz, rot6d, bbox) * is_brick
        x = (
            self.part_emb(part_ids)
            + self.color_emb(color_ids)
            + self.rot24_emb(rot24)
            + self.abs_x_emb(ax)
            + self.abs_y_emb(ay)
            + self.abs_z_emb(az)
            + geom
            + self.step_emb(steps)[None]
        )
        if self.frontier_enc is not None and frontier is not None:
            has_bp = frontier[..., :1].to(dtype)
            x = x + self.frontier_enc(frontier.to(dtype)) * has_bp
        return self.in_drop(self.in_norm(x))

    def encode_sequence(
        self,
        in_emb: torch.Tensor,
        mem: torch.Tensor,
        mem_mask: torch.Tensor | None = None,
    ) -> torch.Tensor:
        x = in_emb
        for blk in self.blocks:
            x = blk(x, mem, mem_mask)
        return self.final_norm(x)

    def predict_pose_from_anchor(self, h_pc: torch.Tensor, h_anchor: torch.Tensor) -> dict[str, torch.Tensor]:
        """Given h_pc (..., D) and chosen parent anchor h_anchor (..., D), predict all 3D pose heads."""
        hp = self.pose_fuse(torch.cat([h_pc, h_anchor], dim=-1))
        return {
            "dx": self.head_dx(hp),
            "dy": self.head_dy(hp),
            "dz": self.head_dz(hp),
            "ax": self.head_ax(hp),
            "ay": self.head_ay(hp),
            "az": self.head_az(hp),
            "rot24": self.head_rot24(hp),
            "rot6d": self.head_rot6d(hp),
        }

    def forward_loss(
        self,
        batch: dict[str, torch.Tensor],
        text_pooled: torch.Tensor,
        text_tokens: torch.Tensor | None = None,
        text_mask: torch.Tensor | None = None,
        cfg_drop_prob: float = 0.10,
        meta_drop_prob: float = 0.30,
        force_drop_blueprint: bool = False,
    ) -> tuple[torch.Tensor, dict[str, float]]:
        """Full teacher-forced training loss over a batch of canonical brick sequences."""
        part = batch["part"]
        color = batch["color"]
        parent = batch["parent"]
        rot24 = batch["rot24"]
        ax, ay, az = batch["ax"], batch["ay"], batch["az"]
        dx, dy, dz = batch["dx"], batch["dy"], batch["dz"]
        xyz, rot6d, bbox = batch["xyz"], batch["rot6d"], batch["bbox"]
        lengths = batch["length"]
        source = batch["source"]
        scale = batch["scale"]
        bp_grid = batch.get("bp_grid") if self.cfg.use_blueprint else None
        bp_scale = batch.get("bp_scale") if self.cfg.use_blueprint else None
        frontier = batch.get("frontier") if self.cfg.use_blueprint else None

        b, S = part.shape
        dev = part.device

        # Build conditioning with Dual-CFG (text + 3D blueprint) and metadata dropout
        drop_text = None
        drop_bp = None
        if self.cfg.use_blueprint and bp_grid is not None:
            if force_drop_blueprint:
                drop_bp = torch.ones(b, dtype=torch.bool, device=dev)
            elif self.training and cfg_drop_prob > 0:
                # Mutually exclusive Dual-CFG partition:
                # 10% drop BOTH, 15% drop text only (shape->LEGO), 20% drop bp only (text->LEGO), 55% keep BOTH
                u = torch.rand(b, device=dev)
                drop_both = u < 0.10
                drop_text = drop_both | ((u >= 0.10) & (u < 0.25))
                drop_bp = drop_both | ((u >= 0.25) & (u < 0.45))
        elif self.training and cfg_drop_prob > 0:
            drop_text = torch.rand(b, device=dev) < cfg_drop_prob

        if self.training and meta_drop_prob > 0:
            src_in = torch.where(torch.rand(b, device=dev) < meta_drop_prob, torch.zeros_like(source), source)
            scl_in = torch.where(torch.rand(b, device=dev) < meta_drop_prob, torch.zeros_like(scale), scale)
        else:
            src_in, scl_in = source, scale

        mem, mem_mask = self.build_memory(
            text_pooled=text_pooled,
            text_tokens=text_tokens,
            text_mask=text_mask,
            source_id=src_in,
            scale_id=scl_in,
            drop_text_mask=drop_text,
            bp_grid=bp_grid,
            bp_scale=bp_scale,
            drop_bp_mask=drop_bp,
        )

        # Zero causal frontier features on blueprint-dropped rows so training matches text-only inference
        if frontier is not None and drop_bp is not None and drop_bp.any():
            frontier = torch.where(drop_bp[:, None, None], torch.zeros_like(frontier), frontier)

        # Build teacher-forced inputs of length T = S + 1:
        #   pos 0: BOS           -> predicts brick 0 (or EOS if empty)
        #   pos 1: brick 0       -> predicts brick 1
        #   ...
        #   pos N_b: brick N_b-1 -> predicts EOS!
        T = S + 1
        in_part = torch.full((b, T), PAD_ID, dtype=torch.long, device=dev)
        in_part[:, 0] = BOS_ID
        in_part[:, 1:] = part

        in_color = torch.zeros((b, T), dtype=torch.long, device=dev)
        in_color[:, 1:] = color

        in_rot24 = torch.full((b, T), ROT24_NONE, dtype=torch.long, device=dev)
        in_rot24[:, 1:] = torch.where(part >= PART_OFFSET, rot24, torch.full_like(rot24, ROT24_NONE))

        in_ax = torch.full((b, T), ABS_XZ_BINS, dtype=torch.long, device=dev)
        in_ay = torch.full((b, T), ABS_Y_BINS, dtype=torch.long, device=dev)
        in_az = torch.full((b, T), ABS_XZ_BINS, dtype=torch.long, device=dev)
        valid_b = part >= PART_OFFSET
        in_ax[:, 1:] = torch.where(valid_b, ax, torch.full_like(ax, ABS_XZ_BINS))
        in_ay[:, 1:] = torch.where(valid_b, ay, torch.full_like(ay, ABS_Y_BINS))
        in_az[:, 1:] = torch.where(valid_b, az, torch.full_like(az, ABS_XZ_BINS))

        in_xyz = torch.zeros((b, T, 3), dtype=xyz.dtype, device=dev)
        in_xyz[:, 1:] = xyz
        in_rot6d = torch.zeros((b, T, 6), dtype=rot6d.dtype, device=dev)
        in_rot6d[:, 1:] = rot6d
        in_bbox = torch.zeros((b, T, 6), dtype=bbox.dtype, device=dev)
        in_bbox[:, 1:] = bbox

        in_emb = self.embed_placed(
            in_part, in_color, in_rot24, in_ax, in_ay, in_az, in_xyz, in_rot6d, in_bbox, frontier=frontier
        )
        h_out = self.encode_sequence(in_emb, mem, mem_mask)  # (B, S+1, D)

        # ---- 1. Part + EOS loss (across all T = S+1 positions) ----
        # Target at pos t < N_b is part[:, t]; target at pos t == N_b is EOS_ID; t > N_b is PAD_ID
        tgt_part = torch.full((b, T), PAD_ID, dtype=torch.long, device=dev)
        tgt_part[:, :S] = part
        # Place EOS right at index lengths[i] (for sequences where lengths[i] <= S)
        row_idx = torch.arange(b, device=dev)
        eos_ok = lengths <= S
        tgt_part[row_idx[eos_ok], lengths[eos_ok]] = EOS_ID

        part_logits = self.head_part(h_out)  # (B, T, V_part)
        loss_part = F.cross_entropy(
            part_logits.reshape(-1, part_logits.shape[-1]).float(),
            tgt_part.reshape(-1),
            ignore_index=PAD_ID,
            label_smoothing=0.05 if self.training else 0.0,
        )

        # For stages 2, 3, 4 we evaluate at brick positions t = 0..S-1 where valid_b (part >= PART_OFFSET)
        h_step = h_out[:, :S]  # (B, S, D): h_step[:, t] predicts brick t!

        # ---- 2. Color | part ----
        h_c = h_step + self.cond_part(self.part_emb(part))
        color_logits = self.head_color(self.color_norm(h_c))
        loss_color = F.cross_entropy(color_logits.reshape(-1, color_logits.shape[-1]).float(), color.reshape(-1), ignore_index=PAD_ID)

        # ---- 3. Parent Pointer Attention | part, color (strictly causal: brick t points to j < t) ----
        h_pc = self.ptr_norm(h_c + self.cond_color(self.color_emb(color)))
        # Placed brick j's key lives at slot j+1 (causal: slot j+1 only depends on bricks 0..j)
        brick_keys = h_out[:, 1:] + in_emb[:, 1:]  # (B, S, D)
        q = self.ptr_q(h_pc)  # (B, S, d_ptr)
        k = self.ptr_k(brick_keys)  # (B, S, d_ptr)
        ptr_logits = torch.bmm(q, k.transpose(1, 2)).float() / math.sqrt(self.cfg.ptr_dim)  # (B, S, S)
        # Strict lower triangular mask: position t can ONLY attend to j < t!
        causal_ptr = torch.tril(torch.ones((S, S), dtype=torch.bool, device=dev), diagonal=-1)
        ptr_logits = ptr_logits.masked_fill(~causal_ptr[None], -1e9)

        has_parent = valid_b & (parent >= 0)
        tgt_parent = torch.where(has_parent, parent, torch.full_like(parent, -100))
        if has_parent.any():
            loss_parent = F.cross_entropy(ptr_logits.reshape(-1, S), tgt_parent.reshape(-1), ignore_index=-100)
        else:
            loss_parent = torch.zeros((), device=dev)

        # ---- 4. Target 3D Pose | part, color, parent ----
        safe_parent = parent.clamp(min=0)
        par_feat = torch.gather(brick_keys, 1, safe_parent.unsqueeze(-1).expand(-1, -1, self.cfg.width))
        anchor = torch.where(has_parent.unsqueeze(-1), par_feat, self.root_anchor.expand(b, S, -1))
        pose_out = self.predict_pose_from_anchor(h_pc, anchor)

        # Mask helper
        def _ce(logits: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
            if not mask.any():
                return torch.zeros((), device=dev)
            return F.cross_entropy(logits[mask].float(), target[mask])

        loss_dx = _ce(pose_out["dx"], dx, has_parent)
        loss_dy = _ce(pose_out["dy"], dy, has_parent)
        loss_dz = _ce(pose_out["dz"], dz, has_parent)
        loss_ax = _ce(pose_out["ax"], ax, valid_b)
        loss_ay = _ce(pose_out["ay"], ay, valid_b)
        loss_az = _ce(pose_out["az"], az, valid_b)
        loss_rot24 = _ce(pose_out["rot24"], rot24, valid_b)

        # Continuous 6D rotation loss (normalized column-wise cosine + smooth L1)
        if valid_b.any():
            pred_r6 = pose_out["rot6d"][valid_b].float()
            tgt_r6 = rot6d[valid_b].float()
            loss_rot6d = F.smooth_l1_loss(pred_r6, tgt_r6)
        else:
            loss_rot6d = torch.zeros((), device=dev)

        loss_rel = (loss_dx + loss_dy + loss_dz) / 3.0
        loss_abs = (loss_ax + loss_ay + loss_az) / 3.0
        total = (
            1.2 * loss_part
            + 0.8 * loss_color
            + 1.0 * loss_parent
            + 1.2 * loss_rel
            + 0.8 * loss_abs
            + 0.8 * loss_rot24
            + 0.5 * loss_rot6d
        )

        # Diagnostic accuracies (no grad)
        with torch.no_grad():
            p_mask = tgt_part != PAD_ID
            part_acc = (part_logits.argmax(-1)[p_mask] == tgt_part[p_mask]).float().mean().item() if p_mask.any() else 0.0
            col_acc = (color_logits.argmax(-1)[valid_b] == color[valid_b]).float().mean().item() if valid_b.any() else 0.0
            par_acc = (ptr_logits.argmax(-1)[has_parent] == parent[has_parent]).float().mean().item() if has_parent.any() else 0.0
            r24_acc = (pose_out["rot24"].argmax(-1)[valid_b] == rot24[valid_b]).float().mean().item() if valid_b.any() else 0.0

        metrics = {
            "loss": float(total.item()),
            "part": float(loss_part.item()),
            "color": float(loss_color.item()),
            "parent": float(loss_parent.item()),
            "rel": float(loss_rel.item()),
            "abs": float(loss_abs.item()),
            "rot24": float(loss_rot24.item()),
            "part_acc": part_acc,
            "color_acc": col_acc,
            "parent_acc": par_acc,
            "rot24_acc": r24_acc,
        }
        return total, metrics
