# Real-page labels: what changes and why

Reviews: Codex, Big Pickle (opencode) and Command Code DeepSeek read `realpage-review-brief.md`. They agreed on the
points below, and each was checked against the code and data before it went in here.

## Findings (checked)

- **RGB agreement is the wrong test.** Booklet palettes and shading differ from our render style, so the blurred RGB
  difference marks most of the model. Dark-line (outline) maps do not depend on palette. Big Pickle measured the
  line distance in the new parts' region on the three evidence pages: full-model render 0.35–1.25 px (p50), model
  so far 1.35–5.03 px (p50). That separates them cleanly where RGB gave 1–40% precision.
- **`red_band` flags orange.** Orange (238,138,44) passes `r>140, r-g>70, r-b>70`. On 40348-20, 92% of the new
  part was erased from the evidence. Real rasters in these sets carry no red outline anyway (40348 has none; 41620's
  is a vector overlay outside the raster). Our renderer's band is (180–235, 0–60, 10–70), 1.8–3.6 px wide.
- **The camera is only checked against its own correspondences.** `fit_camera` frees `eye` whenever the start has one,
  so kept cameras include eye 333, 2.2e9 and 4.2e10. Training draws eye from 2000–9000 (or orthographic). On every
  kept page the solved scale is within 1–3% of the print scale.
- **Silent drops.** `main` drops `rgb is None` (14 cases, all 42079) without a reason; reruns leave stale samples.
- **Chaining only follows kept pages.** A page whose camera is right but whose new parts fail does not pass its view
  on.
- *Refuted:* 42079 step 201 (`palette.ldr`) is a forklift **pallet** being built, not a colour palette; its lines fit
  at 0.35/0.90 px. It stays.
- *Refuted:* "uses `fits[-1]` instead of the best round": the returned camera is the last round's, so `fits[-1]`
  describes it. Not a bug.

## Design

1. **Independent camera check** (`camera_check`): render the whole model at the solved camera and phase-correlate
   it with the page in tiles: at least 8 tiles, median shift ≤ 1.0 px; dark-line p90 ≤ 4 px; scale within 5% of the
   print scale. Among tight starts the smallest tile shift wins (not the most matches). *Measured:* nearest-line
   distance is blind to shifts (studs are dense: an 8 px shift gives p50 0.5), tiles are not (5 px shift reads
   4.97). On the 12 old kept pages, trusted ones shift 0.33–0.71 px; the suspect ones 1.53, 2.35, 7.43, 8.57 px.
2. **Bounded eye**: `fit_camera` keeps `eye` in [1500, 12000].
3. **Edge counterfactual for the new parts** (`edge_agreement`): in the new parts' region (dilated 9 px), the full
   render's lines must fit the page (p50 ≤ 1.5, p90 ≤ 4) and fit it clearly better than the model-so-far render
   (base p50 ≥ full p50 + 0.5). Then each new part with ≥ 40 visible px is removed in turn: in its region the page
   must be fitted by the whole model (p50 ≤ 1.5, p90 ≤ 5) and better with the part than without (p90 by 1 px or p50
   by 0.5). A part whose removal barely changes the drawing (render vs render p90 < 2, e.g. mostly hidden) cannot be
   judged and is skipped. *Measured:* "outline near a page line" support passed a missing part (0.67), so it was
   dropped; removal catches it, and flags 41620 step 8 part 30 (page fits 0.75/2.3 without it, 2.0/15 with it).
   This replaces the RGB test in `label_case`.
4. **`red_band`**: only the renderer's red (g < 100, b < 110, r − g > 110), and only thin structures (a filled red
   part is not a band).
5. **Section camera**: `main` keeps the last camera that passed the camera check, whether or not the page was kept.
   The next page tries it first with only `cx, cy` free (the view is shared across a section), then the standard
   views.
6. **Paper**: only paper-coloured regions connected to the picture border are paper (DeepSeek: a white part on
   white paper was repainted grey).
7. **Accounting**: every drop has a reason (`no image`), and a set's output directory is cleared before it is
   written.

Deferred: main image inside a filled panel (rawimages, shared with the solver); the PlaceDataset evidence channel
still uses RGB change evidence (a model input change; DeepSeek: training and keep decision should share it);
`solve_camera` drops pixels the network calls new, which may starve early steps (DeepSeek) -- measure on the
camera drops first. Pages whose added parts sit in a sub-build panel fail the per-part check.

Realistic target after these: 25–50% kept, with no kept camera off the bounds or the line test.
