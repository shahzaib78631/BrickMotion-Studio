# Design review brief: learned placement of new parts in LEGO booklet steps

You are reviewing a design. **Read-only: do not edit, create or delete any file, and do not run git commands that
change state.** You may read any file and run read-only Python (`cd python && .venv/bin/python -c ...`) to check
claims against the data. Treat every claim below as a hypothesis to verify against the code and data.

## The task

Input for one booklet step: the step picture (raster, ~350-640 px wide), the model built before the step (a list of
LDraw parts with 4x4 poses), the multiset of new part types for the step (part + colour, known from the booklet's
parts list), and a solved camera. Output: a pose for every new part such that a render overlaps the picture
pixel-perfectly. Target speed: under 5 s per step after the camera.

## What already exists and works (verify)

- `python/coordnet/camera.py`: `BookletCamera(yaw, pitch, roll, scale, cx, cy, eye, up, turned)`; `project`,
  `unproject`. LDraw -Y up. `scale` is image px per LDU. Near-orthographic (eye ~4200 LDU).
- Camera solving (`coordnet/evaluate.py: solve_camera`) on LEGO 21065 book 1: tile offset ~0.4 px after solving.
- Legal poses: `booklet_mpd.solver.candidates` (studs/anti-studs of the known model) via
  `coordnet/fastplace.py: connection_candidates`.
- `coordnet/pick.py`: whole-step choice among scored pose votes (branch and bound, exact collision via
  `booklet_mpd.solver.collide.Collider`).
- `coordnet/fastplace.py: place_fast`: network -> votes -> pick -> pass 2 (poses on parts just placed) -> G-buffer
  IoU check.
- Upper bound: with ground-truth per-pixel labels instead of the network, 21065 steps 2-8: 25/25 parts exact,
  7/7 steps, median 4.3 s (`coordnet/bench_place.py --truth-labels`).

## What failed

Current network target (`coordnet/placenet.py`, `coordnet/lattice.py`): per new pixel, the part-local LDraw
coordinate of the surface point it shows (`labels.local_labels`: `local = R^T (xyz - t)`), plus the part's box size,
with a min over symmetry turns about local Y. Voting intersects the pixel ray with plane `y = t_y + (R u)_y` per
rotation/height level and snaps `t = X - R u` to legal poses.

Training: 9,816 synthetic samples (`.cache/coordnet/place-data/shard-*`; shard-000 = validation), 21k steps. Result
on 40 validation samples: new-pixel IoU 0.84 (fine), but the local coordinate collapsed: prediction std per axis
[10.9, 3.7, 3.3] LDU vs label std [27.2, 18.1, 52.6]; Pearson correlation pred/label per axis [-0.12, 0.22, 0.26];
median mean-axis error 8.4 LDU; 18% of pixels within 4 LDU. A 3k-step pilot on 1k samples was at 14%.

My diagnosis: the part-local frame is a per-part-type catalogue convention (which way +X points for each of
thousands of LDraw parts), not something the picture shows, so the net regresses to the mean. Challenge this.

## Proposed replacement (partly written, uncommitted: `git diff python/coordnet/labels.py`)

1. Network input: picture, base render, change evidence (7 channels as now) + 5 constant camera channels
   (`labels.camera_channels`: image vector of one LDU along world +X and +Z divided by scale, and log scale).
2. Per new pixel, predict (a) the 2-D image offset from the pixel centre to where its part's box centre projects,
   in px / cam.scale ("LDU at drawing scale"), and (b) the part's box extent along the world axes, |R| @ box
   (`labels.centre_targets`). Both are the same for all pixels of a part and invariant to its symmetry turns.
3. Voting: for each legal candidate pose, project its world box centre; a pixel votes for candidates whose projected
   centre lies within tol px of `pixel_uv + offset * scale` and whose world extent matches within ~6 LDU. Depth check:
   reject candidates the known model would hide at that pixel. Candidates sharing an image location at different
   depths (line-of-sight twins) are left for pick / pass 2 / IoU check.
4. Labels computed on the fly from existing `labels.npz` (`inst`) + json (`parts`, `cam`, `centre`).

## Mistakes I made recently (so look hardest at this kind of thing)

- Chose a regression target (part-local coordinates) without checking it is observable from the image.
- A test fixture used a camera scale (2.2 px/LDU at 0.48 pt/px) that no printed booklet uses; I only found it when a
  new method assumed the print scale (`booklet_mpd.viewfit.BOOKLET_SCALE` = 0.815 pt/LDU).
- The real-page labeller (`coordnet/realdata.py`) drops almost every page (40271: 0/26, 40348: 1/38); I had blamed
  the camera start, but the diagnostic showed the camera converges on those pages, so the drop is elsewhere (reasons
  are now logged, not yet read).
- Pixel-centre conventions: labels sampled at full-res `[::2, ::2]` (pixel 2x, centre 2x+0.5) while the placer uses
  `uv = 2x+1` for half-res pixels. Check every such convention in the proposal.

## Questions

1. Is the diagnosis of the collapse right? Is there a bug instead (loss, labels, crop, sampling, units, symmetry
   handling in `placenet.local_error`)? Cite file:line evidence.
2. Is the proposed target correct and learnable? Specifically: can the network know the world-axis extent of a part
   from the picture + camera channels; is a raw 2-D offset right or should it be a unit direction (PVNet) or a
   heatmap of centres (CenterNet); how big are offsets for large parts relative to the receptive field?
3. Correctness pitfalls in the proposal: pixel-centre conventions, half-res sampling, crop, perspective (eye),
   occluded part centres (the centre may be hidden or outside the crop), symmetric parts, parts whose box centre is
   not on their symmetry axis, depth twins.
4. Is there a better formulation altogether for this exact setting (small known set of legal poses, known camera,
   known part types, need for pixel-perfect output)? For example: score each legal candidate directly with a network
   that compares the picture with a render of that candidate; instance segmentation + per-instance classification
   over candidates; or render-and-compare only. Weigh speed (5 s) and data (synthetic plus a few real pages).
5. What tests and checks would catch a wrong assumption before a long training run (e.g. overfit a batch, a
   learnability probe, a truth-label upper bound for the new target)?

Answer with: verdict on each question, the design you would implement (concrete enough to code), and the top risks.
Be direct; disagree where you disagree.
