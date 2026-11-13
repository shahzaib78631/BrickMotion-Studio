# Booklet solver: hand-solving 40353 (2026-11-11/12)

Train set 40353 (three BrickHeadz-style figures, 39 booklet steps, 123 counted parts), solved teacher-forced
(true model before each step, true part identities). Each step was run through the solver, its placement drawn over
the booklet picture, and corrected by eye where wrong. The answer key was read only after a step's answer was fixed.

## Results (teacher-forced, current solver settings)

| Run | Exact parts | Steps all exact |
|---|---|---|
| Solver, no picture fixes | 78/123 (63.4%) | 17/38 |
| + white faces kept as foreground | 79/123 (64.2%) | 18/38 |
| + white faces + stricter arrow detection | 82/123 (66.7%) | 20/38 |
| Hand corrections on steps 2 and 4 (no fixes) | 82/123 | 18/38 |
| + collision checker fixed | 86/123 (69.9%) | 21/38 |
| + hole stacks (fill) | 91/123 (74.0%) | |
| + completed-model re-rank of the top 3 beam states | 92/123 (74.8%) | |
| + tight scale, 4 camera hypotheses, Technic roll (current defaults) | 98/123 (79.7%) | 25/38 |

Current defaults: `BOOKLET_SOLVER_SCALE_SPAN=0.03`, `BOOKLET_SOLVER_HYPOTHESES=4`, `FILL` on, `RERANK=3`,
`PUSH` off, `MISMATCH` off. 41605 under the same settings: 39/89 (43.8%), 9/25 steps.

## Findings

1. **White parts read as page background.** On a pale page, white and lightly shaded white sit within the foreground
   threshold (30) of the page colour, and on ~150 px pictures the mask's 9 px opening cuts the thin outline that would
   have enclosed them. In step 4, 1677 of 1973 white pixels were classed as background, so the score could not tell a
   right white placement from a wrong one. Fix: `solver/picture.py: enclosed_faces` adds back pixels enclosed by the
   outline network that are not the page colour (`BOOKLET_SOLVER_ENCLOSED=0` turns it off). With it, the solver solves
   step 4 itself.

2. **Red parts read as arrows.** The arrow rule (red minus its opening) kept stud tops and rims of red bricks: 37 of 39
   steps in 40353 (28/30 in 40456) switched on floating placement, and arrow pixels are erased from the colour classes,
   so red parts lost evidence too. Real arrows are thin strokes drawn over the page, while part rims are fenced off from
   the page by the black outline. New rule: a stroke must be long and have >= 25% of its pixels touching the page;
   a small red blob touching a kept stroke is its head (`BOOKLET_SOLVER_ARROWS=0` restores the old rule).
   Floating placement is now on for 2/39 steps in 40353, 0/30 in 40456, 2/41 in 40348; every remaining detection
   checked by eye was a real arrow. Heads are only partly recovered at this resolution.

3. **Step 2 (headlights) was a collision-checker bug, not a search problem.** Two headlight bricks (4070) with white
   1x1 plates on their side studs. The checker reported the plate as overlapping the brick (the brick's vertical
   sample line bridged the air between its side studs), so the right turn was never allowed. With the checker fixed
   (section below) a collision-aware search finds the answer by itself (completed score 1.702 vs the solver's 1.578).

4. **Sub-models drawn on their own.** When a step starts a sub-model (`visible` empty), the benchmark falls back to the
   enclosing model (`context`) as the base. 183 of 1618 train steps (743 of 5825 parts) take this path. Sometimes the
   booklet draws the sub-model in place (40271 s5, 40274 s42), often alone (40271 s24, 40350 s24, 40349 s32, 40353 s1
   and s22), and then the solver fits the whole parent model to a picture of a lone plate. A plain size test (parent
   model area at the page scale vs picture foreground) does not separate the two cleanly. Needed: decide per step,
   e.g. register both "parent shown" and "built alone" and keep the better fit.

5. **Hidden faces need the collision check.** In step 4 my own choice put a 26604's back side stud into the 1x3
   brick; the picture cannot see it, only collision can.

6. **Stacks sunk in a hole.** BrickHeadz heads hide a 1x1 brick and a round plate in a hole, with a coloured 1x1 plate
   on top that shows (40353 printed steps 7 and 8 of the second figure). Largest first, the brick goes first; nothing
   in the picture says where, and the three parts ended up hidden at the model's bottom. A look-ahead through hidden
   parts did not help (the brick is visible through the open hole, in the wrong colour) and was 10x slower. What
   works: the top plate scores best drawn 32 LDU above the hole's bottom stud, as if floating, and the step's other
   parts fill exactly that gap. `place.py: _filled_stacks` takes each part's best floating poses (even without
   arrows), stacks the other parts from the same stud up to it, and starts the beam with that stack
   (`BOOKLET_SOLVER_FILL=0` turns it off). The stack order follows part size, which matches the key here; the picture
   cannot tell the order of hidden parts.

7. **The beam's ranking loses an answer the completed score prefers.** Printed step 11 (front face: dark-tan tile,
   dark-tan tile, tan slope 85984, tan tile): the solver swapped the tan slope and tan tile. The completed-model score
   prefers the right answer (1.667 vs 1.646), and a joint search over the 4 parts finds it, but the beam ranks states
   by summed per-part gains and drops it. Needed: re-rank the beam's final states by completed score.

8. **Hidden parts have no evidence.** Printed step 3 (second figure): the round plate goes on the back side stud of
   the 87087 added in the same step, facing away. The solver dropped it at the model's bottom. Candidate prior: a
   part hidden everywhere goes on a part new in the same step.

## Second booklet: 41605 (Thanos, 25 steps, 89 parts)

Solver with the fixes above (wide scale): 33/89 (37.1%), 8/25 steps. With tight scale and the arrow push below:
39/89 (43.8%); 40353 under the same settings 99/123 (80.5%). (Those two runs mix tight scale, arrow push and the
Technic roll fix; the separate A/B is below when finished.)

9. **Exploded parts follow their arrows, not their connection axis.** Step 3: a 2x4 plate drawn below and in front of
   the model with two arrows pointing up-left to where it goes. Floating poses were only tried along the approach
   axis (straight up here). Now each arrow's image axis and length are read from the arrow mask
   (`Picture.arrow_axes`; sign not kept, heads are unreliable at this size) and every candidate is also tried shifted
   along each arrow by 0.75-2.5 arrow lengths, both ways; the drawn pose keeps the matching world move in the camera
   plane (`Scored.move`). Switch `BOOKLET_SOLVER_PUSH`. This particular step is still wrong: see 10.

10. **Parts laid flush, tied in later.** The same plate's true pose has no connection yet: it lies level with the two
    base plates, against their front edge, and later steps tie it in. No stud or Technic candidate can produce it.

11. **Covering another part's colour was free.** Step 5: two black and two pearl-gold 1x1 plates in a row, black on the
    outside. The colour term rewarded the part's own colour and penalised covering pixels the model already
    explained, but drawing over pixels of another unexplained colour cost nothing, so the black plates (placed first)
    took the middle studs. `BOOKLET_SOLVER_MISMATCH=1` subtracts those pixels; the gold pair then lands right (off by
    default until the A/B).

12. **Black parts on black have no evidence.** Black faces are dark grey, near the dark-blue class, and booklets draw
    black parts with light-grey outlines while the edge term looks for dark ink. On a black base a black plate
    changes neither colour nor dark edges, so it scores like a hidden pose. Needs an edge map of light lines on dark.

12b. **Camera scale.** Printed step 10: four plates on top spread to fill the extent because the registered scale was
    small. Tight scale (+-3%, 4 hypotheses) is the fix measured earlier.

## Candidate coverage (`python -m booklet_mpd.solver.coverage`)

For every part on the 42 train sets: is its true pose among the enumerated candidates, with the rest of the step in
place? It is the ceiling on teacher-forced accuracy.

| | Covered |
|---|---|
| First run | 4783/5611 (85.2%) |
| Technic turns counted from the host's frame, not the world's (a pin on a beam turned 13.6°) and matching at 0.1 LDU | 5029/5611 (89.6%) |

The 0.1 LDU match matters beyond coverage: `exact_flags` compares at 0.001 LDU and by unique rounded vertices, and
answer keys store about two decimals, so parts on angled beams (42079 pins on 6629) are never "exact" even when
right. `exact_flags(..., atol=0.1)` compares vertex sets by nearest neighbour; the benchmark still uses 0.001.
Remaining misses: 410 touching but not enumerated (half pins 4274 in plate holes are off by 2 LDU from the 10 LDU
slide grid; set-specific embedded parts; bushes; flush plates), 126 parts of sub-models drawn without a base.

## Collision checker (src/plan/collision.ts)

The step-2 failure led to an audit of the app's collision check against the answer keys:
`scripts/collision-audit.ts` runs every part of 295 OMR answer-key sub-models (10,697 parts) against the rest of its
model. Every reported hit is a false collision. With `--shift dx,dy,dz` it moves each part instead and counts how
often the real overlap is caught.

| Change | False hits |
|---|---|
| Start | 33.1% |
| Rotation applied transposed in the part-frame test (any part turned 90° tested wrong) | 16.3% |
| Columns seated in a socket skipped; only studs that stick out of their part poke others | 15.6% |
| Sample points must be inside the part along all three axes (not just the vertical line) | 3.4% |
| Sockets in the tubes under bricks/tiles (a jumper's stud under a tile) | 3.2% |
| 4,853 parts embedded in OMR files extracted to `public/ldraw/models` (missing meshes 249 → 4) | 3.4% (more parts tested) |
| Axles open the holes they sit in; holes in the moving part open for a fixed shaft | 3.2% |
| Cross holes open to the wall where the axle is; samples every 4 LDU down each line | 3.1% |
| Studs midway between two sockets in a 1-wide row (1x2 jumper / 2x2 offset on a 1xN row) | 2.9% |

Caught real overlaps (shifted parts): down 8 LDU 85.7 → 89.2%, down 4 84.3 → 85.3%, sideways 6 82.0 → 86.1%.
Regression tests from real placements are in `tests/plan/collision.test.ts` ("answer-key placements"). The remaining
2.9% (about 310 parts) is mostly self-overlapping OMR models (48208/48205), off-grid poses in the data (4282/3008,
0.6 LDU), and a few joints (15573 on 99781, 6141 on 4274). `scripts/extract_omr_embedded_parts.py` rebuilds the
embedded-part folder (git-ignored, as the library is).

With the fixed checker the solver alone goes 82 → 86/123 on 40353 (21/38 steps exact).

## A/B: arrow push and colour mismatch (same night)

Teacher-forced, tight scale on all runs. T = arrow push on, P = push off, M = mismatch penalty on.

| Set | T (push) | P (no push) | M (mismatch) |
|---|---|---|---|
| 40353 | 99/123 | 98/123 | 82/123 |
| 41605 | 39/89 | 39/89 | |
| 40271 | 36/79 | 36/79 | |
| 41488 | 47/77 | 49/77 | |

Push (parts drawn displaced along their arrows): +1 / 0 / 0 / -2, neutral, so it is off by default
(`BOOKLET_SOLVER_PUSH=1` turns it on). Mismatch (penalise picture pixels of a different colour under the part):
99 -> 82 on 40353, strongly worse; it punishes parts whose picture colour is shaded or outlined, so it stays off. The
other M runs were stopped.

## Related: scale A/B (same night)

Teacher-forced on 4 train sets, scale held to +-3% of the page prior with 4 camera hypotheses vs the old +-10% / 3:
166/366 (45.4%) vs 148/366 (40.4%), better on every set (40271 38 vs 36, 41605 35 vs 30, 41488 48 vs 43,
41620 45 vs 39). Switches: `BOOKLET_SOLVER_SCALE_SPAN`, `BOOKLET_SOLVER_HYPOTHESES`; results kept apart with
`BOOKLET_SOLVER_TAG`. That run predates the picture fixes. Tight scale is now the default.

## Codex small-set run (30023)

Final 15/25 exact: steps 1-5 15/18, all 7 parts of steps 6-9 wrong. Its input (new parts per step) and the
"round sections share an axis" rule were written by hand.

## 2026-11-12: ink, sub-builds, search and section camera

Teacher-forced on the same four sets (exact parts). Each row adds to the one above.

| Run | 40353 /123 | 41605 /89 | 40271 /79 | 41488 /77 | Total /368 |
|---|---|---|---|---|---|
| Value ink (V < 70, or black-hat > 40 and V < 150; was grey, which read booklet red as ink), no sub-builds | 100 | 43 | 37 | 49 | 229 |
| + sub-build panels, old search (O) | 94 | 45 | 36 | 49 | 224 |
| + duplicate poses dropped, best-shown part type first (D) | 96 | 57 | 40 | 57 | 250 |
| + camera held per booklet section (C) | 95 | 60 | 42 | 57 | 254 |
| + unit parts kept apart by the exact collision check, not boxes (F, current defaults) | **103** | **61** | **43** | **60** | **267** |
| F with largest part first (E) | 102 | 61 | 42 | 59 | 264 |
| F settings, sub-builds off (N, before the exact-collision fix) | 99 | 55 | 37 | 53 | 244 |

- **Sub-build panels** (`solver/subbuild.py`, `rawimages.subbuild_images`): a boxed sub-assembly ("2x") is solved
  alone under the main camera, the right way up, every part tried as the base at 4 turns and 3 scales, judged by a
  colour-aware F1 against the panel; its unit is then placed N times as a rigid unit (upright preferred, facing as drawn
  breaks ties). A one-part panel only gives that part's facing. `BOOKLET_SOLVER_SUBBUILDS=0` turns it off.
  Inside a unit, parts may not collide (exact checker: a box test rejected a plate on a headlight brick's recessed side
  stud, 40353 step 2 5/5 -> 1/5); parts the panel is better without are dropped and the rest solved again.
- **Search** (`place.py`, from the fresh review, `booklet-solver-fresh-review.md`): candidates with the same geometry (a
  1x1 plate's four turns) are scored once (`BOOKLET_SOLVER_DEDUPE`); parts go best first-placement gain first, not
  largest (`BOOKLET_SOLVER_ORDER=size` restores it); `_same_spot` is plain float comparison (half a step's time). The
  40349 free-run regression test loses one part to the new order (5 -> 4 of 10); its guard is now 4.
- **Section camera** (`step.SectionCamera`): once two of the last five steps agree on a camera (within 6 degrees), the
  next step is solved under it first at a fixed scale; the free camera search runs only if its completed score falls
  more than 0.15 under what the section's steps scored, and a free camera must then beat it by 0.15. Wired into the
  benchmark and `pipeline.run`; `BOOKLET_SOLVER_CAMERA_HOLD=0` turns it off. Fable's prototype with a hand-set section
  gave 41605 steps 2-17 39/50 vs 29/50; the automatic version adds +4 over D on the four sets.

### What 40353 still loses (20 parts, run F)

| Cause | Parts | Steps |
|---|---|---|
| Picture does not show the step (data alignment): a black base plate for five white/coloured parts | 5 | reindeer 21 |
| Sub-model drawn alone; the whole parent is fitted to it (finding 4); step 22 is also black on black | 6 | elf 1, elfie 22 |
| Facing hidden (side-stud bricks, clips turned 90/180 degrees) | 3 | 20, elf 4, elf 6 |
| No evidence (hidden, score 0) or same-colour small parts swapped | 4-5 | elf 14, elf 17 |
| Depth: one stud further back looks the same | 2 | 5, 18 |

Next: fix the step/picture alignment, a "built alone" hypothesis for sub-model starts, then the next step's picture
for hidden facing and hidden parts.
