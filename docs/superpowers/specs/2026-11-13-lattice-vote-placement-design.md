# Lattice-vote placement: placing a step's new parts in seconds

Status: design, approved approach in chat 2026-11-13; awaiting doc approval. Owner: Claude (architecture, review);
workers: opencode Big Pickle. Builds on CoordNet (`docs/coordnet/DESIGN.md`).

## Why

CoordNet solves each booklet step's camera to about 0.4 px in seconds. Placing the step's new parts is the slow
half: `python/coordnet/place.py` renders thousands of connection candidates and searches whole layouts by
compositing renders against the picture. It is exact on 21065 book 1 steps 5 and 8 but takes 10-20 minutes per
step, so a whole booklet (hundreds of steps) is out of reach and chained reconstruction is impractical.

The user wants placement that is **learned** (trained on part placements), uses **spatial mathematics on the 3D
scene** rather than brute-force rendering, and runs at **about the camera's speed** once the camera is aligned.

## Idea in one paragraph

One network pass labels every new-part pixel with *where on its part it is* (part-local coordinates, LDU). The
camera is solved, so every pixel is a 3D ray. A pixel with local coordinate `u` on a part with yaw `R` and
translation `t` satisfies `ray(pixel) ∋ R·u + t`; for each of the four yaws and each candidate height this pins `t`
to one point, which is snapped to the nearest legal pose (the stud lattice: 20 LDU in X/Z, 8 LDU in Y, with each
part's own origin offset). Every pixel votes; peaks in the
small (yaw, x, y, z) grid are the parts. Because the network says *which stud cell* a pixel is on, the
one-stud-off and line-of-sight twins that defeat silhouette scores vote for different lattice cells. A small
whole-step solve (support, no overlap, exact-cover for identical parts) picks the final set from a few dozen
peaks, and one render confirms it.

## Goals

- Place all new parts of a non-exploded step, given the solved camera, the model so far and the step's parts list.
- Exact poses (same as the answer key up to the part's symmetry), not "close".
- Seconds per step on the M1 (target under 5 s including one verification render; network pass about the
  CoordNet pass).
- Learned from synthetic placements we generate (unlimited, exact labels), using the existing datagen sources
  (OMR official sets, MEPNet sets, BrickNet).
- Every placed step carries a measured residual and a confidence, so failures are flagged, never silent.

## Non-goals (v1)

- Exploded drawings (parts drawn lifted with arrows). Later: read the arrow as the displacement (Big Pickle I10).
- Parts whose legal poses are not axis-aligned (hinges, Technic angles, tilted clips). These fall back to the
  existing `place_joint` search, restricted to that part. Axis-aligned rotations other than yaw (upside down,
  SNOT) are in scope (my call).
- Replacing the camera solver or changing the booklet-camera page.

## Anti-goals (fail even if it "works")

- Regressing continuous poses and rounding them (Manual2Skill style): a 1 cm-tolerant answer is wrong for LEGO.
- Using the answer key anywhere except grading.
- Silently accepting a low-confidence step; it must be marked for review or fall back.
- A speed-up that only works on 21065 book 1 (must hold on held-out synthetic sets and the booklet_mpd train sets).

## How it works

### 1. Learned pass (new network head or small sibling network)

Input: the step picture, the CoordNet-aligned render of the model so far, and the change evidence
(`change_evidence(picture, base_render)` in `place.py`, which already works on real pages).
Per-pixel outputs, at least half resolution (a stud is about 34 px at book 1 scale; 1/8 resolution is too coarse):

- **new**: the pixel shows a new part (trained with the red-band and style jitter; the change evidence is an input
  so the network refines it rather than learning it from scratch).
- **local**: the part-local 3D coordinate of the surface point the pixel shows, in LDU, in the part's own LDraw
  frame. Loss: minimum over the part's symmetry group (rotation-symmetry orders 1/2/4 as in MEPNet's code), so
  symmetric parts have no contradictory labels.
- **size / type cue**: enough to say which of the step's part types a pixel belongs to (for example the part's
  box dimensions, or a score against each type in the step's list). Exact form is the builder's call; it must
  separate the step's own types, not all LDraw parts.
- **confidence** per pixel.

Labels are free: the renderer's G-buffer already gives instance id and model-space xyz per pixel; multiply by the
inverse part matrix for `local`. (My call:) a fresh dataset, because the existing shards render the new parts at
candidate poses and have no local labels; its input render is the model without the new parts. It must fit in
the remaining ~2.4 GB of the 5 GB budget; the existing CoordNet shards are kept untouched. Local labels are stored
for new-part pixels only (int16, compressed).

### 2. Lattice voting (pure geometry, numpy)

For each confident new pixel, each step part type it may belong to, each yaw in {0, 90, 180, 270}, and each
candidate height `t_y` (the model's top surfaces under the pixel and the plate-grid levels near them, plus heights
on parts placed earlier in the same solve), intersect the pixel's ray with the plane `y = t_y + (R·u)_y`, get
`t = X - R·u`, snap `t` to the nearest legal pose of that type and rotation, and add the pixel's confidence to that
bin. (Builder-check call, mine: bins are the legal poses from `candidates()` (per-type KD-tree on translation per
rotation), not an abstract global grid. This handles per-part origin offsets (1x1 vs 2x2, jumpers) and every
axis-aligned rotation `candidates()` produces, including upside-down and sideways (SNOT) mounts, at no extra cost:
the yaw loop becomes a loop over the distinct rotations present in that type's candidates. Poses on new parts
chosen in the same solve come from `candidates()` run on those parts.) Record each bin's sub-LDU
snapping residual too: the true pose has small residuals, a twin has systematic ones.

Peaks per type become candidate poses. Keep the best few dozen overall.

### 3. Legality and the whole-step pick

- **Legal**: a candidate must connect (match a stud/anti-stud connection from
  `booklet_mpd.solver.candidates.candidates`, or connect to another chosen new part) and must not collide (existing
  exact collider). Illegal peaks are dropped, not "nudged".
- **Pick**: choose exactly the step's part multiset (counts per type and colour) maximising vote support, subject
  to no overlap, every part supported, and coverage of the new-pixel mask. Small problem (tens of candidates);
  solved with scipy (`milp` or exhaustive with pruning). Identical parts tiling one area are an exact-cover case of
  the same solve; seams on the picture are the evidence that separates layouts.
- **Stacked new parts**: after the first pick, recompute heights from the chosen new parts and re-vote once for
  pixels not yet explained.
- **Verify**: one render of the chosen layout against the picture (existing `render_error`); report residual,
  coverage and vote margin to the runner-up layout. Below threshold, mark the step for review and optionally run
  `place_rounds` as a fallback.

## Constraints

- numpy, scipy, opencv, torch (MPS) only; no installs, no downloads. 16 GB M1. Dataset ≤ 5 GB under
  `.cache/coordnet/`. Camera conventions as in `docs/coordnet/DESIGN.md`.
- Tests under `python/tests/test_coordnet_*.py`. Nothing committed unless the user asks.
- Answer keys only for grading.

## Gates (measured, no eyeballing)

1. **Geometry unit test**: with ground-truth `local` labels on a synthetic step, voting + pick recovers every pose
   exactly, including two identical plates side by side and one plate stacked on another new plate.
2. **Synthetic held-out**: exact-pose rate per part and per step on held-out sets, with predicted labels.
3. **Real pages**: 21065 book 1 steps 2-8 (non-exploded) against the answer key; must at least match the current
   search (steps 5 and 8 exact) and beat it on the rest; time per step reported.
4. **Speed**: median under 5 s per step end to end on the M1 after the camera, including connection matching,
   the exact collider on the surviving candidates and the verification render (my call: exact checks run only on
   the few dozen peaks, with the collider cached per step). Steps that fall back count in the median and the
   fallback rate is reported; fallbacks are expected on under 20% of non-exploded steps.
5. **Chained run**: steps 2-8 each built on our own previous output, with the camera re-solved each step.

## Decided by the user

- Learned + spatial mathematics, around camera speed, trained on part placements.
- Combine the research: MEPNet-style keypoint/local-coordinate prediction with symmetry codes, PVNet-style
  voting, legal-connection filtering, and Big Pickle's exact-cover tiling (I4) and whole-step solve (I5/I12); later
  arrow reading for exploded steps (I10). Dropped: crystallographic FFT (C1), off-grid sparse recovery (C2);
  C3 (diff against the previous state) is already the change evidence.

## Left to the builder

- Whether the learned pass is a new head on CoordNet or a small separate U-Net (resolution argues for a separate
  half-resolution network sharing the input).
- The exact type cue and the vote weighting; the candidate-height set details; thresholds for review marking.
- Training schedule within the hardware budget.

## References

MEPNet (Wang et al., ECCV 2022) https://arxiv.org/abs/2207.12572 and supplement; PVNet (Peng et al., CVPR 2019);
NOCS (Wang et al., CVPR 2019) https://arxiv.org/abs/1901.02970; Manual2Skill (RSS 2025)
https://arxiv.org/abs/2502.10090; Manual-PA https://arxiv.org/abs/2411.18011; Big Pickle's catalogue
`.cache/coordnet/ideas/bigpickle.md`.
