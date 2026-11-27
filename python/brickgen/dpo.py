"""Offline Reward-Guided Direct Preference Optimization (DPO) for BrickGen v3 (BrickAnything Recipe).

Closes the neural-physical alignment gap by fine-tuning `BrickGen v3` directly on verified native C++
`libbmcore` + Metal `bmshot` CLIP Vision preference pairs `(winner, loser)`:
  1. `collect-dpo`: Samples K rollouts per prompt with `BrickGenerator`, computes the verifiable composite
     reward `R = certified(overlaps, groups, stands) + symmetry + CLIP_Vision + blueprint_IoU - outliers`,
     and writes canonical `(winner, loser)` pairs to `dpo_pairs.npz`.
  2. `train-dpo`:   Fine-tunes `BrickGen v3` with DPO (`beta=0.1`) + NLL anchor (`sft_alpha=0.15`) against
     a frozen reference copy of `brickgen_v3.pt`, exporting a drop-in `brickgen_v3_dpo.pt` checkpoint.

Works identically on local Apple Silicon MPS and NVIDIA Colab A100 bf16!
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from .blueprint import (
    BP_CH,
    BP_G,
    compute_blueprint_scale,
    compute_causal_frontier_features,
    encode_scale_vec,
    rasterize_blueprint,
)
from .clip_encoder import ClipEncoder
from .geometry import (
    ldraw_bbox_to_yup,
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
    PAD_ID,
    PART_OFFSET,
    ROT24_NONE,
    BrickGen,
    scale_bucket,
)
from .train import auto_device, load_checkpoint

DEFAULT_PROMPTS = [
    "a sleek red LEGO Speed Champions sports car with four black wheels, yellow headlights, tinted windshield, and rear spoiler",
    "a yellow LEGO pickup truck with four wheels, cab windshield, and open cargo bed",
    "a blue and white LEGO formula racing car with wide rear wing and four wheels",
    "a red LEGO fire engine truck with ladder, flashing lights, and wheels",
    "a black and white LEGO police patrol car with blue roof lightbar and four wheels",
    "a yellow LEGO construction dump truck with chunky tires and tilting bed",
    "a medieval gray LEGO stone castle watchtower with arched doorway, battlements, and red banner",
    "a white LEGO cottage house with red sloped gable roof, windows, door, and chimney",
    "a tall red and white striped LEGO coastal lighthouse with lantern dome on rocks",
    "a tan and brown LEGO medieval tavern house with timber framing and sloped roof",
    "a gray stone LEGO arched castle bridge spanning a blue river",
    "a white and blue LEGO delta-wing space starfighter jet with cockpit canopy and twin engines",
    "a sleek gray LEGO supersonic fighter jet with swept wings and tail fins",
    "a yellow and black LEGO rescue helicopter with rotor blades and landing skids",
    "a white and orange LEGO space shuttle orbiter with delta wings and booster thrusters",
    "a green and tan LEGO military tank with rotating turret and cannon",
    "a red and blue LEGO BrickHeadz superhero character figure on a black display stand",
    "a dark gray and black LEGO BrickHeadz armored knight figure on a black display stand",
    "a green LEGO mech robot with armored torso, articulated arms, and two legs",
    "a classic black and red LEGO steam locomotive train engine with smokestack",
    "a white and blue LEGO sailing yacht boat with mast and cabin",
    "a red and white LEGO biplane propeller airplane with twin wings and landing gear",
    "a brown and tan LEGO wooden treasure chest with gold trim",
    "a bright green and yellow LEGO dinosaur figure with tail and standing legs",
]


def _compute_symmetry_ratio(bboxes_yup: np.ndarray, colors: list[int]) -> float:
    if len(bboxes_yup) < 2:
        return 1.0
    centers = 0.5 * (bboxes_yup[:, :3] + bboxes_yup[:, 3:6])
    off = [i for i in range(len(bboxes_yup)) if abs(float(centers[i, 0])) >= 10.0]
    if not off:
        return 1.0
    matched = 0
    for i in off:
        cm = np.array([-centers[i, 0], centers[i, 1], centers[i, 2]], dtype=np.float32)
        d = np.linalg.norm(centers - cm[None], axis=-1)
        j = int(np.argmin(d))
        if float(d[j]) <= 6.0 and colors[j] == colors[i]:
            matched += 1
    return matched / float(len(off))


def _rollout_to_arrays(
    gm,
    part_to_tok: dict[str, int],
    color_to_tok: dict[int, int],
    part_bboxes: np.ndarray,
    color_rgba_lut: np.ndarray,
) -> dict[str, np.ndarray]:
    """Convert a `GeneratedModel` into exact canonical BrickGen training arrays."""
    n = len(gm.stems)
    part_ids = np.zeros(n, dtype=np.int16)
    color_ids = np.zeros(n, dtype=np.int16)
    parents = np.full(n, -1, dtype=np.int16)
    xyz = np.zeros((n, 3), dtype=np.float32)
    rot24 = np.zeros(n, dtype=np.int8)
    rot6d = np.zeros((n, 6), dtype=np.float32)
    bbox = np.zeros((n, 6), dtype=np.float32)

    for i, (stem, col, mat) in enumerate(zip(gm.stems, gm.colors, gm.matrices)):
        ptok = part_to_tok[stem]
        pidx = ptok - PART_OFFSET
        part_ids[i] = pidx
        color_ids[i] = color_to_tok.get(int(col), 1)
        xyz[i] = np.array([mat[0, 3], -mat[1, 3], mat[2, 3]], dtype=np.float32)
        rot24[i] = int(nearest_rot24(mat[:3, :3]))
        rot6d[i] = rotmat_to_6d(mat[:3, :3]).astype(np.float32)
        wb_ld = world_bbox_from_local(part_bboxes[pidx], mat)
        bbox[i] = ldraw_bbox_to_yup(wb_ld).astype(np.float32)
        if i > 0:
            # Nearest earlier brick in 3D space (causal parent j < i)
            d = np.linalg.norm(xyz[:i] - xyz[i : i + 1], axis=-1)
            parents[i] = int(np.argmin(d))

    if gm.blueprint_grid is not None:
        bp_g = gm.blueprint_grid.astype(np.float32)
        bp_s = compute_blueprint_scale(bbox)
    else:
        bp_s = compute_blueprint_scale(bbox)
        bp_g, bp_s = rasterize_blueprint(bbox, color_ids.astype(np.int64), color_rgba_lut, scale_vec=bp_s, g=BP_G)

    return {
        "part_id": part_ids,
        "color_id": color_ids,
        "parent": parents,
        "xyz": xyz.astype(np.float16),
        "rot24": rot24,
        "rot6d": rot6d.astype(np.float16),
        "bbox": bbox.astype(np.float16),
        "bp_grid": bp_g.astype(np.float16),
        "bp_scale": bp_s.astype(np.float32),
    }


def collect_dpo_pairs(
    ckpt: Path,
    out_npz: Path,
    blueprint_ckpt: Path | None = None,
    prompts: list[str] | None = None,
    samples_per_prompt: int = 6,
    max_parts: int = 80,
    min_parts: int = 12,
    min_margin: float = 0.12,
    seed: int = 0,
) -> dict:
    """Roll out candidates with `BrickGenerator` + `libbmcore` + `bmshot` CLIP Vision and save `(winner, loser)` pairs."""
    from .generate import BMSHOT, BrickGenerator, render_with_bmshot

    t0 = time.time()
    prompts = prompts or DEFAULT_PROMPTS
    gen = BrickGenerator(ckpt, blueprint_ckpt=blueprint_ckpt, load_vision=True)
    color_to_tok = {int(c): i + 1 for i, c in enumerate(gen.colors)}

    w_records: list[dict[str, np.ndarray]] = []
    l_records: list[dict[str, np.ndarray]] = []
    pair_prompts: list[str] = []
    pair_rewards: list[tuple[float, float]] = []

    for pi, pr in enumerate(prompts):
        _, tp = gen.clip.encode_texts([pr])
        tvec = tp[0]
        scored: list[tuple[float, object]] = []
        for k in range(samples_per_prompt):
            gm = gen.generate_one(
                prompt=pr,
                min_parts=min_parts,
                max_parts=max_parts,
                seed=seed + pi * 1009 + k * 97,
            )
            if gm.check.pieces < 4:
                continue
            cs = 0.0
            if gen.clip.vision_model is not None and BMSHOT.exists():
                imgs = render_with_bmshot(gm.to_ldr(), size=256)
                if imgs:
                    ivecs = gen.clip.encode_images(imgs)
                    cs = float((ivecs @ tvec).mean())
                    gm.clip_score = cs
            # Compute exact verifiable reward
            bbs = np.stack(
                [
                    ldraw_bbox_to_yup(world_bbox_from_local(gen.part_bboxes[gen.part_to_tok[s] - PART_OFFSET], m))
                    for s, m in zip(gm.stems, gm.matrices)
                ],
                axis=0,
            )
            sym_r = _compute_symmetry_ratio(bbs, gm.colors)
            c = gm.check
            bp_term = 1.2 * float(gm.blueprint_iou) if gm.blueprint_iou is not None else 0.0
            rew = (
                1.5 * float(c.overlaps == 0)
                + 1.5 * float(c.groups == 1)
                + 1.5 * float(c.stands)
                + 1.0 * sym_r
                + 3.0 * cs
                + bp_term
                - 0.08 * max(0.0, gm.aspect_ratio - 3.5)
                - 0.06 * float(gm.rollbacks)
            )
            scored.append((rew, gm))

        if len(scored) < 2:
            continue
        scored.sort(key=lambda x: x[0], reverse=True)
        w_rew, w_gm = scored[0]
        # Pair best certified winner against the worst and median losers (up to 2 pairs per prompt)
        loser_idxs = [len(scored) - 1]
        if len(scored) >= 4:
            loser_idxs.append(len(scored) // 2)
        for li in loser_idxs:
            l_rew, l_gm = scored[li]
            if w_rew - l_rew >= min_margin:
                w_records.append(_rollout_to_arrays(w_gm, gen.part_to_tok, color_to_tok, gen.part_bboxes, gen.color_rgba_lut))
                l_records.append(_rollout_to_arrays(l_gm, gen.part_to_tok, color_to_tok, gen.part_bboxes, gen.color_rgba_lut))
                pair_prompts.append(pr)
                pair_rewards.append((round(w_rew, 4), round(l_rew, 4)))
        print(
            f"[DPO-collect {pi + 1}/{len(prompts)}] '{pr[:42]}' | best={w_rew:.3f} worst={scored[-1][0]:.3f} | pairs={len(w_records)}",
            flush=True,
        )

    if not w_records:
        raise RuntimeError("No valid preference pairs collected; try increasing --samples or lowering --min-margin.")

    def _pack_side(recs: list[dict[str, np.ndarray]], prefix: str) -> dict[str, np.ndarray]:
        ptr = [0]
        for r in recs:
            ptr.append(ptr[-1] + len(r["part_id"]))
        return {
            f"{prefix}_part_id": np.concatenate([r["part_id"] for r in recs]),
            f"{prefix}_color_id": np.concatenate([r["color_id"] for r in recs]),
            f"{prefix}_parent": np.concatenate([r["parent"] for r in recs]),
            f"{prefix}_xyz": np.concatenate([r["xyz"] for r in recs]),
            f"{prefix}_rot24": np.concatenate([r["rot24"] for r in recs]),
            f"{prefix}_rot6d": np.concatenate([r["rot6d"] for r in recs]),
            f"{prefix}_bbox": np.concatenate([r["bbox"] for r in recs]),
            f"{prefix}_seq_ptr": np.array(ptr, dtype=np.int64),
            f"{prefix}_bp_grid": np.stack([r["bp_grid"] for r in recs], axis=0),
            f"{prefix}_bp_scale": np.stack([r["bp_scale"] for r in recs], axis=0),
        }

    clip_ids, clip_lens = gen.clip.tokenize(pair_prompts)
    payload = {}
    payload.update(_pack_side(w_records, "w"))
    payload.update(_pack_side(l_records, "l"))
    payload["clip_tokens"] = clip_ids.astype(np.uint16)
    payload["clip_lengths"] = clip_lens.astype(np.int16)
    payload["rewards"] = np.array(pair_rewards, dtype=np.float32)

    out_npz = Path(out_npz)
    out_npz.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_npz, **payload)
    stats = {
        "pairs": len(w_records),
        "prompts": len(prompts),
        "mean_margin": round(float(np.mean([w - l for w, l in pair_rewards])), 4),
        "seconds": round(time.time() - t0, 1),
        "out": str(out_npz),
    }
    print(f"Saved DPO pairs: {stats}", flush=True)
    return stats


def _collate_dpo_side(
    d: dict[str, np.ndarray],
    prefix: str,
    indices: np.ndarray,
    max_bricks: int,
    use_blueprint: bool,
) -> dict[str, torch.Tensor]:
    bsz = len(indices)
    ptr = d[f"{prefix}_seq_ptr"]
    part_id = d[f"{prefix}_part_id"]
    color_id = d[f"{prefix}_color_id"]
    parent_all = d[f"{prefix}_parent"]
    xyz_all = d[f"{prefix}_xyz"]
    rot24_all = d[f"{prefix}_rot24"]
    rot6d_all = d[f"{prefix}_rot6d"]
    bbox_all = d[f"{prefix}_bbox"]
    bp_grids_all = d[f"{prefix}_bp_grid"]
    bp_scales_all = d[f"{prefix}_bp_scale"]

    lens = [min(int(ptr[i + 1] - ptr[i]), max_bricks) for i in indices]
    S = max(max(lens), 1)

    part = np.full((bsz, S), PAD_ID, dtype=np.int64)
    color = np.zeros((bsz, S), dtype=np.int64)
    parent = np.full((bsz, S), -1, dtype=np.int64)
    rot24 = np.zeros((bsz, S), dtype=np.int64)
    ax = np.zeros((bsz, S), dtype=np.int64)
    ay = np.zeros((bsz, S), dtype=np.int64)
    az = np.zeros((bsz, S), dtype=np.int64)
    dx = np.zeros((bsz, S), dtype=np.int64)
    dy = np.zeros((bsz, S), dtype=np.int64)
    dz = np.zeros((bsz, S), dtype=np.int64)
    xyz = np.zeros((bsz, S, 3), dtype=np.float32)
    rot6d = np.zeros((bsz, S, 6), dtype=np.float32)
    bbox = np.zeros((bsz, S, 6), dtype=np.float32)
    length = np.array(lens, dtype=np.int64)
    source = np.zeros((bsz,), dtype=np.int64)
    scale = np.array([scale_bucket(L) for L in lens], dtype=np.int64)

    bp_grid = np.zeros((bsz, BP_CH, BP_G, BP_G, BP_G), dtype=np.float32) if use_blueprint else None
    bp_scale = np.zeros((bsz, 4), dtype=np.float32) if use_blueprint else None
    frontier = np.zeros((bsz, S + 1, 15), dtype=np.float32) if use_blueprint else None

    for row, idx in enumerate(indices):
        p0 = int(ptr[idx])
        L = lens[row]
        p1 = p0 + L
        p_xyz = xyz_all[p0:p1].astype(np.float32)
        p_bb = bbox_all[p0:p1].astype(np.float32)
        p_par = parent_all[p0:p1].astype(np.int64)
        p_par = np.where((p_par >= 0) & (p_par < np.arange(L)), p_par, -1)

        part[row, :L] = part_id[p0:p1].astype(np.int64) + PART_OFFSET
        color[row, :L] = color_id[p0:p1].astype(np.int64)
        parent[row, :L] = p_par
        rot24[row, :L] = rot24_all[p0:p1].astype(np.int64)
        xyz[row, :L] = p_xyz
        rot6d[row, :L] = rot6d_all[p0:p1].astype(np.float32)
        bbox[row, :L] = p_bb

        qax, qay, qaz = quantize_abs(p_xyz)
        ax[row, :L], ay[row, :L], az[row, :L] = qax, qay, qaz

        has_p = p_par >= 0
        if has_p.any():
            rel = p_xyz[has_p] - p_xyz[p_par[has_p]]
            qdx, qdy, qdz = quantize_rel(rel)
            dx[row, :L][has_p] = qdx
            dy[row, :L][has_p] = qdy
            dz[row, :L][has_p] = qdz

        if use_blueprint:
            g = bp_grids_all[idx].astype(np.float32)
            sv = bp_scales_all[idx].astype(np.float32)
            bp_grid[row] = g
            bp_scale[row] = encode_scale_vec(sv)
            frontier[row, : L + 1] = compute_causal_frontier_features(p_bb, g, sv, g=BP_G)

    out = {
        "part": torch.from_numpy(part),
        "color": torch.from_numpy(color),
        "parent": torch.from_numpy(parent),
        "rot24": torch.from_numpy(rot24),
        "ax": torch.from_numpy(ax),
        "ay": torch.from_numpy(ay),
        "az": torch.from_numpy(az),
        "dx": torch.from_numpy(dx),
        "dy": torch.from_numpy(dy),
        "dz": torch.from_numpy(dz),
        "xyz": torch.from_numpy(xyz),
        "rot6d": torch.from_numpy(rot6d),
        "bbox": torch.from_numpy(bbox),
        "length": torch.from_numpy(length),
        "source": torch.from_numpy(source),
        "scale": torch.from_numpy(scale),
    }
    if use_blueprint:
        out["bp_grid"] = torch.from_numpy(bp_grid)
        out["bp_scale"] = torch.from_numpy(bp_scale)
        out["frontier"] = torch.from_numpy(frontier)
    return out


def sequence_logprob(
    model: BrickGen,
    batch: dict[str, torch.Tensor],
    text_pooled: torch.Tensor,
    text_tokens: torch.Tensor,
    text_mask: torch.Tensor,
) -> torch.Tensor:
    """Compute length-normalized per-sequence joint log-probability `(B,)` under BrickGen."""
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
    bp_grid = batch.get("bp_grid") if model.cfg.use_blueprint else None
    bp_scale = batch.get("bp_scale") if model.cfg.use_blueprint else None
    frontier = batch.get("frontier") if model.cfg.use_blueprint else None

    b, S = part.shape
    dev = part.device

    mem, mem_mask = model.build_memory(
        text_pooled=text_pooled,
        text_tokens=text_tokens,
        text_mask=text_mask,
        source_id=source,
        scale_id=scale,
        bp_grid=bp_grid,
        bp_scale=bp_scale,
    )

    T = S + 1
    in_part = torch.full((b, T), PAD_ID, dtype=torch.long, device=dev)
    in_part[:, 0] = BOS_ID
    in_part[:, 1:] = part

    in_color = torch.zeros((b, T), dtype=torch.long, device=dev)
    in_color[:, 1:] = color

    valid_b = part >= PART_OFFSET
    in_rot24 = torch.full((b, T), ROT24_NONE, dtype=torch.long, device=dev)
    in_rot24[:, 1:] = torch.where(valid_b, rot24, torch.full_like(rot24, ROT24_NONE))

    in_ax = torch.full((b, T), ABS_XZ_BINS, dtype=torch.long, device=dev)
    in_ay = torch.full((b, T), ABS_Y_BINS, dtype=torch.long, device=dev)
    in_az = torch.full((b, T), ABS_XZ_BINS, dtype=torch.long, device=dev)
    in_ax[:, 1:] = torch.where(valid_b, ax, torch.full_like(ax, ABS_XZ_BINS))
    in_ay[:, 1:] = torch.where(valid_b, ay, torch.full_like(ay, ABS_Y_BINS))
    in_az[:, 1:] = torch.where(valid_b, az, torch.full_like(az, ABS_XZ_BINS))

    in_xyz = torch.zeros((b, T, 3), dtype=xyz.dtype, device=dev)
    in_xyz[:, 1:] = xyz
    in_rot6d = torch.zeros((b, T, 6), dtype=rot6d.dtype, device=dev)
    in_rot6d[:, 1:] = rot6d
    in_bbox = torch.zeros((b, T, 6), dtype=bbox.dtype, device=dev)
    in_bbox[:, 1:] = bbox

    in_emb = model.embed_placed(
        in_part, in_color, in_rot24, in_ax, in_ay, in_az, in_xyz, in_rot6d, in_bbox, frontier=frontier
    )
    h_out = model.encode_sequence(in_emb, mem, mem_mask)

    # 1. Part + EOS log-prob per sequence
    tgt_part = torch.full((b, T), PAD_ID, dtype=torch.long, device=dev)
    tgt_part[:, :S] = part
    row_idx = torch.arange(b, device=dev)
    eos_ok = lengths <= S
    tgt_part[row_idx[eos_ok], lengths[eos_ok]] = EOS_ID

    lp_part_all = F.log_softmax(model.head_part(h_out).float(), dim=-1)
    p_tok_lp = lp_part_all.gather(-1, tgt_part.unsqueeze(-1)).squeeze(-1)
    p_mask = (tgt_part != PAD_ID).float()
    seq_lp = 1.2 * (p_tok_lp * p_mask).sum(dim=-1) / p_mask.sum(dim=-1).clamp(min=1.0)

    # 2. Color | part
    h_step = h_out[:, :S]
    h_c = h_step + model.cond_part(model.part_emb(part))
    lp_col_all = F.log_softmax(model.head_color(model.color_norm(h_c)).float(), dim=-1)
    c_tok_lp = lp_col_all.gather(-1, color.clamp(min=0).unsqueeze(-1)).squeeze(-1)
    vb_f = valid_b.float()
    vb_den = vb_f.sum(dim=-1).clamp(min=1.0)
    seq_lp = seq_lp + 0.8 * (c_tok_lp * vb_f).sum(dim=-1) / vb_den

    # 3. Parent pointer | part, color
    h_pc = model.ptr_norm(h_c + model.cond_color(model.color_emb(color)))
    brick_keys = h_out[:, 1:] + in_emb[:, 1:]
    q = model.ptr_q(h_pc)
    k = model.ptr_k(brick_keys)
    ptr_logits = torch.bmm(q, k.transpose(1, 2)).float() / math.sqrt(model.cfg.ptr_dim)
    causal_ptr = torch.tril(torch.ones((S, S), dtype=torch.bool, device=dev), diagonal=-1)
    ptr_logits = ptr_logits.masked_fill(~causal_ptr[None], -1e9)

    has_parent = valid_b & (parent >= 0)
    hp_f = has_parent.float()
    hp_den = hp_f.sum(dim=-1).clamp(min=1.0)
    lp_ptr_all = F.log_softmax(ptr_logits, dim=-1)
    safe_par = parent.clamp(min=0)
    par_tok_lp = lp_ptr_all.gather(-1, safe_par.unsqueeze(-1)).squeeze(-1)
    seq_lp = seq_lp + 1.0 * (par_tok_lp * hp_f).sum(dim=-1) / hp_den

    # 4. Pose | part, color, parent
    par_feat = torch.gather(brick_keys, 1, safe_par.unsqueeze(-1).expand(-1, -1, model.cfg.width))
    anchor = torch.where(has_parent.unsqueeze(-1), par_feat, model.root_anchor.expand(b, S, -1))
    pout = model.predict_pose_from_anchor(h_pc, anchor)

    def _mean_lp(logits: torch.Tensor, target: torch.Tensor, m_f: torch.Tensor, den: torch.Tensor) -> torch.Tensor:
        lp = F.log_softmax(logits.float(), dim=-1)
        tok = lp.gather(-1, target.clamp(min=0).unsqueeze(-1)).squeeze(-1)
        return (tok * m_f).sum(dim=-1) / den

    lp_rel = (
        _mean_lp(pout["dx"], dx, hp_f, hp_den)
        + _mean_lp(pout["dy"], dy, hp_f, hp_den)
        + _mean_lp(pout["dz"], dz, hp_f, hp_den)
    ) / 3.0
    lp_abs = (
        _mean_lp(pout["ax"], ax, vb_f, vb_den)
        + _mean_lp(pout["ay"], ay, vb_f, vb_den)
        + _mean_lp(pout["az"], az, vb_f, vb_den)
    ) / 3.0
    lp_r24 = _mean_lp(pout["rot24"], rot24, vb_f, vb_den)
    return seq_lp + 1.2 * lp_rel + 0.8 * lp_abs + 0.8 * lp_r24


def train_dpo(
    base_ckpt: Path,
    pairs_npz: Path,
    out_ckpt: Path,
    steps: int = 300,
    batch_size: int = 8,
    lr: float = 2e-5,
    beta: float = 0.15,
    sft_alpha: float = 0.15,
    log_every: int = 20,
    seed: int = 0,
    device: str | None = None,
) -> dict:
    """Offline Reward-Guided DPO fine-tuning of `BrickGen v3` against a frozen reference policy."""
    dev = device or auto_device()
    torch.manual_seed(seed)
    np.random.seed(seed)

    policy, vocab, info = load_checkpoint(base_ckpt, device=dev)
    ref = copy.deepcopy(policy).eval()
    for p in ref.parameters():
        p.requires_grad_(False)
    policy.train()

    clip = ClipEncoder(device=dev, load_vision=False)
    raw = np.load(pairs_npz, allow_pickle=False)
    d = {k: raw[k] for k in raw.files}
    n_pairs = len(d["clip_lengths"])
    if n_pairs == 0:
        raise ValueError(f"Empty DPO dataset: {pairs_npz}")

    opt = torch.optim.AdamW(policy.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.01)
    rng = np.random.default_rng(seed)
    t0 = time.time()
    last_metrics: dict[str, float] = {}

    for step in range(1, steps + 1):
        idxs = rng.integers(0, n_pairs, size=min(batch_size, n_pairs))
        max_cl = max(int(d["clip_lengths"][idxs].max()), 2)
        cap_ids = torch.from_numpy(d["clip_tokens"][idxs, :max_cl].astype(np.int64))
        cap_mask = (torch.arange(max_cl)[None] < torch.from_numpy(d["clip_lengths"][idxs].astype(np.int64))[:, None]).to(dev)
        tt, tp = clip.encode_token_ids(cap_ids)

        bw = {k: v.to(dev) for k, v in _collate_dpo_side(d, "w", idxs, policy.cfg.max_bricks, policy.cfg.use_blueprint).items()}
        bl = {k: v.to(dev) for k, v in _collate_dpo_side(d, "l", idxs, policy.cfg.max_bricks, policy.cfg.use_blueprint).items()}

        with torch.no_grad():
            ref_w = sequence_logprob(ref, bw, tp, tt, cap_mask)
            ref_l = sequence_logprob(ref, bl, tp, tt, cap_mask)

        pol_w = sequence_logprob(policy, bw, tp, tt, cap_mask)
        pol_l = sequence_logprob(policy, bl, tp, tt, cap_mask)

        margin = (pol_w - ref_w) - (pol_l - ref_l)
        loss_dpo = -F.logsigmoid(beta * margin).mean()
        loss_sft = -pol_w.mean()
        loss = loss_dpo + sft_alpha * loss_sft

        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
        opt.step()

        pref_acc = float((margin > 0).float().mean().item())
        last_metrics = {
            "loss": round(float(loss.item()), 4),
            "dpo": round(float(loss_dpo.item()), 4),
            "sft": round(float(loss_sft.item()), 4),
            "margin": round(float(margin.mean().item()), 4),
            "pref_acc": round(pref_acc, 3),
        }
        if step % log_every == 0 or step == 1 or step == steps:
            print(
                f"[DPO step {step:4d}/{steps}] loss={last_metrics['loss']:.4f} dpo={last_metrics['dpo']:.4f} "
                f"margin={last_metrics['margin']:+.4f} pref_acc={last_metrics['pref_acc']:.3f} ({time.time() - t0:.1f}s)",
                flush=True,
            )

    out_ckpt = Path(out_ckpt)
    out_ckpt.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "config": policy.cfg.to_dict(),
        "vocab": vocab,
        "model": {k: v.detach().cpu().half() for k, v in policy.state_dict().items()},
        "step": int(info.get("step", 0)) + steps,
        "val_metrics": info.get("val_metrics", {}),
        "dpo_metrics": last_metrics,
        "attribution": "BrickGen v3 + Offline Reward-Guided DPO (BrickAnything recipe); BrickNet (CVPR 2026) + LDraw OMR.",
    }
    torch.save(payload, out_ckpt)
    print(f"Exported DPO-aligned checkpoint ({out_ckpt.stat().st_size / 1e6:.1f} MB) -> {out_ckpt}", flush=True)
    return {"out": str(out_ckpt), "pairs": n_pairs, "steps": steps, "metrics": last_metrics}


def collect_main() -> None:
    ap = argparse.ArgumentParser(description="Collect certified BrickGen preference pairs for offline DPO.")
    ap.add_argument("--ckpt", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/brickgen_v3.pt"))
    ap.add_argument("--blueprint-ckpt", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/dpo_pairs.npz"))
    ap.add_argument("--prompts-file", type=Path, default=None, help="Optional newline-separated prompts file")
    ap.add_argument("--samples", type=int, default=6)
    ap.add_argument("--max-parts", type=int, default=80)
    ap.add_argument("--min-parts", type=int, default=12)
    ap.add_argument("--min-margin", type=float, default=0.12)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    prompts = None
    if a.prompts_file is not None:
        prompts = [l.strip() for l in a.prompts_file.read_text().splitlines() if l.strip()]
    collect_dpo_pairs(
        ckpt=a.ckpt,
        out_npz=a.out,
        blueprint_ckpt=a.blueprint_ckpt,
        prompts=prompts,
        samples_per_prompt=a.samples,
        max_parts=a.max_parts,
        min_parts=a.min_parts,
        min_margin=a.min_margin,
        seed=a.seed,
    )


def train_main() -> None:
    ap = argparse.ArgumentParser(description="Fine-tune BrickGen v3 with Offline Reward-Guided DPO.")
    ap.add_argument("--base-ckpt", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/brickgen_v3.pt"))
    ap.add_argument("--pairs", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/dpo_pairs.npz"))
    ap.add_argument("--out", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/brickgen_v3_dpo.pt"))
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--beta", type=float, default=0.15)
    ap.add_argument("--sft-alpha", type=float, default=0.15)
    ap.add_argument("--log-every", type=int, default=20)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", type=str, default=None)
    a = ap.parse_args()
    train_dpo(
        base_ckpt=a.base_ckpt,
        pairs_npz=a.pairs,
        out_ckpt=a.out,
        steps=a.steps,
        batch_size=a.batch,
        lr=a.lr,
        beta=a.beta,
        sft_alpha=a.sft_alpha,
        log_every=a.log_every,
        seed=a.seed,
        device=a.device,
    )
