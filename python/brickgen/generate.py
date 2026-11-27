"""Geometry-Grounded Text-to-LEGO Generator (v2) using BrickGen + Native C++ libbmcore Solver.

Decoder v2 features:
  1. BrickGen predicts P(part), P(color | part), and Pointer Attention P(parent | part, color)
     with Classifier-Free Guidance (CFG) over full 77-token CLIP text cross-attention.
  2. Native C++ BrickGenNative (`libbmcore`) enumerates ALL exact mated, exact triangle-triangle
     collision-free poses on the top predicted parent hosts in ~1-3 ms.
  3. 3D collinear chain guard + compactness regularizer prevents degenerate 1D vertical/horizontal
     rods while preserving intentional tall towers or wide wings.
  4. Native bilateral symmetry pairing (`--symmetric auto|on|off`): when placing an off-center brick
     in a symmetric build (car, jet, tower, house, BrickHeadz), immediately checks if `libbmcore`
     has a legal, 0-overlap, connector-mated mirrored counterpart across X = 0 (swapping chiral L/R
     wedge/wing parts automatically) and commits the pair together so both sides stay symmetric.
  5. Best-of-N reranking combines `overlaps == 0`, `groups == 1`, `bm::stable::check` physical
     stability, 3D compactness, and Metal `bmshot --studio` multi-view CLIP Vision alignment.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from .blueprint import (
    BP_G,
    FRONTIER_DIM,
    BlueprintProgressTracker,
    build_color_rgba_lut,
    compute_blueprint_scale,
    encode_scale_vec,
    load_ldraw_color_rgba,
    mesh_to_blueprint,
    rasterize_blueprint,
    render_blueprint_preview,
)
from .clip_encoder import ClipEncoder
from .geometry import (
    ROT24,
    canonicalize_poses,
    dequantize_abs,
    ldraw_bbox_to_yup,
    mirror_matrix_x,
    nearest_rot24,
    quantize_abs,
    quantize_rel,
    rotmat_to_6d,
    world_bbox_from_local,
)
from .model import (
    ABS_XZ_BINS,
    ABS_Y_BINS,
    BOS_ID,
    EOS_ID,
    PART_OFFSET,
    ROT24_NONE,
)
from .native import ROOT, BrickGenNative, CheckResult
from .train import auto_device, load_checkpoint
from .train_blueprint import load_blueprint_checkpoint

BMSHOT = ROOT / "native/build/render/bmshot"
CATALOG_PATH = ROOT / "public/data/catalog.json"
SOURCE_MAP = {"any": 0, "bricknet": 1, "omr": 2, "moc": 3, "brickheadz": 4}
SCALE_MAP = {"auto": 0, "tiny": 1, "small": 2, "medium": 3, "large": 4, "xl": 5}

SYMMETRIC_PROMPT_RE = re.compile(
    r"\b(car|truck|vehicle|van|bus|jeep|racer|f1|formula|jet|plane|fighter|starfighter|spaceship|"
    r"ship|boat|yacht|tower|castle|house|cottage|building|church|temple|bridge|train|locomotive|"
    r"robot|mech|brickheadz|figure|character|hero|animal|dog|cat|bird|dragon|tank|helicopter|rover)\b",
    re.IGNORECASE,
)
ELONGATED_PROMPT_RE = re.compile(
    r"\b(tower|lighthouse|skyscraper|spire|bridge|train|sword|lightsaber|wand|staff|pole|crane|rocket|missile)\b",
    re.IGNORECASE,
)


def _discover_mirror_map(vocab_parts: list[str], existing: dict[str, str] | None = None) -> dict[str, str]:
    """Build L/R chiral part mirror lookup limited to parts in `vocab_parts`."""
    allowed = set(vocab_parts)
    out: dict[str, str] = {}
    if existing:
        for a, b in existing.items():
            if a in allowed and b in allowed:
                out[a] = b
                out[b] = a
    if CATALOG_PATH.exists():
        try:
            cat = json.loads(CATALOG_PATH.read_text())
            by_norm: dict[str, dict[str, str]] = {}
            for item in cat:
                name = str(item.get("name", ""))
                nl = name.lower()
                if " left" not in nl and " right" not in nl:
                    continue
                pid = str(item.get("id", "")).lower()
                if pid not in allowed:
                    continue
                key = re.sub(r"\b(left|right)\b", "<SIDE>", nl)
                side = "L" if " left" in nl else "R"
                by_norm.setdefault(key, {})[side] = pid
            for pair in by_norm.values():
                if "L" in pair and "R" in pair:
                    out.setdefault(pair["L"], pair["R"])
                    out.setdefault(pair["R"], pair["L"])
        except Exception:
            pass
    # Essential wedge/wing pairs fallback
    for a, b in [
        ("24299", "24307"), ("43723", "43722"), ("43723a", "43722a"),
        ("41770", "41769"), ("41770a", "41769a"), ("54384", "54383"),
        ("48208", "48205"), ("47397", "47398"), ("5091", "5092"),
        ("30355", "30356"), ("43710", "43711"), ("41748", "41747"),
        ("41764", "41765"), ("6564", "6565"), ("29119", "29120"),
    ]:
        if a in allowed and b in allowed:
            out.setdefault(a, b)
            out.setdefault(b, a)
    return out


@dataclass
class GeneratedModel:
    prompt: str
    stems: list[str]
    colors: list[int]
    matrices: list[np.ndarray]
    check: CheckResult
    seconds: float
    rollbacks: int
    clip_score: float | None = None
    image_score: float | None = None
    mirrored_pairs: int = 0
    pruned_outliers: int = 0
    aspect_ratio: float = 1.0
    blueprint_iou: float | None = None
    blueprint_cov: float | None = None
    blueprint_grid: np.ndarray | None = None

    def to_ldr(self, title: str = "BrickGen Model") -> str:
        lines = [
            f"0 {title}",
            f"0 Name: {title}.ldr",
            "0 Author: BrickGen (BrickMotion Studio); trained on BrickNet (Kulits & Schmid, CVPR 2026), LDraw OMR (CC BY 2.0/4.0), and local MOCs",
            f"0 // Prompt: {self.prompt}",
            f"0 // Verified by libbmcore: pieces={self.check.pieces} overlaps={self.check.overlaps} groups={self.check.groups} stands={self.check.stands}",
        ]
        for idx, (stem, col, m) in enumerate(zip(self.stems, self.colors, self.matrices)):
            nums = " ".join(f"{round(float(v), 4) + 0.0:g}" for v in [*m[:3, 3], *m[:3, :3].flat])
            lines.append(f"1 {int(col)} {nums} {stem}.dat")
            if (idx + 1) % 6 == 0 and idx + 1 < len(self.stems):
                lines.append("0 STEP")
        lines.append("0 NOFILE")
        return "\n".join(lines) + "\n"


def _sample_from_logits(
    logits: np.ndarray,
    rng: np.random.Generator,
    temp: float = 0.85,
    top_k: int = 24,
    top_p: float = 0.92,
) -> int:
    if len(logits) == 0:
        raise ValueError("empty logits")
    if temp <= 1e-4 or len(logits) == 1:
        return int(np.argmax(logits))
    x = logits.astype(np.float64) / temp
    k = min(top_k, len(x)) if top_k > 0 else len(x)
    order = np.argsort(-x)[:k]
    p = np.exp(x[order] - x[order[0]])
    p /= p.sum()
    if 0.0 < top_p < 1.0:
        keep = int(np.searchsorted(np.cumsum(p), top_p)) + 1
        order = order[:keep]
        p = p[:keep] / p[:keep].sum()
    return int(order[rng.choice(len(order), p=p)])


def render_with_bmshot(
    ldr_text: str,
    size: int = 384,
    views: tuple[tuple[float, float], ...] = ((0.65, 0.42), (3.79, 0.42)),
) -> list[np.ndarray]:
    """Render photorealistic multi-view images via BrickMotion's native Metal `bmshot` binary (angles in radians)."""
    if not BMSHOT.exists():
        return []
    imgs = []
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        ldr_path = tdp / "model.ldr"
        ldr_path.write_text(ldr_text)
        for vi, (az, el) in enumerate(views):
            out_png = tdp / f"v{vi}.png"
            cmd = [
                str(BMSHOT),
                str(ldr_path),
                "--out",
                str(out_png),
                "--size",
                f"{size}x{size}",
                "--azimuth",
                str(az),
                "--elevation",
                str(el),
                "--studio",
                "--no-floor",
            ]
            res = subprocess.run(cmd, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if res.returncode == 0 and out_png.exists():
                im = Image.open(out_png).convert("RGB")
                imgs.append(np.asarray(im, dtype=np.float32) / 255.0)
    return imgs


class BrickGenerator:
    """High-level generator pairing Stage-1 BlueprintFlow3D + Stage-2 BrickGen + native C++ libbmcore."""

    def __init__(
        self,
        checkpoint: str | Path,
        blueprint_ckpt: str | Path | None = None,
        device: str | None = None,
        load_vision: bool = False,
        use_studio: bool = True,
    ):
        self.dev = device or auto_device()
        self.model, self.vocab, self.info = load_checkpoint(checkpoint, device=self.dev)
        self.bp_model = None
        if blueprint_ckpt is not None:
            self.bp_model, _ = load_blueprint_checkpoint(blueprint_ckpt, device=self.dev)
        self.parts: list[str] = self.vocab["parts"]
        self.part_to_tok: dict[str, int] = {s: i + PART_OFFSET for i, s in enumerate(self.parts)}
        self.part_bboxes = np.array(self.vocab["part_bboxes"], dtype=np.float32)
        raw_conns = self.vocab.get("part_conns")
        if raw_conns is not None and len(raw_conns) == len(self.parts):
            self.part_conns = np.array(raw_conns, dtype=np.int32)
        else:
            self.part_conns = np.full(len(self.parts), 16, dtype=np.int32)
        self.colors: list[int] = [int(c) for c in self.vocab["colors"]]
        self.color_rgba_lut = build_color_rgba_lut(self.vocab)
        self.mirror_map = _discover_mirror_map(self.parts, self.vocab.get("mirror_map"))
        self.clip = ClipEncoder(device=self.dev, load_vision=load_vision)
        self.native = BrickGenNative(use_studio=use_studio)

    def _ensure_vision_loaded(self) -> None:
        if self.clip.vision_model is None:
            self.clip = ClipEncoder(device=self.dev, load_vision=True)

    @torch.no_grad()
    def encode_image_ref(self, image_path: str | Path) -> np.ndarray:
        """Encode a reference image into an L2-normalized `(512,)` CLIP Vision vector in the shared text-image space."""
        self._ensure_vision_loaded()
        im = Image.open(image_path).convert("RGB")
        arr = np.asarray(im, dtype=np.float32) / 255.0
        vec = self.clip.encode_images([arr])[0]
        return vec.astype(np.float32)

    @staticmethod
    def _blend_clip_pool(
        text_pool: torch.Tensor,
        image_pool: np.ndarray | None,
        image_weight: float,
    ) -> torch.Tensor:
        if image_pool is None or image_weight <= 1e-4:
            return text_pool
        w = float(np.clip(image_weight, 0.0, 1.0))
        iv = torch.from_numpy(np.asarray(image_pool, dtype=np.float32)).to(text_pool.device)
        if iv.ndim == 1:
            iv = iv.unsqueeze(0)
        iv = iv.expand_as(text_pool)
        blended = (1.0 - w) * text_pool.float() + w * iv.float()
        return F.normalize(blended, dim=-1).to(text_pool.dtype)

    @torch.no_grad()
    def sample_blueprint(
        self,
        prompt: str,
        style: str = "any",
        scale: str = "auto",
        symmetric: bool = True,
        n_steps: int = 32,
        cfg_scale: float = 3.2,
        n_candidates: int = 4,
        image_pool: np.ndarray | None = None,
        image_weight: float = 0.55,
        seed: int = 0,
    ) -> tuple[np.ndarray, np.ndarray, int]:
        """Generate a batch of 16x16x16x5 colored 3D blueprints via Stage-1 and select the best-formed silhouette."""
        if self.bp_model is None:
            raise RuntimeError("No Stage-1 blueprint checkpoint loaded (`blueprint_ckpt=None`).")
        k = max(1, int(n_candidates))
        ids_np, lens_np = self.clip.tokenize([prompt] * k)
        L = max(int(lens_np[0]), 2)
        tt, tp = self.clip.encode_token_ids(torch.from_numpy(ids_np[:, :L]))
        tp = self._blend_clip_pool(tp, image_pool, image_weight)
        tm = torch.ones((k, L), dtype=torch.bool, device=self.dev)
        src_t = torch.full((k,), SOURCE_MAP.get(style, 0), dtype=torch.long, device=self.dev)
        scl_t = torch.full((k,), SCALE_MAP.get(scale, 0), dtype=torch.long, device=self.dev)
        grids, scales, est = self.bp_model.sample(
            tp, tt, tm, src_t, scl_t, n_steps=n_steps, cfg_scale=cfg_scale, symmetric=symmetric, seed=seed
        )
        # Prefer well-formed silhouettes in realistic LEGO occupancy band [240, 1450] voxels (avoids empty specks & bloated cubes)
        best_i = 0
        best_pen = 1e9
        for i in range(k):
            occ = int((grids[i, 0] > 0.5).sum())
            if occ < 240:
                pen = (240 - occ) * 4.0
            elif occ > 1450:
                pen = (occ - 1450) * 1.5
            else:
                pen = abs(occ - 750) * 0.1
            if pen < best_pen:
                best_pen = pen
                best_i = i
        return grids[best_i], scales[best_i], est[best_i]

    def extract_blueprint_from_mesh(
        self,
        mesh_path: str | Path,
        span_studs: float = 12.0,
        up_axis: str = "y",
    ) -> tuple[np.ndarray, np.ndarray, int]:
        """Voxelize any external 3D triangle mesh (.obj/.stl/.ply from TRELLIS/Hunyuan3D/Blender) into a 16^3x5 blueprint."""
        return mesh_to_blueprint(mesh_path, g=BP_G, target_span_ldu=float(span_studs) * 20.0, up_axis=up_axis)

    def extract_blueprint_from_file(self, path: str | Path) -> tuple[np.ndarray, np.ndarray, int]:
        """Extract a canonical 16x16x16x5 colored 3D blueprint directly from any `.ldr`/`.mpd`/`.io` model."""
        data = self.native.load_model(path, check_overlaps=False, check_stability=False)
        if not data.get("ok") or data.get("n_pieces", 0) == 0:
            raise RuntimeError(f"Could not load model for blueprint extraction: {path}")
        pieces = data["pieces"]
        mats = np.array([p["matrix"] for p in pieces], dtype=np.float64).reshape(-1, 4, 4)
        lb = np.array([p["local_bbox"] for p in pieces], dtype=np.float32)
        _, wb_ld = canonicalize_poses(mats, lb, force_upright=True)
        wb_yup = ldraw_bbox_to_yup(wb_ld)
        cmap = load_ldraw_color_rgba()
        # Map each piece's color into a temporary RGBA LUT
        uniq_c = sorted({int(p["color"]) for p in pieces})
        c_to_i = {c: i for i, c in enumerate(uniq_c)}
        lut = np.array([cmap.get(c, (0.62, 0.62, 0.62, 0.0)) for c in uniq_c], dtype=np.float32)
        cids = np.array([c_to_i[int(p["color"])] for p in pieces], dtype=np.int64)
        sv = compute_blueprint_scale(wb_yup)
        grid, sv = rasterize_blueprint(wb_yup, cids, lut, scale_vec=sv, g=BP_G)
        return grid, sv, len(pieces)

    def _prepare_memory(
        self,
        prompt: str,
        style: str,
        scale: str,
        cfg_scale: float,
        cfg_shape: float = 1.0,
        bp_grid: np.ndarray | None = None,
        bp_scale: np.ndarray | None = None,
        image_pool: np.ndarray | None = None,
        image_weight: float = 0.55,
    ):
        ids_np, lens_np = self.clip.tokenize([prompt])
        L = max(int(lens_np[0]), 2)
        ids_t = torch.from_numpy(ids_np[:, :L])
        text_toks, text_pool = self.clip.encode_token_ids(ids_t)
        text_pool = self._blend_clip_pool(text_pool, image_pool, image_weight)
        text_mask = torch.ones((1, L), dtype=torch.bool, device=self.dev)

        src_t = torch.tensor([SOURCE_MAP.get(style, 0)], dtype=torch.long, device=self.dev)
        scl_t = torch.tensor([SCALE_MAP.get(scale, 0)], dtype=torch.long, device=self.dev)

        has_bp = bool(self.model.cfg.use_blueprint and bp_grid is not None and bp_scale is not None)
        use_dual_cfg = has_bp and (cfg_scale > 1.0 + 1e-4 or cfg_shape > 1.0 + 1e-4)
        use_text_cfg = (not has_bp) and (cfg_scale > 1.0 + 1e-4)

        if use_dual_cfg:
            # Slot 0: text + blueprint | Slot 1: text only | Slot 2: unconditional
            bpg_t = torch.from_numpy(bp_grid).to(self.dev).unsqueeze(0).repeat(3, 1, 1, 1, 1)
            bps_t = torch.from_numpy(encode_scale_vec(bp_scale)).to(self.dev).unsqueeze(0).repeat(3, 1)
            mem, mem_mask = self.model.build_memory(
                text_pool.repeat(3, 1),
                text_toks.repeat(3, 1, 1),
                text_mask.repeat(3, 1),
                torch.cat([src_t, src_t, torch.zeros_like(src_t)], dim=0),
                torch.cat([scl_t, scl_t, torch.zeros_like(scl_t)], dim=0),
                drop_text_mask=torch.tensor([False, False, True], dtype=torch.bool, device=self.dev),
                bp_grid=bpg_t,
                bp_scale=bps_t,
                drop_bp_mask=torch.tensor([False, True, True], dtype=torch.bool, device=self.dev),
            )
            mode = "dual_cfg"
        elif use_text_cfg:
            mem, mem_mask = self.model.build_memory(
                text_pool.repeat(2, 1),
                text_toks.repeat(2, 1, 1),
                text_mask.repeat(2, 1),
                torch.cat([src_t, torch.zeros_like(src_t)], dim=0),
                torch.cat([scl_t, torch.zeros_like(scl_t)], dim=0),
                drop_text_mask=torch.tensor([False, True], dtype=torch.bool, device=self.dev),
            )
            mode = "text_cfg"
        else:
            bpg_t = torch.from_numpy(bp_grid).to(self.dev).unsqueeze(0) if has_bp else None
            bps_t = torch.from_numpy(encode_scale_vec(bp_scale)).to(self.dev).unsqueeze(0) if has_bp else None
            mem, mem_mask = self.model.build_memory(
                text_pool, text_toks, text_mask, src_t, scl_t, bp_grid=bpg_t, bp_scale=bps_t
            )
            mode = "single"
        return mem, mem_mask, mode, text_pool[0].float().cpu().numpy()

    @torch.no_grad()
    def generate_one(
        self,
        prompt: str,
        style: str = "any",
        scale: str = "auto",
        min_parts: int = 8,
        max_parts: int = 80,
        cfg_scale: float = 2.5,
        cfg_shape: float = 2.2,
        bp_score_weight: float = 1.8,
        bp_grid: np.ndarray | None = None,
        bp_scale: np.ndarray | None = None,
        image_pool: np.ndarray | None = None,
        image_weight: float = 0.55,
        temp: float = 0.90,
        pose_temp: float = 0.70,
        top_k_parts: int = 18,
        top_hosts: int = 16,
        fine_angles: bool = False,
        max_rollbacks: int = 15,
        chain_penalty: float = 2.2,
        symmetric: str = "auto",
        prune_outliers: bool = True,
        mega_host_conn_limit: int = 120,
        seed: int = 0,
    ) -> GeneratedModel:
        t0 = time.time()
        rng = np.random.default_rng(seed)
        max_parts = min(max_parts, self.model.cfg.max_bricks)

        use_sym = (symmetric == "on") or (symmetric == "auto" and bool(SYMMETRIC_PROMPT_RE.search(prompt)))
        allow_elongated = bool(ELONGATED_PROMPT_RE.search(prompt))

        # Auto-sample a Stage-1 3D blueprint when Stage-1 model is loaded and none was passed
        if bp_grid is None and self.bp_model is not None:
            bp_grid, bp_scale, _ = self.sample_blueprint(
                prompt,
                style=style,
                scale=scale,
                symmetric=use_sym,
                image_pool=image_pool,
                image_weight=image_weight,
                seed=seed,
            )

        tracker = BlueprintProgressTracker(bp_grid, bp_scale, g=BP_G) if (bp_grid is not None and bp_scale is not None) else None
        mem, mem_mask, cfg_mode, _ = self._prepare_memory(
            prompt,
            style,
            scale,
            cfg_scale,
            cfg_shape=cfg_shape,
            bp_grid=bp_grid,
            bp_scale=bp_scale,
            image_pool=image_pool,
            image_weight=image_weight,
        )
        bsz = 3 if cfg_mode == "dual_cfg" else (2 if cfg_mode == "text_cfg" else 1)
        self.native.reset()

        seq_part = [BOS_ID]
        seq_color = [0]
        seq_rot24 = [ROT24_NONE]
        seq_ax = [ABS_XZ_BINS]
        seq_ay = [ABS_Y_BINS]
        seq_az = [ABS_XZ_BINS]
        seq_xyz = [np.zeros(3, dtype=np.float32)]
        seq_rot6d = [np.zeros(6, dtype=np.float32)]
        seq_bbox = [np.zeros(6, dtype=np.float32)]
        seq_frontier = [
            tracker.current_feature(last_box=None) if tracker is not None else np.zeros(FRONTIER_DIM, dtype=np.float32)
        ]

        stems_out: list[str] = []
        colors_out: list[int] = []
        mats_out: list[np.ndarray] = []
        # Track recent step directions, hosts, connector counts, and mate counts
        step_dirs: list[np.ndarray] = []
        step_hosts: list[int] = []
        step_conns: list[int] = []
        step_mates: list[int] = []
        rollbacks = 0
        mirrored_pairs = 0

        def _cfg_blend(t: torch.Tensor) -> torch.Tensor:
            if cfg_mode == "dual_cfg":
                # Dual-CFG: uncond + w_text*(text - uncond) + w_shape*(text+bp - text)
                return t[2] + cfg_scale * (t[1] - t[2]) + cfg_shape * (t[0] - t[1])
            if cfg_mode == "text_cfg":
                return t[1] + cfg_scale * (t[0] - t[1])
            return t[0]

        def _forward_prefix():
            T = len(seq_part)
            p_t = torch.tensor(seq_part, dtype=torch.long, device=self.dev).unsqueeze(0).expand(bsz, T)
            c_t = torch.tensor(seq_color, dtype=torch.long, device=self.dev).unsqueeze(0).expand(bsz, T)
            r_t = torch.tensor(seq_rot24, dtype=torch.long, device=self.dev).unsqueeze(0).expand(bsz, T)
            ax_t = torch.tensor(seq_ax, dtype=torch.long, device=self.dev).unsqueeze(0).expand(bsz, T)
            ay_t = torch.tensor(seq_ay, dtype=torch.long, device=self.dev).unsqueeze(0).expand(bsz, T)
            az_t = torch.tensor(seq_az, dtype=torch.long, device=self.dev).unsqueeze(0).expand(bsz, T)
            xyz_t = torch.from_numpy(np.stack(seq_xyz)).to(self.dev).unsqueeze(0).expand(bsz, T, 3)
            r6_t = torch.from_numpy(np.stack(seq_rot6d)).to(self.dev).unsqueeze(0).expand(bsz, T, 6)
            bb_t = torch.from_numpy(np.stack(seq_bbox)).to(self.dev).unsqueeze(0).expand(bsz, T, 6)
            fr_t = None
            if self.model.cfg.use_blueprint:
                fr_base = torch.from_numpy(np.stack(seq_frontier)).to(self.dev)
                if cfg_mode == "dual_cfg":
                    # Slot 0 sees live causal blueprint frontier; slots 1 & 2 have blueprint dropped (zeros)
                    fr_t = torch.zeros((3, T, FRONTIER_DIM), dtype=fr_base.dtype, device=self.dev)
                    fr_t[0] = fr_base
                else:
                    fr_t = fr_base.unsqueeze(0).expand(bsz, T, FRONTIER_DIM)
            in_emb = self.model.embed_placed(p_t, c_t, r_t, ax_t, ay_t, az_t, xyz_t, r6_t, bb_t, frontier=fr_t)
            h_out = self.model.encode_sequence(in_emb, mem, mem_mask)
            return in_emb, h_out

        def _push_brick(
            p_tok: int,
            c_tok: int,
            stem: str,
            ldraw_col: int,
            mat: np.ndarray,
            wbbox_ldraw: np.ndarray,
            host_i: int = -1,
            rel_vec: np.ndarray | None = None,
            n_mates: int = 2,
        ):
            self.native.add(stem, ldraw_col, mat)
            wb_yup = ldraw_bbox_to_yup(wbbox_ldraw)
            pos_yup = np.array([mat[0, 3], -mat[1, 3], mat[2, 3]], dtype=np.float32)
            r24 = int(nearest_rot24(mat[:3, :3]))
            r6 = rotmat_to_6d(mat[:3, :3]).astype(np.float32)
            qax, qay, qaz = quantize_abs(pos_yup)

            seq_part.append(p_tok)
            seq_color.append(c_tok)
            seq_rot24.append(r24)
            seq_ax.append(int(qax))
            seq_ay.append(int(qay))
            seq_az.append(int(qaz))
            seq_xyz.append(pos_yup)
            seq_rot6d.append(r6)
            seq_bbox.append(wb_yup.astype(np.float32))
            if tracker is not None:
                seq_frontier.append(tracker.push(wb_yup))
            else:
                seq_frontier.append(np.zeros(FRONTIER_DIM, dtype=np.float32))
            stems_out.append(stem)
            colors_out.append(ldraw_col)
            mats_out.append(mat.copy())
            step_hosts.append(host_i)
            p_idx_loc = p_tok - PART_OFFSET
            c_cnt = int(self.part_conns[p_idx_loc]) if 0 <= p_idx_loc < len(self.part_conns) else 16
            step_conns.append(c_cnt)
            step_mates.append(int(n_mates))
            if rel_vec is not None and np.linalg.norm(rel_vec) > 1e-3:
                step_dirs.append((rel_vec / np.linalg.norm(rel_vec)).astype(np.float32))
            else:
                step_dirs.append(np.zeros(3, dtype=np.float32))

        def _pop_brick():
            self.native.pop()
            if tracker is not None:
                tracker.pop()
            seq_part.pop()
            seq_color.pop()
            seq_rot24.pop()
            seq_ax.pop()
            seq_ay.pop()
            seq_az.pop()
            seq_xyz.pop()
            seq_rot6d.pop()
            seq_bbox.pop()
            seq_frontier.pop()
            stems_out.pop()
            colors_out.pop()
            mats_out.pop()
            step_hosts.pop()
            step_conns.pop()
            step_mates.pop()
            step_dirs.pop()

        def _try_mirror_pair(stem: str, c_tok: int, ldraw_col: int, mat: np.ndarray) -> bool:
            """If brick sits off X=0, try snapping its exact collision-free mirrored partner at -x."""
            if len(stems_out) >= max_parts:
                return False
            x_pos = float(mat[0, 3])
            if abs(x_pos) < 15.0:
                return False
            stem_m = self.mirror_map.get(stem, stem)
            p_tok_m = self.part_to_tok.get(stem_m)
            if p_tok_m is None:
                return False

            mat_target = mirror_matrix_x(mat, plane_x=0.0)
            target_yup = np.array([mat_target[0, 3], -mat_target[1, 3], mat_target[2, 3]], dtype=np.float32)
            # Skip if an identical/partner piece already occupies that mirrored spot
            placed_arr = np.stack(seq_xyz[1:], axis=0)
            dists_existing = np.linalg.norm(placed_arr - target_yup[None], axis=-1)
            if float(dists_existing.min()) < 6.0:
                return False

            # Query native C++ solver on the nearest hosts to the mirrored target spot (avoid mega-baseplate O(1024) scans)
            near_raw = np.argsort(dists_existing)
            normal_near = [int(i) for i in near_raw if step_conns[int(i)] <= mega_host_conn_limit]
            near_list = normal_near[: min(12, len(normal_near))]
            if not near_list:
                near_list = [int(i) for i in near_raw[: min(4, len(near_raw))]]
            near_order = np.array(near_list, dtype=np.int32)
            mc = self.native.candidates(stem_m, hosts=near_order, max_out=512, fine_angles=False, filter_collisions=True)
            if len(mc["matrices"]) == 0:
                return False

            m_mats = mc["matrices"]
            m_pos = np.stack([m_mats[:, 0, 3], -m_mats[:, 1, 3], m_mats[:, 2, 3]], axis=-1)
            pos_err = np.linalg.norm(m_pos - target_yup[None], axis=-1)
            # Rotation closeness: Frobenius inner product of 3x3 rotation matrices (3.0 = identical)
            r_dots = np.einsum("nij,ij->n", m_mats[:, :3, :3], mat_target[:3, :3])
            # For X-symmetric parts, allow 180-deg equivalent rotations too if bbox matches cleanly
            ok = (pos_err <= 3.5) & (r_dots >= 2.75)
            if not ok.any():
                # Check if exact bbox match with same position (handles 180° symmetric bricks/plates/wheels!)
                tb = world_bbox_from_local(self.part_bboxes[p_tok_m - PART_OFFSET], mat_target)
                bb_err = np.abs(mc["bboxes"] - tb[None]).max(axis=-1)
                ok = (pos_err <= 2.5) & (bb_err <= 2.5)
            if not ok.any():
                return False

            idxs = np.where(ok)[0]
            best_i = int(idxs[np.argmin(pos_err[idxs] - 0.5 * r_dots[idxs])])
            bb_yup_m = ldraw_bbox_to_yup(mc["bboxes"][best_i])
            if bb_yup_m[1] < -4.5:
                return False
            if tracker is not None and bp_score_weight > 0:
                _, m_spill, _ = tracker.score_candidates(bb_yup_m[None], self.color_rgba_lut[c_tok])
                if float(m_spill[0]) > 0.80:
                    return False
            h_m = int(mc["hosts"][best_i])
            rel_m = m_pos[best_i] - placed_arr[h_m]
            _push_brick(
                p_tok_m,
                c_tok,
                stem_m,
                ldraw_col,
                m_mats[best_i],
                mc["bboxes"][best_i],
                host_i=h_m,
                rel_vec=rel_m,
                n_mates=int(mc["mates"][best_i]),
            )
            return True

        while len(stems_out) < max_parts:
            step_idx = len(stems_out)
            in_emb, h_out = _forward_prefix()
            h_cur = h_out[:, -1, :]

            part_logits = _cfg_blend(self.model.head_part(h_cur)).float().cpu().numpy()
            part_logits[0] = -1e9
            part_logits[1] = -1e9
            if step_idx < min_parts:
                part_logits[EOS_ID] = -1e9
            elif tracker is not None and tracker.covered_fraction >= 0.85:
                # Encourage crisp completion once the target 3D silhouette is filled
                part_logits[EOS_ID] += 2.5 * (tracker.covered_fraction - 0.85) / 0.15

            chosen_tok = _sample_from_logits(part_logits, rng, temp=temp, top_k=top_k_parts)
            if step_idx >= min_parts and chosen_tok == EOS_ID:
                break

            # ---- Root brick (step 0) ----
            if step_idx == 0:
                p_tok = chosen_tok
                p_idx = p_tok - PART_OFFSET
                stem = self.parts[p_idx]

                pt_t = torch.full((bsz,), p_tok, dtype=torch.long, device=self.dev)
                h_c = h_cur + self.model.cond_part(self.model.part_emb(pt_t))
                col_logits = _cfg_blend(self.model.head_color(self.model.color_norm(h_c))).float().cpu().numpy()
                col_logits[0] = -1e9
                c_tok = _sample_from_logits(col_logits, rng, temp=temp, top_k=8)
                ldraw_col = self.colors[c_tok - 1]

                ct_t = torch.full((bsz,), c_tok, dtype=torch.long, device=self.dev)
                h_pc = self.model.ptr_norm(h_c + self.model.cond_color(self.model.color_emb(ct_t)))
                anchor = self.model.root_anchor.squeeze(1).expand(bsz, -1)
                pout = self.model.predict_pose_from_anchor(h_pc, anchor)

                r24 = _sample_from_logits(_cfg_blend(pout["rot24"]).float().cpu().numpy(), rng, temp=pose_temp, top_k=4)
                ax_b = _sample_from_logits(_cfg_blend(pout["ax"]).float().cpu().numpy(), rng, temp=pose_temp, top_k=5)
                ay_b = _sample_from_logits(_cfg_blend(pout["ay"]).float().cpu().numpy(), rng, temp=pose_temp, top_k=5)
                az_b = _sample_from_logits(_cfg_blend(pout["az"]).float().cpu().numpy(), rng, temp=pose_temp, top_k=5)
                pos0 = dequantize_abs(ax_b, ay_b, az_b)

                mat = np.eye(4, dtype=np.float64)
                mat[:3, :3] = ROT24[r24]
                # Only snap root to symmetry plane X=0 when predicted near center (preserve off-center wheel/leg roots!)
                rx0 = round(pos0[0] / 20.0) * 20.0
                mat[0, 3] = 0.0 if (use_sym and abs(rx0) < 20.0) else rx0
                mat[2, 3] = round(pos0[2] / 20.0) * 20.0
                mat[1, 3] = 0.0
                wb0 = world_bbox_from_local(self.part_bboxes[p_idx], mat)
                mat[1, 3] -= float(wb0[4])
                wb0 = world_bbox_from_local(self.part_bboxes[p_idx], mat)

                _push_brick(p_tok, c_tok, stem, ldraw_col, mat, wb0)
                continue

            # ---- Step t >= 1: Native C++ exact connector snapping + neural pose scoring ----
            valid_logits = part_logits.copy()
            valid_logits[:PART_OFFSET] = -1e9
            top_order = np.argsort(-valid_logits)[: max(top_k_parts, 12)]
            part_try_list = [chosen_tok] + [int(t) for t in top_order if int(t) != chosen_tok]

            brick_keys = h_out[:, 1:, :] + in_emb[:, 1:, :]
            k_ptr = self.model.ptr_k(brick_keys)
            placed_xyz = np.stack(seq_xyz[1:], axis=0)
            cur_bb = np.stack(seq_bbox[1:], axis=0)
            cur_lo = cur_bb[:, :3].min(0)
            cur_hi = cur_bb[:, 3:6].max(0)

            # Detect active 3D collinear chain ending at brick step_idx - 1
            chain_len = 0
            chain_dir = np.zeros(3, dtype=np.float32)
            if step_idx >= 3 and step_hosts[-1] == step_idx - 2 and np.linalg.norm(step_dirs[-1]) > 0.5:
                d_last = step_dirs[-1]
                chain_dir = d_last
                k_cur = step_idx - 1
                while k_cur >= 1 and step_hosts[k_cur] == k_cur - 1:
                    if float(step_dirs[k_cur] @ d_last) > 0.94:
                        chain_len += 1
                        k_cur -= 1
                    else:
                        break

            placed_ok = False
            for p_tok in part_try_list[:10]:
                if p_tok < PART_OFFSET:
                    continue
                p_idx = p_tok - PART_OFFSET
                stem = self.parts[p_idx]

                pt_t = torch.full((bsz,), p_tok, dtype=torch.long, device=self.dev)
                h_c = h_cur + self.model.cond_part(self.model.part_emb(pt_t))
                col_logits = _cfg_blend(self.model.head_color(self.model.color_norm(h_c))).float().cpu().numpy()
                col_logits[0] = -1e9
                c_tok = _sample_from_logits(col_logits, rng, temp=temp, top_k=8)
                ldraw_col = self.colors[c_tok - 1]

                ct_t = torch.full((bsz,), c_tok, dtype=torch.long, device=self.dev)
                h_pc = self.model.ptr_norm(h_c + self.model.cond_color(self.model.color_emb(ct_t)))
                q_ptr = self.model.ptr_q(h_pc).unsqueeze(1)
                ptr_raw = torch.bmm(q_ptr.float(), k_ptr.float().transpose(1, 2)).squeeze(1) / np.sqrt(self.model.cfg.ptr_dim)
                ptr_logits = _cfg_blend(ptr_raw)
                ptr_logp = F.log_softmax(ptr_logits, dim=-1).cpu().numpy()

                k_h = min(step_idx, top_hosts)
                ranked_hosts = np.argsort(-ptr_logp)
                # Baseplate speed guard: prevent 32x32 baseplates (>120 conns) from triggering 1,000+ stud Cartesian scans every step!
                normal_hosts = [int(h) for h in ranked_hosts if step_conns[int(h)] <= mega_host_conn_limit]
                mega_hosts = [int(h) for h in ranked_hosts if step_conns[int(h)] > mega_host_conn_limit]
                if not mega_hosts:
                    host_order = ranked_hosts[:k_h].astype(np.int32)
                    cands = self.native.candidates(stem, hosts=host_order, max_out=1536, fine_angles=fine_angles, filter_collisions=True)
                    if len(cands["matrices"]) == 0 and k_h < step_idx:
                        cands = self.native.candidates(stem, hosts=None, max_out=1536, fine_angles=fine_angles, filter_collisions=True)
                else:
                    # Query top normal hosts first; only include a mega-baseplate if we have <2 normal hosts or it's top-2 AND capped!
                    pick_h = normal_hosts[:k_h]
                    if len(normal_hosts) < 2 or (int(ranked_hosts[0]) in mega_hosts and step_idx < 10):
                        pick_h = pick_h + mega_hosts[:1]
                    max_c = 512 if (mega_hosts[0] in pick_h) else 1024
                    cands = self.native.candidates(
                        stem, hosts=np.array(pick_h, dtype=np.int32), max_out=max_c, fine_angles=fine_angles, filter_collisions=True
                    )
                    if len(cands["matrices"]) == 0 and len(normal_hosts) > len(pick_h):
                        cands = self.native.candidates(
                            stem, hosts=np.array(normal_hosts, dtype=np.int32), max_out=1024, fine_angles=fine_angles, filter_collisions=True
                        )
                    if len(cands["matrices"]) == 0 and mega_hosts[0] not in pick_h:
                        cands = self.native.candidates(
                            stem, hosts=np.array(mega_hosts[:1], dtype=np.int32), max_out=256, fine_angles=fine_angles, filter_collisions=True
                        )
                if len(cands["matrices"]) == 0:
                    continue

                mats_c = cands["matrices"]
                bb_ld_c = cands["bboxes"]
                hosts_c = cands["hosts"]
                mates_c = cands["mates"]

                bb_yup_c = ldraw_bbox_to_yup(bb_ld_c)
                above_floor = bb_yup_c[:, 1] >= -4.5
                if above_floor.any():
                    mats_c = mats_c[above_floor]
                    bb_ld_c = bb_ld_c[above_floor]
                    bb_yup_c = bb_yup_c[above_floor]
                    hosts_c = hosts_c[above_floor]
                    mates_c = mates_c[above_floor]

                uniq_hosts, inv_idx = np.unique(hosts_c, return_inverse=True)
                uh_t = torch.from_numpy(uniq_hosts.astype(np.int64)).to(self.dev)
                anc_u = brick_keys[:, uh_t, :]
                hpc_u = h_pc.unsqueeze(1).expand(bsz, len(uniq_hosts), -1)
                pout = self.model.predict_pose_from_anchor(hpc_u, anc_u)

                lp_dx = F.log_softmax(_cfg_blend(pout["dx"]).float(), dim=-1).cpu().numpy()
                lp_dy = F.log_softmax(_cfg_blend(pout["dy"]).float(), dim=-1).cpu().numpy()
                lp_dz = F.log_softmax(_cfg_blend(pout["dz"]).float(), dim=-1).cpu().numpy()
                lp_ax = F.log_softmax(_cfg_blend(pout["ax"]).float(), dim=-1).cpu().numpy()
                lp_ay = F.log_softmax(_cfg_blend(pout["ay"]).float(), dim=-1).cpu().numpy()
                lp_az = F.log_softmax(_cfg_blend(pout["az"]).float(), dim=-1).cpu().numpy()
                lp_r24 = F.log_softmax(_cfg_blend(pout["rot24"]).float(), dim=-1).cpu().numpy()
                pred_r6 = _cfg_blend(pout["rot6d"]).float().cpu().numpy()
                pred_r6 = pred_r6 / np.maximum(np.linalg.norm(pred_r6, axis=-1, keepdims=True), 1e-6)

                pos_c = np.stack([mats_c[:, 0, 3], -mats_c[:, 1, 3], mats_c[:, 2, 3]], axis=-1)
                rel_c = pos_c - placed_xyz[hosts_c]
                qdx, qdy, qdz = quantize_rel(rel_c)
                qax, qay, qaz = quantize_abs(pos_c)
                r24_c = nearest_rot24(mats_c[:, :3, :3])
                r6_c = rotmat_to_6d(mats_c[:, :3, :3])
                r6_c = r6_c / np.maximum(np.linalg.norm(r6_c, axis=-1, keepdims=True), 1e-6)
                # Penalize off-axis 45° cylindrical/pin spins (e.g. tire/rim hubs) that tilt subsequent chassis bricks!
                r_ortho_dot = np.einsum("nij,nij->n", mats_c[:, :3, :3], ROT24[r24_c])
                s_ortho = np.where(r_ortho_dot >= 2.98, 0.0, -5.0).astype(np.float32) if not fine_angles else np.zeros(len(mats_c), dtype=np.float32)

                s_par = ptr_logp[hosts_c]
                s_rel = lp_dx[inv_idx, qdx] + lp_dy[inv_idx, qdy] + lp_dz[inv_idx, qdz]
                s_abs = lp_ax[inv_idx, qax] + lp_ay[inv_idx, qay] + lp_az[inv_idx, qaz]
                s_r24 = lp_r24[inv_idx, r24_c]
                s_r6 = np.sum(pred_r6[inv_idx] * r6_c, axis=-1)
                s_grip = 0.30 * np.log1p(np.maximum(mates_c, 0).astype(np.float32))

                # 3D Collinear Chain Guard (vertical, horizontal, or diagonal 1D needle loops)
                s_rep = np.zeros(len(mats_c), dtype=np.float32)
                if chain_penalty > 0 and chain_len >= 2:
                    rel_norms = np.maximum(np.linalg.norm(rel_c, axis=-1), 1e-5)
                    cos_dir = (rel_c @ chain_dir) / rel_norms
                    extending = (hosts_c == step_idx - 1) & (cos_dir > 0.94)
                    # Penalize single-mate cantilever chains even harder; allow wider multi-stud towers slightly more
                    s_rep[extending] -= chain_penalty * float(chain_len - 1) * np.where(mates_c[extending] <= 1, 1.5, 0.9)

                # Identical-part vertical streak guard
                if chain_penalty > 0 and step_idx >= 2 and stems_out[-1] == stem:
                    streak = 1
                    for prev_s in reversed(stems_out[:-1]):
                        if prev_s == stem:
                            streak += 1
                        else:
                            break
                    if streak >= 2:
                        same_col = (hosts_c == step_idx - 1) & (np.abs(rel_c[:, 0]) < 1.0) & (np.abs(rel_c[:, 2]) < 1.0)
                        s_rep[same_col] -= chain_penalty * float(streak - 1)

                # Mild compactness regularizer against extreme needle aspect ratios (> 4:1)
                s_compact = np.zeros(len(mats_c), dtype=np.float32)
                if not allow_elongated and step_idx >= 8:
                    new_lo = np.minimum(cur_lo[None], bb_yup_c[:, :3])
                    new_hi = np.maximum(cur_hi[None], bb_yup_c[:, 3:6])
                    spans = np.maximum(new_hi - new_lo, 20.0)
                    aspect = spans.max(axis=-1) / np.maximum(np.median(spans, axis=-1), 20.0)
                    excess = np.maximum(aspect - 3.2, 0.0)
                    s_compact = -0.6 * excess

                # 3D Blueprint Silhouette Guidance (integral-volume O(1) per candidate!)
                s_bp = np.zeros(len(mats_c), dtype=np.float32)
                if tracker is not None and bp_score_weight > 0:
                    gain, spill, col_sim = tracker.score_candidates(bb_yup_c, self.color_rgba_lut[c_tok])
                    s_bp = bp_score_weight * (2.5 * gain - 3.2 * spill + 1.0 * col_sim)

                total_score = (
                    1.0 * s_par
                    + 1.1 * s_rel
                    + 0.7 * s_abs
                    + 0.9 * s_r24
                    + 0.8 * s_r6
                    + s_grip
                    + s_ortho
                    + s_rep
                    + s_compact
                    + s_bp
                )
                best_m = _sample_from_logits(total_score, rng, temp=pose_temp, top_k=8, top_p=0.9)

                _push_brick(
                    p_tok,
                    c_tok,
                    stem,
                    ldraw_col,
                    mats_c[best_m],
                    bb_ld_c[best_m],
                    host_i=int(hosts_c[best_m]),
                    rel_vec=rel_c[best_m],
                    n_mates=int(mates_c[best_m]),
                )
                if use_sym and _try_mirror_pair(stem, c_tok, ldraw_col, mats_c[best_m]):
                    mirrored_pairs += 1
                placed_ok = True
                break

            if not placed_ok:
                rollbacks += 1
                if rollbacks > max_rollbacks or len(stems_out) <= 1:
                    break
                _pop_brick()

        chk = self.native.check()

        # Stray single-mate outlier pruner: cleanly trims protruding 1-mate antennae/spurs while strictly preserving
        # overlaps==0, groups==1, stands==True, and blueprint IoU!
        pruned_outliers = 0
        if prune_outliers and len(stems_out) >= max(min_parts + 2, 12) and chk.overlaps == 0:
            for _ in range(6):
                if len(stems_out) <= max(min_parts, 8):
                    break
                all_bb = np.stack(seq_bbox[1:], axis=0)
                centers = 0.5 * (all_bb[:, :3] + all_bb[:, 3:6])
                med = np.median(centers, axis=0)
                radii = np.linalg.norm(centers - med[None], axis=-1)
                med_r = max(float(np.median(radii)), 20.0)
                # Only consider single-mate protruding leaves strictly outside 1.75x median radius
                # AND never prune bricks that have children pointing to them
                has_child = set(h for h in step_hosts if h >= 0)
                cand_idxs = [
                    i
                    for i in range(1, len(stems_out))
                    if step_mates[i] <= 1 and i not in has_child and radii[i] > 1.75 * med_r
                ]
                if not cand_idxs:
                    break
                cand_idxs.sort(key=lambda i: -radii[i])
                pruned_this_round = False
                cur_span_max = float((all_bb[:, 3:6].max(0) - all_bb[:, :3].min(0)).max())
                for drop_i in cand_idxs[:4]:
                    sub_bb = np.delete(all_bb, drop_i, axis=0)
                    new_span_max = float((sub_bb[:, 3:6].max(0) - sub_bb[:, :3].min(0)).max())
                    if cur_span_max - new_span_max < 18.0:
                        continue
                    # Verify physically via libbmcore that removing drop_i keeps connectivity & stability intact!
                    self.native.reset()
                    for j, (st_j, col_j, mat_j) in enumerate(zip(stems_out, colors_out, mats_out)):
                        if j != drop_i:
                            self.native.add(st_j, col_j, mat_j)
                    chk_sub = self.native.check()
                    if (
                        chk_sub.overlaps == 0
                        and chk_sub.groups <= chk.groups
                        and (chk_sub.stands or not chk.stands)
                    ):
                        stems_out.pop(drop_i)
                        colors_out.pop(drop_i)
                        mats_out.pop(drop_i)
                        seq_bbox.pop(drop_i + 1)
                        step_mates.pop(drop_i)
                        # Remap parent indices for remaining bricks
                        step_hosts.pop(drop_i)
                        step_hosts = [h - 1 if h > drop_i else h for h in step_hosts]
                        chk = chk_sub
                        pruned_outliers += 1
                        pruned_this_round = True
                        break
                if not pruned_this_round:
                    break

        aspect_ratio = 1.0
        if len(seq_bbox) > 1:
            all_bb = np.stack(seq_bbox[1:], axis=0)
            sp = np.maximum(all_bb[:, 3:6].max(0) - all_bb[:, :3].min(0), 10.0)
            aspect_ratio = float(sp.max() / max(float(np.median(sp)), 10.0))

        return GeneratedModel(
            prompt=prompt,
            stems=stems_out,
            colors=colors_out,
            matrices=mats_out,
            check=chk,
            seconds=round(time.time() - t0, 2),
            rollbacks=rollbacks,
            mirrored_pairs=mirrored_pairs,
            pruned_outliers=pruned_outliers,
            aspect_ratio=round(aspect_ratio, 2),
            blueprint_iou=round(tracker.iou, 3) if tracker is not None else None,
            blueprint_cov=round(tracker.covered_fraction, 3) if tracker is not None else None,
            blueprint_grid=bp_grid,
        )

    def generate(
        self,
        prompt: str,
        n_samples: int = 6,
        rerank_clip: bool = True,
        style: str = "any",
        scale: str = "auto",
        min_parts: int = 8,
        max_parts: int = 80,
        cfg_scale: float = 2.5,
        cfg_shape: float = 2.2,
        bp_score_weight: float = 1.8,
        bp_grid: np.ndarray | None = None,
        bp_scale: np.ndarray | None = None,
        image_ref: str | Path | None = None,
        image_weight: float = 0.55,
        temp: float = 0.90,
        pose_temp: float = 0.70,
        symmetric: str = "auto",
        prune_outliers: bool = True,
        seed: int = 0,
    ) -> GeneratedModel:
        """Generate N candidates and select the best certified + blueprint-aligned + text/image CLIP-aligned model."""
        candidates: list[GeneratedModel] = []
        _, text_pool = self.clip.encode_texts([prompt])
        text_vec = text_pool[0]
        img_vec: np.ndarray | None = None
        if image_ref is not None:
            img_vec = self.encode_image_ref(image_ref)
        allow_elongated = bool(ELONGATED_PROMPT_RE.search(prompt))
        w_img = float(np.clip(image_weight, 0.0, 1.0)) if img_vec is not None else 0.0

        for k in range(n_samples):
            gm = self.generate_one(
                prompt=prompt,
                style=style,
                scale=scale,
                min_parts=min_parts,
                max_parts=max_parts,
                cfg_scale=cfg_scale,
                cfg_shape=cfg_shape,
                bp_score_weight=bp_score_weight,
                bp_grid=bp_grid,
                bp_scale=bp_scale,
                image_pool=img_vec,
                image_weight=w_img,
                temp=temp,
                pose_temp=pose_temp,
                symmetric=symmetric,
                prune_outliers=prune_outliers,
                seed=seed + k * 997,
            )
            if rerank_clip and self.clip.vision_model is not None and BMSHOT.exists() and gm.check.pieces > 0:
                imgs = render_with_bmshot(gm.to_ldr(), size=256)
                if imgs:
                    ivecs = self.clip.encode_images(imgs)
                    gm.clip_score = float((ivecs @ text_vec).mean())
                    if img_vec is not None:
                        gm.image_score = float((ivecs @ img_vec).mean())
            candidates.append(gm)

        def _rank(gm: GeneratedModel):
            c = gm.check
            cs_t = gm.clip_score if gm.clip_score is not None else 0.0
            if img_vec is not None and gm.image_score is not None:
                cs = (1.0 - w_img) * cs_t + w_img * gm.image_score
            else:
                cs = cs_t
            bp_bonus = 0.15 * gm.blueprint_iou if gm.blueprint_iou is not None else 0.0
            # Penalize extreme needle shapes in reranking when not prompted for a tower/bridge
            needle_pen = 0.0 if allow_elongated else max(0.0, gm.aspect_ratio - 4.0) * 0.025
            return (
                int(c.overlaps == 0),
                int(c.groups == 1),
                int(c.stands),
                cs + bp_bonus - needle_pen,
                c.pieces,
            )

        candidates.sort(key=_rank, reverse=True)
        return candidates[0]


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate certified LEGO models from text and/or reference image using BrickGen v3.")
    ap.add_argument("prompt", type=str)
    ap.add_argument("--ckpt", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/brickgen_v3.pt"))
    ap.add_argument("--blueprint-ckpt", type=Path, default=None, help="Stage-1 BlueprintFlow3D checkpoint (blueprint.pt)")
    ap.add_argument("--blueprint-from", type=Path, default=None, help="Extract 3D blueprint directly from an existing .ldr/.mpd/.io")
    ap.add_argument("--blueprint-from-mesh", type=Path, default=None, help="Voxelize an external 3D mesh (.obj/.stl/.ply) into a 3D blueprint")
    ap.add_argument("--mesh-span-studs", type=float, default=12.0, help="Target longest span in studs for --blueprint-from-mesh")
    ap.add_argument("--mesh-up-axis", choices=["y", "z"], default="y", help="Up axis of external mesh (.obj/.stl/.ply)")
    ap.add_argument("--image-ref", type=Path, default=None, help="Optional reference image (.png/.jpg) for CLIP Vision hybrid conditioning & reranking")
    ap.add_argument("--image-weight", type=float, default=0.55, help="Blend weight for --image-ref vs text prompt [0..1]")
    ap.add_argument("--save-blueprint", type=Path, default=None, help="Optional PNG preview path for the 3D blueprint")
    ap.add_argument("--out", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/out.ldr"))
    ap.add_argument("--render", type=Path, default=None, help="Optional PNG render path via Metal bmshot")
    ap.add_argument("--style", choices=list(SOURCE_MAP.keys()), default="any")
    ap.add_argument("--scale", choices=list(SCALE_MAP.keys()), default="auto")
    ap.add_argument("--min-parts", type=int, default=16)
    ap.add_argument("--max-parts", type=int, default=90)
    ap.add_argument("--cfg", type=float, default=2.2)
    ap.add_argument("--cfg-shape", type=float, default=2.2)
    ap.add_argument("--bp-weight", type=float, default=1.8)
    ap.add_argument("--temp", type=float, default=0.90)
    ap.add_argument("--pose-temp", type=float, default=0.70)
    ap.add_argument("--symmetric", choices=["auto", "on", "off"], default="auto")
    ap.add_argument("--no-prune-outliers", action="store_true", help="Disable post-generation stray single-mate outlier pruner")
    ap.add_argument("--samples", type=int, default=6)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-clip-rerank", action="store_true")
    a = ap.parse_args()

    need_vision = (not a.no_clip_rerank) or (a.image_ref is not None)
    gen = BrickGenerator(a.ckpt, blueprint_ckpt=a.blueprint_ckpt, load_vision=need_vision)
    bp_grid, bp_scale = None, None
    if a.blueprint_from is not None:
        bp_grid, bp_scale, src_n = gen.extract_blueprint_from_file(a.blueprint_from)
        print(f"Extracted 3D blueprint from {a.blueprint_from} ({src_n} pieces, span={bp_scale[:3].round(0).tolist()} LDU)", flush=True)
    elif a.blueprint_from_mesh is not None:
        bp_grid, bp_scale, n_tris = gen.extract_blueprint_from_mesh(
            a.blueprint_from_mesh, span_studs=a.mesh_span_studs, up_axis=a.mesh_up_axis
        )
        print(
            f"Voxelized mesh blueprint from {a.blueprint_from_mesh} ({n_tris} tris, "
            f"occ={int((bp_grid[0] > 0.5).sum())} vox, span={bp_scale[:3].round(0).tolist()} LDU)",
            flush=True,
        )

    res = gen.generate(
        prompt=a.prompt,
        n_samples=a.samples,
        rerank_clip=not a.no_clip_rerank,
        style=a.style,
        scale=a.scale,
        min_parts=a.min_parts,
        max_parts=a.max_parts,
        cfg_scale=a.cfg,
        cfg_shape=a.cfg_shape,
        bp_score_weight=a.bp_weight,
        bp_grid=bp_grid,
        bp_scale=bp_scale,
        image_ref=a.image_ref,
        image_weight=a.image_weight,
        temp=a.temp,
        pose_temp=a.pose_temp,
        symmetric=a.symmetric,
        prune_outliers=not a.no_prune_outliers,
        seed=a.seed,
    )
    a.out.parent.mkdir(parents=True, exist_ok=True)
    ldr_text = res.to_ldr(title=a.out.stem)
    a.out.write_text(ldr_text)
    if a.save_blueprint is not None and res.blueprint_grid is not None:
        render_blueprint_preview(res.blueprint_grid, a.save_blueprint)
        print(f"Saved blueprint preview -> {a.save_blueprint}", flush=True)
    bp_str = f" | bp_iou={res.blueprint_iou} cov={res.blueprint_cov}" if res.blueprint_iou is not None else ""
    img_str = f" | img_sim={res.image_score:.3f}" if res.image_score is not None else ""
    prn_str = f", pruned={res.pruned_outliers}" if res.pruned_outliers else ""
    print(
        f"Generated {a.out}: {res.check.pieces} parts (sym_pairs={res.mirrored_pairs}{prn_str}, aspect={res.aspect_ratio}{bp_str}) | "
        f"overlaps={res.check.overlaps} | groups={res.check.groups} | stands={res.check.stands} "
        f"(margin={res.check.margin:.1f}) | clip={res.clip_score}{img_str} | rollbacks={res.rollbacks} | {res.seconds}s",
        flush=True,
    )
    if a.render is not None and BMSHOT.exists():
        a.render.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                str(BMSHOT),
                str(a.out),
                "--out",
                str(a.render),
                "--size",
                "768x768",
                "--azimuth",
                "0.65",
                "--elevation",
                "0.42",
                "--studio",
            ],
            cwd=ROOT,
            check=False,
        )
        print(f"Rendered -> {a.render}", flush=True)


if __name__ == "__main__":
    main()
