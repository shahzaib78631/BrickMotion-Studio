# Review brief: real-page label fixes (before the expensive re-run)

**Read-only: do not edit, create or delete files, do not change git state, write nothing to disk.** You may read any
file, view images, and run read-only Python (`cd python && .venv/bin/python -c ...` printing to stdout).

Context: `docs/coordnet/realpage-review-brief.md` (the problem), `docs/coordnet/realpage-design.md` (the design).
The change is uncommitted: `git diff -- python/coordnet python/tests` plus the new
`python/tests/test_coordnet_realpage.py`. Kept samples from the *old* labeller are in
`.cache/coordnet/place-data/real-*/` (their json has the camera) if you want to try the new checks on them.

What changed:
1. `coordnet/realdata.py:camera_check` -- network-free camera test: phase-correlated tile shifts (>= 8 tiles,
   median <= 1.0 px), dark-line p90 <= 4, scale within 5% of print scale. Tight starts are ranked by tile shift.
   Measured on the 12 old kept pages: trusted 0.33-0.71 px, suspect pages 1.53/2.35/7.43/8.57 px.
2. `realdata.edge_agreement` -- replaces the RGB agreement: line distance in the new parts' region (full render
   fits, and beats the model-so-far render), then per-part removal counterfactual (skip parts whose removal barely
   changes the drawing).
3. `solve.fit_camera` -- eye bounded to [1500, 12000] (`solve.EYE_RANGE`).
4. `place.red_band` -- pure red only, thin structures only.
5. `realdata.paper_mask` -- paper = paper-coloured regions connected to the picture border.
6. `realdata.main` -- logs "no image" drops; clears the set's output dir; the section camera is the last camera that
   passed `camera_check` (even if the page then failed), tried first with only cx, cy free.

Follow-ups already made after Big Pickle and DeepSeek reviewed this (check them too):
7. `camera_check` also requires line p50 <= 1.2.
8. `edge_agreement`: parts judged must cover >= 50% of the new visible pixels; a part with too few lines is
   unjudged, not rejected.
9. `evaluate.dark_lines(..., thin=True)` / `line_distance(..., thin=True)` (used by realdata only): filled dark
   regions (a black part's face) are not lines.
10. `realdata.finite`: sample meta has no NaN. `main` prints a per-set count of drop reasons.
Known and ruled: mirror-symmetric views are not dropped (same picture -> same pixel labels; asymmetric new parts
fail the per-part check). A staged run on set 40348 is in progress.

Questions -- be concrete, cite file:line, verify claims by running code where you can:
1. Bugs: anything wrong in the diff (logic, thresholds applied wrongly, units: px at picture resolution after
   `_prepare` rescales, crashes on edge cases such as no tiles, NaN line distances, empty parts)?
2. Will these checks admit wrong labels? Construct a concrete failure (e.g. symmetric model, wrong quadrant; a
   translation-only section fit locking onto a neighbour; a part hidden enough to be "uninformative" but wrong).
3. Will they reject good pages for a bad reason (dark/black parts with light lines, thick booklet lines,
   upscaled small images where tiles are few, 640 px cap)?
4. Do the tests actually test the behaviour (would they fail if the feature were broken)? What is missing?
5. Anything that should be fixed before running the labeller over 187 pages (about an hour of compute).

Answer with a ranked list of findings (severity, evidence, suggested fix). Be direct; say "no issue" where none.
