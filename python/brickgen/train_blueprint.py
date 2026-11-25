"""Training & sampling for Stage-1 BlueprintFlow3D (Text -> 16x16x16x5 Colored 3D LEGO Blueprint).

Trains on BOTH:
  1. Unified canonical LEGO models (BrickNet + OMR + MOC + BrickHeadz) with full RGB + translucency + occupancy.
  2. StableText2Brick (42.6k captioned 3D shapes) with occupancy + physical scale supervision (color masked).

Runs fast on Apple Silicon MPS AND NVIDIA CUDA (A100 bf16: ~10 min for 15,000 steps!).
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
    blueprint_flip_x,
    blueprint_rot_yaw90,
    build_color_rgba_lut,
    compute_blueprint_scale,
    encode_scale_vec,
    rasterize_blueprint,
    render_blueprint_preview,
)
from .blueprint_model import BP_PRESETS, BlueprintFlow3D, BlueprintFlowConfig
from .clip_encoder import ClipEncoder
from .model import scale_bucket
from .train import auto_device

DEFAULT_CORPUS = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/corpus_v3")
DEFAULT_OUT = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/run_blueprint")

# Source sampling shares across LEGO + StableText2Brick
DEFAULT_BP_WEIGHTS = {
    1: 0.42,  # bricknet (color + trans + occ)
    2: 0.25,  # omr (official LEGO sets)
    3: 0.05,  # moc (custom Studio MOCs)
    4: 0.03,  # brickheadz
    5: 0.25,  # stabletext2brick (42.6k clean 3D shapes, occ + scale)
}


class BlueprintDataset:
    """Unified in-RAM dataset serving augmented 16x16x16x5 blueprints from LEGO corpus + StableText2Brick."""

    def __init__(
        self,
        npz_path: Path,
        color_rgba_lut: np.ndarray,
        stb_npz_path: Path | None = None,
        stb_split_id: int = 0,  # 0=train, 1=val
    ):
        d = np.load(npz_path, allow_pickle=False)
        self.color_id = d["color_id"]
        self.bbox = d["bbox"]
        self.seq_ptr = d["seq_ptr"]
        self.source_id = d["source_id"]
        self.is_whole = d["is_whole"] if "is_whole" in d.files else np.ones(len(self.source_id), dtype=bool)
        self.cap_ptr = d["cap_ptr"]
        self.clip_tokens = d["clip_tokens"]
        self.clip_lengths = d["clip_lengths"]
        self.color_rgba_lut = color_rgba_lut
        self.lengths = np.diff(self.seq_ptr)
        self.n_lego = len(self.source_id)

        self.by_source: dict[int, np.ndarray] = {}
        self.weights_by_source: dict[int, np.ndarray] = {}
        for s in np.unique(self.source_id).tolist():
            si = int(s)
            idxs = np.where(self.source_id == si)[0]
            self.by_source[si] = idxs
            # Quality weighting: favor richer multi-part builds & whole OMR/MOC sets
            w = np.sqrt(np.clip(self.lengths[idxs].astype(np.float64), 8.0, 256.0))
            if si in (2, 3):
                w *= np.where(self.is_whole[idxs], 2.0, 1.0)
            self.weights_by_source[si] = w / w.sum()

        # Optional StableText2Brick shapes (source_id = 5)
        self.has_stb = False
        if stb_npz_path is not None and Path(stb_npz_path).exists():
            sd = np.load(stb_npz_path, allow_pickle=False)
            keep = np.where(sd["split"] == stb_split_id)[0]
            if len(keep) > 0:
                self.has_stb = True
                self.stb_occ_bits = sd["occ_bits"]
                self.stb_scale = sd["scale_vec"]
                self.stb_cap_ptr = sd["cap_ptr"]
                self.stb_clip_tokens = sd["clip_tokens"]
                self.stb_clip_lengths = sd["clip_lengths"]
                self.by_source[5] = keep
                self.weights_by_source[5] = np.full(len(keep), 1.0 / len(keep), dtype=np.float64)

    def _unpack_stb_occ(self, idx: int) -> np.ndarray:
        bits = np.unpackbits(self.stb_occ_bits[idx])[: BP_G ** 3]
        return bits.reshape(BP_G, BP_G, BP_G).astype(np.float32)

    def sample_batch(
        self,
        batch_size: int,
        rng: np.random.Generator,
        augment: bool = True,
        source_weights: dict[int, float] = DEFAULT_BP_WEIGHTS,
        fixed_pairs: list[tuple[int, int]] | None = None,
    ) -> dict[str, torch.Tensor]:
        if fixed_pairs is None:
            active = [s for s in self.by_source if len(self.by_source[s]) > 0]
            rw = np.array([source_weights.get(s, 0.05) for s in active], dtype=np.float64)
            probs = rw / rw.sum()
            counts = rng.multinomial(batch_size, probs)
            pairs: list[tuple[int, int]] = []
            for s, cnt in zip(active, counts):
                if cnt > 0:
                    picks = rng.choice(self.by_source[s], size=int(cnt), replace=True, p=self.weights_by_source[s])
                    pairs.extend((s, int(i)) for i in picks)
            rng.shuffle(pairs)
        else:
            pairs = fixed_pairs
            batch_size = len(pairs)

        grids = np.zeros((batch_size, BP_CH, BP_G, BP_G, BP_G), dtype=np.float32)
        scales = np.zeros((batch_size, 4), dtype=np.float32)
        has_color = np.zeros((batch_size,), dtype=bool)
        src_arr = np.zeros((batch_size,), dtype=np.int64)
        scl_arr = np.zeros((batch_size,), dtype=np.int64)
        cap_ids = np.zeros((batch_size, 77), dtype=np.int64)
        cap_lens = np.zeros((batch_size,), dtype=np.int64)

        for row, (s, idx) in enumerate(pairs):
            if s == 5:
                occ = self._unpack_stb_occ(idx)
                g = np.zeros((BP_CH, BP_G, BP_G, BP_G), dtype=np.float32)
                g[0] = occ
                sv = self.stb_scale[idx].astype(np.float32).copy()
                n_est = max(16.0, float(occ.sum()) * 0.25)
                has_color[row] = False
                c0, c1 = int(self.stb_cap_ptr[idx]), int(self.stb_cap_ptr[idx + 1])
                crow = int(rng.integers(c0, c1)) if (augment and c1 > c0) else c0
                cap_ids[row] = self.stb_clip_tokens[crow].astype(np.int64)
                cap_lens[row] = int(self.stb_clip_lengths[crow])
            else:
                p0, p1 = int(self.seq_ptr[idx]), int(self.seq_ptr[idx + 1])
                bb = self.bbox[p0:p1].astype(np.float32)
                ci = self.color_id[p0:p1].astype(np.int64)
                sv = compute_blueprint_scale(bb)
                g, sv = rasterize_blueprint(bb, ci, self.color_rgba_lut, scale_vec=sv, g=BP_G)
                n_est = float(p1 - p0)
                has_color[row] = True
                c0, c1 = int(self.cap_ptr[idx]), int(self.cap_ptr[idx + 1])
                crow = int(rng.integers(c0, c1)) if (augment and c1 > c0) else c0
                cap_ids[row] = self.clip_tokens[crow].astype(np.int64)
                cap_lens[row] = int(self.clip_lengths[crow])

            if augment:
                if rng.random() < 0.5:
                    g = blueprint_flip_x(g)
                k = int(rng.integers(0, 4))
                if k != 0:
                    g = blueprint_rot_yaw90(g, k)
                    if k % 2 == 1:
                        sv = np.array([sv[2], sv[1], sv[0], sv[3]], dtype=np.float32)

            grids[row] = g
            scales[row] = encode_scale_vec(sv, n_parts=n_est)
            src_arr[row] = s
            scl_arr[row] = scale_bucket(int(round(n_est)))

        max_clen = max(int(cap_lens.max()), 2)
        cap_ids_t = torch.from_numpy(cap_ids[:, :max_clen])
        cap_mask = torch.arange(max_clen)[None] < torch.from_numpy(cap_lens)[:, None]

        return {
            "grid": torch.from_numpy(grids),
            "norm_scale": torch.from_numpy(scales),
            "has_color": torch.from_numpy(has_color),
            "source": torch.from_numpy(src_arr),
            "scale": torch.from_numpy(scl_arr),
            "cap_ids": cap_ids_t,
            "cap_mask": cap_mask,
        }


def _prefetch(ds: BlueprintDataset, batch_size: int, seed: int, num_workers: int = 2, pin_memory: bool = False):
    q: queue.Queue = queue.Queue(maxsize=12)
    stop = threading.Event()

    def _worker(wid: int):
        rng = np.random.default_rng(seed + wid * 10007)
        try:
            while not stop.is_set():
                b = ds.sample_batch(batch_size, rng, augment=True)
                if pin_memory:
                    b = {k: v.pin_memory() for k, v in b.items()}
                q.put(b)
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


@torch.no_grad()
def evaluate_blueprint(
    model: BlueprintFlow3D,
    clip: ClipEncoder,
    val_ds: BlueprintDataset,
    dev: str,
    amp_dtype: torch.dtype | None,
    max_eval: int = 256,
    batch_size: int = 32,
) -> dict[str, float]:
    model.eval()
    rng = np.random.default_rng(777)
    # Deterministic stratified validation set across LEGO sources + STB
    pairs: list[tuple[int, int]] = []
    for s in sorted(val_ds.by_source.keys()):
        arr = val_ds.by_source[s]
        if len(arr) == 0:
            continue
        k = min(len(arr), max(8, max_eval // max(1, len(val_ds.by_source))))
        picks = arr[np.linspace(0, len(arr) - 1, k).astype(np.int64)]
        pairs.extend((s, int(i)) for i in picks)
    pairs = pairs[:max_eval]

    totals: dict[str, float] = {}
    batches = 0
    for i in range(0, len(pairs), batch_size):
        b = val_ds.sample_batch(batch_size, rng, augment=False, fixed_pairs=pairs[i : i + batch_size])
        grid = b["grid"].to(dev)
        ns = b["norm_scale"].to(dev)
        hc = b["has_color"].to(dev)
        src = b["source"].to(dev)
        scl = b["scale"].to(dev)
        cm = b["cap_mask"].to(dev)
        if amp_dtype is not None and dev == "cuda":
            with torch.autocast("cuda", dtype=amp_dtype):
                tt, tp = clip.encode_token_ids(b["cap_ids"])
                _, m = model.forward_loss(grid, ns, hc, tp, tt, cm, src, scl, cfg_drop_prob=0.0, meta_drop_prob=0.0)
        else:
            tt, tp = clip.encode_token_ids(b["cap_ids"])
            _, m = model.forward_loss(grid, ns, hc, tp, tt, cm, src, scl, cfg_drop_prob=0.0, meta_drop_prob=0.0)
        for k, v in m.items():
            totals[k] = totals.get(k, 0.0) + v
        batches += 1
    model.train()
    return {k: v / max(1, batches) for k, v in totals.items()}


def export_blueprint_checkpoint(best_pt: Path, out_pt: Path) -> Path:
    st = torch.load(best_pt, map_location="cpu", weights_only=False)
    payload = {
        "config": st["config"],
        "model": {k: v.half() for k, v in st["model"].items()},
        "step": st.get("step", 0),
        "val_metrics": st.get("val_metrics", {}),
    }
    out_pt = Path(out_pt)
    out_pt.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, out_pt)
    print(f"Exported Stage-1 blueprint checkpoint ({out_pt.stat().st_size / 1e6:.1f} MB) -> {out_pt}", flush=True)
    return out_pt


def load_blueprint_checkpoint(path: str | Path, device: str | None = None) -> tuple[BlueprintFlow3D, dict]:
    dev = device or auto_device()
    st = torch.load(path, map_location="cpu", weights_only=True)
    cfg = BlueprintFlowConfig.from_dict(st["config"])
    model = BlueprintFlow3D(cfg)
    model.load_state_dict({k: v.float() for k, v in st["model"].items()})
    model.to(dev).eval()
    return model, {"step": st.get("step", 0), "val_metrics": st.get("val_metrics", {})}


def train_blueprint(
    corpus_dir: Path = DEFAULT_CORPUS,
    out_dir: Path = DEFAULT_OUT,
    preset: str = "base",
    steps: int = 15_000,
    batch_size: int = 64,
    grad_accum: int = 1,
    lr: float = 3e-4,
    eval_every: int = 500,
    log_every: int = 50,
    minutes: float | None = None,
    seed: int = 0,
    device: str | None = None,
) -> dict:
    corpus_dir, out_dir = Path(corpus_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    dev = device or auto_device()
    torch.manual_seed(seed)
    np.random.seed(seed)

    vocab = json.loads((corpus_dir / "vocab.json").read_text())
    lut = build_color_rgba_lut(vocab)
    stb_path = corpus_dir / "stb_blueprints.npz"
    if not stb_path.exists():
        stb_path = None

    train_ds = BlueprintDataset(corpus_dir / "train.npz", lut, stb_npz_path=stb_path, stb_split_id=0)
    val_ds = BlueprintDataset(corpus_dir / "val.npz", lut, stb_npz_path=stb_path, stb_split_id=1)

    cfg = BlueprintFlowConfig(**BP_PRESETS[preset])
    model = BlueprintFlow3D(cfg).to(dev)
    clip = ClipEncoder(device=dev, load_vision=False)
    print(
        f"[Stage-1 BlueprintFlow3D] Device={dev} | preset={preset} | params={sum(p.numel() for p in model.parameters()):,} | "
        f"train_by_src={ {k: len(v) for k, v in train_ds.by_source.items()} }",
        flush=True,
    )

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

    opt = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.03)
    scaler = torch.amp.GradScaler("cuda", enabled=use_scaler)

    ckpt_path = out_dir / "bp_ckpt.pt"
    best_path = out_dir / "bp_best.pt"
    step = 0
    best_val = math.inf
    history = []

    if ckpt_path.exists():
        st = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        model.load_state_dict(st["model"])
        opt.load_state_dict(st["opt"])
        if use_scaler and "scaler" in st:
            scaler.load_state_dict(st["scaler"])
        step = int(st["step"])
        best_val = float(st.get("best_val", math.inf))
        history = list(st.get("history", []))
        print(f"Resumed Stage-1 from step {step} (best_val={best_val:.4f})", flush=True)

    warmup = min(500, max(10, steps // 20))

    def _lr_at(s: int) -> float:
        if s < warmup:
            return lr * (s + 1) / warmup
        prog = min(1.0, (s - warmup) / max(1, steps - warmup))
        return lr * (0.05 + 0.95 * 0.5 * (1.0 + math.cos(math.pi * prog)))

    def _run_eval():
        nonlocal best_val
        vm = evaluate_blueprint(model, clip, val_ds, dev, amp_dtype)
        tag = ""
        if vm["loss"] < best_val:
            best_val = vm["loss"]
            torch.save({"config": cfg.to_dict(), "model": model.state_dict(), "step": step, "val_metrics": vm}, best_path)
            export_blueprint_checkpoint(best_path, out_dir / "blueprint.pt")
            tag = " *BEST*"
        history.append({"step": step, "val": vm})
        print(
            f"[BP-VAL step {step:6d}] loss={vm['loss']:.4f} occ={vm['occ']:.4f} col={vm['col']:.4f} "
            f"scale={vm['scale']:.4f} iou={vm['iou']:.3f} col_l1={vm['col_l1']:.3f}{tag}",
            flush=True,
        )
        torch.save(
            {
                "config": cfg.to_dict(),
                "model": model.state_dict(),
                "opt": opt.state_dict(),
                "scaler": scaler.state_dict(),
                "step": step,
                "best_val": best_val,
                "history": history,
            },
            ckpt_path,
        )
        (out_dir / "bp_history.json").write_text(json.dumps(history, indent=1))

    it = _prefetch(train_ds, batch_size, seed + step, num_workers=2 if dev == "cuda" else 1, pin_memory=(dev == "cuda"))
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

        step_m: dict[str, float] = {}
        for _ in range(grad_accum):
            b = next(it)
            grid = b["grid"].to(dev, non_blocking=True)
            ns = b["norm_scale"].to(dev, non_blocking=True)
            hc = b["has_color"].to(dev, non_blocking=True)
            src = b["source"].to(dev, non_blocking=True)
            scl = b["scale"].to(dev, non_blocking=True)
            cm = b["cap_mask"].to(dev, non_blocking=True)
            if amp_dtype is not None and dev == "cuda":
                with torch.autocast("cuda", dtype=amp_dtype):
                    tt, tp = clip.encode_token_ids(b["cap_ids"])
                    loss, m = model.forward_loss(grid, ns, hc, tp, tt, cm, src, scl)
                    sl = loss / grad_accum
            else:
                tt, tp = clip.encode_token_ids(b["cap_ids"])
                loss, m = model.forward_loss(grid, ns, hc, tp, tt, cm, src, scl)
                sl = loss / grad_accum
            if use_scaler:
                scaler.scale(sl).backward()
            else:
                sl.backward()
            for k, v in m.items():
                step_m[k] = step_m.get(k, 0.0) + v / grad_accum

        if use_scaler:
            scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        if use_scaler:
            scaler.step(opt)
            scaler.update()
        else:
            opt.step()

        step += 1
        for k, v in step_m.items():
            running[k] = running.get(k, 0.0) + v
        n_log += 1

        if step % log_every == 0 or step == 1:
            avg = {k: v / n_log for k, v in running.items()}
            elapsed = time.time() - t0
            sps = (step - start_step) / max(elapsed, 1e-3)
            print(
                f"bp step {step:6d}/{steps} | loss={avg['loss']:.4f} occ={avg['occ']:.4f} col={avg['col']:.4f} "
                f"iou={avg['iou']:.3f} col_l1={avg['col_l1']:.3f} | lr={cur_lr:.2e} {elapsed:.0f}s ({sps:.1f} it/s)",
                flush=True,
            )
            running.clear()
            n_log = 0

        if step % eval_every == 0 or step == steps:
            _run_eval()

    if not best_path.exists() or (history and history[-1]["step"] != step):
        _run_eval()

    out_export = export_blueprint_checkpoint(best_path, out_dir / "blueprint.pt")
    return {"step": step, "best_val": best_val, "export": str(out_export)}


def sample_blueprint_cli() -> None:
    ap = argparse.ArgumentParser(description="Sample and preview 3D colored blueprints from Stage-1 BlueprintFlow3D.")
    ap.add_argument("prompt", type=str)
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("/Users/mac/Projects/BrickMotion-Data/brickgen/blueprint_preview.png"))
    ap.add_argument("--n", type=int, default=4)
    ap.add_argument("--steps", type=int, default=32)
    ap.add_argument("--cfg", type=float, default=4.0)
    ap.add_argument("--no-symmetric", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    dev = auto_device()
    model, _ = load_blueprint_checkpoint(a.ckpt, device=dev)
    clip = ClipEncoder(device=dev, load_vision=False)
    ids_np, lens_np = clip.tokenize([a.prompt] * a.n)
    L = max(int(lens_np[0]), 2)
    tt, tp = clip.encode_token_ids(torch.from_numpy(ids_np[:, :L]))
    tm = torch.ones((a.n, L), dtype=torch.bool, device=dev)
    grids, scales, est_parts = model.sample(
        tp, tt, tm, n_steps=a.steps, cfg_scale=a.cfg, symmetric=not a.no_symmetric, seed=a.seed
    )
    a.out.parent.mkdir(parents=True, exist_ok=True)
    for i in range(a.n):
        p = a.out.with_name(f"{a.out.stem}_{i}{a.out.suffix}") if a.n > 1 else a.out
        render_blueprint_preview(grids[i], p)
        occ_n = int((grids[i, 0] > 0.5).sum())
        print(f"Saved {p} | occ={occ_n} vox | span={scales[i][:3].round(0).tolist()} LDU | est_parts={est_parts[i]}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="Train Stage-1 BlueprintFlow3D (Text -> 3D Colored Blueprint).")
    ap.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--preset", choices=list(BP_PRESETS.keys()), default="base")
    ap.add_argument("--steps", type=int, default=15_000)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--grad-accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--log-every", type=int, default=50)
    ap.add_argument("--minutes", type=float, default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", type=str, default=None)
    a = ap.parse_args()
    train_blueprint(
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
        seed=a.seed,
        device=a.device,
    )


if __name__ == "__main__":
    main()
