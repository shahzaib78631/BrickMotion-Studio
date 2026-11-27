"""3D Colored Blueprint representation, rasterizer, causal frontier tracker, and preview renderer.

Every LEGO model (from 8 parts to 384+ parts) is mapped into a canonical, aspect-preserving
16 x 16 x 16 x 5 colored 3D silhouette grid + physical scale vector:

  Grid channels (5, G, G, G) with axis order (C, X, Y_up, Z):
    ch 0: occ   in {0, 1}   — binary occupancy
    ch 1: R     in [0, 1]   — exact sRGB red from LDConfig.ldr (0 where empty)
    ch 2: G     in [0, 1]   — exact sRGB green
    ch 3: B     in [0, 1]   — exact sRGB blue
    ch 4: trans in [0, 1]   — translucent/glass fraction (windshields, windows, lights)

  Coordinate mapping (isotropic, ground-aligned, X-symmetry-aligned):
    cube_S = max(2 * max(|min_x|, |max_x|), max_y_up, 2 * max(|min_z|, |max_z|), 80.0)
    u_x = x / cube_S + 0.5  ->  ix in [0, G-1]  (x = 0 is ALWAYS exact center between ix=7 and ix=8)
    u_y = y_up / cube_S     ->  iy in [0, G-1]  (ground y_up = 0 is ALWAYS iy = 0)
    u_z = z / cube_S + 0.5  ->  iz in [0, G-1]  (z = 0 is ALWAYS exact center between iz=7 and iz=8)

  Physical scale vector:
    scale_vec = [span_x, span_y, span_z, cube_S] in LDU.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
from PIL import Image

BP_G = 16
BP_CH = 5
FRONTIER_DIM = 15  # [has_bp, cov, rem, ovf, f_cx, f_cy, f_cz, f_sx, f_sy, f_sz, l_occ, l_r, l_g, l_b, l_tr]

REPO_ROOT = Path(__file__).resolve().parents[2]
LDCONFIG_PATH = REPO_ROOT / "public/ldraw/LDConfig.ldr"

_LDCOLOR_RE = re.compile(
    r"0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})(?:.*?ALPHA\s+(\d+))?"
)

# Fallback RGBA table for standard LDraw colors if LDConfig.ldr is unavailable (e.g. on Colab)
_FALLBACK_RGBA: dict[int, tuple[float, float, float, float]] = {
    0: (0.11, 0.16, 0.20, 0.0),
    1: (0.12, 0.35, 0.66, 0.0),
    2: (0.00, 0.52, 0.17, 0.0),
    4: (0.71, 0.00, 0.00, 0.0),
    6: (0.35, 0.23, 0.14, 0.0),
    7: (0.60, 0.61, 0.60, 0.0),
    8: (0.39, 0.40, 0.39, 0.0),
    14: (0.98, 0.78, 0.04, 0.0),
    15: (0.96, 0.96, 0.96, 0.0),
    16: (0.65, 0.65, 0.65, 0.0),
    19: (0.87, 0.78, 0.58, 0.0),
    25: (0.99, 0.54, 0.09, 0.0),
    33: (0.00, 0.13, 0.63, 1.0),
    36: (0.79, 0.10, 0.04, 1.0),
    40: (0.39, 0.37, 0.32, 1.0),
    41: (0.33, 0.60, 0.72, 1.0),
    42: (0.75, 1.00, 0.00, 1.0),
    46: (0.96, 0.80, 0.18, 1.0),
    47: (0.99, 0.99, 0.99, 1.0),
    57: (0.94, 0.56, 0.11, 1.0),
    70: (0.35, 0.16, 0.09, 0.0),
    71: (0.59, 0.59, 0.59, 0.0),
    72: (0.39, 0.39, 0.39, 0.0),
}


def load_ldraw_color_rgba(ldconfig_path: Path = LDCONFIG_PATH) -> dict[int, tuple[float, float, float, float]]:
    """Parse LDConfig.ldr into `code -> (r, g, b, is_trans)` with values in [0, 1]."""
    out = dict(_FALLBACK_RGBA)
    if ldconfig_path.exists():
        text = ldconfig_path.read_text(encoding="utf-8", errors="ignore")
        for m in _LDCOLOR_RE.finditer(text):
            code = int(m.group(2))
            hx = m.group(3)
            alpha = int(m.group(4)) if m.group(4) else 255
            r = int(hx[0:2], 16) / 255.0
            g = int(hx[2:4], 16) / 255.0
            b = int(hx[4:6], 16) / 255.0
            is_trans = 1.0 if alpha < 250 else 0.0
            out[code] = (round(r, 4), round(g, 4), round(b, 4), is_trans)
    return out


def build_color_rgba_lut(vocab: dict) -> np.ndarray:
    """Build (1 + n_colors, 4) float32 lookup table `[r, g, b, trans]` indexed by color token ID (0=PAD)."""
    raw = vocab.get("color_rgba")
    colors = [int(c) for c in vocab["colors"]]
    if raw is not None and len(raw) == len(colors) + 1:
        return np.asarray(raw, dtype=np.float32)
    cmap = load_ldraw_color_rgba()
    lut = np.zeros((len(colors) + 1, 4), dtype=np.float32)
    for i, c in enumerate(colors, start=1):
        lut[i] = cmap.get(c, (0.62, 0.62, 0.62, 0.0))
    return lut


def compute_blueprint_scale(bboxes_yup: np.ndarray) -> np.ndarray:
    """Compute canonical isotropic blueprint scale vector `[span_x, span_y, span_z, cube_S]` in LDU."""
    if len(bboxes_yup) == 0:
        return np.array([80.0, 80.0, 80.0, 80.0], dtype=np.float32)
    lo = bboxes_yup[:, :3].min(axis=0)
    hi = bboxes_yup[:, 3:6].max(axis=0)
    span = np.maximum(hi - lo, 16.0)
    max_abs_x = max(abs(float(lo[0])), abs(float(hi[0])))
    max_abs_z = max(abs(float(lo[2])), abs(float(hi[2])))
    max_y = max(float(hi[1]), 24.0)
    cube_s = max(2.0 * max_abs_x, max_y, 2.0 * max_abs_z, 80.0)
    return np.array([float(span[0]), float(span[1]), float(span[2]), float(cube_s)], dtype=np.float32)


def encode_scale_vec(scale_vec: np.ndarray, n_parts: float | None = None) -> np.ndarray:
    """Normalize `[span_x, span_y, span_z, cube_S]` (or optional `n_parts`) for neural inputs."""
    sx, sy, sz, cs = [max(float(v), 16.0) for v in scale_vec]
    fourth = math.log(max(float(n_parts), 4.0) / 40.0) if n_parts is not None else math.log(cs / 160.0)
    return np.array(
        [
            math.log(sx / 160.0),
            math.log(sy / 160.0),
            math.log(sz / 160.0),
            fourth,
        ],
        dtype=np.float32,
    )


def decode_scale_token(norm_scale: np.ndarray) -> tuple[np.ndarray, int]:
    """Invert Stage-1 scale token `[log(sx/160), log(sy/160), log(sz/160), log(n_parts/40)]`."""
    ns = np.clip(np.asarray(norm_scale, dtype=np.float64), -2.2, 2.2)
    sx = float(np.clip(160.0 * math.exp(ns[0]), 40.0, 640.0))
    sy = float(np.clip(160.0 * math.exp(ns[1]), 32.0, 640.0))
    sz = float(np.clip(160.0 * math.exp(ns[2]), 40.0, 640.0))
    est_parts = int(round(np.clip(40.0 * math.exp(ns[3]), 10.0, 320.0)))
    cube_s = max(sx, sy, sz, 80.0)
    return np.array([sx, sy, sz, cube_s], dtype=np.float32), est_parts


def bboxes_to_voxel_ranges(
    bboxes_yup: np.ndarray,
    cube_s: float,
    g: int = BP_G,
) -> tuple[np.ndarray, np.ndarray]:
    """Map canonical Y-up bboxes `(N, 6)` -> integer voxel bounds `(lo[N,3], hi[N,3])` in `[0, g]`."""
    inv_s = 1.0 / max(float(cube_s), 1.0)
    u_x0 = (bboxes_yup[:, 0] * inv_s + 0.5) * g
    u_x1 = (bboxes_yup[:, 3] * inv_s + 0.5) * g
    u_y0 = (bboxes_yup[:, 1] * inv_s) * g
    u_y1 = (bboxes_yup[:, 4] * inv_s) * g
    u_z0 = (bboxes_yup[:, 2] * inv_s + 0.5) * g
    u_z1 = (bboxes_yup[:, 5] * inv_s + 0.5) * g

    # Slight inset (0.15 voxel) prevents adjacent touching bricks from bleeding extra voxels
    lo_x = np.clip(np.floor(u_x0 + 0.12).astype(np.int32), 0, g - 1)
    lo_y = np.clip(np.floor(u_y0 + 0.12).astype(np.int32), 0, g - 1)
    lo_z = np.clip(np.floor(u_z0 + 0.12).astype(np.int32), 0, g - 1)

    hi_x = np.clip(np.ceil(u_x1 - 0.12).astype(np.int32), 1, g)
    hi_y = np.clip(np.ceil(u_y1 - 0.12).astype(np.int32), 1, g)
    hi_z = np.clip(np.ceil(u_z1 - 0.12).astype(np.int32), 1, g)

    lo = np.stack([lo_x, lo_y, lo_z], axis=-1)
    hi = np.maximum(np.stack([hi_x, hi_y, hi_z], axis=-1), lo + 1)
    hi = np.minimum(hi, g)
    return lo, hi


def rasterize_blueprint(
    bboxes_yup: np.ndarray,
    color_ids: np.ndarray,
    color_rgba_lut: np.ndarray,
    scale_vec: np.ndarray | None = None,
    g: int = BP_G,
) -> tuple[np.ndarray, np.ndarray]:
    """Rasterize canonical bricks into `(grid[5, G, G, G] float32, scale_vec[4] float32)`."""
    if scale_vec is None:
        scale_vec = compute_blueprint_scale(bboxes_yup)
    cube_s = float(scale_vec[3])
    grid = np.zeros((BP_CH, g, g, g), dtype=np.float32)
    if len(bboxes_yup) == 0:
        return grid, scale_vec

    lo, hi = bboxes_to_voxel_ranges(bboxes_yup, cube_s, g=g)
    cnt = np.zeros((g, g, g), dtype=np.float32)
    rgba_sum = np.zeros((4, g, g, g), dtype=np.float32)
    lut_len = len(color_rgba_lut)

    for i in range(len(bboxes_yup)):
        x0, y0, z0 = int(lo[i, 0]), int(lo[i, 1]), int(lo[i, 2])
        x1, y1, z1 = int(hi[i, 0]), int(hi[i, 1]), int(hi[i, 2])
        cid = int(color_ids[i])
        rgba = color_rgba_lut[cid if 0 <= cid < lut_len else 0]
        cnt[x0:x1, y0:y1, z0:z1] += 1.0
        rgba_sum[:, x0:x1, y0:y1, z0:z1] += rgba[:, None, None, None]

    occ = cnt > 0.0
    grid[0] = occ.astype(np.float32)
    inv_cnt = np.where(occ, 1.0 / np.maximum(cnt, 1.0), 0.0)
    grid[1:5] = rgba_sum * inv_cnt[None]
    return grid, scale_vec


def blueprint_flip_x(grid: np.ndarray) -> np.ndarray:
    """Exact left-right reflection of `(5, G, G, G)` across X = 0."""
    return np.ascontiguousarray(grid[:, ::-1, :, :])


def blueprint_rot_yaw90(grid: np.ndarray, k: int) -> np.ndarray:
    """Exact 90° * k rotation around Y_up matching `geometry.YAW90[k]` (`x'=z, z'=-x` for k=1)."""
    k = k % 4
    if k == 0:
        return grid
    # YAW90[1] maps (x, z) -> (z, -x), so out[z, G-1-x] = in[x, z] <=> np.rot90(grid, k=-1, axes=(1, 3))
    return np.ascontiguousarray(np.rot90(grid, k=-k, axes=(1, 3)))


def _frontier_from_remaining(
    occ_coords_sorted: np.ndarray,
    rem_mask: np.ndarray,
    cube_s: float,
    g: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Given target voxel coords `(M, 3)` sorted ascending by `iy`, compute lowest-layer frontier `(center, span)` in LDU/200."""
    idx = np.flatnonzero(rem_mask)
    if len(idx) == 0:
        return np.zeros(3, dtype=np.float32), np.zeros(3, dtype=np.float32)
    first_y = int(occ_coords_sorted[idx[0], 1])
    # Active frontier band = lowest 2 voxel layers still uncovered
    band_coords = occ_coords_sorted[idx]
    band = band_coords[band_coords[:, 1] <= first_y + 1]
    # Map voxel center (ix+0.5)/G back to canonical Y-up LDU
    vox_w = float(cube_s) / g
    wx = ((band[:, 0] + 0.5) / g - 0.5) * cube_s
    wy = ((band[:, 1] + 0.5) / g) * cube_s
    wz = ((band[:, 2] + 0.5) / g - 0.5) * cube_s
    center = np.array([wx.mean(), wy.mean(), wz.mean()], dtype=np.float32) / 200.0
    span = np.array(
        [
            (wx.max() - wx.min() + vox_w),
            (wy.max() - wy.min() + vox_w),
            (wz.max() - wz.min() + vox_w),
        ],
        dtype=np.float32,
    ) / 200.0
    return center, span


def compute_causal_frontier_features(
    bboxes_yup: np.ndarray,
    grid: np.ndarray,
    scale_vec: np.ndarray,
    g: int = BP_G,
) -> np.ndarray:
    """Fast vectorized strictly-causal `(L + 1, 15)` blueprint frontier & local target features.

    Row 0 (BOS): 0 bricks placed yet -> full blueprint remaining, local sample = target voxel at frontier center.
    Row t (1..L): bricks `0..t-1` placed -> exact remaining target frontier + local target sample at brick `t-1`.
    """
    L = len(bboxes_yup)
    feats = np.zeros((L + 1, FRONTIER_DIM), dtype=np.float32)
    cube_s = float(scale_vec[3])
    target_occ = grid[0] > 0.5
    coords = np.argwhere(target_occ)  # (M, 3): (ix, iy, iz)
    M = len(coords)
    if M == 0:
        return feats

    # Sort target voxels bottom-up by iy (then iz, ix)
    order = np.lexsort((coords[:, 0], coords[:, 2], coords[:, 1]))
    coords = coords[order].astype(np.int32)
    cx, cy, cz = coords[:, 0], coords[:, 1], coords[:, 2]

    # Precompute world coords (LDU / 200) for all M target voxels once
    vox_w = float(cube_s) / g
    inv_200 = 1.0 / 200.0
    wx = (((cx + 0.5) / g - 0.5) * cube_s * inv_200).astype(np.float32)
    wy = (((cy + 0.5) / g) * cube_s * inv_200).astype(np.float32)
    wz = (((cz + 0.5) / g - 0.5) * cube_s * inv_200).astype(np.float32)
    vw_n = float(vox_w * inv_200)

    lo, hi = bboxes_to_voxel_ranges(bboxes_yup, cube_s, g=g)

    # First brick index `first_hit[m]` (in 0..L-1) that covers each target voxel m (or L if never covered)
    hit = (
        (cx[None, :] >= lo[:, 0:1])
        & (cx[None, :] < hi[:, 0:1])
        & (cy[None, :] >= lo[:, 1:2])
        & (cy[None, :] < hi[:, 1:2])
        & (cz[None, :] >= lo[:, 2:3])
        & (cz[None, :] < hi[:, 2:3])
    )  # (L, M) bool
    any_hit = hit.any(axis=0)
    first_hit = np.where(any_hit, hit.argmax(axis=0), L).astype(np.int32)  # (M,)

    # Exact covered fraction for all rows 0..L in O(L + M)
    newly_cov_at = np.bincount(first_hit, minlength=L + 1)[:L]
    cov_counts = np.zeros(L + 1, dtype=np.float32)
    cov_counts[1:] = np.cumsum(newly_cov_at, dtype=np.float32)
    inv_M = 1.0 / float(M)
    feats[:, 0] = 1.0
    feats[:, 1] = cov_counts * inv_M
    feats[:, 2] = (M - cov_counts) * inv_M

    # Vectorized local target mean over each brick's box via 5-channel 3D summed-area table
    sat = np.pad(grid, ((0, 0), (1, 0), (1, 0), (1, 0)), mode="constant")
    sat = sat.cumsum(axis=1).cumsum(axis=2).cumsum(axis=3)
    x0, y0, z0 = lo[:, 0], lo[:, 1], lo[:, 2]
    x1, y1, z1 = hi[:, 0], hi[:, 1], hi[:, 2]
    vol = np.maximum(((x1 - x0) * (y1 - y0) * (z1 - z0)).astype(np.float32), 1.0)
    box_sum = (
        sat[:, x1, y1, z1]
        - sat[:, x0, y1, z1]
        - sat[:, x1, y0, z1]
        - sat[:, x1, y1, z0]
        + sat[:, x0, y0, z1]
        + sat[:, x0, y1, z0]
        + sat[:, x1, y0, z0]
        - sat[:, x0, y0, z0]
    )  # (5, L)
    feats[0, 10:15] = grid[:, int(cx[0]), int(cy[0]), int(cz[0])]
    feats[1:, 10:15] = (box_sum / vol[None, :]).T

    # Check if every brick lies inside target_occ (always true for ground-truth training blueprints -> overflow=0!)
    sat_occ = sat[0]
    in_tgt = (
        sat_occ[x1, y1, z1]
        - sat_occ[x0, y1, z1]
        - sat_occ[x1, y0, z1]
        - sat_occ[x1, y1, z0]
        + sat_occ[x0, y0, z1]
        + sat_occ[x0, y1, z0]
        + sat_occ[x1, y0, z0]
        - sat_occ[x0, y0, z0]
    )
    if float((vol - in_tgt).max()) > 0.5:
        # General fallback when a brick extends outside target_occ
        placed_grid = np.zeros((g, g, g), dtype=bool)
        placed_total = 0
        placed_outside = 0
        for t in range(L):
            sub_p = placed_grid[x0[t] : x1[t], y0[t] : y1[t], z0[t] : z1[t]]
            new_p = ~sub_p
            if new_p.any():
                placed_total += int(new_p.sum())
                sub_t = target_occ[x0[t] : x1[t], y0[t] : y1[t], z0[t] : z1[t]]
                placed_outside += int((new_p & (~sub_t)).sum())
                placed_grid[x0[t] : x1[t], y0[t] : y1[t], z0[t] : z1[t]] = True
            feats[t + 1, 3] = placed_outside / float(max(placed_total, 1))

    # Fast active-band frontier loop over only the `<= 2` active y-layers (group indices by iy!)
    y_starts = np.searchsorted(cy, np.arange(g + 1))
    # Precompute max first_hit per iy layer so finding lowest non-empty layer is O(16)
    layer_max_hit = np.full(g, -1, dtype=np.int32)
    for ly in range(g):
        s0, s1 = int(y_starts[ly]), int(y_starts[ly + 1])
        if s1 > s0:
            layer_max_hit[ly] = int(first_hit[s0:s1].max())

    cur_ly = 0
    for row in range(L + 1):
        while cur_ly < g and layer_max_hit[cur_ly] < row:
            cur_ly += 1
        if cur_ly >= g:
            break
        s0 = int(y_starts[cur_ly])
        s1 = int(y_starts[min(cur_ly + 2, g)])
        m_sub = first_hit[s0:s1] >= row
        bx = wx[s0:s1][m_sub]
        by = wy[s0:s1][m_sub]
        bz = wz[s0:s1][m_sub]
        feats[row, 4] = bx.mean()
        feats[row, 5] = by.mean()
        feats[row, 6] = bz.mean()
        feats[row, 7] = bx.max() - bx.min() + vw_n
        feats[row, 8] = by.max() - by.min() + vw_n
        feats[row, 9] = bz.max() - bz.min() + vw_n
    return feats


class BlueprintProgressTracker:
    """Incremental push/pop causal frontier tracker + fast vectorized candidate scorer for inference."""

    def __init__(self, grid: np.ndarray, scale_vec: np.ndarray, g: int = BP_G):
        self.g = g
        self.grid = np.asarray(grid, dtype=np.float32)
        self.scale_vec = np.asarray(scale_vec, dtype=np.float32)
        self.cube_s = float(self.scale_vec[3])
        self.target_occ = self.grid[0] > 0.5
        coords = np.argwhere(self.target_occ)
        if len(coords) > 0:
            order = np.lexsort((coords[:, 0], coords[:, 2], coords[:, 1]))
            self.coords = coords[order].astype(np.int32)
        else:
            self.coords = np.zeros((0, 3), dtype=np.int32)
        self.M = max(len(self.coords), 1)
        self.placed_cnt = np.zeros((g, g, g), dtype=np.int32)
        self._stack: list[tuple[int, int, int, int, int, int]] = []

    def reset(self) -> None:
        self.placed_cnt.fill(0)
        self._stack.clear()

    def push(self, bbox_yup: np.ndarray) -> np.ndarray:
        """Push one placed brick's canonical Y-up bbox and return its updated `(15,)` frontier feature."""
        lo, hi = bboxes_to_voxel_ranges(bbox_yup[None], self.cube_s, g=self.g)
        box = (int(lo[0, 0]), int(lo[0, 1]), int(lo[0, 2]), int(hi[0, 0]), int(hi[0, 1]), int(hi[0, 2]))
        x0, y0, z0, x1, y1, z1 = box
        self.placed_cnt[x0:x1, y0:y1, z0:z1] += 1
        self._stack.append(box)
        return self.current_feature(last_box=box)

    def pop(self) -> None:
        if not self._stack:
            return
        x0, y0, z0, x1, y1, z1 = self._stack.pop()
        self.placed_cnt[x0:x1, y0:y1, z0:z1] -= 1

    @property
    def covered_fraction(self) -> float:
        if len(self.coords) == 0:
            return 0.0
        placed = self.placed_cnt > 0
        hit = int((placed & self.target_occ).sum())
        return hit / float(len(self.coords))

    @property
    def iou(self) -> float:
        if len(self.coords) == 0:
            return 0.0
        placed = self.placed_cnt > 0
        inter = int((placed & self.target_occ).sum())
        union = int((placed | self.target_occ).sum())
        return inter / float(max(union, 1))

    def current_feature(self, last_box: tuple[int, int, int, int, int, int] | None = None) -> np.ndarray:
        feat = np.zeros(FRONTIER_DIM, dtype=np.float32)
        if len(self.coords) == 0:
            return feat
        placed = self.placed_cnt > 0
        rem_mask = ~placed[self.coords[:, 0], self.coords[:, 1], self.coords[:, 2]]
        rem_cnt = int(rem_mask.sum())
        cov_frac = (len(self.coords) - rem_cnt) / float(len(self.coords))
        rem_frac = rem_cnt / float(len(self.coords))
        p_tot = int(placed.sum())
        p_out = int((placed & (~self.target_occ)).sum())
        ovf_frac = p_out / float(max(p_tot, 1))
        f_c, f_s = _frontier_from_remaining(self.coords, rem_mask, self.cube_s, self.g)
        if last_box is not None:
            x0, y0, z0, x1, y1, z1 = last_box
            loc = self.grid[:, x0:x1, y0:y1, z0:z1].mean(axis=(1, 2, 3))
        else:
            fx0, fy0, fz0 = int(self.coords[0, 0]), int(self.coords[0, 1]), int(self.coords[0, 2])
            loc = self.grid[:, fx0, fy0, fz0]
        feat[0] = 1.0
        feat[1] = cov_frac
        feat[2] = rem_frac
        feat[3] = ovf_frac
        feat[4:7] = f_c
        feat[7:10] = f_s
        feat[10:15] = loc
        return feat

    def score_candidates(
        self,
        bboxes_yup: np.ndarray,
        cand_rgba: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Vectorized O(N) integral-image scoring of candidate brick poses against live uncovered blueprint.

        Args:
            bboxes_yup: `(N, 6)` candidate world bboxes in canonical Y-up LDU.
            cand_rgba:  `(4,)` float32 `[r, g, b, trans]` of the candidate brick color.

        Returns:
            gain:      `(N,)` newly covered uncovered-target voxels / candidate volume (higher = better)
            spill:     `(N,)` outside-target voxels / candidate volume (higher = worse)
            color_sim: `(N,)` color + translucency agreement in `[-1, 1]` on target-overlapping voxels
        """
        n = len(bboxes_yup)
        if n == 0 or len(self.coords) == 0:
            z = np.zeros(n, dtype=np.float32)
            return z, z, z

        lo, hi = bboxes_to_voxel_ranges(bboxes_yup, self.cube_s, g=self.g)
        g = self.g
        uncovered = (self.target_occ & (self.placed_cnt == 0)).astype(np.float32)
        target_f = self.target_occ.astype(np.float32)

        # 3D summed-area tables (integral volumes) for O(1) exact box queries across all N candidates!
        def _sat3d(vol: np.ndarray) -> np.ndarray:
            s = np.pad(vol, ((1, 0), (1, 0), (1, 0)), mode="constant")
            return s.cumsum(axis=0).cumsum(axis=1).cumsum(axis=2)

        def _query(sat: np.ndarray) -> np.ndarray:
            x0, y0, z0 = lo[:, 0], lo[:, 1], lo[:, 2]
            x1, y1, z1 = hi[:, 0], hi[:, 1], hi[:, 2]
            return (
                sat[x1, y1, z1]
                - sat[x0, y1, z1]
                - sat[x1, y0, z1]
                - sat[x1, y1, z0]
                + sat[x0, y0, z1]
                + sat[x0, y1, z0]
                + sat[x1, y0, z0]
                - sat[x0, y0, z0]
            )

        vol_c = np.maximum(((hi[:, 0] - lo[:, 0]) * (hi[:, 1] - lo[:, 1]) * (hi[:, 2] - lo[:, 2])).astype(np.float32), 1.0)
        newly_cov = _query(_sat3d(uncovered))
        in_target = _query(_sat3d(target_f))
        outside = np.maximum(vol_c - in_target, 0.0)

        gain = newly_cov / vol_c
        spill = outside / vol_c

        # Color & translucency similarity on target-overlapping voxels
        cr, cg, cb, ctr = [float(v) for v in cand_rgba]
        col_diff = (
            np.abs(self.grid[1] - cr)
            + np.abs(self.grid[2] - cg)
            + np.abs(self.grid[3] - cb)
            + 1.5 * np.abs(self.grid[4] - ctr)
        ) * target_f
        sum_diff = _query(_sat3d(col_diff))
        mean_diff = np.where(in_target > 0.5, sum_diff / np.maximum(in_target, 1.0), 1.5)
        color_sim = np.where(in_target > 0.5, 1.0 - mean_diff, 0.0).astype(np.float32)
        return gain.astype(np.float32), spill.astype(np.float32), color_sim


def stb_20_to_blueprint16(occ_20: np.ndarray, g: int = BP_G) -> tuple[np.ndarray, np.ndarray]:
    """Convert a StableText2Brick `(20, 20, 20)` binary brick grid `(X, Y_horiz, Z_up)`
    into canonical aspect-preserving `(occ[G,G,G] bool, scale_vec[4] float32)` in Y-up LDU.

    Each StableText2Brick cell is a 1x1x1 brick = (20 LDU X, 20 LDU Z, 24 LDU Y_up).
    Longest horizontal axis is aligned along Z, bottom grounded at y_up = 0, centered on X/Z.
    """
    pts = np.argwhere(occ_20 > 0)  # (N, 3): (ix, iy_horiz, iz_up)
    if len(pts) == 0:
        return np.zeros((g, g, g), dtype=bool), np.array([80.0, 80.0, 80.0, 80.0], dtype=np.float32)

    # Convert to canonical Y-up LDU brick centers & bounding boxes
    x = pts[:, 0].astype(np.float32) * 20.0
    z = pts[:, 1].astype(np.float32) * 20.0
    y = pts[:, 2].astype(np.float32) * 24.0

    # Align longest horizontal axis along Z (matches canonicalize_poses!)
    if (x.max() - x.min()) > (z.max() - z.min()) + 10.0:
        x, z = z, -x

    # Ground y at 0 and center x/z on 20-LDU stud grid
    cx = round(0.5 * float(x.min() + x.max() + 20.0) / 20.0) * 20.0
    cz = round(0.5 * float(z.min() + z.max() + 20.0) / 20.0) * 20.0
    y0_min = float(y.min())
    x0 = x - cx
    z0 = z - cz
    y0 = y - y0_min

    bboxes = np.stack([x0, y0, z0, x0 + 20.0, y0 + 24.0, z0 + 20.0], axis=-1).astype(np.float32)
    scale_vec = compute_blueprint_scale(bboxes)
    lo, hi = bboxes_to_voxel_ranges(bboxes, float(scale_vec[3]), g=g)
    out = np.zeros((g, g, g), dtype=bool)
    for i in range(len(bboxes)):
        out[lo[i, 0] : hi[i, 0], lo[i, 1] : hi[i, 1], lo[i, 2] : hi[i, 2]] = True
    return out, scale_vec


def keep_largest_component_3d(occ: np.ndarray) -> np.ndarray:
    """Keep the largest 6-connected component of a `(G, G, G)` boolean occupancy mask."""
    from collections import deque

    occ = np.asarray(occ, dtype=bool)
    g0, g1, g2 = occ.shape
    visited = np.zeros_like(occ)
    best: list[tuple[int, int, int]] = []

    for x, y, z in np.argwhere(occ).tolist():
        if visited[x, y, z]:
            continue
        comp = []
        q = deque([(x, y, z)])
        visited[x, y, z] = True
        while q:
            cx, cy, cz = q.popleft()
            comp.append((cx, cy, cz))
            for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                nx, ny, nz = cx + dx, cy + dy, cz + dz
                if 0 <= nx < g0 and 0 <= ny < g1 and 0 <= nz < g2 and occ[nx, ny, nz] and not visited[nx, ny, nz]:
                    visited[nx, ny, nz] = True
                    q.append((nx, ny, nz))
        if len(comp) > len(best):
            best = comp

    out = np.zeros_like(occ)
    for x, y, z in best:
        out[x, y, z] = True
    return out


def _load_obj_mesh(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Pure-NumPy Wavefront .obj (+ optional .mtl Kd colors and per-vertex RGB) loader."""
    verts: list[list[float]] = []
    vcols: list[list[float] | None] = []
    faces: list[tuple[int, int, int]] = []
    face_cols: list[list[float] | None] = []
    mtl_colors: dict[str, list[float]] = {}
    cur_mtl: str | None = None

    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        tag = parts[0]
        if tag == "mtllib" and len(parts) >= 2:
            mp = path.parent / " ".join(parts[1:])
            if mp.exists():
                mname = None
                for ml in mp.read_text(encoding="utf-8", errors="ignore").splitlines():
                    ms = ml.strip().split()
                    if not ms:
                        continue
                    if ms[0] == "newmtl" and len(ms) >= 2:
                        mname = ms[1]
                    elif ms[0] == "Kd" and mname is not None and len(ms) >= 4:
                        try:
                            mtl_colors[mname] = [float(ms[1]), float(ms[2]), float(ms[3])]
                        except ValueError:
                            pass
        elif tag == "usemtl" and len(parts) >= 2:
            cur_mtl = parts[1]
        elif tag == "v" and len(parts) >= 4:
            verts.append([float(parts[1]), float(parts[2]), float(parts[3])])
            if len(parts) >= 7:
                vcols.append([float(parts[4]), float(parts[5]), float(parts[6])])
            else:
                vcols.append(None)
        elif tag == "f" and len(parts) >= 4:
            idxs = []
            for tok in parts[1:]:
                vi = int(tok.split("/")[0])
                idxs.append(vi - 1 if vi > 0 else len(verts) + vi)
            fc = mtl_colors.get(cur_mtl) if cur_mtl else None
            for k in range(1, len(idxs) - 1):
                faces.append((idxs[0], idxs[k], idxs[k + 1]))
                face_cols.append(fc)

    if not verts or not faces:
        raise ValueError(f"Empty or invalid OBJ mesh: {path}")
    v_arr = np.asarray(verts, dtype=np.float32)
    f_arr = np.asarray(faces, dtype=np.int64)
    has_vc = all(c is not None for c in vcols)
    if has_vc:
        vc_arr = np.clip(np.asarray(vcols, dtype=np.float32), 0.0, 1.0)
        tri_cols = (vc_arr[f_arr[:, 0]] + vc_arr[f_arr[:, 1]] + vc_arr[f_arr[:, 2]]) / 3.0
    elif any(c is not None for c in face_cols):
        tri_cols = np.asarray([c if c is not None else [0.62, 0.62, 0.62] for c in face_cols], dtype=np.float32)
    else:
        tri_cols = None
    return v_arr, f_arr, tri_cols


def _load_stl_mesh(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Pure-NumPy ASCII and binary STL loader."""
    import struct

    raw = path.read_bytes()
    if len(raw) >= 84:
        n_tris = struct.unpack_from("<I", raw, 80)[0]
        if 84 + n_tris * 50 == len(raw) and n_tris > 0:
            dt = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
            data = np.frombuffer(raw, dtype=dt, offset=84, count=n_tris)
            v_arr = data["v"].reshape(-1, 3).astype(np.float32)
            f_arr = np.arange(len(v_arr), dtype=np.int64).reshape(-1, 3)
            return v_arr, f_arr, None

    verts = []
    for line in raw.decode("utf-8", errors="ignore").splitlines():
        s = line.strip().split()
        if len(s) >= 4 and s[0].lower() == "vertex":
            verts.append([float(s[1]), float(s[2]), float(s[3])])
    if len(verts) < 3:
        raise ValueError(f"Empty or invalid STL mesh: {path}")
    n3 = (len(verts) // 3) * 3
    v_arr = np.asarray(verts[:n3], dtype=np.float32)
    f_arr = np.arange(n3, dtype=np.int64).reshape(-1, 3)
    return v_arr, f_arr, None


def _load_ply_mesh(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Pure-NumPy ASCII PLY mesh loader (with optional RGB vertex colors)."""
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    n_verts = 0
    n_faces = 0
    v_props: list[str] = []
    in_vert = False
    hdr_end = 0
    for i, line in enumerate(lines):
        s = line.strip().split()
        if not s:
            continue
        if s[0] == "format" and len(s) >= 2 and s[1] != "ascii":
            raise ValueError(f"Only ASCII PLY is supported natively (got {s[1]}): {path}")
        if s[0] == "element":
            in_vert = s[1] == "vertex"
            if s[1] == "vertex":
                n_verts = int(s[2])
            elif s[1] == "face":
                n_faces = int(s[2])
        elif s[0] == "property" and in_vert:
            v_props.append(s[-1].lower())
        elif s[0] == "end_header":
            hdr_end = i + 1
            break
    if n_verts <= 0:
        raise ValueError(f"No vertices in PLY: {path}")
    ix = v_props.index("x") if "x" in v_props else 0
    iy = v_props.index("y") if "y" in v_props else 1
    iz = v_props.index("z") if "z" in v_props else 2
    has_rgb = all(k in v_props for k in ("red", "green", "blue"))
    ir = v_props.index("red") if has_rgb else -1
    ig = v_props.index("green") if has_rgb else -1
    ib = v_props.index("blue") if has_rgb else -1

    verts = np.zeros((n_verts, 3), dtype=np.float32)
    vcols = np.zeros((n_verts, 3), dtype=np.float32) if has_rgb else None
    for i in range(n_verts):
        toks = lines[hdr_end + i].split()
        verts[i] = [float(toks[ix]), float(toks[iy]), float(toks[iz])]
        if vcols is not None:
            rgb = np.array([float(toks[ir]), float(toks[ig]), float(toks[ib])], dtype=np.float32)
            vcols[i] = rgb / 255.0 if rgb.max() > 1.0 else rgb

    faces: list[tuple[int, int, int]] = []
    for i in range(n_faces):
        if hdr_end + n_verts + i >= len(lines):
            break
        toks = lines[hdr_end + n_verts + i].split()
        cnt = int(toks[0])
        idxs = [int(x) for x in toks[1 : 1 + cnt]]
        for k in range(1, len(idxs) - 1):
            faces.append((idxs[0], idxs[k], idxs[k + 1]))

    if not faces:
        # Point-cloud fallback: degenerate tiny triangles at vertices
        f_arr = np.stack([np.arange(n_verts), np.arange(n_verts), np.arange(n_verts)], axis=-1).astype(np.int64)
    else:
        f_arr = np.asarray(faces, dtype=np.int64)
    tri_cols = None
    if vcols is not None:
        tri_cols = (vcols[f_arr[:, 0]] + vcols[f_arr[:, 1]] + vcols[f_arr[:, 2]]) / 3.0
    return verts, f_arr, tri_cols


def _fill_interior_voxels_3d(shell: np.ndarray) -> np.ndarray:
    """Fill enclosed interior cavities of a `(G, G, G)` boolean surface shell via exterior 6-connected flood fill."""
    from collections import deque

    g0, g1, g2 = shell.shape
    padded = np.zeros((g0 + 2, g1 + 2, g2 + 2), dtype=bool)
    padded[1:-1, 1:-1, 1:-1] = shell
    ext = np.zeros_like(padded)
    q = deque([(0, 0, 0)])
    ext[0, 0, 0] = True
    while q:
        x, y, z = q.popleft()
        for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            nx, ny, nz = x + dx, y + dy, z + dz
            if 0 <= nx < g0 + 2 and 0 <= ny < g1 + 2 and 0 <= nz < g2 + 2:
                if not padded[nx, ny, nz] and not ext[nx, ny, nz]:
                    ext[nx, ny, nz] = True
                    q.append((nx, ny, nz))
    return ~ext[1:-1, 1:-1, 1:-1]


def mesh_to_blueprint(
    mesh_path: str | Path,
    g: int = BP_G,
    target_span_ldu: float = 240.0,
    up_axis: str = "y",
    default_rgb: tuple[float, float, float] = (0.62, 0.62, 0.62),
    fill_interior: bool = True,
    n_samples: int = 36_000,
    seed: int = 0,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Convert any external 3D triangle mesh (`.obj`, `.stl`, `.ply` from TRELLIS/Hunyuan3D/Blender)
    into a canonical `(grid[5, G, G, G], scale_vec[4], n_tris)` BrickGen v3 colored 3D blueprint!
    """
    p = Path(mesh_path)
    ext = p.suffix.lower()
    if ext == ".obj":
        verts, faces, tri_cols = _load_obj_mesh(p)
    elif ext == ".stl":
        verts, faces, tri_cols = _load_stl_mesh(p)
    elif ext == ".ply":
        verts, faces, tri_cols = _load_ply_mesh(p)
    else:
        raise ValueError(f"Unsupported mesh format '{ext}'. Supported: .obj, .stl, .ply")

    v = verts.astype(np.float64).copy()
    if up_axis.lower() == "z":
        # Map Z-up (x, y, z) -> Y-up (x, z, -y)
        v = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=-1)

    # Align longest horizontal axis along Z (matches BrickGen canonical frame)
    lo0, hi0 = v.min(axis=0), v.max(axis=0)
    span0 = np.maximum(hi0 - lo0, 1e-6)
    if span0[0] > span0[2] * 1.05:
        v = np.stack([v[:, 2], v[:, 1], -v[:, 0]], axis=-1)
        lo0, hi0 = v.min(axis=0), v.max(axis=0)
        span0 = np.maximum(hi0 - lo0, 1e-6)

    # Scale cleanly into LEGO LDU with bottom at y_up=0 and centered X/Z
    scale_f = float(target_span_ldu) / float(span0.max())
    cx = 0.5 * (lo0[0] + hi0[0])
    cz = 0.5 * (lo0[2] + hi0[2])
    v[:, 0] = (v[:, 0] - cx) * scale_f
    v[:, 1] = (v[:, 1] - lo0[1]) * scale_f
    v[:, 2] = (v[:, 2] - cz) * scale_f

    lo, hi = v.min(axis=0), v.max(axis=0)
    span = np.maximum(hi - lo, 20.0)
    cube_s = max(2.0 * max(abs(float(lo[0])), abs(float(hi[0]))), float(hi[1]), 2.0 * max(abs(float(lo[2])), abs(float(hi[2]))), 80.0)
    scale_vec = np.array([float(span[0]), float(span[1]), float(span[2]), float(cube_s)], dtype=np.float32)

    # Uniform area-weighted surface point sampling across all triangles
    v0 = v[faces[:, 0]]
    v1 = v[faces[:, 1]]
    v2 = v[faces[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=-1)
    area_sum = float(areas.sum())
    rng = np.random.default_rng(seed)
    if area_sum > 1e-9:
        probs = areas / area_sum
        tri_idx = rng.choice(len(faces), size=n_samples, p=probs)
        r1 = np.sqrt(rng.random(n_samples))[:, None]
        r2 = rng.random(n_samples)[:, None]
        pts = (1.0 - r1) * v0[tri_idx] + (r1 * (1.0 - r2)) * v1[tri_idx] + (r1 * r2) * v2[tri_idx]
        # Also include all triangle vertices so sharp corners never drop out
        pts = np.concatenate([pts, v], axis=0)
        if tri_cols is not None:
            pcols = np.concatenate([tri_cols[tri_idx], np.tile(np.asarray(default_rgb, dtype=np.float32), (len(v), 1))], axis=0)
        else:
            pcols = None
    else:
        pts = v
        pcols = None

    ix = np.clip(np.floor((pts[:, 0] / cube_s + 0.5) * g).astype(np.int32), 0, g - 1)
    iy = np.clip(np.floor((pts[:, 1] / cube_s) * g).astype(np.int32), 0, g - 1)
    iz = np.clip(np.floor((pts[:, 2] / cube_s + 0.5) * g).astype(np.int32), 0, g - 1)

    shell = np.zeros((g, g, g), dtype=bool)
    shell[ix, iy, iz] = True
    occ = _fill_interior_voxels_3d(shell) if fill_interior else shell
    occ = keep_largest_component_3d(occ)

    grid = np.zeros((BP_CH, g, g, g), dtype=np.float32)
    grid[0] = occ.astype(np.float32)
    def_rgb = np.asarray(default_rgb, dtype=np.float32)
    if pcols is not None:
        csum = np.zeros((3, g, g, g), dtype=np.float32)
        ccnt = np.zeros((g, g, g), dtype=np.float32)
        for k in range(3):
            np.add.at(csum[k], (ix, iy, iz), pcols[:, k])
        np.add.at(ccnt, (ix, iy, iz), 1.0)
        mean_rgb = np.where(ccnt[None] > 0, csum / np.maximum(ccnt[None], 1.0), def_rgb[:, None, None, None])
        # Propagate surface color inward to interior filled voxels using mean surface color
        surf_mean = pcols.mean(axis=0) if len(pcols) else def_rgb
        interior_only = occ & (ccnt == 0)
        for k in range(3):
            mean_rgb[k][interior_only] = surf_mean[k]
        grid[1:4] = np.where(occ[None], np.clip(mean_rgb, 0.0, 1.0), 0.0)
    else:
        for k in range(3):
            grid[1 + k] = np.where(occ, def_rgb[k], 0.0)
    return grid, scale_vec, len(faces)


def render_blueprint_preview(
    grid: np.ndarray,
    out_path: str | Path | None = None,
    size: int = 256,
) -> Image.Image:
    """Render a crisp 3-view (Isometric 3/4, Side, Top) preview image of a `(5, G, G, G)` colored blueprint."""
    occ = grid[0] > 0.5
    rgb = np.clip(grid[1:4], 0.0, 1.0)
    tr = np.clip(grid[4], 0.0, 1.0)
    # Tint translucent voxels slightly bright cyan-white so windshields/lights pop visually
    vis_rgb = rgb * (1.0 - 0.35 * tr[None]) + np.array([0.70, 0.90, 1.0], dtype=np.float32)[:, None, None, None] * (
        0.35 * tr[None]
    )
    g = occ.shape[0]

    def _ortho(axis: int, flip_v: bool = True) -> np.ndarray:
        canvas = np.full((g, g, 3), 0.94, dtype=np.float32)
        for d in range(g):
            if axis == 0:  # Side view (+X looking toward -X): rows=Y, cols=Z
                sl_o = occ[d, :, :]
                sl_c = vis_rgb[:, d, :, :].transpose(1, 2, 0)
            elif axis == 2:  # Front view (+Z looking toward -Z): rows=Y, cols=X
                sl_o = occ[:, :, d].T
                sl_c = vis_rgb[:, :, :, d].transpose(2, 1, 0)
            else:  # Top view (+Y looking down): rows=Z, cols=X
                sl_o = occ[:, d, :].T
                sl_c = vis_rgb[:, :, d, :].transpose(2, 1, 0)
            shade = 0.72 + 0.28 * (d / max(g - 1, 1))
            canvas[sl_o] = sl_c[sl_o] * shade
        if flip_v:
            canvas = canvas[::-1]
        return canvas

    def _iso() -> np.ndarray:
        # Painter's algorithm isometric projection (camera looking from (+X, +Y, +Z))
        scale = max(6, size // (2 * g + 4))
        w_img = int(g * 2.2 * scale)
        h_img = int(g * 2.4 * scale)
        img = np.full((h_img, w_img, 3), 0.94, dtype=np.float32)
        ox = w_img // 2
        oy = int(h_img * 0.78)
        # Back-to-front depth order: x + z + y ascending
        pts = np.argwhere(occ)
        if len(pts) > 0:
            depth = pts[:, 0] + pts[:, 2] + pts[:, 1]
            pts = pts[np.argsort(depth)]
            r = max(2, int(scale * 0.65))
            for ix, iy, iz in pts.tolist():
                px = int(ox + (ix - iz) * scale * 0.86)
                py = int(oy - (ix + iz) * scale * 0.43 - iy * scale * 0.95)
                col = vis_rgb[:, ix, iy, iz]
                y0, y1 = max(0, py - r), min(h_img, py + r)
                x0, x1 = max(0, px - r), min(w_img, px + r)
                if y1 > y0 and x1 > x0:
                    img[y0:y1, x0:x1] = col
                    # Subtle top highlight & dark border
                    img[y0 : min(y0 + max(1, r // 2), y1), x0:x1] = np.clip(col * 1.15, 0, 1)
                    img[y1 - 1, x0:x1] *= 0.65
                    img[y0:y1, x1 - 1] *= 0.75
        return img

    p_iso = Image.fromarray((np.clip(_iso(), 0, 1) * 255).astype(np.uint8)).resize((size, size), Image.Resampling.NEAREST)
    p_side = Image.fromarray((np.clip(_ortho(0), 0, 1) * 255).astype(np.uint8)).resize((size, size), Image.Resampling.NEAREST)
    p_front = Image.fromarray((np.clip(_ortho(2), 0, 1) * 255).astype(np.uint8)).resize((size, size), Image.Resampling.NEAREST)
    p_top = Image.fromarray((np.clip(_ortho(1, flip_v=False), 0, 1) * 255).astype(np.uint8)).resize((size, size), Image.Resampling.NEAREST)

    sheet = Image.new("RGB", (size * 4 + 12, size + 8), (235, 238, 242))
    for i, im in enumerate((p_iso, p_side, p_front, p_top)):
        sheet.paste(im, (4 + i * (size + 2), 4))
    if out_path is not None:
        out_p = Path(out_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(out_p)
    return sheet
