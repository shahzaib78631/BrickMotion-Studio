# Brick Lab, Experiment 1: the legal-moves builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A part-level builder model, trained on the 67k captioned BrickNet models, that generates 100-part models from a caption with zero overlaps, because every step is restricted to legal moves.

**Architecture:** Python package `python/lab/`. A model is a sequence of steps (part, colour, attach-to part, connectors, joint angles), BrickNet's graph representation. A small decoder transformer learns it, conditioned on the CLIP vector of a caption, and trains on Kaggle. A local sampler offers the model only legal moves at each step (free connectors, compatible types, no overlap), rolls back when stuck, and writes LDraw files. The app's own `certify()` is the final judge, run through vitest.

**Tech Stack:** Python 3 (numpy, torch, MPS locally, CUDA T4 on Kaggle), pytest; TypeScript and vitest for the app-side check.

**Spec:** `docs/superpowers/specs/2026-11-08-brick-lab-design.md` (Experiment 1 only. Experiments 2–4 get their own plans after the user has seen these results.)

## Global Constraints

- `PV` = the Python venv with numpy, torch 2.15 and pytest 9: `/private/tmp/claude-501/-Users-mac-Projects-BrickMotion-Studio/6f8fdaa7-2b4c-49b9-992e-b66b396951ff/scratchpad/pv/bin/python`. Data scripts run with `$PV -I`; tests run with `$PV -m pytest`.
- Data dir `D` = `/Users/mac/Projects/BrickMotion-Data/bricknet` (`sft.npz`, `val.npz`, `captions_sft.jsonl`, `captions_val.jsonl`, `captions_sft_clip.npy`, `part_names.json`, `labels.json.xz`). Read only. Generated data goes in `/Users/mac/Projects/BrickMotion-Data/lab/`.
- Reuse `python/bricknet/decode.py` (`Catalog`, `joint`, `load`, `model`, `realise`, `to_ldr`, `KINDS`) and `python/omr/voxelise.py` (`points`). Do not install the external `bricknet` package.
- Credit "BrickNet (Kulits & Schmid, CVPR 2026)" in every LDraw file header and the report.
- Disk is tight (about 20 GB free). Token data in int16/int32 npz; at most 2 checkpoints kept.
- Only one MPS job at a time: no local training while sampling runs.
- **No commits.** The user commits only when they ask; every "commit" step below is replaced by "leave uncommitted".
- Angles quantised to whole degrees and the axle slide to whole LDU, as BrickNet does.

## Review Focus

- A part with no connector frames or no geometry file gets picked → the sampler must never offer it (masked out of the part vocabulary). Test in Task 7.
- A baseplate with 2,304 connectors gets placed → a legal step must still take under 1 s. Test in Task 3.
- A part placed at a non-90° angle (hinge, ball) → the overlap test must still catch overlaps. Test in Task 3.
- The model asks for a parent index or connector that doesn't exist yet → masked, never an error. Test in Task 7.
- The Kaggle run restarts from an earlier run's output → it resumes from the checkpoint instead of starting again. Test in Task 6.

---

### Task 1: Connector types and what fits what

**Files:**
- Create: `python/lab/__init__.py` (empty), `python/lab/connectors.py`
- Test: `python/tests/test_lab_connectors.py`

**Interfaces:**
- Consumes: `decode.Catalog(D)`, `decode.load`, `decode.KINDS`.
- Produces:
  - `class Connectors(cat: Catalog)`
    - `.types(pid: int) -> list[str]`: one label per connector, in `Catalog.frames` order, written `"kind/sub/polarity"` (polarity `""` when the label has none).
    - `.frames(pid) -> np.ndarray (N,4,4)`: same as `Catalog.frames`.
  - `build_compat(arrs, conn) -> dict[tuple[str, str], dict[str, int]]`: counts, per (a-type, b-type), of each edge kind seen in the data.
  - `save_compat(path, compat)` / `load_compat(path)`: JSON at `/Users/mac/Projects/BrickMotion-Data/lab/compat.json`.
  - `fits(compat, ta: str, tb: str) -> list[str]`: the kinds allowed, best first; `[]` means not compatible.

- [ ] **Step 1: Write the failing tests**

```python
def test_types_align_with_frames(conn):          # for 200 random used parts
    assert len(conn.types(p)) == len(conn.frames(p))
def test_plate_stud_fits_plate_hole(compat, conn):  # 3023 (1x2 plate): a stud-type label and a hole-type label
    assert 'stud' in fits(compat, t_stud, t_hole)
def test_stud_does_not_fit_stud(compat):
    assert fits(compat, t_stud, t_stud) == []
def test_every_sft_edge_is_allowed(compat, conn):   # first 2,000 models of sft.npz
    assert all(e_kind in fits(compat, ta, tb) for each edge)
```

- [ ] **Step 2: Run them, expect failure** — `$PV -m pytest python/tests/test_lab_connectors.py -v` → ImportError.
- [ ] **Step 3: Implement `connectors.py`.** Walk `cat.labels[stem+'.dat']` in the same sorted order as `Catalog.frames`. Build compat from all of `sft.npz` with numpy (stack the type ids of both ends of each edge, then `np.unique` with counts), not a Python loop over 4M edges.
- [ ] **Step 4: Run them, expect PASS.** Write `compat.json` with `$PV -I -m lab.connectors` (a `__main__` that builds and saves it).
- [ ] **Step 5: Leave uncommitted.**

---

### Task 2: Step sequences — encode a model, decode it back

**Files:**
- Create: `python/lab/sequence.py`
- Test: `python/tests/test_lab_sequence.py`

**Interfaces:**
- Consumes: `Connectors`, `decode.model`, `decode.joint`.
- Produces:
  - `FIELDS = ('part','colour','parent','pconn','oconn','kind','a1','a2','a3','flip')`: 10 tokens per step.
  - `class Vocab`
    - ranges, in this order: specials `PAD, BOS, EOS, NONE`; parts (catalog pids used in sft, mapped densely); colours (330 used codes); parent `0..99`; connector `0..2303`; kind (6); angle `0..359`; slide `-330..330`; flip `0,1`.
    - methods `.encode(field, value) -> int`, `.decode(token) -> (field, value)`, `.range(field) -> (lo, hi)`, `.save(path)`, `Vocab.load(path)`.
  - `to_steps(pids, colors, edges, root: int) -> list[dict]`: breadth-first spanning tree from `root`, one dict per part with the FIELDS keys. The root's step has only part and colour; the rest are `None`.
  - `encode(steps, vocab) -> np.ndarray[int32]`: `BOS + 10·len(steps) tokens + EOS`.
  - `decode_tokens(tokens, vocab) -> list[dict]`.
  - `poses(steps, conn) -> list[np.ndarray(4,4)]`: world pose per step, root at identity.
  - Joint parameters per kind:
    - stud and hole: a1 = yaw.
    - hinge: a1 = yaw, plus flip.
    - axle: a1 = rotation, a2 = slide, plus flip.
    - ball: a1, a2, a3 = euler angles.
    - fixed: none.

- [ ] **Step 1: Write the failing tests**

```python
def test_round_trip_tokens():  # 500 sft models, random roots
    assert decode_tokens(encode(s, v), v) == s
def test_poses_match_realise():  # same 500: every part's pose within 0.6 LDU / 1° of decode.realise from the same root
def test_sample_covers_every_joint_kind():  # the 500 include stud, hinge, fixed, ball, axle edges
def test_root_step_has_no_parent():
    assert s[0]['parent'] is None
```

- [ ] **Step 2: Run them, expect failure.**
- [ ] **Step 3: Implement `sequence.py`.** Use `realise`'s walk (edges indexed both ways), but start from the given root. Quantisation: angles `round(deg) % 360`; slide `round` clamped to ±330. Decode angles back as whole degrees.
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Leave uncommitted.**

---

### Task 3: The world — overlaps and free connectors

**Files:**
- Create: `python/lab/world.py`
- Test: `python/tests/test_lab_world.py`

**Interfaces:**
- Consumes: `Connectors`, `fits`, `voxelise.points`, `decode.Catalog.stems`.
- Produces:
  - `occupancy(stem: str) -> np.ndarray (K,3)`: the part's solid sample points in its own frame. Its surface points are filled through along local Y, then pulled 1.5 LDU inwards so faces that only touch don't count. Cached. Studs are excluded, as `points` already does.
  - `class World(conn, compat)`
    - `.add(pid, color, pose) -> int`: the index of the new part.
    - `.collides(pid, pose) -> bool`: true if any sample point of the new part falls in a 2-LDU cell held by a placed part's points.
    - `.free(i) -> list[int]`: connector indices of part `i` that no other part's connector occupies. A connector is occupied when one of the other part's connectors of a compatible type sits within 1 LDU of it, with parallel axes.
    - `.pose_for(parent_i, pconn, pid, oconn, kind, params) -> np.ndarray`
    - `.n` (the number of placed parts)
    - `.to_ldr(name, caption) -> str`, through `decode.to_ldr`.

- [ ] **Step 1: Write the failing tests**

```python
def test_stacked_plates_do_not_collide():        # 3023 on 3023, one plate up (-8 Y)
def test_same_spot_collides():                   # two 3001 at the same pose → collides
def test_half_overlap_collides():                # 3001 shifted 10 LDU in X → collides
def test_rotated_45_collides():                  # 3001 rotated 45° about Y at the same centre → collides
def test_side_by_side_touching_ok():             # 3001 next to 3001, 40 LDU apart in X → no collision
def test_real_models_mostly_clean():             # 300 val models placed part by part: ≤ 2% of parts flagged
def test_studs_freed_and_taken():                # 3001 on 3001: the bottom's 8 studs are no longer free; the top's 8 are
def test_baseplate_step_under_1s():              # 3811 (32x32) placed, then .free + .collides for a 3001 takes < 1 s
```

- [ ] **Step 2: Run them, expect failure.**
- [ ] **Step 3: Implement `world.py`.**
  - Placed parts' world points go into one dict, keyed by 2-LDU cell, value the part index.
  - Connector world positions go into a second dict, keyed by rounded position, for the free-connector test.
  - Both dicts are updated in `.add`, so each step costs only the new part's points.
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Leave uncommitted.**

---

### Task 4: The app agrees with the Python overlap test

**Files:**
- Create: `python/lab/agreement.py` (writes cases), `tests/lab/agreement.test.ts` (judges them)
- Test: `python/tests/test_lab_agreement.py`

**Interfaces:**
- Consumes: `World`, `importLDraw` (`src/io/ldrawImport.ts`), `certify` (`src/generate/certify.ts`), `useAppParts` (`tests/helpers/appParts.ts`).
- Produces:
  - `/Users/mac/Projects/BrickMotion-Data/lab/agreement/case_###.ldr`: 300 two-part cases. 150 are adjacent pairs taken from val models; 150 are the same pairs with the second part shifted by a random 4–20 LDU.
  - `cases.json` holding `{name, python_overlap}` for each case.
  - The vitest run writes `verdicts.json` holding `{name, app_overlap}`, read from `certify(plan,{realModel:true}).overlapping > 0`. It only runs when `LAB_AGREEMENT_DIR` is set.

- [ ] **Step 1: Write the failing test.** `test_python_agrees_with_app`: loads both JSON files and asserts that the two verdicts agree on at least 95% of cases. On failure it prints the disagreeing cases.
- [ ] **Step 2: Write the cases** with `$PV -I -m lab.agreement`, run `LAB_AGREEMENT_DIR=/Users/mac/Projects/BrickMotion-Data/lab/agreement npx vitest run tests/lab/agreement.test.ts`, then run the pytest. Expect a PASS, or a list of disagreements.
- [ ] **Step 3: Tune `occupancy` if needed** (the inward pull, the cell size) until agreement is at least 95%. Keep Task 3's tests passing.
- [ ] **Step 4: Leave uncommitted.**

---

### Task 5: Training data and the builder model

**Files:**
- Create: `python/lab/dataset.py`, `python/lab/builder.py`
- Test: `python/tests/test_lab_builder.py`

**Interfaces:**
- Consumes: `to_steps`, `encode`, `Vocab`, `captions_sft_clip.npy`. That file has one CLIP row per caption line, in the same order as `captions_sft.jsonl`; map lines to model ids with each line's `id`.
- Produces:
  - `build(split: str) -> path`: writes `lab/tokens_{split}.npz` with keys `tokens` (int16, concatenated), `ptr` (int64), `model` (int32), `vocab.json`. There are 4 random roots per model; models whose `poses` don't decode are skipped and counted.
  - `class SeqData(npz, clip, caption_ids)`: a torch Dataset that yields `(clip[512] float16, tokens[≤1002] int64)`. It picks one of the model's captions at random each time.
  - `class Builder(vocab_size, width=512, layers=8, heads=8, max_steps=100)`
    - `.forward(clip (B,512), tokens (B,T)) -> logits (B,T,V)`
    - The CLIP vector is projected to one prefix position.
    - Each token's embedding is the sum of: token embedding + field embedding (which of the 10 fields) + step embedding (`0..100`).
    - Uses `Block` from `python/shape/shape.py`, causal, with dropout 0.1 while training.

- [ ] **Step 1: Write the failing tests**

```python
def test_dataset_counts():            # tokens_val.npz from val.npz: ≥ 95% of models kept
def test_tokens_in_vocab():           # every token < vocab size; every sequence starts BOS and ends EOS
def test_builder_shapes():            # logits.shape == (2, T, V)
def test_builder_overfits_8_models():  # 300 steps on 8 sequences: loss < 0.5
```

- [ ] **Step 2: Run them, expect failure.**
- [ ] **Step 3: Implement both files.** Build the val tokens locally. The sft tokens are built in the Kaggle stage (Task 6), so they never need to fit on this disk.
- [ ] **Step 4: Run them, expect PASS** (the overfit test on MPS).
- [ ] **Step 5: Leave uncommitted.**

---

### Task 6: Train on Kaggle

**Files:**
- Create: `python/lab/train.py`, `python/lab/kaggle_bundle.py`
- Test: `python/tests/test_lab_train.py`

**Interfaces:**
- Consumes: `build`, `SeqData`, `Builder`. Follow the pattern of `python/shape/kaggle_bundle.py`: `CODE_VERSION`, newest-code selection, carry-over from any input that has `lab.ckpt`, stage `.done` files, a `REDO_TRAIN` setting.
- Produces:
  - `train(out_dir, steps=60000, batch=32, lr=3e-4, patience=12) -> path`.
    - AdamW and cosine decay, with fp16 autocast and a GradScaler on CUDA.
    - Every 1,000 steps: a test loss on 512 fixed val sequences. A new best saves `lab.best.pt`; training stops after 12 checks without one. `lab.ckpt` holds the latest state, for resuming.
  - `export(out_dir) -> lab.pt`: the best weights (fp16) plus `vocab.json` and the config.
  - The bundle: `/Users/mac/Projects/BrickMotion-Data/kaggle-lab/` (a zip of `python/lab`, `python/bricknet/decode.py`, `python/shape/shape.py`, plus an ipynb). The data input is the BrickNet files as a Kaggle dataset.
  - Stages: tokens → train → export.

- [ ] **Step 1: Write the failing tests**

```python
def test_smoke_train_and_resume(tmp_path):  # 40 steps on val tokens, stop, run again: resumes at step 40 from lab.ckpt
def test_export_loads():                    # export → Builder loads lab.pt, same logits as before export within 2e-2
```

- [ ] **Step 2: Run them, expect failure.**
- [ ] **Step 3: Implement `train.py` and `kaggle_bundle.py`;** build the bundle.
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Hand over to the user.** Give the steps for uploading the BrickNet data and the bundle, then Save & Run All on a T4. Wait for `lab.pt` to come back, and install it at `/Users/mac/Projects/BrickMotion-Data/lab/lab.pt`.
- [ ] **Step 6: Leave uncommitted.**

---

### Task 7: The legal-moves sampler

**Files:**
- Create: `python/lab/sample.py`
- Test: `python/tests/test_lab_sample.py`

**Interfaces:**
- Consumes: `Builder`, `Vocab`, `World`, `fits`, `Connectors`.
- Produces:
  - `generate(model, vocab, new_world: Callable[[], World], clip, steps=100, top_k=20, top_p=0.95, seed=0, legal=True) -> Result`
  - `Result = {world: World, tokens, rollbacks: int, rejected: int, seconds: float, first_overlap: int | None}`

Each step fills its fields in order. Every field's logits are masked to that field's range, and with `legal=True`, to its legal values too:

| Field | Legal values |
|---|---|
| part | used parts that have frames and occupancy points |
| colour | any |
| parent | `< world.n`, and only parts with at least one free connector |
| pconn | `world.free(parent)` |
| oconn | the part's connectors with `fits(type(pconn), type)` non-empty |
| kind | `fits(...)` |
| a1–a3 | per the kind's ranges |
| flip | 0 or 1 |

- If the finished pose collides, the angle fields are resampled, up to 8 tries. Then oconn, pconn, parent and part are resampled the same way, with 8 tries each, excluding what failed.
- If the whole step still fails, the last step is rolled back (BrickGPT's method). After 20 rollbacks the run stops with what it has.
- With `legal=False`, the model samples freely, with field-range masks only, and `first_overlap` records the first step that collides. This is the BrickNet-style baseline.
- EOS is suppressed until `steps` parts are placed, as BrickNet does unconditionally.

- [ ] **Step 1: Write the failing tests** (with a random-weight `Builder`, so they don't depend on Kaggle)

```python
def test_legal_reaches_100_parts_no_overlap():   # world.n == 100; recheck every pair with World.collides → none
def test_never_offers_partless_parts():          # mask for 'part' excludes pids with empty frames/points
def test_parent_masked_to_placed():              # at step 5 the parent mask allows only 0..4
def test_illegal_baseline_reports_first_overlap():  # legal=False on random weights → first_overlap is not None
```

- [ ] **Step 2: Run them, expect failure.**
- [ ] **Step 3: Implement `sample.py`.**
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Leave uncommitted.**

---

### Task 8: Run experiment 1 and judge it with the app

**Files:**
- Create: `python/lab/exp1.py`, `tests/lab/certifyLdr.test.ts`
- Test: the run itself, judged by the pass criteria below.

**Interfaces:**
- Consumes: `generate`, the trained `lab.pt`, `captions_val.jsonl` with its CLIP vectors (encode with `openai/clip-vit-base-patch32`'s text model, as `python/shape/prepare.py` does).
- Produces:
  - `/Users/mac/Projects/BrickMotion-Data/lab/exp1/`:
    - `legal_##.ldr` and `free_##.ldr` for 64 val captions.
    - `exp1.json` holding, per run: caption, parts, rollbacks, rejected, seconds, first_overlap.
  - `certifyLdr.test.ts`: when `LAB_LDR_DIR` is set, runs `certify(importLDraw(text), {realModel:true})` on each file and writes `certify.json` with `{file, parts, overlapping, floating, buildable}`.
  - `report.md`: a summary table, with BrickNet credited.

- [ ] **Step 1: Run** `$PV -I -m lab.exp1`, then `LAB_LDR_DIR=/Users/mac/Projects/BrickMotion-Data/lab/exp1 npx vitest run tests/lab/certifyLdr.test.ts`.
- [ ] **Step 2: Check the pass criteria.** All 64 `legal_` models have 100 parts, `overlapping: 0` and `parts: 1` in `certify.json`. For the `free_` baseline, report the average `first_overlap` (BrickNet 14B averages about 19).
- [ ] **Step 3: If it fails:**
  - If more than 10% stop short of 100 parts, report rollbacks per model and where they happen.
  - If the app flags overlaps that Python missed, go back to Task 4's tuning with those files as new cases.
- [ ] **Step 4: Open 3 `legal_` models in the app** (Models → open the file) and screenshot them for the user, with their captions.
- [ ] **Step 5: Leave uncommitted.** Report to the user and stop. Experiment 2 gets its own plan.
