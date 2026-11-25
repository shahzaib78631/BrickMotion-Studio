"""Build a compact Google Colab GPU training bundle (A100 / L4 / T4) for BrickGen v3 (2-Stage Coarse-to-Fine).

Packages:
  - Unified canonical LEGO corpus v3 (`train.npz`, `val.npz`, `vocab.json`)
  - Optional `stb_blueprints.npz` (47k StableText2Brick 16^3 silhouettes for Stage-1!)
  - Pure-PyTorch `python/brickgen/` training code (zero C++ or LDraw needed on Colab!)
  - Unified `brickgen_v3_colab_train.ipynb` that trains BOTH:
      Stage 1: BlueprintFlow3D (Text -> 16x16x16x5 colored 3D silhouette + physical scale, ~10m on A100)
               + inline visual PNG blueprint previews right inside Colab!
      Stage 2: BrickGen v3 (3D Blueprint-Conditioned + Causal Frontier-Aware Brick Transformer, ~45m on A100)
               + exports `blueprint.pt`, `brickgen_v3.pt`, and `brickgen_v3_best_ce.pt` to Google Drive!
"""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

DEFAULT_CORPUS = Path("/Users/mac/Projects/BrickMotion-Data/brickgen/corpus_v3")
DEFAULT_OUT = Path("/Users/mac/Projects/BrickMotion-Data/colab-brickgen-v3")
PKG_DIR = Path(__file__).resolve().parent

CODE_FILES = [
    "__init__.py",
    "blueprint.py",
    "blueprint_model.py",
    "clip_encoder.py",
    "geometry.py",
    "model.py",
    "train.py",
    "train_blueprint.py",
]

CORPUS_FILES = [
    "vocab.json",
    "train.npz",
    "val.npz",
]
OPTIONAL_CORPUS_FILES = [
    "stb_blueprints.npz",
]


def _cell(src: str, kind: str = "code") -> dict:
    c = {"cell_type": kind, "metadata": {}, "source": src.splitlines(keepends=True)}
    if kind == "code":
        c.update(execution_count=None, outputs=[])
    return c


def build_notebook() -> dict:
    intro = """# BrickGen v3 — Two-Stage Coarse-to-Fine Text-to-LEGO Training (Google Colab GPU)

Trains the full **BrickGen v3** 2-stage architecture on **BrickNet + OMR + MOC + BrickHeadz + StableText2Brick**:
1. **Stage 1 (`BlueprintFlow3D`, ~27M params, ~10–12 min on A100)**: 3D Patchified Diffusion Transformer (Rectified Flow) that maps text prompts to globally coherent, bilaterally symmetric `16×16×16×5` colored 3D silhouettes `[occ, R, G, B, trans]` + physical proportions `(span_x, span_y, span_z)`.
2. **Stage 2 (`BrickGen v3`, ~96M params, ~45 min on A100)**: 3D Blueprint-Conditioned + Causal Frontier-Aware Brick Transformer with Dual Classifier-Free Guidance (`w_text` + `w_shape`), exact chiral X-mirror augmentation, and quality-weighted sampling toward full human-designed LEGO builds.

### Quick Start
1. **Runtime → Change runtime type → A100 GPU** (L4 also works automatically).
2. Upload `brickgen-v3-colab-bundle.zip` to `MyDrive/brickgen/` in Google Drive (or `/content/`).
3. Run all cells. Both stages auto-resume from Google Drive if interrupted!
4. Download **`blueprint.pt`** and **`brickgen_v3.pt`** from `MyDrive/brickgen/run_v3/` into `/Users/mac/Projects/BrickMotion-Data/brickgen/` on your Mac!

*Attribution: BrickNet (Kulits & Schmid, CVPR 2026), LDraw OMR (CC BY 2.0/4.0), and StableText2Brick (MIT).*
"""

    settings = """# === BrickGen v3 Two-Stage Training Configuration ===
RUN_STAGE1 = True           # Stage 1: BlueprintFlow3D (Text -> 16x16x16x5 colored 3D silhouette)
BP_PRESET = "base"          # 27M params 3D DiT (fast, crisp global silhouettes)
BP_STEPS = 15000            # ~10-12 min on A100 bf16
BP_LR = 3e-4

RUN_STAGE2 = True           # Stage 2: BrickGen v3 (3D Blueprint + Frontier-Aware Brick Transformer)
BRICK_PRESET = "large"      # ~96M params, max 384 bricks, dropout=0.20, Dual-CFG
BRICK_STEPS = 24000         # ~45 min on A100 bf16 (full cosine LR decay)
BRICK_LR = 3e-4
EVAL_EVERY = 1000

RUN_NAME = "run_v3"
USE_GOOGLE_DRIVE = True
DRIVE_DIR = "/content/drive/MyDrive/brickgen"
BUNDLE_ZIP = "/content/drive/MyDrive/brickgen/brickgen-v3-colab-bundle.zip"
"""

    setup = """import os, shutil, subprocess, sys, zipfile
from pathlib import Path
import torch

assert torch.cuda.is_available(), "No GPU detected! Go to Runtime -> Change runtime type -> GPU."
gpu_name = torch.cuda.get_device_name(0)
vram_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
print(f"GPU: {gpu_name} ({vram_gb:.1f} GB VRAM), bf16={torch.cuda.is_bf16_supported()}")

# Auto-pick batch sizes for both stages on A100 / L4 / T4
if vram_gb >= 35:      # A100 40GB/80GB
    BP_BATCH, BP_ACCUM = 128, 1
    BRICK_BATCH, BRICK_ACCUM = 64, 1
elif vram_gb >= 20:    # L4 24GB / A10G
    BP_BATCH, BP_ACCUM = 64, 2
    BRICK_BATCH, BRICK_ACCUM = 32, 2
else:                  # T4 16GB
    BP_BATCH, BP_ACCUM = 32, 4
    BRICK_BATCH, BRICK_ACCUM = 16, 4
print(f"Stage-1 batch: {BP_BATCH}x{BP_ACCUM}={BP_BATCH*BP_ACCUM} | Stage-2 batch: {BRICK_BATCH}x{BRICK_ACCUM}={BRICK_BATCH*BRICK_ACCUM}")

if USE_GOOGLE_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    Path(DRIVE_DIR).mkdir(parents=True, exist_ok=True)

bundle_path = Path(BUNDLE_ZIP)
if not bundle_path.exists():
    alt = Path("/content/brickgen-v3-colab-bundle.zip")
    if alt.exists():
        bundle_path = alt
    else:
        raise FileNotFoundError(f"Upload brickgen-v3-colab-bundle.zip to {BUNDLE_ZIP} or /content/")

WORK = Path("/content/brickgen_v3_work")
if WORK.exists():
    shutil.rmtree(WORK)
WORK.mkdir(parents=True)
with zipfile.ZipFile(bundle_path) as zf:
    zf.extractall(WORK)

CORPUS_DIR = WORK / "corpus"
CODE_DIR = WORK / "code"
RUN_DIR = Path(DRIVE_DIR) / RUN_NAME if USE_GOOGLE_DRIVE else WORK / RUN_NAME
STAGE1_DIR = RUN_DIR / "stage1_blueprint"
STAGE2_DIR = RUN_DIR / "stage2_brickgen"
STAGE1_DIR.mkdir(parents=True, exist_ok=True)
STAGE2_DIR.mkdir(parents=True, exist_ok=True)
print("Corpus files:", sorted(p.name for p in CORPUS_DIR.iterdir()))
print("Run dir:", RUN_DIR)
"""

    download_clip = """# Cache CLIP ViT-B/32 weights locally for frozen text encoder
from huggingface_hub import snapshot_download
snap = snapshot_download(
    "openai/clip-vit-base-patch32",
    allow_patterns=["pytorch_model.bin", "vocab.json", "merges.txt", "config.json"],
)
print("CLIP snapshot ready:", snap)
"""

    run_s1 = """# === STAGE 1: Train BlueprintFlow3D (Text -> 16x16x16x5 Colored 3D Silhouette) ===
if RUN_STAGE1:
    cmd = [
        sys.executable, "-m", "brickgen.train_blueprint",
        "--corpus", str(CORPUS_DIR),
        "--out", str(STAGE1_DIR),
        "--preset", BP_PRESET,
        "--steps", str(BP_STEPS),
        "--batch", str(BP_BATCH),
        "--grad-accum", str(BP_ACCUM),
        "--lr", str(BP_LR),
        "--eval-every", str(EVAL_EVERY),
        "--log-every", "100",
    ]
    print("Running Stage 1:", " ".join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=CODE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        print(line, end="", flush=True)
    if p.wait() != 0:
        raise RuntimeError("Stage-1 training failed!")
    shutil.copy2(STAGE1_DIR / "blueprint.pt", RUN_DIR / "blueprint.pt")
    print("Copied Stage-1 weights ->", RUN_DIR / "blueprint.pt")
"""

    preview_s1 = """# === Visual Sanity Check of Stage-1 Generated 3D Colored Blueprints ===
sys.path.insert(0, str(CODE_DIR))
from IPython.display import display
from brickgen.blueprint import render_blueprint_preview
from brickgen.clip_encoder import ClipEncoder
from brickgen.train_blueprint import load_blueprint_checkpoint

bp_pt = RUN_DIR / "blueprint.pt"
if bp_pt.exists():
    bp_m, bp_info = load_blueprint_checkpoint(bp_pt, device="cuda")
    clip_e = ClipEncoder(device="cuda", load_vision=False)
    test_prompts = [
        "a sleek red LEGO sports car with black wheels, yellow headlights, and a clear windshield",
        "a detailed gray LEGO medieval castle tower with arches, battlements, and flags",
        "a white and blue LEGO delta-wing space starfighter with cockpit canopy",
        "a white LEGO cottage house with red sloped roof and windows",
    ]
    ids_np, lens_np = clip_e.tokenize(test_prompts)
    L = max(int(lens_np.max()), 2)
    tt, tp = clip_e.encode_token_ids(torch.from_numpy(ids_np[:, :L]))
    tm = torch.arange(L)[None] < torch.from_numpy(lens_np)[:, None]
    grids, scales, est = bp_m.sample(tp, tt, tm.to("cuda"), n_steps=32, cfg_scale=4.0, symmetric=True, seed=0)
    for i, pr in enumerate(test_prompts):
        print(f"[{i+1}] {pr} | occ={int((grids[i,0]>0.5).sum())} vox | span={scales[i][:3].round(0).tolist()} LDU | est_parts={est[i]}")
        im = render_blueprint_preview(grids[i], RUN_DIR / f"bp_preview_{i}.png", size=192)
        display(im)
    del bp_m, clip_e
    torch.cuda.empty_cache()
"""

    run_s2 = """# === STAGE 2: Train BrickGen v3 (3D Blueprint-Conditioned + Frontier-Aware Brick Transformer) ===
if RUN_STAGE2:
    cmd = [
        sys.executable, "-m", "brickgen.train",
        "--corpus", str(CORPUS_DIR),
        "--out", str(STAGE2_DIR),
        "--preset", BRICK_PRESET,
        "--steps", str(BRICK_STEPS),
        "--batch", str(BRICK_BATCH),
        "--grad-accum", str(BRICK_ACCUM),
        "--lr", str(BRICK_LR),
        "--eval-every", str(EVAL_EVERY),
        "--log-every", "100",
    ]
    print("Running Stage 2:", " ".join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=CODE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:
        print(line, end="", flush=True)
    if p.wait() != 0:
        raise RuntimeError("Stage-2 training failed!")
    for src_fn, dst_fn in [("brickgen.pt", "brickgen_v3.pt"), ("brickgen_best_ce.pt", "brickgen_v3_best_ce.pt")]:
        sp = STAGE2_DIR / src_fn
        if sp.exists():
            shutil.copy2(sp, RUN_DIR / dst_fn)
            print(f"Copied {dst_fn} ({sp.stat().st_size / 1e6:.1f} MB) -> {RUN_DIR / dst_fn}")
"""

    inspect_out = """import json
from pathlib import Path

for name, hp in [("Stage-1 BlueprintFlow3D", STAGE1_DIR / "bp_history.json"), ("Stage-2 BrickGen v3", STAGE2_DIR / "history.json")]:
    if hp.exists():
        hist = json.loads(hp.read_text())
        print(f"=== {name} ({len(hist)} evals) ===")
        if "score" in hist[0]:
            best_acc = max(hist, key=lambda r: r.get("score", -1e9))
            best_ce = min(hist, key=lambda r: r["val"]["loss"])
            print(f"  Best ACC step {best_acc['step']} (score={best_acc['score']:.4f}):", json.dumps(best_acc["val"]))
            if best_acc.get("val_text_only"):
                print("  Text-only (no BP):", json.dumps(best_acc["val_text_only"]))
            print(f"  Best CE  step {best_ce['step']}:", json.dumps(best_ce["val"]))
        else:
            best = min(hist, key=lambda r: r["val"]["loss"])
            print(f"  Best step {best['step']}:", json.dumps(best["val"]))

print("\\nReady to download from", RUN_DIR)
for fn in ["blueprint.pt", "brickgen_v3.pt", "brickgen_v3_best_ce.pt"]:
    p = RUN_DIR / fn
    if p.exists():
        print(f"  - {p.name} ({p.stat().st_size / 1e6:.1f} MB)")
"""

    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "language_info": {"name": "python"},
            "colab": {"provenance": [], "gpuType": "A100"},
            "accelerator": "GPU",
        },
        "cells": [
            _cell(intro, "markdown"),
            _cell(settings),
            _cell(setup),
            _cell(download_clip),
            _cell(run_s1),
            _cell(preview_s1),
            _cell(run_s2),
            _cell(inspect_out),
        ],
    }


def make_bundle(corpus_dir: Path = DEFAULT_CORPUS, out_dir: Path = DEFAULT_OUT) -> tuple[Path, Path]:
    corpus_dir, out_dir = Path(corpus_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / "brickgen-v3-colab-bundle.zip"
    nb_path = out_dir / "brickgen_v3_colab_train.ipynb"

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for fn in CORPUS_FILES:
            fp = corpus_dir / fn
            if not fp.exists():
                raise FileNotFoundError(f"Missing corpus file: {fp}. Run `python -m brickgen build-corpus` first.")
            zf.write(fp, f"corpus/{fn}")
        for fn in OPTIONAL_CORPUS_FILES:
            fp = corpus_dir / fn
            if fp.exists():
                zf.write(fp, f"corpus/{fn}")
        for fn in CODE_FILES:
            zf.write(PKG_DIR / fn, f"code/brickgen/{fn}")

    nb_path.write_text(json.dumps(build_notebook(), indent=1))
    print(f"Colab v3 bundle created:\n  zip: {zip_path} ({zip_path.stat().st_size / 1e6:.1f} MB)\n  nb : {nb_path}", flush=True)
    return zip_path, nb_path


def main() -> None:
    ap = argparse.ArgumentParser(description="Create Google Colab GPU 2-stage training bundle for BrickGen v3.")
    ap.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = ap.parse_args()
    make_bundle(a.corpus, a.out)


if __name__ == "__main__":
    main()
