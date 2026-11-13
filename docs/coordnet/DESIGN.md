# CoordNet: pixel-accurate booklet alignment from dense correspondences

Status: working end to end on 21065 book 1 steps 1-8 (2026-11-13); see Results. Owner: Claude (architecture, review); workers: opencode Big Pickle.

## Problem

Input: one booklet step picture (LEGO line-drawing style), the model built so far (known LDraw parts and poses),
the step's new parts (types and colours, from the reviewed parts list) and connection candidates for each.
Output: the camera for the picture, and the new parts' poses, such that the render overlaps the drawing to about
one pixel everywhere.

Why the hand-made scores failed (21065 book 1, steps 5-8): repeated studs and plate edges make one-plate and
one-stud shifts of the crop look almost right, and a part moved along the line of sight (step 8: 32 LDU deeper,
5 px in the picture) is decided by a few pixels of camera error. Outline and edge chamfers cannot tell these
apart reliably.

## Approach (render-and-compare dense correspondence)

1. **Booklet-style renderer** (`python/coordnet/render.py`, numpy + OpenCV, no GL): z-buffered triangles into a
   G-buffer (instance id, depth, normal, model-space xyz) and a booklet-style image: flat part colour with mild
   shading, lines from G-buffer discontinuities (instance change, depth step, normal crease), dark lines on light
   parts and light lines on dark parts, grey background, red outline on the new parts' own contour (the rule the
   booklet uses: red only where a new part's own silhouette ends, not where an earlier part hides it).
   The camera is the page's camera (`src/dev/bookletCameraMath.ts`), ported exactly (`coordnet/camera.py`), so
   a solved camera drops straight into the booklet-camera page.
2. **Synthetic pairs** (`coordnet/datagen.py`): from real build sequences (OMR official set models, MEPNet sets,
   BrickNet), pick a step, a booklet-like camera (yaw/pitch/roll ranges of real booklets, perspective eye,
   turned-over model), render the *picture* (true camera, new parts in place, red outline, style jitter), and a
   *render* of the current estimate (camera perturbed by up to a plate/stud and a few degrees, new parts absent
   or at a wrong candidate pose: one stud off, one plate off, along the line of sight). Ground truth: for every
   picture pixel on an earlier part, the render pixel showing the same 3D point (dense flow), validity (visible in
   both), and the new-part mask. Ground truth is exact: both images come from known geometry.
3. **Network** (`coordnet/model.py`, pure PyTorch, MPS): RAFT-style iterative flow from picture to render
   (shared feature encoder, all-pairs correlation pyramid, GRU updates), plus heads for per-pixel confidence and
   new-part mask. It matches local line-drawing structure, so it generalises to models it never saw.
4. **Solver** (`coordnet/solve.py`): correspondences = picture pixel <-> render pixel + flow <-> render's xyz.
   Camera update by robust least squares on reprojection error (per-step crop offset; shared yaw, pitch, roll,
   scale, eye distance across a booklet section), iterate render -> flow -> update until flow < 0.5 px.
   New parts: each connection candidate is rendered into the estimate; the network's flow and mask agreement on
   the new-part pixels scores it (a part 32 LDU too deep shows as a consistent 5 px flow, not as "almost right").
   Collisions and connector mates are checked as before; every accepted step gets a measured residual.
5. **Gates** (no eyeballing): synthetic held-out EPE and % pixels < 1 px; real booklet steps with answer keys
   (21065 book 1 steps 1-8, the 42 train sets of booklet_mpd) — camera residual and part-pose accuracy. A step
   is accepted only if its final residual is under 1 px (p90) and its parts collide nowhere.

## Constraints

- No downloads or new packages: numpy, scipy, opencv, torch (MPS) only. M1 Pro, 16 GB RAM, ~20 GB free disk.
  Dataset budget 5 GB (`.cache/coordnet/`); generate in shards, keep compact (PNG + int16 flow).
- Camera convention = `bookletCameraMath.ts` (LDraw -Y up; pixel origin top-left; perspective eye distance in
  LDU; `rasterScale` for per-picture points-per-pixel).
- Tests in `python/tests/test_coordnet_*.py`; run with `cd python && .venv/bin/python -m pytest`.

## Module contracts

- `camera.py`: `BookletCamera(yaw, pitch, roll, scale, cx, cy, up=1, eye=0)`, `project(cam, centre, pts) ->
  (uv, depth)`; matches `bookletCamera()` + `Vector3.project` to 1e-6 px (test against values computed by the TS
  code). `turned` = model rotated 180 deg about LDraw X before projection.
- `render.py`: `gbuffer(parts, cam, centre, W, H, ss=2) -> {id, depth, normal, xyz}`; `booklet_style(gbuf,
  colours, new_ids, style) -> RGB uint8`; style parameters randomisable.
- `datagen.py`: `python -m coordnet.datagen --out .cache/coordnet/shard-NNN --n 500 --seed S`; writes
  `NNNNN.picture.png, NNNNN.render.png, NNNNN.flow.npz (int16 x8, valid, newmask), NNNNN.json (cameras, parts)`.
- `model.py`: `CoordNet(...)(picture, render) -> {flows: [B,2,H,W] per iteration, conf, newmask}`.
- `train.py`: MPS training, checkpoints in `.cache/coordnet/ckpt/`, val metrics every N steps, `::progress` lines.
- `solve.py`: `solve_step(picture, ptsPerPx, base_parts, new_parts, candidates, cam_init) -> result + residuals`.

## Results (2026-11-13)

Data: 10 shards, ~9,900 synthetic pairs from OMR build steps (2.6 GB in `.cache/coordnet/`), booklet sets kept out.
Training: 25k steps, batch 6, 288x384 crops, MPS (~6.5 h). Held-out shard: flow EPE 1.57 px, 87.6% of pixels
within 1 px, 96.0% within 3 px, confidence precision 0.93, new-part IoU 0.51.

Camera on the real booklet (`python -m coordnet.evaluate`, steps 1-8, start = page's shared camera + silhouette
offset). Independent check, no network: tiled phase correlation of render vs picture (`tile_shifts`, resolves
~0.3 px). Median tile offset before -> after: step 2 1.17 -> 0.42, 3 1.57 -> 0.39, 4 1.08 -> 0.37,
5 1.85 -> 0.51, 6 1.68 -> 0.43, 7 1.63 -> 0.40, 8 2.42 -> 0.38 px. Step 1 0.49 -> 0.62: its picture is an
exploded drawing (4x4 plate drawn lifted, with arrows) but its step file says `exploded: false`, so the check
compares the lifted plate with the plate in place there.
The per-step fits agree to ~0.1 deg, so the page's shared camera itself is off: refined values (steps 2-8)
yaw 35.23, pitch 35.42, roll 0.24, scale 1.6848, eye ~4190 (was 36.78 / 35.12 / 1.28 / 1.711 / 4593), in
`.cache/coordnet/shared-camera-21065.json` and the teach config (`camera_book1`, previous kept).

Booklet-camera page: `python -m coordnet.evaluate --export` writes each step's solved camera and model centre to
`public/_booklet/21065/coordnet.json`; `booklet-camera.html` uses those cameras (no search; ~1 min instead of
10+) and still fits exploded parts' screen offsets. `?fit=1` runs the page's own fit; steps missing from the file
are fitted by the page. The centre is passed through because the page's box (three.js geometry) can differ from
CoordNet's by a few LDU.

Placement (`python -m coordnet.place --step N`): camera solved from the parts built before the step only,
candidates generated here (no answer key; the key is only used to grade). Step 8 (4x 3030 + 4477): 5/5 exact.
Step 5 (turned model; 2445, 28653, 2x 78329, 2x 11212 stacked on the 78329s): 6/6 exact.

What it took (each tried and measured on step 8 / step 5):
- The network's new-part head is near zero on real pages: placement must not depend on it.
- Single-part scores (flow agreement, coverage, outline-on-lines, single-part render error) all fail: identical
  plates tiling one stud field, and line-of-sight twins (one plate higher and 20 LDU nearer) cover the same
  pixels. Whole layouts must be compared.
- Change evidence = picture vs booklet render of the model so far (not "outside the model's footprint": new
  parts in front of old ones count). Red band excluded from evidence and penalised under footprints.
- Layout score = composite of per-candidate rendered layers over the model render (10-30 ms per layout), searched
  by seeded greedy + single swaps + pair moves; final pick by full supersampled renders.
- Rounds: later rounds add candidates on the parts already placed (a part resting on another new part).
- New-new collision must be exact: a plate's studs reach 4 LDU into the part above, so bounding boxes reject
  every legal stack.

Open: exploded steps (new parts drawn lifted with arrows) are not handled by placement; step 1's metadata;
runtime is minutes per step (layer renders, exact collisions); steps 9+ need pictures exported first.
