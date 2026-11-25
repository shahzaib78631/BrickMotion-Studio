"""Training loop for BrickGen on Apple Silicon MPS and NVIDIA CUDA (Google Colab A100/L4/T4).

Features:
  - Source-balanced sampling so OMR, MOC, and BrickHeadz receive strong weight alongside BrickNet.
  - Exact on-the-fly 4-way 90° Y-rotation augmentation (xyz, rot24, rot6d, bbox, quantized bins).
  - Live frozen CLIP ViT-B/32 text encoder producing BOTH 77-token hidden states AND pooled vectors.
  - Classifier-Free Guidance (CFG) dropout (10%) and source/scale metadata dropout (30%).
  - Resumable training checkpoints (`ckpt.pt`), best validation tracking (`best.pt`), and compact
    fp16 inference bundle export (`brickgen.pt`).
"""
from __future__ import annotations

import argparse
import json
import math
import queue
import threading
import time
from pathlib import Path

import numpy as np
import torch

from .blueprint import (
    BP_CH,
    BP_G,
    FRONTIER_DIM,
    build_color_rgba_lut,
    compute_blueprint_scale,
    compute_causal_frontier_features,
    encode_scale_vec,
    rasterize_blueprint,
)
from .clip_encoder import ClipEncoder
from .geometry import augment_mirror_x_arrays, augment_yaw90_arrays, quantize_abs, quantize_rel
from .model import (
    PAD_ID,
    PART_OFFSET,
    PRESETS,
    BrickGen,
    BrickGenConfig,
    scale_bucket,
)

DEFAULT_CORPUS = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/corpus_v3")
DEFAULT_RUN = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/run_v3")

# Target sampling probabilities across sources during training (v3):
# Quality-filtered BrickNet + higher share for real human-designed OMR/MOC/BrickHeadz builds.
DEFAULT_SOURCE_WEIGHTS = {
    1: 0.62,  # bricknet (>=8 parts, length-weighted toward richer 30-100 part builds)
    2: 0.28,  # omr (whole official LEGO sets 2x weighted over named sub-assemblies)
    3: 0.06,  # moc (custom Studio .io & .mpd MOCs)
    4: 0.04,  # brickheadz (character figures)
}


def build_mirror_tables_from_vocab(vocab: dict) -> tuple[np.ndarray, np.ndarray]:
    """Build (mirror_part_table[V] int64, mirror_ok[V] bool) from vocab.json."""
    parts = vocab["parts"]
    n = len(parts)
    idx_of = {s: i for i, s in enumerate(parts)}
    table = np.arange(n, dtype=np.int64)
    for a, b in (vocab.get("mirror_map") or {}).items():
        if a in idx_of and b in idx_of:
            table[idx_of[a]] = idx_of[b]
            table[idx_of[b]] = idx_of[a]
    raw_ok = vocab.get("mirror_ok")
    if raw_ok is not None and len(raw_ok) == n:
        ok = np.array(raw_ok, dtype=bool)
    else:
        ok = np.zeros(n, dtype=bool)
    return table, ok


def composite_val_score(vm: dict[str, float]) -> float:
    """Selection score balancing accuracy gains against uncalibrated CE overconfidence."""
    return (
        1.00 * vm.get("part_acc", 0.0)
        + 0.50 * vm.get("parent_acc", 0.0)
        + 0.50 * vm.get("rot24_acc", 0.0)
        + 0.30 * vm.get("color_acc", 0.0)
        - 0.03 * vm.get("loss", 20.0)
    )


def auto_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class BrickCorpusSplit:
    """Memory-compact in-RAM loader for one canonical BrickGen corpus split."""

    def __init__(
        self,
        npz_path: Path,
        max_bricks: int = 256,
        mirror_part_table: np.ndarray | None = None,
        mirror_ok: np.ndarray | None = None,
        color_rgba_lut: np.ndarray | None = None,
        compute_blueprint: bool = False,
    ):
        d = np.load(npz_path, allow_pickle=False)
        self.part_id = d["part_id"]
        self.color_id = d["color_id"]
        self.parent = d["parent"]
        self.xyz = d["xyz"]
        self.rot24 = d["rot24"]
        self.rot6d = d["rot6d"]
        self.bbox = d["bbox"]
        self.seq_ptr = d["seq_ptr"]
        self.source_id = d["source_id"]
        self.is_whole = d["is_whole"] if "is_whole" in d.files else np.ones(len(self.source_id), dtype=bool)
        self.cap_ptr = d["cap_ptr"]
        self.clip_tokens = d["clip_tokens"]
        self.clip_lengths = d["clip_lengths"]
        self.max_bricks = max_bricks
        self.n_models = len(self.source_id)
        self.lengths = np.minimum(np.diff(self.seq_ptr), max_bricks)
        self.mirror_part_table = mirror_part_table
        self.mirror_ok = mirror_ok
        self.color_rgba_lut = color_rgba_lut
        self.compute_blueprint = compute_blueprint

        # Index models by source with quality-aware length & whole-set weights
        self.by_source: dict[int, np.ndarray] = {}
        self.weights_by_source: dict[int, np.ndarray] = {}
        for s in np.unique(self.source_id).tolist():
            si = int(s)
            idxs = np.where(self.source_id == si)[0]
            self.by_source[si] = idxs
            w = np.sqrt(np.clip(self.lengths[idxs].astype(np.float64), 8.0, 256.0))
            if si in (2, 3):
                w *= np.where(self.is_whole[idxs], 2.0, 1.0)
            self.weights_by_source[si] = w / w.sum()

    def sample_batch(
        self,
        indices: np.ndarray,
        rng: np.random.Generator,
        augment: bool = True,
    ) -> tuple[dict[str, torch.Tensor], torch.Tensor, torch.Tensor]:
        """Materialize a padded batch of canonical models with optional exact 90° Y augmentation."""
        b = len(indices)
        lens = [int(self.lengths[i]) for i in indices]
        S = max(lens)

        part = np.full((b, S), PAD_ID, dtype=np.int64)
        color = np.zeros((b, S), dtype=np.int64)
        parent = np.full((b, S), -1, dtype=np.int64)
        rot24 = np.zeros((b, S), dtype=np.int64)
        ax = np.zeros((b, S), dtype=np.int64)
        ay = np.zeros((b, S), dtype=np.int64)
        az = np.zeros((b, S), dtype=np.int64)
        dx = np.zeros((b, S), dtype=np.int64)
        dy = np.zeros((b, S), dtype=np.int64)
        dz = np.zeros((b, S), dtype=np.int64)
        xyz = np.zeros((b, S, 3), dtype=np.float32)
        rot6d = np.zeros((b, S, 6), dtype=np.float32)
        bbox = np.zeros((b, S, 6), dtype=np.float32)
        src = np.zeros((b,), dtype=np.int64)
        scl = np.zeros((b,), dtype=np.int64)
        if self.compute_blueprint:
            bp_grid = np.zeros((b, BP_CH, BP_G, BP_G, BP_G), dtype=np.float32)
            bp_scale = np.zeros((b, 4), dtype=np.float32)
            frontier = np.zeros((b, S + 1, FRONTIER_DIM), dtype=np.float32)
        else:
            bp_grid = bp_scale = frontier = None

        cap_ids = np.zeros((b, 77), dtype=np.int64)
        cap_lens = np.zeros((b,), dtype=np.int64)

        for row, idx in enumerate(indices.tolist()):
            p0 = int(self.seq_ptr[idx])
            L = int(self.lengths[idx])
            p1 = p0 + L

            raw_p = self.part_id[p0:p1].astype(np.int64)
            ci = self.color_id[p0:p1].astype(np.int64)
            par = self.parent[p0:p1].astype(np.int64)
            xi = self.xyz[p0:p1].astype(np.float32)
            r24 = self.rot24[p0:p1].astype(np.int64)
            r6 = self.rot6d[p0:p1].astype(np.float32)
            bb = self.bbox[p0:p1].astype(np.float32)

            if augment:
                # 1. Exact 50% Left-Right X-Mirror Augmentation when all parts in the model are mirror-safe
                if (
                    self.mirror_ok is not None
                    and self.mirror_part_table is not None
                    and rng.random() < 0.5
                    and bool(self.mirror_ok[raw_p].all())
                ):
                    raw_p, xi, r24_m, r6, bb = augment_mirror_x_arrays(raw_p, xi, r24, r6, bb, self.mirror_part_table)
                    r24 = r24_m.astype(np.int64)
                # 2. Exact 4-way 90° Y-rotation augmentation
                k = int(rng.integers(0, 4))
                if k != 0:
                    xi, r24_new, r6, bb = augment_yaw90_arrays(xi, r24, r6, bb, k)
                    r24 = r24_new.astype(np.int64)
                # 3. Random stud-aligned horizontal translation jitter (keeps Y_up grounded)
                j_lim = 1 if self.compute_blueprint else 2
                jx = float(rng.integers(-j_lim, j_lim + 1)) * 20.0
                jz = float(rng.integers(-j_lim, j_lim + 1)) * 20.0
                if jx != 0.0 or jz != 0.0:
                    xi = xi.copy()
                    bb = bb.copy()
                    xi[:, 0] += jx
                    xi[:, 2] += jz
                    bb[:, [0, 3]] += jx
                    bb[:, [2, 5]] += jz

            if self.compute_blueprint and self.color_rgba_lut is not None:
                sv = compute_blueprint_scale(bb)
                g, sv = rasterize_blueprint(bb, ci, self.color_rgba_lut, scale_vec=sv, g=BP_G)
                fr = compute_causal_frontier_features(bb, g, sv, g=BP_G)
                bp_grid[row] = g
                bp_scale[row] = encode_scale_vec(sv)
                frontier[row, : L + 1] = fr

            pi = raw_p + PART_OFFSET

            qax, qay, qaz = quantize_abs(xi)
            # Compute relative offset to parent brick (0 for root)
            safe_par = np.maximum(par, 0)
            rel_xyz = xi - xi[safe_par]
            qdx, qdy, qdz = quantize_rel(rel_xyz)

            part[row, :L] = pi
            color[row, :L] = ci
            parent[row, :L] = par
            rot24[row, :L] = r24
            ax[row, :L], ay[row, :L], az[row, :L] = qax, qay, qaz
            dx[row, :L], dy[row, :L], dz[row, :L] = qdx, qdy, qdz
            xyz[row, :L] = xi
            rot6d[row, :L] = r6
            bbox[row, :L] = bb
            src[row] = int(self.source_id[idx])
            scl[row] = scale_bucket(int(self.seq_ptr[idx + 1] - self.seq_ptr[idx]))

            c0, c1 = int(self.cap_ptr[idx]), int(self.cap_ptr[idx + 1])
            crow = int(rng.integers(c0, c1)) if c1 > c0 else c0
            cap_ids[row] = self.clip_tokens[crow].astype(np.int64)
            cap_lens[row] = int(self.clip_lengths[crow])

        max_clen = max(int(cap_lens.max()), 2)
        cap_ids_t = torch.from_numpy(cap_ids[:, :max_clen])
        # Key padding mask: True for active tokens 0..cap_lens[row]-1
        pos_idx = torch.arange(max_clen)[None]
        cap_mask = pos_idx < torch.from_numpy(cap_lens)[:, None]

        batch = {
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
            "length": torch.tensor(lens, dtype=torch.long),
            "source": torch.from_numpy(src),
            "scale": torch.from_numpy(scl),
        }
        if self.compute_blueprint:
            batch["bp_grid"] = torch.from_numpy(bp_grid)
            batch["bp_scale"] = torch.from_numpy(bp_scale)
            batch["frontier"] = torch.from_numpy(frontier)
        return batch, cap_ids_t, cap_mask


def balanced_batch_iterator(
    split: BrickCorpusSplit,
    batch_size: int,
    rng: np.random.Generator,
    source_weights: dict[int, float] = DEFAULT_SOURCE_WEIGHTS,
):
    """Yields length-bucketed batches with source-balanced & quality-weighted sampling."""
    active_sources = [s for s in split.by_source if len(split.by_source[s]) > 0]
    raw_w = np.array([source_weights.get(s, 0.05) for s in active_sources], dtype=np.float64)
    probs = raw_w / raw_w.sum()

    pool_batches = 32
    pool_size = batch_size * pool_batches
    while True:
        # Draw a pool of model indices according to source + length/whole quality weights
        src_counts = rng.multinomial(pool_size, probs)
        pool = []
        for s, cnt in zip(active_sources, src_counts):
            if cnt > 0:
                arr = split.by_source[s]
                p_arr = split.weights_by_source.get(s)
                pool.append(rng.choice(arr, size=int(cnt), replace=True, p=p_arr))
        idx = np.concatenate(pool)
        # Sort pool by sequence length to minimize padding waste, then shuffle batches
        idx = idx[np.argsort(split.lengths[idx], kind="stable")]
        chunks = [idx[i : i + batch_size] for i in range(0, len(idx), batch_size) if len(idx[i : i + batch_size]) == batch_size]
        rng.shuffle(chunks)
        for ch in chunks:
            yield split.sample_batch(ch, rng, augment=True)


def _prefetch_iterator(gen_factory, num_workers: int = 3, pin_memory: bool = False, maxsize: int = 12):
    """Multi-threaded CPU prefetch producer so A100/L4 GPUs stay at 99% utilization."""
    q: queue.Queue = queue.Queue(maxsize=maxsize)
    stop = threading.Event()

    def _worker(wid: int):
        try:
            for item in gen_factory(wid):
                if stop.is_set():
                    break
                if pin_memory:
                    batch, cap_ids, cap_mask = item
                    batch = {k: v.pin_memory() for k, v in batch.items()}
                    item = (batch, cap_ids.pin_memory(), cap_mask.pin_memory())
                q.put(item)
        except Exception as exc:
            q.put(exc)

    threads = [threading.Thread(target=_worker, args=(w,), daemon=True) for w in range(max(1, num_workers))]
    for t in threads:
        t.start()
    try:
        while True:
            item = q.get()
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        stop.set()


def _to_device(batch: dict[str, torch.Tensor], dev: str) -> dict[str, torch.Tensor]:
    return {k: v.to(dev, non_blocking=True) for k, v in batch.items()}


@torch.no_grad()
def evaluate(
    model: BrickGen,
    clip: ClipEncoder,
    val_split: BrickCorpusSplit,
    dev: str,
    amp_dtype: torch.dtype | None,
    max_eval: int = 256,
    batch_size: int = 16,
    source_filter: tuple[int, ...] | None = None,
    force_drop_blueprint: bool = False,
) -> dict[str, float]:
    model.eval()
    rng = np.random.default_rng(12345)
    if source_filter is not None:
        pool = np.where(np.isin(val_split.source_id, list(source_filter)))[0]
    else:
        pool = np.arange(val_split.n_models, dtype=np.int64)
    if len(pool) == 0:
        model.train()
        return {}
    n = min(max_eval, len(pool))
    chosen = pool[np.linspace(0, len(pool) - 1, n).astype(np.int64)]
    chosen = chosen[np.argsort(val_split.lengths[chosen])]

    totals: dict[str, float] = {}
    batches = 0
    for i in range(0, n, batch_size):
        sub = chosen[i : i + batch_size]
        batch, cap_ids, cap_mask = val_split.sample_batch(sub, rng, augment=False)
        batch = _to_device(batch, dev)
        cap_mask = cap_mask.to(dev)
        if amp_dtype is not None and dev == "cuda":
            with torch.autocast("cuda", dtype=amp_dtype):
                text_toks, text_pool = clip.encode_token_ids(cap_ids)
                _, m = model.forward_loss(
                    batch,
                    text_pool,
                    text_toks,
                    cap_mask,
                    cfg_drop_prob=0.0,
                    meta_drop_prob=0.0,
                    force_drop_blueprint=force_drop_blueprint,
                )
        else:
            text_toks, text_pool = clip.encode_token_ids(cap_ids)
            _, m = model.forward_loss(
                batch,
                text_pool,
                text_toks,
                cap_mask,
                cfg_drop_prob=0.0,
                meta_drop_prob=0.0,
                force_drop_blueprint=force_drop_blueprint,
            )
        for k, v in m.items():
            totals[k] = totals.get(k, 0.0) + v
        batches += 1
    model.train()
    return {k: v / max(1, batches) for k, v in totals.items()}


def export_checkpoint(best_pt: Path, vocab_path: Path, out_pt: Path) -> Path:
    st = torch.load(best_pt, map_location="cpu", weights_only=False)
    vocab = json.loads(Path(vocab_path).read_text())
    payload = {
        "config": st["config"],
        "model": {k: v.half() for k, v in st["model"].items()},
        "vocab": {
            "parts": vocab["parts"],
            "part_bboxes": vocab["part_bboxes"],
            "part_conns": vocab.get("part_conns"),
            "mirror_map": vocab.get("mirror_map", {}),
            "colors": vocab["colors"],
            "color_rgba": vocab.get("color_rgba"),
            "color_names": vocab.get("color_names", {}),
            "sources": vocab.get("sources", {}),
            "attribution": vocab.get("attribution", ""),
        },
        "step": st.get("step", 0),
        "val_metrics": st.get("val_metrics", {}),
    }
    out_pt = Path(out_pt)
    out_pt.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, out_pt)
    print(f"Exported inference checkpoint ({out_pt.stat().st_size / 1e6:.1f} MB) -> {out_pt}", flush=True)
    return out_pt


def load_checkpoint(path: str | Path, device: str | None = None) -> tuple[BrickGen, dict, dict]:
    dev = device or auto_device()
    st = torch.load(path, map_location="cpu", weights_only=True)
    cfg = BrickGenConfig.from_dict(st["config"])
    model = BrickGen(cfg)
    model.load_state_dict({k: v.float() for k, v in st["model"].items()})
    model.to(dev).eval()
    return model, st["vocab"], {"step": st.get("step", 0), "val_metrics": st.get("val_metrics", {})}


def train(
    corpus_dir: Path = DEFAULT_CORPUS,
    out_dir: Path = DEFAULT_RUN,
    preset: str = "base",
    steps: int = 20_000,
    batch_size: int = 24,
    grad_accum: int = 1,
    lr: float = 3e-4,
    eval_every: int = 500,
    log_every: int = 50,
    minutes: float | None = None,
    max_bricks: int | None = None,
    use_blueprint: bool = True,
    seed: int = 0,
    device: str | None = None,
) -> dict:
    corpus_dir, out_dir = Path(corpus_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    dev = device or auto_device()
    torch.manual_seed(seed)
    np.random.seed(seed)

    vocab = json.loads((corpus_dir / "vocab.json").read_text())
    p_kw = dict(PRESETS[preset])
    if max_bricks is not None:
        p_kw["max_bricks"] = max_bricks
    p_kw["use_blueprint"] = bool(use_blueprint)

    cfg = BrickGenConfig(n_parts=len(vocab["parts"]), n_colors=len(vocab["colors"]), **p_kw)
    print(f"Device: {dev} | Preset: {preset} | Blueprint3D={cfg.use_blueprint} | Config: {cfg.to_dict()}", flush=True)

    mirror_table, mirror_ok = build_mirror_tables_from_vocab(vocab)
    color_lut = build_color_rgba_lut(vocab) if cfg.use_blueprint else None
    train_split = BrickCorpusSplit(
        corpus_dir / "train.npz",
        max_bricks=cfg.max_bricks,
        mirror_part_table=mirror_table,
        mirror_ok=mirror_ok,
        color_rgba_lut=color_lut,
        compute_blueprint=cfg.use_blueprint,
    )
    val_split = BrickCorpusSplit(
        corpus_dir / "val.npz",
        max_bricks=cfg.max_bricks,
        color_rgba_lut=color_lut,
        compute_blueprint=cfg.use_blueprint,
    )
    print(
        f"Loaded corpus: train={train_split.n_models:,} (by_src={ {k: len(v) for k, v in train_split.by_source.items()} }), "
        f"val={val_split.n_models:,}, mirror_safe_parts={int(mirror_ok.sum())}/{len(mirror_ok)}",
        flush=True,
    )

    clip = ClipEncoder(device=dev, load_vision=False)
    model = BrickGen(cfg).to(dev)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"BrickGen parameters: {n_params:,}", flush=True)

    # Precision & A100/CUDA TensorCore setup
    amp_dtype = None
    use_scaler = False
    if dev == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.set_float32_matmul_precision("high")
        if torch.cuda.is_bf16_supported():
            amp_dtype = torch.bfloat16
        else:
            amp_dtype = torch.float16
            use_scaler = True

    opt = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.05)
    scaler = torch.amp.GradScaler("cuda", enabled=use_scaler)

    ckpt_path = out_dir / "ckpt.pt"
    best_path = out_dir / "best.pt"
    best_ce_path = out_dir / "best_ce.pt"
    step = 0
    best_val = math.inf
    best_score = -math.inf
    history = []

    if ckpt_path.exists():
        st = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        model.load_state_dict(st["model"])
        opt.load_state_dict(st["opt"])
        if use_scaler and "scaler" in st:
            scaler.load_state_dict(st["scaler"])
        step = int(st["step"])
        best_val = float(st.get("best_val", math.inf))
        best_score = float(st.get("best_score", -math.inf))
        history = list(st.get("history", []))
        print(f"Resumed from step {step} (best_val={best_val:.4f}, best_score={best_score:.4f})", flush=True)

    warmup = min(500, max(10, steps // 20))

    def _lr_at(s: int) -> float:
        if s < warmup:
            return lr * (s + 1) / warmup
        prog = min(1.0, (s - warmup) / max(1, steps - warmup))
        return lr * (0.05 + 0.95 * 0.5 * (1.0 + math.cos(math.pi * prog)))

    def _save_ckpt() -> None:
        torch.save(
            {
                "config": cfg.to_dict(),
                "model": model.state_dict(),
                "opt": opt.state_dict(),
                "scaler": scaler.state_dict(),
                "step": step,
                "best_val": best_val,
                "best_score": best_score,
                "history": history,
            },
            ckpt_path,
        )

    def _run_eval() -> dict[str, float]:
        nonlocal best_val, best_score
        vm = evaluate(model, clip, val_split, dev, amp_dtype)
        vm_txt = evaluate(model, clip, val_split, dev, amp_dtype, max_eval=128, force_drop_blueprint=True) if cfg.use_blueprint else {}
        vm_bn = evaluate(model, clip, val_split, dev, amp_dtype, max_eval=128, source_filter=(1,))
        vm_om = evaluate(model, clip, val_split, dev, amp_dtype, max_eval=128, source_filter=(2, 3, 4))
        score = composite_val_score(vm)

        tags = []
        if score > best_score:
            best_score = score
            torch.save(
                {"config": cfg.to_dict(), "model": model.state_dict(), "step": step, "val_metrics": vm, "val_score": score},
                best_path,
            )
            export_checkpoint(best_path, corpus_dir / "vocab.json", out_dir / "brickgen.pt")
            tags.append("*BEST-ACC*")
        if vm["loss"] < best_val:
            best_val = vm["loss"]
            torch.save(
                {"config": cfg.to_dict(), "model": model.state_dict(), "step": step, "val_metrics": vm, "val_score": score},
                best_ce_path,
            )
            export_checkpoint(best_ce_path, corpus_dir / "vocab.json", out_dir / "brickgen_best_ce.pt")
            tags.append("*BEST-CE*")

        history.append({"step": step, "score": score, "val": vm, "val_text_only": vm_txt, "val_bricknet": vm_bn, "val_omr_moc": vm_om})
        tag = (" " + " ".join(tags)) if tags else ""
        extra = ""
        if vm_txt:
            extra += f" | txt_only_loss={vm_txt['loss']:.2f}(part={vm_txt['part_acc']*100:.1f}%)"
        if vm_bn and vm_om:
            extra += f" | BN={vm_bn['part_acc']*100:.1f}% OMR/MOC={vm_om['part_acc']*100:.1f}%"
        print(
            f"[VAL step {step:6d}] score={score:.4f} loss={vm['loss']:.4f} part={vm['part']:.3f}({vm['part_acc']*100:.1f}%) "
            f"col={vm['color']:.3f}({vm['color_acc']*100:.1f}%) par={vm['parent']:.3f}({vm['parent_acc']*100:.1f}%) "
            f"rel={vm['rel']:.3f} abs={vm['abs']:.3f} r24={vm['rot24']:.3f}({vm['rot24_acc']*100:.1f}%){extra}{tag}",
            flush=True,
        )
        _save_ckpt()
        (out_dir / "history.json").write_text(json.dumps(history, indent=1))
        return vm

    it = _prefetch_iterator(
        lambda wid: balanced_batch_iterator(train_split, batch_size, np.random.default_rng(seed + step + wid * 10007)),
        num_workers=3 if dev == "cuda" else 1,
        pin_memory=(dev == "cuda"),
        maxsize=12,
    )
    t0 = time.time()
    start_step = step
    running: dict[str, float] = {}
    n_log = 0
    model.train()

    while step < steps:
        if minutes is not None and (time.time() - t0) >= minutes * 60.0:
            print(f"Reached time budget ({minutes} min) at step {step}.", flush=True)
            break

        cur_lr = _lr_at(step)
        for g in opt.param_groups:
            g["lr"] = cur_lr
        opt.zero_grad(set_to_none=True)

        step_metrics: dict[str, float] = {}
        for _ in range(grad_accum):
            batch, cap_ids, cap_mask = next(it)
            batch = _to_device(batch, dev)
            cap_mask = cap_mask.to(dev, non_blocking=True)

            if amp_dtype is not None and dev == "cuda":
                with torch.autocast("cuda", dtype=amp_dtype):
                    text_toks, text_pool = clip.encode_token_ids(cap_ids)
                    loss, m = model.forward_loss(batch, text_pool, text_toks, cap_mask)
                    scaled_loss = loss / grad_accum
            else:
                text_toks, text_pool = clip.encode_token_ids(cap_ids)
                loss, m = model.forward_loss(batch, text_pool, text_toks, cap_mask)
                scaled_loss = loss / grad_accum

            if use_scaler:
                scaler.scale(scaled_loss).backward()
            else:
                scaled_loss.backward()
            for k, v in m.items():
                step_metrics[k] = step_metrics.get(k, 0.0) + v / grad_accum

        if use_scaler:
            scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        if use_scaler:
            scaler.step(opt)
            scaler.update()
        else:
            opt.step()

        step += 1
        for k, v in step_metrics.items():
            running[k] = running.get(k, 0.0) + v
        n_log += 1

        if step % log_every == 0 or step == 1:
            avg = {k: v / n_log for k, v in running.items()}
            elapsed = time.time() - t0
            sps = (step - start_step) / max(elapsed, 1e-3)
            print(
                f"step {step:6d}/{steps} | loss={avg['loss']:.4f} part={avg['part']:.3f}({avg['part_acc']*100:.1f}%) "
                f"col={avg['color']:.3f} par={avg['parent']:.3f}({avg['parent_acc']*100:.1f}%) "
                f"rel={avg['rel']:.3f} r24={avg['rot24']:.3f} | lr={cur_lr:.2e} {elapsed:.0f}s ({sps:.1f} it/s)",
                flush=True,
            )
            running.clear()
            n_log = 0

        if step % eval_every == 0 or step == steps:
            _run_eval()

    if not best_path.exists() or (history and history[-1]["step"] != step):
        _run_eval()

    out_export = out_dir / "brickgen.pt"
    export_checkpoint(best_path, corpus_dir / "vocab.json", out_export)
    return {"step": step, "best_val": best_val, "export": str(out_export)}


def main() -> None:
    ap = argparse.ArgumentParser(description="Train BrickGen 3D Pose-Grounded LEGO Transformer.")
    ap.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    ap.add_argument("--out", type=Path, default=DEFAULT_RUN)
    ap.add_argument("--preset", choices=list(PRESETS.keys()), default="base")
    ap.add_argument("--steps", type=int, default=15_000)
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--grad-accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--log-every", type=int, default=50)
    ap.add_argument("--minutes", type=float, default=None)
    ap.add_argument("--max-bricks", type=int, default=None)
    ap.add_argument("--no-blueprint", action="store_true", help="Disable v3 3D blueprint conditioning (v2 mode)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", type=str, default=None)
    a = ap.parse_args()
    train(
        corpus_dir=a.corpus,
        out_dir=a.out,
        preset=a.preset,
        steps=a.steps,
        batch_size=a.batch,
        grad_accum=a.grad_accum,
        lr=a.lr,
        eval_every=a.eval_every,
        log_every=a.log_every,
        minutes=a.minutes,
        max_bricks=a.max_bricks,
        use_blueprint=not a.no_blueprint,
        seed=a.seed,
        device=a.device,
    )


if __name__ == "__main__":
    main()
