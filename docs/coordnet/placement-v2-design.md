# Placement v2: centre-vote shortlist + candidate scorer

Status: design settled 2026-11-13 after independent reviews by opencode Big Pickle and Command Code (DeepSeek V4
Pro) of `placement-review-brief.md`. Supersedes the part-local-coordinate target of the lattice-vote design.

## Why v1 failed (both reviews confirmed; no label or loss bug)

The network had to regress part-local catalogue coordinates and box sizes without being told the part type. Both
heads collapsed to the conditional mean (local: pred std [10.9, 3.7, 3.3] vs label [27.2, 18.1, 52.6] LDU; size:
median error 17 LDU, 3% within 4 LDU). 1,805 new part types in the synthetic set, 434 seen at most once: the
network cannot learn per-type frames. The mask head is fine (IoU 0.84).

## Design

1. **Dense network (PlaceNet v2)** predicts per half-res pixel: new-part logit, and the 2-D image offset from the
   pixel centre to where its part's box centre projects (px / cam.scale), plus confidence. This is instance
   grouping, not type recognition. Input: picture, base render, change evidence (+ camera channels incl. eye).
   The offset is a per-pixel field; `pixel + offset * scale` is constant over a part.
2. **Centre vote → shortlist.** Every legal candidate pose (from `connection_candidates`) has a projected box
   centre. Pixels vote softly (Gaussian in px, sigma relative to part size) for candidates whose centre is near
   `pixel + offset * scale`, gated by the base-depth occlusion rule. The centre cannot tell rotations about the
   centre apart (a 2x4 along x or z), so the shortlist per type is: all legal rotations at the top-voted centres,
   K per type.
3. **Candidate scorer.** For each shortlisted candidate: crop around its projected box; channels = picture, base
   render, candidate silhouette + depth rendered with the base (occlusion modelled), change evidence. A small CNN
   outputs a score. Trained on synthetic samples: true pose positive; negatives from the shortlist and
   `datagen.wrong_pose` (stud, plate, sight, turn). The scorer compares; it does not need to know part types.
4. **Pick, pass 2, check** unchanged (`pick.pick` with scores as vote weights, exact collider, `new_iou`).

## Conventions (fixed with tests)

- Half-res pixel `x` is full-res pixel `2x`, centre `2x + 0.5` (labels sample `[::2, ::2]`). The v1 placer used
  `2x + 1`; fixed.
- Offsets are computed on the full image before cropping (crop-invariant: differences of pixel coordinates).
- No hard extent/size filters on network output.

## Gates, in order (no training before 1-2 pass)

1. **Answer-key shortlist recall**: true offsets → shortlist; true pose in shortlist for every part of 21065
   steps 2-8 and >= 98% of synthetic shard-000 parts at the chosen K. Records K and time.
2. **Answer-key scorer stand-in** (true pose scores 1): full pipeline exact on 21065 steps 2-8 (25/25).
3. **Overfit probe**: 8 samples, offset error -> ~0.
4. **Short training** with a mean-offset baseline and collapse watch (pred std vs label std); validation split by
   part type as well as shard.
5. Scorer training; then benchmarks (synthetic, 21065, chained) and speed (< 5 s after the camera).

## Real pages (separate blocker)

The labeller's drops on 40348 steps 11-15 come from the new-parts precision gate (0.28-0.44 < 0.48): change
evidence between a real page and a plain render flags styling differences. Steps 2-4 fail the camera (few parts).
