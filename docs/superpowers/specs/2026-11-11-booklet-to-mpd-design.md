# Booklet → MPD reconstruction (confidence-flagged)

Status: draft for approval. Nothing here is built yet.

## Intent

Give the system an official LEGO instruction booklet (PDF) and get back an
MPD/LDraw model of the set with its build steps. The output is allowed to be
imperfect, but it must say where. Success for the first version is **a mostly
right model with every uncertain step flagged**, not a guaranteed exact model.

Why: sets without an MPD cannot be animated or studied in the app. A wrong model
that looks confident is worse than a partial one that says "check step 17".

## Goals

1. Booklet PDF in, MPD out, with per-step and per-part confidence.
2. A hard, repeatable score against known answers (the OMR models), so progress
   is measured and never assumed.
3. Flags that are *calibrated*: when the system says "sure", it is right far
   more often than when it says "unsure".
4. Learning is used where it beats geometry, trained on real booklet/OMR pairs.

## Non-goals (first version)

- Guaranteed exact reconstruction of every part.
- Sets with no OMR available as a scoring reference (they can be run, not scored).
- Photos of built models, video, or non-LEGO booklets.
- Replacing the existing renderer or the LDraw part library.

## Anti-goals (a failure even if it "works")

- Ships a plausible-but-wrong model with no warning (the failure the existing
  doc names).
- Scores that were tuned on the same sets they are reported on.
- Counting an arrow detector metric as progress when the MPD did not improve.

## What exists today (verified by reading, not running)

- `python/brickheadz/instruction_place.py`: orthographic camera, projection,
  silhouette render, IoU calibration, per-part pose search on the stud grid.
  Exact on a controlled 3-part test; about 15% exact on synthetic Aquaman
  steps; real-scan silhouette IoU about 0.30, documented as not trusted.
- `python/instructions_pdf/` (extract, match, raster): booklet page handling.
- `joint_arrows.py` and the arrow corpus: an arrow tip/direction detector,
  24/39 tips, 3 false positives on small agent-reviewed test crops. Not wired
  into placement. Weak transfer (Doctor Doom 0/8).
- Data: 1,470 OMR sets downloaded in `/Users/mac/Projects/BrickMotion-Data/omr`
  (1,835 MPD files). 120 booklet PDFs cached under
  `.cache/instructions/arrow-catalog-100/pdf`; 31 of them match an OMR set by
  set number. Pages are mostly raster images with some vector content.

## Constraints

- Booklet camera is orthographic axonometric, so projection is affine.
- Each step's callout lists the exact parts and colours being added; this is the
  strongest constraint available and must be used.
- Existing frozen weights (stud detector etc.) must not change unless a
  decision says so.
- Local machine, Python in `python/.venv`, no paid API required to run.

## Approach (my calls; confirm or overrule)

1. **OMR as answer key.** Pair each booklet with its OMR set, align OMR STEPs to
   booklet pages, and use the exact poses as labels and as the benchmark.
   Held-out sets are whole sets, never pages from a training set.
2. **Learn perception, solve placement exactly.** Networks find new-part pixels,
   read the callout parts list, and detect arrows and submodel boxes. The pose
   of each part comes from a discrete search (stud grid, 24 rotations) scored by
   rendering against the page, under collision and support constraints.
3. **Solve a step jointly**, with limited backtracking, so one wrong part does
   not cascade through the rest of the booklet.
4. **Arrows as constraints:** an arrow's direction narrows the displacement axis
   of the sub-assembly it points at. Its value is judged by whether placement
   scores improve, not by detection F1.
5. **Confidence per step and per part** from agreement between independent
   cues (silhouette fit, colour fit, collisions, support, parts-list count, next
   step's consistency). Low agreement raises a flag.
6. **Self-checks that need no labels:** the parts list must be fully consumed
   across the booklet; the final model must match the cover image; steps must
   not collide.
7. **Synthetic data** rendered from OMR models in booklet style for more
   training pairs; real pairs remain the only data used for reported scores.

## Order of work

1. Pairing + benchmark harness on the 31 matched sets; report per-step exact
   pose rate and flag precision/recall for the *current* pipeline (baseline).
2. Fetch more booklets for the remaining OMR sets (after approval of downloads).
3. Fix the largest measured bottleneck first (expected: step-image cleanup and
   per-step camera fit; to be confirmed by the baseline, not assumed).
4. Joint step solve with parts-list constraint.
5. Learned perception where the baseline shows geometry failing.
6. Confidence calibration and flagged-MPD output.
7. Arrow constraints, last, and only if they raise placement scores.

## Measures

- Fraction of parts with exactly correct id, colour and pose, per set and step.
- Fraction of parts correct *among those the system did not flag*.
- Flag recall: wrong parts that were flagged / all wrong parts.
- Calibration: unflagged exactness vs flagged exactness, per held-out set.
- Target for v1 is set after the baseline; this document does not invent one.

## Open items for the builder

- Alignment of OMR STEP lines to booklet pages is unverified; many OMRs do not
  follow the booklet exactly. If alignment fails for a set, exclude it and
  record why.
- Whether the 31 matched sets are enough for a reliable held-out score. If not,
  step 2 becomes the first priority.
- Booklet pages with several submodels per page and rotation callouts.

## Left to the builder

Module layout, model sizes, search pruning, exact calibration method, and the
confidence-combination formula.
