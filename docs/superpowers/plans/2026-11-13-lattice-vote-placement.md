# Lattice-Vote Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place a booklet step's new parts in seconds, exactly, from one network pass plus ray/lattice voting and a small whole-step pick, given the CoordNet-solved camera.

**Architecture:** A half-resolution U-Net (`placenet`) labels each picture pixel with new/not-new, part-local coordinates, part box size and confidence. Pure geometry (`lattice`) casts each confident pixel's camera ray, intersects it with each legal pose's height plane, snaps to the nearest legal pose from `candidates()`, and accumulates votes. `pick` chooses the step's exact part multiset (no overlap, supported, covering the new pixels); one render verifies. Training data is synthetic (`placedata`) plus real booklet_mpd train-set pages labelled through the solved camera (`realdata`).

**Tech Stack:** Python 3, numpy, scipy (`cKDTree`, `milp`), OpenCV, PyTorch (MPS). Existing: `coordnet.camera`, `coordnet.render`, `coordnet.place`, `coordnet.evaluate`, `booklet_mpd.solver.candidates`, `booklet_mpd.solver.collide`, `booklet_mpd.solver.dataset`, `booklet_mpd.protocol`.

**Spec:** `docs/superpowers/specs/2026-11-13-lattice-vote-placement-design.md`

## Global Constraints

- numpy, scipy, opencv, torch (MPS) only; no installs, no downloads. 16 GB M1.
- New dataset ≤ 2.4 GB under `.cache/coordnet/place-data/`; existing CoordNet shards untouched.
- Answer keys of 21065 and the booklet_mpd held-out sets (`heldout_sets(g, "validation")`, `heldout_sets(g, "test")`) are used only for grading. Real-page training uses `tuning_sets(g)` only, with `g = booklet_mpd.solver.dataset.grades()`. Synthetic data keeps excluding `coordnet.datagen.eval_sets()`.
- Camera conventions as in `docs/coordnet/DESIGN.md` (LDraw −Y up; `turned` = rotate π about X).
- Lattice: 20 LDU in X/Z, 8 LDU in Y; legal poses come from `booklet_mpd.solver.candidates.candidates`, never an abstract grid.
- Non-axis-aligned legal poses (hinges, Technic angles, tilted clips) fall back to `coordnet.place.place_joint` for that part only.
- Speed gate: median < 5 s per non-exploded step after the camera, including connection matching, exact collider on surviving peaks, and one verification render; fallbacks count; fallback rate reported, expected < 20 %.
- Tests in `python/tests/test_coordnet_*.py`; run `cd python && .venv/bin/python -m pytest`. Long jobs (datagen, training, benchmarks) run through `jw run` with `::progress n/N` lines.
- Commit only when the user has asked for commits in the session; commit steps below are where a commit belongs.

## Review Focus

1. **A step type with no legal poses** (first step on an empty base, or a part that only connects to another new part): must not crash; pass 2 supplies poses on chosen parts, otherwise the part is reported unplaced and the step marked for review. → test in Task 6.
2. **A new part almost fully hidden** (few or no votes): the count still demands it; the pick must place it only if a legal, non-colliding pose exists with any support, and mark the step for review when its votes are under threshold. → test in Task 3.
3. **Two step types with the same shape but different colours**: box size cannot separate them; votes must be weighted by the pixel's colour agreement with each type's booklet colour. → test in Task 2.
4. **Turned model (`cam.turned=True`)**: rays and local coordinates must use the turned frame consistently. → test in Task 2.
5. **No new pixels detected** (evidence empty or net says nothing is new): return no placements and a review flag, never an exception. → test in Task 6.

---

### Task 1: Local-coordinate labels and part symmetry

**Files:**
- Create: `python/coordnet/labels.py`
- Test: `python/tests/test_coordnet_labels.py`

**Interfaces:**
- Consumes: `render.GBuffer` (`part [H,W] int32`, `xyz [H,W,3]` world), parts as `[(id, colour, 4x4 world matrix)]`, `render.part_triangles(part)`.
- Produces:
  - `sym_order(part: str) -> int` — rotation-symmetry order about the part's local Y (1, 2 or 4), cached; a rotation counts as a symmetry when every vertex maps onto a vertex within 0.5 LDU.
  - `part_box(part: str) -> np.ndarray` — `[3]` float32 extent (LDU) of the part's triangles in its local frame.
  - `local_labels(g: GBuffer, parts: list, new: set[int]) -> dict` with `local [H,W,3] float32` (part-local LDU of the visible point, nan elsewhere), `size [H,W,3] float32` (`part_box` of the pixel's part), `new [H,W] bool`, `inst [H,W] int32` (index into `parts`, −1 background). Only pixels of parts in `new` get `local`/`size`.
  - `canonical(local: np.ndarray, order: int) -> np.ndarray` — `[order, ..., 3]` the label under each symmetry rotation about local Y (for min-over-group losses).

- [ ] **Step 1: Write the failing tests**

```python
def test_sym_order_known_parts():
    assert labels.sym_order("3024.dat") == 4      # 1x1 plate
    assert labels.sym_order("3020.dat") == 2      # 2x4 plate
    assert labels.sym_order("3040.dat") == 1      # 1x2 slope

def test_local_labels_invert_the_part_matrix():
    # one 3020 plate at (40, -8, 20) yawed 90; render G-buffer; every new pixel's local maps back to its world xyz
    lab = labels.local_labels(g, parts, {0})
    m = parts[0][2]
    w = lab["local"][lab["new"]] @ m[:3, :3].T + m[:3, 3]
    assert np.abs(w - g.xyz[lab["new"]]).max() < 1e-3
    assert np.allclose(lab["size"][lab["new"]][0], labels.part_box("3020.dat"))

def test_canonical_has_one_entry_per_symmetry():
    u = np.array([[30.0, 0.0, 10.0]])
    c = labels.canonical(u, 2)
    assert c.shape == (2, 1, 3) and np.allclose(c[1, 0], [-30.0, 0.0, -10.0])
```

- [ ] **Step 2: Run them to verify they fail** — `.venv/bin/python -m pytest tests/test_coordnet_labels.py -v` → FAIL (module missing).
- [ ] **Step 3: Implement `coordnet/labels.py`** with the signatures above (local = `inv(R)·(xyz − t)` per pixel's part).
- [ ] **Step 4: Run the tests** → PASS.
- [ ] **Step 5: Commit** `feat(coordnet): part-local labels and symmetry orders for placement`.

---

### Task 2: Lattice voting

**Files:**
- Create: `python/coordnet/lattice.py`
- Test: `python/tests/test_coordnet_lattice.py`

**Interfaces:**
- Consumes: `camera.unproject`, `BookletCamera`, `labels.part_box`, `labels.sym_order`, legal pose matrices (row-major 4×4 world) per type from `coordnet.place.connection_candidates(lib, need, model)`.
- Produces:
  - `class PoseTable` built by `PoseTable.build(part: str, poses: list[np.ndarray]) -> PoseTable`; groups poses by rotation (rounded 3×3) and by translation Y, holds a `cKDTree` on X/Z per (rotation, Y). `axis_aligned: bool` per pose; non-axis poses are listed in `table.fallback`.
  - `rays(cam, centre, uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]` — origins and unit directions `[N,3]` in world (unproject at two depths).
  - `@dataclass Vote: key: tuple[str,int]; pose: np.ndarray; score: float; pixels: int; residual: float` (mean snap distance, LDU).
  - `vote(uv, local, size, rgb, weight, cam, centre, tables: dict[tuple[str,int], PoseTable], colours: dict[tuple[str,int], np.ndarray], snap: float = 6.0, size_tol: float = 6.0) -> list[Vote]` sorted by score. For each pixel, type key whose `part_box` matches `size` within `size_tol` on every axis, each rotation `R` in that table, each pose height `t_y` in that rotation: intersect the ray with plane `y = t_y + (R·u)_y`, `t = X − R·u`, nearest legal pose in X/Z; count it if within `snap`. Pixel weight × colour agreement `exp(−‖rgb − colour‖² / (2·40²))`. Local coordinates are tried under every symmetry rotation (`canonical`) and the best snap is kept.

- [ ] **Step 1: Write the failing tests** (ground-truth labels from Task 1 stand in for the network)

```python
def test_votes_recover_two_identical_plates_exactly():
    # base 6x6 plate; two 3020 at (0,-8,±20) (same layout as tests/test_coordnet_place.py); GT labels from local_labels
    votes = lattice.vote(...)
    top = [v for v in votes if v.key == ("3020.dat", 15)][:2]
    assert sorted(tuple(np.round(v.pose[:3, 3])) for v in top) == [(0, -8, -20), (0, -8, 20)]
    assert all(v.residual < 1.0 for v in top)

def test_line_of_sight_twin_scores_below_truth():
    # truth plate vs the legal pose 8 LDU higher and 20 LDU nearer: truth score > 2x twin score
    ...

def test_colour_separates_same_shape_types():
    # 3020 in red and 3020 in black in one step; red pixels vote mostly for the red key
    ...

def test_turned_camera_votes_the_same_poses():
    # same scene with cam.turned=True (centre/poses in the unturned LDraw frame): identical top poses
    ...

def test_non_axis_poses_go_to_fallback():
    t = lattice.PoseTable.build("3020.dat", [np.eye(4), rot_x(30)])
    assert len(t.fallback) == 1
```

- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_coordnet_lattice.py -v` → FAIL.
- [ ] **Step 3: Implement `coordnet/lattice.py`.** Vectorise over pixels per (type, rotation, height); subsample to ≤ 6000 confident pixels before voting.
- [ ] **Step 4: Run tests** → PASS; also check `vote` on the two-plate scene runs in < 0.3 s (print timing in the test, assert < 1.0 s).
- [ ] **Step 5: Commit** `feat(coordnet): ray/lattice voting onto legal poses`.

---

### Task 3: Whole-step pick

**Files:**
- Create: `python/coordnet/pick.py`
- Test: `python/tests/test_coordnet_pick.py`

**Interfaces:**
- Consumes: `lattice.Vote`, `coordnet.place.part_points(part, n)`, `booklet_mpd.solver.collide.Collider` (exact; `set_model(list)`, `hits(part)`), `camera.project`.
- Produces:
  - `splat(part: str, pose: np.ndarray, cam, centre, shape: tuple[int,int]) -> np.ndarray` — bool footprint at the given (half) resolution from projected `part_points(part, 400)`, closed with a 3×3 kernel. No rendering.
  - `@dataclass Pick: placed: list[tuple[str,int,np.ndarray]]; score: float; margin: float; unplaced: dict[tuple[str,int],int]; review: bool`.
  - `pick(votes: list[Vote], need: dict[tuple[str,int],int], newmask: np.ndarray, cam, centre, collider=None, keep: int = 40, min_votes: float = 20.0) -> Pick`. Takes the top `keep` votes; chooses exactly `need` per key maximising `Σ score + λ·|∪footprint ∩ newmask| − μ·|∪footprint ∖ newmask|` (λ = 1, μ = 1 by default), forbidding pairs that collide (exact collider; box test first, results cached per pair). Search: branch and bound over keys in descending vote order (problems are tens of candidates). `margin` = best − second-best objective. `review` when any chosen vote is below `min_votes`, any key is unplaced, or `margin` < 5 % of `score`.

- [ ] **Step 1: Write the failing tests**

```python
def test_pick_tiles_identical_plates_without_overlap():
    # four 3030-like plates side by side + one 4477 (step-8 layout), votes from GT labels
    p = pick.pick(votes, need, newmask, cam, centre)
    assert exact_set(p.placed, truth) and not p.review

def test_pick_forbids_colliding_pairs():
    # two strong votes on the same cells; need = 1 of that type plus 1 elsewhere
    ...

def test_hidden_part_placed_but_flagged():
    # need 2, only one has votes; a second legal non-colliding pose exists with 3 votes
    p = pick.pick(...)
    assert len(p.placed) == 2 and p.review

def test_unplaceable_part_reported():
    # need asks for a type with no votes and no poses
    p = pick.pick(...)
    assert p.unplaced == {("3001.dat", 4): 1} and p.review
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `coordnet/pick.py`.**
- [ ] **Step 4: Run** → PASS; assert the step-8-layout pick takes < 1.0 s.
- [ ] **Step 5: Commit** `feat(coordnet): whole-step pick with exact collision and coverage`.

---

### Task 4: Synthetic placement dataset

**Files:**
- Create: `python/coordnet/placedata.py`
- Test: `python/tests/test_coordnet_placedata.py`

**Interfaces:**
- Consumes: `datagen.pick_step`, `datagen.sample_camera`, `datagen.eval_sets`, `datagen.model_files`, `render.render`, `render.Style`, `place.change_evidence`, `labels.local_labels`.
- Produces: shards under `.cache/coordnet/place-data/shard-NNN/`:
  - `NNNNN.picture.png` (true camera, new parts in place, red outline, random style), `NNNNN.base.png` (model without new parts, same camera perturbed ≤ 0.5 px / 0.3°, plain style), `NNNNN.labels.npz` (`new uint8 [H,W]`, `local int16 [3,H,W]` in 1/4 LDU, 0 off new parts, `size int16 [3,H,W]` LDU, `inst int16 [H,W]`), `NNNNN.json` (set, step, camera, centre, parts with `new` flags, step type list with colours).
  - `sample(seed: int, files: list[Path]) -> dict | None`, `write(out: Path, k: int, s: dict) -> None`, `main(argv=None)` with `--shards`, `--per-shard`, `--workers`; prints `::progress`.
  - `class PlaceDataset(torch.utils.data.Dataset)` (`__init__(dirs, crop=(384, 512), train=True, seed=0)`) returning `picture [3,H,W]`, `base [3,H,W]`, `evidence [1,H,W]` (computed on load with `change_evidence`), `new [H,W]`, `local [3,H,W]` LDU, `size [3,H,W]`, `sym [H,W]` (symmetry order per pixel via `inst` → json part → `sym_order`). Crops keep the new parts in view; horizontal flips are not used (they would mirror part geometry).

- [ ] **Step 1: Write the failing tests**

```python
def test_sample_labels_are_consistent(tmp_path):
    s = placedata.sample(3, files)            # a small fixture model from python/tests/data
    placedata.write(tmp_path, 0, s)
    item = placedata.PlaceDataset([tmp_path], crop=(256, 256), train=False)[0]
    assert item["new"].sum() > 50
    assert torch.isnan(item["local"]).sum() == 0
    assert (item["local"][:, item["new"] == 0] == 0).all()

def test_shard_size_budget(tmp_path):
    # 20 samples average < 160 KB each (2.4 GB / 15k samples)
    ...
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `coordnet/placedata.py`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Generate the dataset** — `jw run -- .venv/bin/python -m coordnet.placedata --shards 15 --per-shard 1000 --workers 6`; check `du -sh .cache/coordnet/place-data` ≤ 2.4 GB (stop adding shards if it would exceed).
- [ ] **Step 6: Commit** code + tests (not data) `feat(coordnet): synthetic placement dataset with part-local labels`.

---

### Task 5: Real-page labels from booklet_mpd train sets

**Files:**
- Create: `python/coordnet/realdata.py`
- Test: `python/tests/test_coordnet_realdata.py`

**Interfaces:**
- Consumes: `booklet_mpd.protocol.tuning_sets`, `booklet_mpd.solver.dataset.cases(set_number)` (`Case.rgb`, `visible`, `added`, `pts_per_px`), `evaluate.Net`, `evaluate.solve_camera`, `evaluate.initial_camera`-style start (shared camera prior per set from the step's own fit), `labels.local_labels`.
- Produces: the same shard format as Task 4 under `.cache/coordnet/place-data/real-NNN/`, json adds `"real": true`, `"fit": {median, p90}`. `label_case(net, case) -> dict | None` returns `None` unless the camera fit median < 1.0 px and p90 < 2.0 px. `main(argv=None)` with `--sets` (default all tuning sets; refuses any set not in `tuning_sets`).

- [ ] **Step 1: Write the failing tests**

```python
def test_refuses_heldout_sets():
    with pytest.raises(SystemExit):
        realdata.main(["--sets", "21065"])

def test_label_case_on_a_rendered_page():
    # a fake Case whose rgb is our own render with a known camera; label_case recovers labels matching local_labels
    ...

def test_bad_fit_is_dropped(monkeypatch):
    # solve_camera monkeypatched to report median 3 px -> None
    ...
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `coordnet/realdata.py`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Generate** — `jw run -- .venv/bin/python -m coordnet.realdata`; report kept/dropped counts per set.
- [ ] **Step 6: Commit** `feat(coordnet): real booklet train-set pages labelled through the solved camera`.

---

### Task 6: Placement network, training, and the fast placer

**Files:**
- Create: `python/coordnet/placenet.py`, `python/coordnet/placetrain.py`, `python/coordnet/fastplace.py`
- Test: `python/tests/test_coordnet_placenet.py`, `python/tests/test_coordnet_fastplace.py`

**Interfaces:**
- Consumes: `PlaceDataset` (Task 4, also loading Task 5 shards), `labels.canonical`, `lattice.PoseTable`/`vote`, `pick.pick`, `place.change_evidence`, `place.connection_candidates`, `place.place_joint`, `place.JointScene.render_error`, `render.render`, `render.colour_table`.
- Produces:
  - `class PlaceNet(nn.Module)` — U-Net, input 7 channels (picture, base render, evidence), output at half resolution: `new` logit `[B,1]`, `local [B,3]` LDU, `size [B,3]` LDU, `conf` logit `[B,1]`. < 4 M parameters.
  - `placenet_loss(out, batch) -> dict[str, Tensor]`: BCE on `new`; on new pixels, L1 of `local` minimised over `canonical(·, sym)`; L1 on `size`; BCE on `conf` with target `local error < 4 LDU`.
  - `placetrain.main(argv)` — `--steps`, `--real-weight` (sampling weight for real shards, default 0.3), `--out .cache/coordnet/placenet/`; validation on 5 % held-out synthetic shards; prints `::progress`; saves `best.pt` by validation local-error.
  - `fastplace.place_fast(net, lib, picture, base, need, cam, centre, collider=None, log=None) -> tuple[list[tuple[str,int,np.ndarray]], dict]` — evidence → net (half-res, upsampled coordinates of pixels) → `PoseTable`s from `connection_candidates` → `vote` → `pick` → pass 2 (`connection_candidates` on the picked new parts, re-vote unexplained new pixels, re-pick) → one render; report `{seconds, votes, margin, render_error, review, fallback: [keys]}`; keys with only non-axis poses go through `place_joint` restricted to those keys.
  - `fastplace.main(argv)` — `python -m coordnet.fastplace --step N [--ckpt]`, same outputs as `coordnet.place` under `.cache/coordnet/fastplace/`.

- [ ] **Step 1: Write the failing tests**

```python
def test_placenet_shapes_and_budget():
    out = PlaceNet()(torch.rand(2, 7, 128, 160))
    assert out["local"].shape == (2, 3, 64, 80) and sum(p.numel() for p in PlaceNet().parameters()) < 4_000_000

def test_symmetric_loss_ignores_symmetric_flip():
    # a 2-fold part labelled with the 180-degree equivalent coordinates gives zero local loss
    ...

def test_placenet_overfits_one_sample():
    # 80 steps on one PlaceDataset item: local L1 on new pixels drops below half its start
    ...

def test_place_fast_with_oracle_net_is_exact():
    # stub net returning GT labels; base 6x6 + two 3020 plates + one 3024 stacked on a new plate
    placed, rep = fastplace.place_fast(oracle, lib, pic, base, need, cam, centre, collider)
    assert exact_set(placed, truth) and not rep["review"] and rep["seconds"] < 5

def test_place_fast_with_no_new_pixels():
    placed, rep = fastplace.place_fast(blank_net, ...)
    assert placed == [] and rep["review"]

def test_part_only_on_new_part_is_found_in_pass_two():
    # the 3024 has no legal pose on the base; it must come from pass 2
    ...
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `placenet.py` + `placenet_loss`.** Run the placenet tests → PASS.
- [ ] **Step 4: Implement `fastplace.py`.** Run the fastplace tests → PASS.
- [ ] **Step 5: Train** — `jw run -- .venv/bin/python -m coordnet.placetrain --steps 30000`; record validation new-IoU and local-error < 4 LDU rate.
- [ ] **Step 6: Commit** `feat(coordnet): placement network, training, and fast placer`.

---

### Task 7: Gates and results

**Files:**
- Create: `python/coordnet/bench_place.py`
- Modify: `docs/coordnet/DESIGN.md` (Results section), `docs/superpowers/specs/2026-11-13-lattice-vote-placement-design.md` (Status line)
- Test: `python/tests/test_coordnet_bench_place.py`

**Interfaces:**
- Consumes: `fastplace.place_fast`, `place.same_pose`, `evaluate.load_step`, `evaluate.solve_camera`, `booklet_mpd.solver.dataset.cases`, `booklet_mpd.protocol.heldout_sets`.
- Produces: `python -m coordnet.bench_place --suite {synthetic,21065,heldout,chained}` writing `.cache/coordnet/bench-place/<suite>.json` with per-step `{exact, placed, needed, seconds, review, fallback}` and a summary `{exact_part_rate, exact_step_rate, median_seconds, fallback_rate, review_rate}`. `chained` builds 21065 steps 2–8 each on its own previous output, re-solving the camera each step.

- [ ] **Step 1: Write the failing test** — `test_summary_counts`: given three fake step rows, the summary rates and median are right.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Run the gates** (each through `jw run`):
  - synthetic held-out shards: report exact part / step rates;
  - `21065` steps 2–8: must be exact on 5 and 8 (current method) and report the rest; median seconds;
  - `heldout`: booklet_mpd validation sets, non-exploded steps;
  - `chained`: 21065 steps 2–8.
  Gate pass = 21065 steps 5 and 8 exact, median < 5 s, fallback rate < 20 %, every non-exact step has `review: true`.
- [ ] **Step 6: Write results** into `docs/coordnet/DESIGN.md` and update the spec status; update memory `coordnet-status.md`.
- [ ] **Step 7: Commit** `feat(coordnet): placement benchmark and results`.
