# Review brief: why real booklet pages fail to become training labels

**Read-only: do not edit, create or delete files, and do not change git state; write nothing to disk.** You may
read any file, view the images listed below, and run read-only Python (`cd python && .venv/bin/python -c ...`).
Treat every claim here as a hypothesis to check against the code and data.

## Goal

`python/coordnet/realdata.py` turns step pictures from real LEGO instruction booklets (booklet_mpd *train* sets;
held-out sets are refused) into training labels for the placement network (`docs/coordnet/placement-v2-design.md`).
Per step: solve the camera with CoordNet against a render of the step's full model (answer key), then keep the page
only if the fit is tight and the rendered new parts agree with what changed on the page. Labels then come from the
G-buffer. We need many trustworthy real pages from many booklet styles.

## Result: 12 of 187 pages kept (sets 40348 BrickHeadz, 41620 Friends, 42079 Technic)

Drop reasons (logged by `label_case(..., why=...)`): 69 camera (no tight fit from any start), 57 new-parts check,
35 no base or no new parts (step 1, or steps whose answer-key group has no added parts).

## Evidence (images in `docs/coordnet/realpage-evidence/`, each row: page | render of full model with new parts
outlined | render of model so far | change evidence: red = flagged only, green = new parts only, yellow = both)

- `40348-13.png`: camera fit median 0.57 px, p90 1.30 (geometry lines up). New parts 32k px; change evidence 85k px,
  only 36% of it on new parts. The booklet's colours (saturated tan, dark grey, bright blue) differ strongly from our
  colour table/render style (`coordnet/render.py`), so `place.change_evidence` (blurred RGB difference > 60, minus
  red outline) flags nearly the whole model.
- `40348-20.png`: fit median 0.28 px, p90 0.62. Change evidence 86k px, 1% on the new parts. The new part is orange
  on the page, tan in our render (colour table or booklet palette?).
- `41620-12.png`: fit median 0.56, change evidence 40% on new parts.
- `40348-3-page.png`: early step, small single-colour model, upscaled from a small embedded image; no start
  converges.

Relevant code: `coordnet/realdata.py` (`_prepare`, `standard_views`, `label_case`, `main` chaining), `coordnet/
place.py:change_evidence`, `coordnet/render.py` (`Style`, `colour_table`), `coordnet/evaluate.py:solve_camera`,
`booklet_mpd/solver/dataset.py:cases`, `booklet_mpd/rawimages.py:main_model_image_info` (takes only the largest
raster image in the picture box; some booklets tile pictures into several images).

Earlier findings: solved cameras on these booklets sit at pitch ~35 deg and yaw ~35 deg in one of four quadrants; the
print scale `booklet_mpd.viewfit.BOOKLET_SCALE / pts_per_px` predicts the solved scale within ~2%; per-step fits on
LEGO 21065 agree to ~0.1 deg (the view is shared across a booklet section).

## My hypotheses (attack them)

1. New-parts check: compare structure, not colour. Either (a) calibrate a per-booklet palette from the base region,
   whose geometry is known after the camera solve (median page colour per LDraw colour), then render with it; or (b)
   compare line/edge maps (pages and renders both draw black outlines): new parts are where the render *with* them
   explains the page's edges better than the render without them.
2. Camera on hard steps: solve the booklet's view once from steps that converge, then for other steps of the same
   section fit only the 2-D offset (scale from print scale), checked with a weaker test.
3. The 35 "no base / no new parts" are correct skips except step 1 (all parts new on an empty base), which is not
   useful for placement anyway.

## Questions

1. Is the diagnosis right for each drop class? Find anything I missed (e.g. a bug in `_prepare`, chaining in
   `main`, case extraction, the agreement thresholds in `label_case`, pages that are exploded/sub-build drawings).
2. What is the most reliable new-parts agreement test across booklet styles? Concrete and testable.
3. What is the most reliable camera strategy for small/early steps and view changes within a booklet?
4. How do we guarantee kept pages are *correct* labels (no silent mislabels)? What checks, and what kept rate is
   realistic?
5. What tests should guard each fix?

Answer with: verdicts, the design you would implement (concrete enough to code), and top risks. Be direct.
