# Network-free camera fit to the page's lines (proposal, for review before it is built)

## Why

Staged run on 40348: 6/41 kept; 30 pages got no camera at all. On those pages CoordNet is confident on < 1% of
pixels and calls 52–66% of the picture "new" even from the right quadrant (step 5: 110 matches with the new-part
gate, 582 without; steps 14, 23: under 125 either way). CoordNet only knows our render style; this booklet's
palette and shading are outside it. The view itself is nearly known: one of 8 standard views (yaw 35 + k·90,
upright or turned), pitch ≈ 35, scale = print scale within 1–3%, eye ≈ 4200.

## Method (`coordnet/linefit.py`)

1. **Page lines.** `dark_lines(pic, thin=stroke)` (thin: filled dark faces are not lines; stroke follows the
   upscale). Distance transform with nearest-pixel labels.
2. **Model lines.** `render.scene_lines(parts)`: the LDraw edge segments in 3D, sampled every ~1 px of their
   projected length. Visible = the projected point's depth ≤ G-buffer depth + tol (one `gbuffer` per iteration,
   0.3 s; no full render inside the loop, 2.1 s).
3. **Global translation per start.** Start = standard view framed on the page foreground at print scale (or the
   section's last verified camera). Rasterise the visible model lines, blur both line maps (σ ≈ 1.5 px) and take
   the FFT cross-correlation peak over the whole picture: a global translation, so the fit does not lock onto a
   neighbouring stud. Keep the top 3 peaks as separate candidates (repeated structure).
4. **ICP refinement.** Match each visible model-line point to its nearest page-line pixel within r (8 → 4 → 2 px
   over iterations), then `solve.fit_camera(matches, cam, centre, free=...)`: first (cx, cy), then
   (yaw, pitch, roll, cx, cy), then scale within ±3% of print. Eye fixed at 4200 (released only if a later
   test shows the image supports it). Soft-L1 robust loss, as now. Stop when the median match moves < 0.1 px.
5. **Verification is unchanged and separate.** Each candidate goes through `camera_check` (tile shift, line
   p50/p90, scale) and then `edge_agreement`. The solver never decides acceptance; it only proposes.
6. **Ambiguity.** Keep all candidates that pass `camera_check`. If two pass with materially different poses (yaw
   > 3 deg apart or translation > 2 px) and give different new-part labels (new-mask IoU < 0.9), abstain. Equivalent
   symmetric views (same labels) are not a reason to abstain.
7. **Where it runs.** In `label_case`, after CoordNet: if no CoordNet start yields a camera that passes
   `camera_check`, try `linefit` from the section camera, then the 8 standard views. Meta records the solver
   (`coordnet` / `linefit`) and its diagnostics.

## Tests (before code)

- Synthetic page from the true camera, start = standard view framed (~10 px and ~4 deg off): recovers the camera
  to < 0.5 px tile shift.
- Same page recoloured (palette permuted, black faces lightened): still recovers (no colour used).
- Start translated by one stud pitch (20 LDU) from truth: the global step escapes the neighbour.
- Page of a *different* model / blank page: no candidate passes `camera_check`.
- Two candidates that pass with different labels -> abstain; mirror-equivalent candidates -> kept.
- `label_case` with a zero-confidence network (no matches) on a correct synthetic page: labels via `linefit`.

## Risks

- Booklet lines that our LDraw edges do not have (stud logos, printed decorations, shadows) add page lines with no
  model counterpart: the robust loss and the shrinking radius should absorb them; the verifier decides.
- Conditional lines (curved silhouettes) are view-dependent; `line_mask`'s conditional handling must be mirrored or
  they are left out of the ICP points (left out at first).
- Speed: 8 starts × ~6 iterations × 0.3 s ≈ 15 s per page worst case; acceptable for offline labelling.
