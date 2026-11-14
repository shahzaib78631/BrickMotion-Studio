# Booklet → model pipeline: stages, gates and where each stands (14 Nov 2026)

Goal: from a booklet's pages, build the model step by step so that every step's render overlaps its picture
exactly.

Rules for the work:
- Four stages, in order. Each has **one fixed test set, one number and one pass mark**.
- Each stage is tested on its own. Its inputs come from the answer key, not from the stage before, so a
  failure is always pinned to one stage.
- A stage isn't "done" until its gate passes. Every change reports the gate number before and after.
- The end-to-end run (all four stages chained) is reported every time, but only to see how the stages work
  together; it isn't where a stage gets fixed.

## Test sets (fixed, never tuned on silently)

| Set | Answer key | Used for |
|---|---|---|
| 5 teacher sets (`.cache/booklet-mpd/solver/teacher`) | MPD, step-aligned | all four gates |
| 21065 book 1 | verified answer | camera, placement |
| 40348 BrickHeadz | MPD | camera, placement |
| Synthetic shard-000 (200 steps) | exact | placement coverage per joint type |
| Desk MOC (user's images) | none (images only) | end-to-end visual check only |

## Gate 1: identify the parts of each step

- **In:** the step's page.
- **Out:** a multiset of (part, colour) per step.
- **Number:** per-step exact multiset match.
- **Pass:** ≥ 98% of steps.
- **Now:** median part recall is 0.90 over 42 sets. Some sets collapse (40413: 0.03; 41621: 0.35;
  40274: 0.52). It only works from a PDF with element IDs. There is no reader for images (the desk was
  typed by hand).

## Gate 2: divide the page into steps and panels

- **In:** the page.
- **Out:** per step its main picture, callout and sub-build panels, plus "attach sub-model" steps.
- **Number:** steps and panels matched to the answer key.
- **Pass:** 100% on the test sets.
- **Now:** not measured. `raster_step` handles one Studio step per page. Cropping the desk took manual
  dividers and panel blanking. The solver has no "attach a finished sub-model" step.

## Gate 3: find the camera

- **In:** the step picture plus the answer-key model so far.
- **Out:** the camera.
- **Number:** p90 line distance in the booklet's own pixels.
- **Pass:** ≤ 1.5 px on ≥ 95% of steps.
- **Now:**
  - 21065: 0.37–0.5 px median (CoordNet).
  - 40348: 15 of 41 steps verified with the line fit.
  - The other sets are not measured against this gate.

## Gate 4: place the new parts (camera and parts from the answer key)

4a. **Coverage.** Is the true pose among the candidates? It is counted per joint type, and every type must
reach ≥ 99%:

| Joint type | Now |
|---|---|
| Studs (top/bottom, quarter turns) | covered |
| Rotations off the quarter grid (45°, 22.5°…) | not generated |
| SNOT (side studs, brackets) | catalogue side studs exist; desk 22885 still failed; not measured per type |
| Hinges (on/in, free angle) | not generated (catalogue has them; work started 14 Nov) |
| Bar / clip (free roll and slide) | excluded in `snap_candidates` (work started 14 Nov) |
| Technic pins/axles (continuous slide) | slide grid −20..20 step 10; misses −7, 18.5, 25.4… |
| Parts with no catalogue data | 33 synthetic misses |

Overall: real sets 5,029/5,611 covered (90%). Synthetic: 571/772 visible true poses (74%).

4b. **Selection.** With the true camera and the true candidate set, is the right pose chosen?
- **Pass:** ≥ 95% of parts exact.
- **Now:** not measured in isolation. The teacher run, which also solves its own camera, gets 200/458 parts
  exact (44%) and 36% of steps.

4c. **Overlap.** The render of the completed step matches the picture.
- **Pass:** p90 line distance ≤ 1.5 px for every step.

## Measured baseline (14 Nov 2026, `python -m booklet_mpd.gates`, test sets 40271 40350 41488 41605 41620 40348)

Results: `.cache/booklet-mpd/gates/gates-{1-2,4a,3-4b}.json`.

| Gate | Pass mark | Measured | Verdict |
|---|---|---|---|
| 1 Parts | ≥ 98% of steps exact | 161/181 = **89%** (40348 98%, 41620 83%) | fail |
| 2 Steps | 100% | every answer-key step has a picture; sub-build detection is unreliable in lump-mode sets (40348 reports 0) | not measurable yet |
| 3 Camera (oracle) | p90 ≤ 1.5 px on ≥ 95% | **60%** of 167 steps; median p90 1.48 px; median silhouette IoU 0.96 | fail |
| 4a Coverage | ≥ 99% per joint type | **584/609 = 95.9%** overall | fail on 4 types |
| 4b Selection (oracle camera) | ≥ 95% parts exact | **64%** parts (370/578), 56% of steps | fail, largest gap |

Gate 4a by joint type (each part counted under its hardest joint):

| Joint type | Covered |
|---|---|
| Stud | 350/350 (100%) |
| SNOT | 223/223 (100%) |
| Hinge | 2/2 (100%; both at quarter angles) |
| Technic | 4/6 |
| Bar/clip | 4/11 |
| Off-grid rotation | 1/5 |
| No joint found (plates laid flush, tied in later) | 0/12 |

Gate 4b split by camera quality:

| Camera | Steps | Parts exact |
|---|---|---|
| Good (p90 ≤ 1.5 px) | 101 | 258/359 = **72%** |
| Bad | 66 | 112/219 = 51% |

What this says:
- Coverage misses about 4% of parts.
- With a good camera, the solver still picks the wrong pose for about 28% of parts.
- So choosing among the candidates (4b) is now the biggest loss, then the camera (3). The joint types are a
  smaller loss on these sets, though they matter for MOCs like the desk.

## Order of work

1. ~~Measure first~~: done, see the baseline above.
2. **4a coverage, one joint type at a time,** each with real fixtures from the answer keys:
   - bar/clip and hinges (tests written: `python/tests/test_booklet_mpd_joints.py`)
   - SNOT
   - off-grid rotations
   - Technic slides
   - uncatalogued parts
3. **4b selection** with the true camera.
4. **Gate 3** on all test sets.
5. **Gates 1 and 2:** an image parts reader and panel parsing (needed for MOCs like the desk).

Stage 4 is worked on first because it is the bottleneck and can be tested with answer-key inputs while the
earlier gates are still open. The report after each item always shows the full gate table.

## Work log

### 14 Nov: gate 4b, why the right pose isn't chosen (good-camera steps, 101 wrong parts)

| Cause | Parts |
|---|---|
| Search lost a pose that scores better (truth scores higher on the whole model) | 63 |
| Scorer prefers a wrong pose | 23 |
| Part hidden in the picture (< 40 px) | 7 |
| Collision check rejects the true pose (6091, 2420, 24947, 3659) | 7 |
| True pose not a candidate | 1 |

**Tried on the 26 "search lost" steps (125 parts):**

| Change | Parts exact | Steps fully right | Time |
|---|---|---|---|
| Baseline (beam 6, 12 candidates per part) | 49 | 0 | 1.0× |
| Wider beam (24, re-score all) | 57 | 4 | 1.35× |
| Final pass (`place.polish`), sub-build steps included | 65 | 7 | 1.9× |
| Final pass, sub-build steps skipped (to keep the headlights unit test) | 51 | not counted | not counted |

**Full gate:** 4b with the final pass (sub-build steps skipped) gave 368/578 parts exact, against 370
without it, so it has no effect. The pass is in the code with tests but **off by default**
(`BOOKLET_SOLVER_POLISH=1` turns it on).

**What is left after the final pass (60 wrong parts):**
- 21: the true pose isn't a candidate while the other new parts are misplaced (it sits on another new part).
- 37: no single move toward the truth raises the score.
- 6: the true pose is outside the top 32 alternatives.

All of the final pass's gain was in sub-build steps.

**Next:**
- Move a host part and the parts on it together.
- Move sub-build units as whole units in the final pass.

### 14 Nov: unit-aware final pass (sub-build copies move whole)

**Full gate 4b:** 372/578 parts exact (64.4%), against 370 baseline. Good-camera steps: 261/359, against
258. 13 steps got better and 12 worse; time +24%. That is noise, so the pass stays **off**.

The 12 worse steps are the finding. The pass only accepts moves that raise the whole-model score, yet it
moved correct parts to wrong poses. So the whole-model score (`register.Aligner`) itself ranks some wrong
layouts above the right one. A better search against this score has a ceiling. The next gate to add measures
the score on its own: does the true layout outscore every one-part change of it?

### 14 Nov: gate 1 P0 checks (parts reading, all 42 sets, fresh run)

Recall is 4,936/5,869 = **84.1%**. The cached table (80%) was stale.

**Checked and ruled out:**
- **Step shift:** the best offset is 0 on every set. 40413 is now 49/116, not 3%.
- **Count inflation:** the piece count per step is right on 1,520/1,631 steps (93%), with only 55 pieces over and 143
  under; 114 of the under-count is 75317, which has no inventory. The "2–9× pieces" came from counting every
  booklet step against only the answer-keyed ones. The Technic answer keys cover 12–28 of 100–300 steps.

**Where the 933 misses are:**

| Kind | Parts |
|---|---|
| Wrong part, right colour | 328 |
| Wrong part and colour | 356 |
| Right part, wrong colour | 106 (75277 greens and greys; rubber black 256 read as 0) |
| Not read (75317 data) | 143 |

By group: printed list 326, no list 276, Technic 331. The top confusions are look-alikes:
- plate lengths (1×3/1×4/1×6) and plates 3×3/4×4;
- curved slope against corner plate;
- jumper with/without understud (LDraw variants of one element);
- friction pin variants.

There are answer-key artefacts too: 42120's truth has submodels standing in as parts (27× "61332"). About 40
truth ids aren't in the library.

**Conclusion:** the work is shape and colour recognition, plus data fixes. Count repair and hard count
conservation (DeepSeek P1/P2) would gain at most about 70 parts.
Scripts and output: `scratchpad/p0/` (run.py, analyze.py, alias.py, analysis.txt).

### 14 Nov: gate 1 data fixes

- Rubber colours now score as their plain colour (Rubber_Black 256 = Black 0): `evaluate.same_colour`.
- The set number falls back to LEGO's file name (`75317-6334518.pdf`). 75317 now gets its Rebrickable
  inventory: 0% → 74%.
- Checked and dropped: alias/moved LDraw ids (3023/28653…) were already matched by `same_part`.

**Gate 1, all 42 sets:**

| Metric | Before | After |
|---|---|---|
| Recall | 84.1% | **85.8%** |
| Steps exact | — | 76.1% |

By group:

| Group | Recall |
|---|---|
| Printed list | 88.1% |
| No list | 71.1% |
| Technic | 72.7% |

The remaining misses are recognition (wrong shape or colour).

### 15 Nov: gate 1 matching (P1–P3)

Training sets (42) are tuned on. Validation (33) is reported as totals only; its failures were never
inspected.

| Change | Train recall | Validation recall |
|---|---|---|
| Before (after the data fixes) | 85.8% | 75.4% |
| Dark pages are background, not ink (75277 419 → 503/522) | 87.3% | |
| Parts-list slivers skipped (merging tiles tried: 77.1%, reverted) | 87.4% | |
| Printed counts bind the assignment (penalty 0.02/0.05 → 0.3) | 88.1% | |
| 64-px outline + CIELAB colour + inside lines | **89.2%** | **77.5%** |

Train by group: parts list 95.2%, no list 79.7%, Technic 73.5%.
Validation by group: parts list 87.2 → 89.5%, Technic 72.5 → 74.4%, no list 16.1 → 17.0%.

**Checked, nothing to fix:** per-step counts (P0) and tiny callout crops. No train crop is under 15 px.

**Answer-key mismatches (the reader can't fix these):**
- 40413 and 42076: the step pairing is wrong. Hits rise 51 → 101 and 16 → 78 at other steps.
- 41621: its Rebrickable inventory lacks most of the key's dark-orange parts, so the key is a different
  build version.

On 103 of the remaining misses the callout clearly matches the reader's pick (similarity < 0.6 to the
key's part, > 0.85 to the pick).

**Remaining reader misses (train):**
- 146 clearly wrong;
- 106 close calls (margin < 0.1).

They are mostly Technic look-alikes and booklets with no parts list.

**Validation, no parts list:**
- 40378 reads 89/96;
- 10270 reads 35/551;
- 31088 reads 2/93.

Those two collapse structurally. They aren't diagnosed, to keep them held out.
