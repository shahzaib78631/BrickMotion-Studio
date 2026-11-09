# Brick Lab Experiment 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow each caption as many parallel builds that are rendered, scored against the caption with CLIP, and resampled, and measure whether that closes at least half the CLIP-match gap between the Sketch model and real sets.

**Architecture:** A part renderer (point splats from LDraw triangles, Lambert shading, two three-quarter views) feeds CLIP ViT-B/32's image encoder; a score is the mean cosine between view embeddings and the caption's text embedding. The sampler's `generate` is split into a resumable `Run` so a population of runs can be stepped, scored every few parts, and resampled (sequential Monte Carlo). Baselines are scored with the same renderer: real val sets, the Sketch model (shape2.bin, cells as 1x1 plates), and single builds.

**Tech Stack:** Python 3.14 (scratchpad venv `$PV`), PyTorch (MPS), transformers CLIP ViT-B/32, numpy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-brick-lab-design.md` (Experiments table, row 2; "How it works" 3)

## Global Constraints

- Leave everything uncommitted (user rule: no commits unless asked).
- Only one MPS job at a time.
- Data stays in `/Users/mac/Projects/BrickMotion-Data/lab/`; lab modules run as `$PV -m lab.X` from `python/`.
- BrickNet (Kulits & Schmid, CVPR 2026) credited in every written model and report; research use.
- Builder weights: `BrickMotion-Data/lab/lab.pt` (load with `load_builder`, weights_only).
- Sampler rules from experiment 1 stay: legal moves, strict loose overlap, joint habits, `finish=True`, upright output.

## Review Focus

1. An empty or one-part model renders and scores without crashing (score of a blank image, not NaN).
2. A part with no geometry file (unknown stem) is skipped by the renderer, not fatal.
3. All runs in a population dead-ending (no legal move) still returns the best finished-or-partial run.
4. Resampling copies a run's World so children diverge without sharing mutable state.
5. Very tall or flat models still fill the frame (scale by the larger projected extent).

---

### Task 1: Part renderer and CLIP scorer

**Files:** Create `python/lab/render.py`; Test `python/tests/test_lab_render.py`

**Interfaces:**
- Produces: `part_points(stem) -> (points Nx3, normals Nx3)` cached; `render(stems, colours, poses, yaw, pitch=0.5, size=224) -> HxWx3 float`; `views(stems, colours, poses) -> list[img]` (yaw 0.8 and -0.8+π, front three-quarter views, y up = -LDraw y); `Scorer(device)` with `.text(list[str]) -> Nx512`, `.images(list[img]) -> Nx512`, `.score(models: list[(stems, colours, poses)], text_vec) -> np.ndarray` (mean view cosine per model).

- [ ] Test `test_render_brick_has_its_colour`: a red 3001 (colour 4) renders; > 3% of pixels are red-dominant; background stays light.
- [ ] Test `test_red_caption_prefers_red_brick`: `Scorer` scores "a red LEGO brick" higher for red 3001 than blue (colour 1) 3001.
- [ ] Tests for Review Focus 1, 2, 5: empty model and unknown stem render the background; a 1x1x40 tower spans > 60% of image height.
- [ ] Run, watch fail; implement; run, pass.

### Task 2: Baselines

**Files:** Create `python/lab/baselines.py`; Test `python/tests/test_lab_baselines.py`

**Interfaces:**
- Produces: `real_model(i) -> (stems, colours, poses)` (val model i, BrickNet poses, upright); `Sketch(path=public/data/ai/shape2.bin)` with `.model(text_vec, seed) -> (stems, colours, poses)`: GPT2 codes sampled (top-k 20) → VQ decode → each filled cell a `3024` plate at (20x, -8y, 20z) in its class colour ("other" → 71).
- [ ] Tests: `real_model(0)` has the val model's part count; `Sketch().model(text("a red car"))` returns ≥ 10 plates whose colours are LDraw codes from the shape2 colour table.
- [ ] Run, fail; implement (load tensors from the .bin header into shape2.VQ2/GPT2); pass.

### Task 3: Resumable runs and the parallel-builds search

**Files:** Modify `python/lab/sample.py` (split `generate` into `Run`); Create `python/lab/smc.py`; Test `python/tests/test_lab_smc.py`

**Interfaces:**
- Produces: `Run(model, vocab, new_world, clip, rules, seed, legal=True, finish=True, min_parts=2, max_parts=150)` with `.step() -> bool` (False once done), `.done`, `.finished`, `.world`, `.steps`, `.copy(seed) -> Run` (independent World/steps/rng); `generate(...)` keeps its signature and result, built on `Run`.
  `smc(model, vocab, new_world, clip, caption_vec, scorer, rules, n=16, every=8, max_parts=150, seed=0) -> dict(best: Run, scores, rounds, seconds)`: step all live runs `every` parts, render+score all runs, keep the top half by score (finished runs keep their score and stop), refill by copying survivors; return the best scoring finished run, else the best run.
- [ ] Tests: existing sample tests still pass (generate unchanged); `test_copy_diverges` (Review Focus 4); `test_smc_follows_the_scorer` with a fake scorer that rewards red parts: the smc best has a larger red share than the mean of the same number of single runs; `test_smc_all_dead_ends` (Review Focus 3).
- [ ] Run, fail; implement; pass.

### Task 4: Run experiment 2

**Files:** Create `python/lab/exp2.py`

**Interfaces:**
- Consumes: Tasks 1-3, `lab.pt`, `clip_val.npy`, val captions.
- Produces: `BrickMotion-Data/lab/exp2/` with per caption `real_##`, `sketch_##`, `single_##`, `smc_##` .ldr, `exp2.json` (caption, CLIP score per method, parts, seconds), `report.md` with mean scores and the pass check: `(smc - sketch) >= 0.5 * (real - sketch)`.
- [ ] Step 1: Same 64 val captions as experiment 1 (evenly spread rows). Run after experiment 1 finishes (one MPS job).
- [ ] Step 2: Report pass/fail, per-method means, time per caption.
- [ ] Step 3: Open the best 3 smc models in the app, screenshot, report to the user. Leave uncommitted.
