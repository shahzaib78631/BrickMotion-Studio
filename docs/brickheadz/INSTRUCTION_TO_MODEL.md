# Instruction step-image → 3D model (research prototype)

Goal: reconstruct each piece's grid pose from a LEGO instruction booklet, so we
can build sets that have **no MPD**. This is a research build, not a one-shot
feature; this document records the prior art, the mathematics, what is
implemented, the measured status, and the roadmap.

## Prior art

- **Brickthrough** (W. Snyder) — the closest pipeline: Mask R-CNN part masks →
  **PnP pose** from 2D-3D correspondences (OpenCV) → pose refinement. Confirms
  *segment → estimate pose → refine*. <https://github.com/WHSnyder/Brickthrough>
- **LEGO-Anything** — single-image 3D scene reconstruction by a coding agent
  (analysis-by-synthesis / IR3D-Bench). <https://arxiv.org/html/2609.36380v1>
- **IR3D-Bench** — frames reconstruction as *analysis-by-synthesis*: render,
  compare, optimise. <https://ir3d-bench.github.io/>
- **Brickognize** — photo-realistic render synthesis for brick recognition with
  limited data (justifies using rendered references for matching).
  <https://mdpi.com/1424-8220/23/4/1898>
- **Axonometric projection** — the orthographic camera model instructions use.
  <https://en.wikipedia.org/wiki/Axonometric_projection>

No published system targets *instruction-booklet → MPD* directly, so we build it
from these primitives. Our advantage: the LDraw geometry library, a triangle
exact collision oracle, and an OMR ground-truth model to benchmark against.

## Mathematics

**Camera (orthographic axonometric).** With LDraw axes (x right, y down, z front)
and a rotation `R = Rx(pitch)·Ry(yaw)`:

```
u = s·(R·p)_x + ox
v = -s·(R·p)_y + oy        (screen v grows downward; model up is -y)
depth = (R·p)_z
```

**Part projection.** A piece is part-space vertices `V` (LDraw LDU) with a 4×4
placement `M`; world vertices are `W = M·V`. Its silhouette is
`hull( project(W) )` — the convex hull of projected vertices (a fast convex
approximation adequate for block parts).

**Placement as inverse rendering (analysis-by-synthesis).** For each new part of
a step, solve

```
pose* = argmin_pose  w_c·colourMismatch(pose)
                   + w_s·(1 − silhouetteIoU(pose))
                   + collisionPenalty(pose)      # grid-cell overlap, via oracle
                   + supportPenalty(pose)         # must rest on realised pieces
subject to:  pose ∈ grid (x, z, rot∈{0,90,180,270}), y from support
```

scored by comparing the part's rendered colour/silhouette to the *new-part*
pixels in the step image (instructions draw new parts in colour, built parts
faded). This is exactly analysis-by-synthesis, made discrete by the stud grid.

**Camera calibration.** Choose `(yaw, pitch)` maximising silhouette IoU between
the rendered accumulated model and the step image's foreground; `s, ox, oy` come
from bounding-box alignment. With ground truth (OMR) the calibration can also be
fitted exactly, which is how the search is tuned.

## Architecture (intended)

```
booklet step images ─┐
callout parts (known) ┼─▶ 1. per-step camera calibration (IoU fit)
inventory/plan ──────┘          │
                               ▼
                    2. segment "new parts" (saturated colour pixels)
                               │
                    3. per part: inverse-render pose search (grid × 4 rot)
                               │  support + non-overlap (grid + MeshOracle)
                               ▼
                    4. commit → next step → per-step confidence
                               ▼
                    assembled MPD + per-step certificate
```

## Implemented now (`python/brickheadz/instruction_place.py`)

- Orthographic camera + projection, part-vertex extraction, convex-hull
  silhouette, scanline polygon fill, painter-order render, foreground mask,
  mask normalisation, IoU, and a `calibrate()` IoU search.
- Tests (`tests/test_brickheadz_instruction_place.py`) cover the projection
  math, hull, fill, render, and IoU.

**Measured status:** the camera + renderer work; calibrating by silhouette IoU
against the real Aquaman booklet step photo gives **≈0.30** (best at yaw≈10,
pitch≈25). The renderer is sound; the **step-image preprocessing** (tight crop,
background/outline/hatching removal, per-step camera fit) is not yet good enough
for reliable placement. On that basis a from-images assembly is **not** trusted
yet — which is the whole point of benchmarking against the OMR.

## Roadmap (concrete next iterations)

1. **Clean step images.** Tight-crop the model, separate the faded "built" layer
   from the coloured "new" layer, remove outlines/hatching. Re-measure IoU per
   step; target >0.7 before placing anything.
2. **Per-step calibration** using the accumulated model + bbox, not a global fit.
3. **Pose search** with the inverse-render cost above, using the MeshOracle for
   collision and the grid for support; prune by projected-bbox overlap.
4. **Joint step solve** (parts interact) with limited backtracking.
5. **Benchmark harness** against the OMR: per-step pose accuracy (part id +
   x/y/z/rot), so improvements are measured, never assumed.
6. **Fallback:** when an OMR model exists, use it (exact geometry) and the
   instruction steps for order — the reliable path already used for Aquaman.

## Why this is hard (and why we benchmark)

A single isometric view is under-determined for depth; parts occlude each other;
the booklet art is stylised (hatching, outlines, faded-built layers). Ships-a-
plausible-but-wrong-model is the failure mode. The discipline is measured
reconstruction against a known model before trusting the engine on MPD-less sets.

## What is implemented (end-to-end) and how it measures

`python/brickheadz/instruction_place.py` now implements the whole chain, and
`scripts/reconstruct_aquaman.py` drives it:

1. **Instruction renderer** — absolute-camera painter render; built parts grey,
   new parts coloured on top, thin dark outlines between pieces (booklet style).
2. **Segmentation** — colour masks (saturated, non-background, near the callout
   colour), plus **connected-component instance separation** so several parts of
   one colour do not collapse together.
3. **Analytic pose seed** — for each `(orientation ∈ 24 cube rotations, y)`, the
   grid `(x, z)` that puts the part's vertex centroid on the target pixel is
   solved in closed form (orthographic projection is affine, so `du/dx = s·20·R₀₀`).
4. **Search + constraints** — local `(x, z)` refinement, non-overlap on the plate
   cell grid, best colour/silhouette IoU wins.
5. **Assemble → benchmark** — commits per step, compares recovered matrices to
   the OMR ground truth.

Measured:

| Test | Result |
| --- | --- |
| Controlled 3-piece step sequence (unit-tested stages) | **3/3 exact poses** |
| Full Aquaman, synthetic booklet-style step images (30 steps, 135 pieces) | **~15% exact** (rest: same-colour instance confusion, mutual occlusion of new parts, and greedy error cascade) |
| Real booklet scans | calibration IoU ≈ 0.30 — not trusted |

Verdict: the **pipeline is complete and runs**, and every stage is correct in
isolation, but the accuracy on a full model is limited by the part-instance and
occlusion problem — precisely the stage that prior art solves with a **learned
instance segmenter (Mask R-CNN → PnP, as in Brickthrough)** rather than
deterministic code. A single view where new parts overlap does not, by itself,
determine which pixel blob is which part.

## Path to a trustworthy solver

1. **Learned instance segmentation** of new-part blobs (Mask R-CNN-style), or
   booklet "exploded" views where new parts never overlap, to fix identification.
2. **Joint step solve** (parts interact) with limited backtracking instead of
   greedy commits, to stop the error cascade.
3. **Physical constraints** (support + MeshOracle collision) during the search.
4. Keep benchmarking every change against the OMR; never trust an unmeasured gain.

