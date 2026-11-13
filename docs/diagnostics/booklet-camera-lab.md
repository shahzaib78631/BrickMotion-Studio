# Booklet camera lab

Run `npm run dev`, then open `/booklet-camera.html?set=21065`.
The page fits an orthographic camera to known LDraw geometry and booklet crops, then displays the reference, a Three.js render, a magenta edge overlay, and a silhouette difference for each step. Green means overlap, red means reference only, and blue means render only.

The camera yaw, pitch, roll, and printed scale are shared. Crop translation, model turnover, and each new part's exploded displacement are per step. `ptsPerPx` normalizes raster resolution across crops. The fitter first registers the existing assembly with red-enclosed new regions excluded, then holds the shared camera while fitting new parts in the image plane.

The inputs are known assembled poses, not inferred part identities. Export them with:

```sh
cd python
.venv/bin/python ../scripts/teach_export_camera.py 21065 1
```

This writes `public/_booklet/<set>/index.json`, `step-NNNN.json`, and native-resolution `step-NNNN.png` images. The page's Download link exports the fitted camera, per-step displacement vectors, turnover decisions, and measurements.

Useful query parameters:

- `steps=1,2,3,4,5,6`: choose which steps to display. Shared calibration always uses the complete indexed booklet, so adding or hiding a displayed step does not refit the camera.
- `anchor=2`: choose the assembled calibration step. Otherwise the first upright step with at least four parts is used.
- `prior=36,35,0,1.7`: seed yaw, pitch, roll, and pixels per LDraw unit. Without this, a coarse search estimates them from the anchor.
- `trust=1,2,3,4`: use all parts in these steps during shared calibration. Only use this for assembled drawings.
- `zoom=0.6`: display scale; fitting and metrics still use native pixels.
- `joint=0`: retain the independent per-step diagnostic fitter.

## Verification

```sh
npm test -- tests/dev/bookletCameraMath.test.ts
npm run typecheck
node scripts/verify-booklet-camera.cjs 'http://localhost:5173/booklet-camera.html?set=21065&zoom=0.6' output/booklet-camera/21065.png
```

The verifier launches its own headless Chrome, waits for the fitting result, writes a JSON report and PNG comparisons, and exits on page failure or timeout. `CHROME_BIN` and `CDP_PORT` can override Chrome and the debugging port.

## Limits

A shared camera is a section-level hypothesis. Rotated views, detail insets, different illustration scales, and new submodels need separate sections. The current page supports upright / turned-over model orientation, not arbitrary rotations. A single orthographic image cannot determine explosion displacement along the viewing direction; exported offsets are minimum-depth camera-plane displacements and must not be treated as physical assembly motion. Arrows, red outlines, conditional LDraw edges, differences in part geometry, and printing style may leave residual pixel error. The displayed metrics expose that error rather than certify pixel perfection.

## Measured example: 21065, first six exported steps

The saved comparison is at `/output/booklet-camera/index.html`. With the corrected source geometry, automatic calibration recovers yaw 36.60°, pitch 35.30°, roll 1.11°, scale 1.7040 px/LDU. These angles remain shared throughout the sequence. Steps 5 and 6 are turned over.

| Step | Silhouette IoU | Render → reference p90 | Reference → render p90 |
| --- | --- | --- | --- |
| 1 | 0.917 | 1.00 px | 6.24 px |
| 2 | 0.917 | 1.00 px | 7.00 px |
| 3 | 0.906 | 1.00 px | 7.00 px |
| 4 | 0.914 | 1.00 px | 7.00 px |
| 5 | 0.846 | 1.41 px | 2.41 px |
| 6 | 0.891 | 1.41 px | 2.41 px |

These results support a shared camera for this example; they do not establish pixel-perfect recovery or general accuracy across booklets. Reverse edge errors and silhouette mismatch remain material. Eleven regression tests and TypeScript type checking passed; headless Chrome completed all six Three.js renders. The final assembled-step fix preserves the shared camera and the step-1 through step-5 comparison PNGs byte-for-byte. Step 6 has zero illustration offsets, no reported assembled collisions, no missing meshes, and a connector mate for each new end plate.

## Step-selector regression

The default shared fitter calibrates from the complete indexed booklet before applying the `steps` display filter. Previously, selecting only step 5 made the exploded step the calibration anchor; adding step 6 selected a different anchor and changed the joint objective, so step 5 was solved under a different camera.

To verify selection invariance, render `?set=21065&steps=5` and `?set=21065&steps=5,6` into separate folders using `verify-booklet-camera.cjs` (set different `CDP_PORT` values when running concurrently), then compare:

```sh
node scripts/check-booklet-camera-selection.cjs \
  output/booklet-camera/selection-single/21065.json \
  output/booklet-camera/selection-pair/21065.json 5
```

The check requires identical calibration references, anchor, shared camera, full step-5 fitting report, and PNG bytes. Explicit `names` runs are custom reference experiments; they continue to calibrate against their named images. The independent `joint=0` mode is unaffected.

## Assembled poses, gaps and collision diagnostics

The initial 21065 export was stale: step-5 end plates still had Y=16 while the teacher model had been corrected to Y=0. Step 6 also had a misplaced left end plate at (-220,24,-20); it now extends the opposite end at (-240,0,0). The reference export was regenerated from the teacher model. `teacherSha256` in `index.json` records the exported teacher version; regenerate after editing verified poses.

Step 6 is explicitly marked `exploded: false` in both the teacher record and the exported reference. This keeps every assembled part transform fixed and fits crop translation with the whole model visible. Previously, a few pixels of independent end-plate displacement opened an artificial seam even after the assembled input was corrected. Other unannotated diagnostic steps retain the experimental explosion search.

The page now runs the editor's `collisionWorld` against the assembled matrices and reports its sampled mesh collision pairs, missing geometry, and connector mates for new parts. These are diagnostics of the assembled model, not certificates for arbitrary exploded display offsets. Collision checks detect interpenetration; connector mating checks reveal detached parts. On the corrected six-step reference there were zero reported overlaps among 50 tested part instances, no missing meshes, and valid mates for both new step-6 plates.

`prior=yaw,pitch,roll,scale&lock=1` holds the shared camera exactly, useful for distinguishing geometry errors from camera errors. The corrected step-6 poses were also rendered under the previous camera without recalibrating it. Regression checks cover source-pose continuity, end-plate placement, missing geometry, connector loss after a small drift, and the existing camera projection tests.

## Book-one parts manifest (21065)

The final reviewed list is `public/_booklet/21065/book1-parts.json`, mirrored in `output/book1-parts/book1-parts.json`. The searchable evidence gallery is `/output/book1-parts/index.html`; `book1-step-bins.zip` contains all 447 LDCad bins, separated into the three restarted numbering sequences. The book-one aggregate is `book1-parts.pbg`.

The audit covers 447 main step records (111 + 151 + 185), 331 distinct PDF artwork groups, 1,277 printed quantity labels, 4,043 pieces and 315 part/colour combinations. Twenty assembly-only steps are retained as empty groups. The source is book 1, PDF 6655036; the printed inventory comes from book 3, PDF 6655038.

The accepted inventory is the user's first `ldcad_parts_bin_21065-1-sagrada-familia.pbg`. It agrees with the printed inventory and the current Rebrickable API on every one of the 514 whole-set part/colour counts, totalling 12,060 main pieces. Historical element-number mappings used in book one were independently refreshed for 51 IDs, with no identity or colour discrepancies. The later `21065-1.pbg` was excluded at the user's request. No raw forum part was installed or substituted.

Matching uses complete visible parts-box components instead of individual embedded image objects: the PDF splits some single pieces into overlapping images. Every artwork group has an explicit reviewed identity in `reference/booklets/21065/book1-identifications.json`. Six corrected cases distinguish open/solid round studs and studded/flat plates. Quantity labels are paired by left alignment, avoiding swaps when a long part's bounding box extends beneath its neighbour. An independent source check verifies all 1,277 labels, their literal quantities and uniqueness; the maximum label/artwork left-alignment discrepancy is 0.457 PDF points. Main callout quantities already include the indicated subassembly repetitions and are not multiplied again.

Identification is separate from mesh availability. All 170 distinct identified part IDs were checked recursively with `PartLibrary`: 168 exact meshes are complete, and the base shape for both printed variants `22385pr0149` / `22385pr0166` exists but their exact decorations are unavailable locally. Their distinct IDs, element numbers and source images remain in the manifest and bins; they were not collapsed to plain `22385`.

Reproduction from the existing source PDFs and catalogue caches:

```sh
python/.venv/bin/python scripts/audit_book1_parts.py
python/.venv/bin/python scripts/verify_book1_catalog.py
python/.venv/bin/python scripts/build_book1_parts_manifest.py --pbg /Users/mac/Downloads/ldcad_parts_bin_21065-1-sagrada-familia.pbg
python/.venv/bin/python scripts/verify_book1_parts_source.py
npx tsx scripts/audit-book1-meshes.ts
cd python && .venv/bin/python -m pytest tests/test_booklet_parts_manifest.py -q
```

The optional contact-sheet review helper uses Pillow. Review identities are bound to the PDF checksum and the complete artwork-key set; changed or unreviewed artwork fails compilation. The teacher workbench now prefers `audited-parts-1.json`, keeps geometry aliases such as `28653` / `3023b`, and rejects a source-PDF or published-manifest checksum mismatch. The old step-9 `3666` black override was corrected to the visibly five-stud `78329`, consistent with the supplied inventory.

Validation: ten manifest tests pass, TypeScript checking passes, every zipped step bin agrees with the JSON, all source quantity checks pass, and the teacher pipeline reads 447 reviewed groups / 4,043 pieces. Browser checks confirmed sequence/step filtering, printed-part search and reset to all 447 records. These are explicit coverage and consistency checks, not a calibrated statistical assertion of a zero error rate.
