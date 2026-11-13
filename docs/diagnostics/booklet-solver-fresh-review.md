# Booklet solver: fresh review (2026-11-12)

Scope: `python/booklet_mpd/solver/` on branch `feat/booklet-mpd-phase1`, read as of this morning. No existing file
was edited. Prototypes, logs and pictures are in
`/private/tmp/claude-501/-Users-mac-Projects-BrickMotion-Studio/fable-review/` (scripts monkeypatch the solver from
outside). The machine was heavily loaded by the running benchmarks (load average 24-39 on 10 cores), so every
experiment here is small: 41605 (one booklet, 89 parts) and the first steps of 40353. Read the numbers as direction, not
as benchmark results.

## Short version

1. On the BrickHeadz-style sets the candidates are fine (coverage 97-100%). On 41605 (steps 2-26, 89 parts, 45 exact
   as is) the 44 lost parts split into 19 evidence losses, 16 search losses (the solver's own completed-model score
   prefers the answer key to what the solver returned) and 9 behind a wrong camera. 18 of the 19 evidence losses are
   two steps: the arm units, built in a sub-build panel and drawn apart from the model with arrows (steps 20, 23).
2. **The camera is the cheapest large win.** A booklet section has one camera; the solver re-estimates it at every
   step (scale spread 3.3%, single steps 5-11 degrees or 180 degrees off). Holding one camera for 41605 steps 2-17,
   taken from the solver's own per-step choices, gives 39/50 against 29/50, in about a ninth of the time. With two
   search fixes on top: 43/50. After the model is turned round (steps 18-26) the
   camera changes several times and an automatic two-pass version gains little (18/39 against 16/39): sections must
   be detected.
3. Three things in the search waste the beam: geometrically identical poses are kept as different candidates
   (41-47% of all candidates), parts are placed largest first even when the largest part has the weakest evidence,
   and one pure-Python loop takes 60% of a step's time. The first two give 31/41 against 27/41 on steps 2-13 without
   the camera fix. Steps with several identical parts need more than that (a wider beam did not help).
4. **The previous step's picture is a perfect render of the model so far** and is not used. Aligned and subtracted it
   isolates the new parts; it aligns on about three quarters of the steps with a crude aligner. My first way of
   scoring with it did not improve results (28/41 against 29/41), so this one is evidence shown, gain not shown.
5. MEPNet's two structural assumptions are exactly points 2 and 4: a known, fixed camera, and the model so far given
   to the network in image space. Its learned keypoint detector is the part that transfers least to 100 dpi pictures
   and 42 training sets.

## 1. How the current design loses parts

The pipeline per step is: guess the camera from the model so far on this step's picture (several hypotheses), place
parts one at a time by render-and-compare with a beam, re-register with the completed model, keep the hypothesis with
the best completed score.

I measured where a wrong step goes wrong with `fable-review/diag.py` (answer key used for diagnosis only). For each
step it records:

* **coverage**: is each true pose among the enumerated candidates;
* **oracle camera**: the best registration of the true completed model, to compare with the camera the solver chose;
* **truth under the chosen camera**: the solver's own completed-model score (`register`, same local refinement as
  `step.completed`) for the answer key under the camera the solver picked, to compare with the score of what it
  returned. If the truth scores higher, the objective was right and the search failed.

41605, steps 2-26, solver as it is (89 parts, 45 exact, 44 lost; `fable-review/diag-41605-base.log`). "Gap" is the
completed score of the truth under the chosen camera minus the completed score of the returned answer.

| Step | Lost | Kind | Gap | Note |
|---|---|---|---|---|
| 2 | 1 | camera | -0.28 | camera 179 degrees off (symmetric base) |
| 3 | 1 | camera + coverage | -0.87 | plate drawn apart with arrows; true pose is flush, no connection yet |
| 5 | 4 | search | +0.05 | black and gold 1x1 plates; black placed first |
| 8 | 2 | search | +0.09 | sub-build panel (plates on the side studs of new bricks) |
| 11 | 3 | search | +0.01 | six identical 22885 forming a ring |
| 12 | 2 | search | +0.12 | sub-build panel, stack in the hollow |
| 13 | 1 | search | +0.003 | six 22885 again |
| 14 | 2 | camera | +0.01 | scale 2% too large |
| 15 | 2 | camera | +0.38 | 5 degrees and 6 px off |
| 16 | 3 | camera | +0.03 | 11 degrees and 14 px off (a large panel covers the base) |
| 18 | 2 | search | +0.04 | first step after the model is turned round |
| 19 | 1 | evidence | -0.01 | |
| 20 | 7 | evidence | -0.03 | arm unit drawn apart with arrows, sub-build panel |
| 21 | 2 | search | +0.04 | |
| 23 | 11 | evidence | -0.07 | second arm unit, same drawing as step 20 |

Totals: **evidence 19, search 16, camera 9** (one of the camera parts also has no candidate). A step is "camera" when the
chosen view is more than 3.5 degrees, 1.5% scale or 4 px from the oracle; "search" when the camera is right and the
gap is positive; "evidence" when the objective itself prefers the wrong answer. The kinds overlap: steps 12 and 13
count as search here, yet both also improved when the camera was held fixed (section 5).

A positive gap proves the returned answer is not the objective's best. It does not prove the truth is the best: a
wider search could find a third answer that scores higher still. Step 11 is the warning (section 5: beam 24 did not
help).

## 2. Root causes, by lost parts

### RC1. The search loses answers its own objective prefers

Evidence: section 1 table. Three mechanisms, each visible in the code and measured:

* **Duplicate poses fill the beam.** `candidates()` dedupes by translation and rotation matrix, so a 1x1 plate on a
  stud is four candidates (four turns), a 2x2 plate two or four. Over the first 15 steps of 41605, 17,758 candidates
  hold 10,543 geometrically distinct poses (ratio 1.68); on 40353 10,732 vs 5,743 (1.87)
  (`fable-review/symcount.py`). In `solve_step`, `per_part=12` and the state key both keep the turns apart, so a beam
  of 6 often holds one or two real alternatives. 41605 step 5: the top four candidates of each 1x1 plate are the same
  pose.
* **Largest first is the wrong order.** Size says nothing about evidence. 41605 step 5 (two black and two pearl-gold
  1x1 plates on a black plate): all four are the same size, black goes first, black has no evidence on black (its
  true poses rank 9 and 81 of 144, edge term -23 and -70 because booklets outline black parts in light grey), so it
  takes the gold plates' studs. Gold's true poses rank 1 and 2 once duplicates are removed. Placing the best-evidenced
  type first solves the step.
* **Summed per-part gains are not the completed score**, and only the top 3 final states are re-scored
  (`RERANK=3`). Identical parts make this worse: six 22885 in one step are 6! orderings of every placement set.

### RC2. The camera is re-estimated every step

Booklets hold one camera through a build section (it changes only at a rotate icon or a new sub-model). The oracle
camera over 41605 steps 4-17 is the same cube orientation, yaw 55, pitch 32.5-37.5 (the oracle's own 5 degree grid). The solver's per-step choice wanders around it:

| Step | Oracle scale | Chosen scale | Angle from oracle | Offset error (px) | Exact |
|---|---|---|---|---|---|
| 2 | 1.109 | 1.120 | 179 | 27, 22 | 0/1 |
| 9 | 1.120 | 1.109 | 2 | 1, 3 | 2/2 |
| 13 | 1.126 | 1.115 | 2 | 0, 3 | 5/6 |
| 14 | 1.123 | 1.145 | 2 | 0, 2 | 0/2 |
| 15 | 1.126 | 1.126 | 5 | 0, 6 | 0/2 |
| 16 | 1.134 | 1.123 | 11 | 1, 14 | 0/3 |

Over steps 4-17 the chosen scale ranges from 1.109 to 1.145 (3.3%) on a booklet whose camera does not change until
the model is turned round at step 18 (the oracle's yaw goes from 55 to 35 there). The oracle is itself a registration
and wanders too (1.109-1.134), which is the point: one picture does not fix the scale to better than about 1%, the
booklet as a whole does.

A 2% scale error over a 200 px model is 4 px, close to half a plate height (9 px). And on an early, symmetric base
the camera is truly ambiguous in one picture: step 2 of 41605 (two 2x2 plates, one 1x4 brick added) was registered
179 degrees from the true camera with a *higher* completed score than the truth (1.736 vs 1.688). No per-step
evidence can fix that; the later steps of the same booklet can.

### RC3. The previous step's picture is not used

The model so far is compared with the picture through our own flat-colour rasteriser and a colour-class table. That
comparison is what fails on white-on-pale, black-on-black, shaded faces, prints, and red read as ink. But the booklet
already contains a render of the model so far in its own style: the previous step's picture. Aligned by a pure
translation (same camera, same scale), the per-pixel difference is the new parts and nothing else
(`fable-review/img/masks-41605.png`, `img/pdiff-41605-0.png`).

How often a crude aligner (integer shift, colour-class correlation, `changed_mask` in `fable-review/proto2.py`) finds
the previous picture, on steps with a base:

| Set | Steps aligned | Parts in those steps | Median share of foreground that changed |
|---|---|---|---|
| 41605 | 19/25 | 72/89 | 0.24 |
| 40353 | 26/38 | 80/123 | 0.23 |
| 40271 | 15/25 | 49/79 | 0.23 |
| 41488 | 21/22 | 76/77 | 0.27 |

So about three quarters of the parts sit in steps where the difference is available, before any work on sub-pixel
alignment or on steps that follow a sub-model.

What it gives that the current evidence cannot:

* a hard negative: where the picture did not change, no new part is visible (today that rests on the rendered base
  matching the picture's colour class);
* black on black, tan on tan, white on white: the outline and stud changes show in the difference even when the
  colour class does not change;
* a completeness test for the step: changed pixels no new part covers mean something is still wrong (useful as a
  free-run confidence feature);
* the camera offset for free: the translation that aligns picture N-1 to picture N carries the registered offset
  forward, so the offset never has to be re-searched;
* "sub-model drawn alone" (finding 4 of the hand-solve notes) becomes a direct test: the previous picture does not
  align and the foreground is small.

### RC4. Units drawn apart from the model

41605 steps 20 and 23: 18 parts, all lost, camera exact, all poses covered, and the objective prefers the wrong
answer (gap -0.03 and -0.07). The arm is assembled in a sub-build panel and the main picture draws it whole, away
from the body, with two arrows. Nothing in this step's main picture shows the unit seated, so render-and-compare
against it cannot be right; the floating search moves single parts along their own connection axes, not a unit along
an arrow. This is the same family as open problems 4 and 5 and it is the largest single block of lost parts on this
set. Neither the camera nor the search fixes touch it. What does: solve the unit from its panel (as `subbuild.py`
does), then choose its seat by the **next step's picture**, which shows it attached (4.4). I did not prototype it.

### RC5. Speed blocks a wider search

Profile of 41605 step 10 (four 2x2 plates, 23 parts in the model; `fable-review/prof.py`): 140 s, of which 84 s is
`_filled_stacks` -> `_fills`, and 68 s of that is 2.28 million calls of `_same_spot` (`np.allclose` on two
3-vectors). Rasterising for registration is 22 s, scoring candidates 14 s. Step 12 took 443 s. A plain float
comparison in `_same_spot` (same test) removes about half of this step's time; computing each host's candidate list
once per `_fills` call instead of once per (pool part, pose) removes most of the rest. This is the first thing to do
for Technic, where steps could not be evaluated at all.

### RC6. Coverage (known; unchanged by this review)

`coverage.json`: 5029/5611 covered. Studded sets are at 97-100% (40353 122/125, 41605 88/91, 41488 78/79), so
coverage is not what holds the BrickHeadz numbers down. It is the cap for Technic (42061 8/40, 42120 50/137,
42079 209/320): half pins 4274 (39 misses), 2780 (20), 41677 (16), 43093 (11), 6558 (10), set-embedded parts, and
126 parts of sub-models drawn without a base.

### Checked and ruled out: working resolution

`Picture.from_rgb` resamples to 1.1 px/LDU. 41605 is 1.13 px/LDU natively (no resampling); 40353 is 1.70, so it loses
58% of its pixels. I expected that to matter. It does not on what I could run: 40353, steps 2-12 of the first two
figures, 75 parts: 63 exact at 1.1 px/LDU, 62 at native resolution, identical step by step except one part, and
1.6 times slower. Not a root cause on this set.

## 3. How others solved it, and what transfers

Written from memory of the papers except where a local file is cited; I could only confirm titles and abstracts
online today, not method details.

**MEPNet** (Wang et al., "Translating a Visual LEGO Manual to a Machine-Executable Plan", ECCV 2022). Per step the
network gets the manual image, the model so far *projected into the image under a known camera* (voxels lifted to
image-aligned features), and the new components' shapes. An hourglass network predicts, per component, a 2D keypoint
heatmap, a mask and a rotation class; a separate 2D-to-3D step turns the keypoint into a 3D position by searching the
positions where the component can connect to the base (stud to anti-stud) and taking the one whose projection is
closest. Trained on synthetic LPub3D renders; "classics" and "architecture" are LPub3D renders of real sets, not
scanned or PDF booklets. Published teacher-forced numbers as kept in `solver/bench.py: MEPNET_PUBLISHED`: component
accuracy 96.96 / 88.69 / 83.47% (synthetic / classics / architecture).

What transfers:

| MEPNet element | Here |
|---|---|
| Camera known and fixed for the whole manual | Not used: re-estimated per step (RC2). Estimate once per section. |
| Model so far given in image space, network sees image minus base | Our analogue is exact and free: the previous step's picture (RC3). |
| Keypoint, then snap to the discrete connection positions | Already the design (`candidates` + render-and-compare). We have a stronger back end than MEPNet: exact meshes, Technic snaps, collision oracle. |
| Rotation as a class among symmetry-distinct turns | Missing: symmetric turns are separate candidates (RC1). |
| Several identical components predicted as a set | Missing: identical parts are ordered (RC1). |
| Learned detector for the 2D evidence | Transfers least: pictures are about 1.1-1.7 px/LDU, 42 train sets. See 4.6. |

**Render-and-compare pose refinement** (DeepIM, CosyPose, MegaPose): a network scores or refines a pose from the
pair (observed crop, render of the hypothesis). This is the learned form of `gain()`. It becomes worth it only when
the hand-built comparison is the limit; RC1-RC3 say it is not yet.

**Manual-to-assembly for furniture** (IKEA-Manual, Manual-PA 2024, Manual2Skill 2025): align part point clouds to
manual drawings with transformers or a VLM; poses are continuous and coarse. Nothing there beats discrete connection
candidates for LEGO.

**Break and Make / LTRON** (Walsman et al., ECCV 2022), **Brick-by-Brick** (Chung et al., NeurIPS 2021): interactive
or generative assembly, not manual reading. I could not confirm a published successor that reads real LEGO PDF
booklets end to end.

Ideas from that line that fit our data:

* **The next step's picture.** Step N+1 draws step N's parts seated and (in the same section) under the same camera.
  For a step drawn exploded with arrows (41605 step 3: the plate is drawn apart, and its true pose has no connection
  yet), score step N's completed model against picture N+1 as well; pixels that changed between N and N+1 are
  ignored. This is the cheapest answer to "flush, tied in later" placements.
* **Parts-list callout images.** They show each new part alone, large, in the step's colours. Already used for
  identity; they can also calibrate the colour classes per booklet (the part's real drawn colours, shaded faces
  included) instead of LDConfig values with a brightness factor.

## 4. Proposed changes, ranked by gain per effort

By measured gain per effort: 4.2 (camera) first, with 4.1d (speed) because it makes every later experiment
affordable; then 4.1a-b; then 4.4 and 4.1c/e, which address the two largest blocks nothing here fixed; 4.3 needs a
better scoring form before it pays.

### 4.1 Search hygiene (hours)

a. Dedupe candidates by resulting geometry (key: hash of the rotated vertex set relative to its min corner, plus
   that corner's position). Prototype: `cands_sym` in `fable-review/proto2.py`.
b. Order a step's part types by their best root-state gain, not by size (prototype: `_order`); better, pick the next
   type per state as the one with the largest margin.
c. Treat identical parts as a set: choose k poses for the type in one move (top-k non-overlapping), not k moves.
d. `_same_spot` without numpy; cache candidate lists per host in `_fills`.
e. Re-score **all** final beam states by completed score, then hill-climb on that score: move one part to its next
   candidates, swap two parts of equal footprint, accept on improvement. The completed score is already the trusted
   judge; make it the objective of the last stage instead of a tie-break among three states.

Measure: teacher-forced exact parts on the four small sets, plus the share of wrong steps where truth-under-chosen
beats the returned score (`diag.py`); that share should fall towards zero. What remains is evidence, not search.

### 4.2 One camera per booklet section (a day)

Pass 1 over the booklet: register every step as now, keep the top registrations. Vote for (orientation, yaw, pitch,
scale) weighted by the number of parts in the model (late steps are unambiguous); take the median of the winning
cluster. Pass 2: solve every step under that camera, searching only the offset (and +-1% scale). A step whose best
score under the section camera collapses starts a new section (rotate icon, new sub-model). In free-run the same
vote runs over a sliding window. Prototype: flag `cam` in `proto2.py`.

Measure: scale and angle spread of the chosen cameras per set (should be zero within a section); exact parts.

### 4.3 Previous-picture difference (one to two days)

Align picture N-1 to picture N by translation (class-plane correlation as in `register._match`, then a sub-pixel
refinement; reject when agreement is low or more than about 60% of the foreground changed). Use the mask in three
places: (1) gain: penalise visible part pixels on unchanged picture pixels; (2) completed score: penalise changed
pixels no new part covers; (3) camera: carry the offset forward by the alignment shift. Keep the colour and edge
terms as they are inside the mask.

Measure: exact parts; separately the black-on-black and same-colour steps (41605 step 5, hand-solve finding 12).
My first prototype (flag `diff`) adds +1 per changed and -1 per unchanged pixel under the part; see section 5 for
why that crude form is not enough by itself.

### 4.4 Next-picture evidence for units and parts drawn apart (a day or two, after 4.2)

As in section 3 and RC4: 18 of 44 lost parts on 41605. For a sub-build unit: solve it from the panel, enumerate its
seats as now, and score each seat against picture N+1 under the section camera (the unit is drawn attached there). Needs "contact" candidates for the flush case: poses on the stud lattice adjacent to the model with
no connection, admitted only when the difference mask shows the part there.

### 4.5 Technic coverage and speed (ongoing)

After 4.1d, re-run coverage per connector family. Half-pin and bush offsets are a small table (2 LDU off the 10 LDU
slide grid), not a search problem.

### 4.6 A learned comparator, last

Once 4.1-4.3 are in, the remaining errors are true evidence ties (which way a side stud faces at 13 px). That is where
a small network trained on synthetic booklet-style renders (OMR and BrickNet models, the LDraw edge lines as outlines,
the booklet palette) can add something: input (picture crop, previous-picture crop, render of hypothesis A, render of
hypothesis B), output which hypothesis. It replaces only the tie-break, so it needs far less data than a detector, and
the 42 train sets remain a real validation set.

## 5. Prototype results

All teacher-forced, exact parts at 0.001 LDU as in the benchmark, collision oracle on, sub-build panels on, run with
`fable-review/proto2.py` (flags below) and `proto3.py`. Every variant, including "as is", uses the plain-float
`_same_spot` so the runs finish; it does not change results on the steps where I have both (steps 2-13 give 27/41
with and without it).

### 5.1 41605, steps 2-17 (one camera section, 50 parts)

| Variant | Exact | Seconds |
|---|---|---|
| Solver as is | 29/50 | about 1500 |
| + duplicates removed everywhere (`sym`) | 27/41 on steps 2-13 (as is: 27/41) | |
| + duplicates removed everywhere + evidence-first order (`sym,order`) | 34/50 | about 1140 |
| + duplicates removed in the beam only + evidence-first order (`sym2,order`) | 31/41 on steps 2-13 (as is: 27/41) | 764 for steps 2-13 (as is: 1112) |
| One camera for the section (`cam`), nothing else | **39/50** | **163** |
| One camera + `sym2,order` | **43/50** | **163** |

Per step (as is / camera only / camera + sym2,order): s2 0,1,1 of 1; s3 0,0,0 of 1; s5 0,0,4 of 4; s8 2,2,2 of 4;
s11 3,3,3 of 6; s12 2,3,3 of 4; s13 5,6,6 of 6; s14 0,2,2 of 2; s15 0,2,2 of 2; s16 0,3,3 of 3; all others equal.

How the camera was obtained matters, so plainly: the section camera here (yaw 55, pitch 35, scale 1.1231) is the
median of the cameras **the solver itself chose** on steps 4-18 of this booklet in the "as is" run (14 of 16 of
those were within 3.5 degrees of each other). No answer key went into it, but it is a second pass, and I picked the
section boundary (step 18) by eye. `proto3.py` does both passes and the fallback automatically; its results are in
5.4.

Two things I got wrong on the way, both worth knowing:

* Voting with the **pre-placement** registrations does not work. The best registration of the model so far on the
  current picture picked a different cube orientation in most steps (weights 379 for one orientation, 290 for the
  right one): a boxy BrickHeadz base, partly covered by the new parts, fits almost as well turned 90 degrees. The
  vote has to use the cameras chosen after placement (completed score), as the hypotheses loop already does per
  step.
* Removing duplicate candidates inside `candidates()` broke `_filled_stacks`: `_fills` matches stack parts by
  `host_conn`, and the duplicate that survives may carry another connector (step 12 went 2/4 to 0/4). Dedupe only the
  list the beam scores and expands, or keep every (host, connector) pair on the surviving candidate.

The time: one hypothesis instead of four, no coarse search over orientations. Roughly 7-9 times less on these steps,
measured under changing machine load, so treat the factor loosely.

### 5.2 Wider beam does not fix the identical-part steps

41605 step 11 (six 22885 in a ring) with beam 24 and all 24 final states re-ranked: 2/6 (beam 6: 3/6), 362 s. At the
root the six true poses rank 2, 3, 9, 10, 13 and 18 of 1042 by gain; poses shifted by one stud score as well or better
because each covers grey that two true bricks share. Partial states made of shifted bricks out-score true prefixes,
so width alone does not help. The step needs a set-level objective (the six must tile the changed grey region without
overlap) or the completed-score hill-climb of 4.1e. I did not prototype either.

### 5.3 Previous-picture difference, first crude form

`sym,order,diff,other` on 41605 steps 2-13: 28/41 against 29/41 for `sym,order` (step 5 4 to 3, step 11 3 to 2,
step 13 5 to 6). Adding the mask as +1/-1 per pixel on top of the colour term is not the right use: inside the mask
it rewards any part of any colour equally, so on step 5 black still prefers the gold plates' spots (which changed
more). The masks themselves are right where the alignment is right (`img/masks-41605.png`: steps 5, 10, 11, 13),
and visibly noisy where it is a pixel off (step 14). So: the evidence is there, my scoring of it is not good yet. The
form I would build next is in 4.3 (negative only in the gain, coverage in the completed score, offset carried
forward).

### 5.4 Automatic two-pass camera (`proto3.py`)

Pass 1 is the solver as it is; the vote clusters the cameras it finally chose (within 6 degrees, weighted by model
size); pass 2 solves each step under the winning camera with `sym2,order`, and keeps the pass-1 answer when the
completed score under the forced camera falls more than 0.15 below pass 1.

41605 steps 18-26 (after the model is turned round; 39 parts): **16/39 as is, 18/39 two-pass.** Step 21 went 2 to 4;
four of nine steps fell back (18, 19, 20, 26), correctly: their forced-camera scores collapsed (1.05, 0.61, 0.70, 0.56
against 1.5-1.65). So this stretch of the booklet holds several cameras (the turn at 18, the arm unit at 20, another
view at 26), one camera per model file is too coarse, and sections have to be found (score collapse, or failure of
the previous picture to align). The fallback did its job: no step got worse.

40271: started, not finished in the time I had (its sub-build steps take many minutes each as is). No result.

Put together for 41605, steps 2-26 (89 parts): as is 45; with the camera held per section and the two search fixes
61 (43 on steps 2-17 with the section boundary set by hand, 18 on steps 18-26 automatically). That is a mix of a
hand-set and an automatic boundary, so read it as what a working section detector should reach on this set, not as
a measured benchmark number.

## 6. Not verified

* The camera result is one booklet: large on 41605 steps 2-17 (boundary set by hand), small on steps 18-26
  (automatic). The 40271 run did not finish. Nothing on 40353, 41488 or any Technic set.
* The oracle camera in the diagnosis is itself a registration with about 1% scale noise, so "camera" versus "search"
  for small errors (steps 12-14) is a judgement, not a measurement.
* Sub-build panels (open problem 4), Technic speed and the 75277 losses: read, not run.
* Next-picture evidence (4.4), set-level placement of identical parts (4.1c), the hill-climb (4.1e) and the learned
  comparator (4.6) are proposals without prototypes.
* The MEPNet description and the other papers are from memory; today I could confirm titles and abstracts only.
* Timings were taken with the machine at load 24-39; ratios are indicative.
* 40353 "as is" on the steps I ran is 63/75; I did not run its third figure or the sub-model steps.
