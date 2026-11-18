# Build a model from Studio instructions

The local Studio model builder accepts instruction PDFs or ordered PNG/JPEG/WebP
pages. It reads the raster labels and part thumbnails, matches them to local
LDraw parts, fits the step camera, and searches connected placements with the
existing booklet solver. No source `.io` model or external AI service is used.

Start the upload and review interface from the project root:

```sh
npm run studio:builder
```

Open <http://127.0.0.1:8791>. Choose the PDF or page images in build order, then
click **Build model**. The first recognition scan renders and caches candidate
parts. The quick setting searches 256 frequently used parts; choose a larger
library for broader coverage, or optionally enter known part IDs to restrict
recognition. The quick scan cannot identify parts outside its candidate library.

The result includes part suggestions, editable IDs/colors/quantities, an MPD
download, and comparison images showing source / reconstructed view / overlay.
Confirm or correct a part and rebuild. Open the MPD using BrickMotion's existing
model import. All inferred poses carry review flags.

The observations editor also lets you change crop boxes and add missed steps.
Boxes use original page-image pixels `[left, top, right, bottom]`; `page` is a
zero-based index. Source images are linked beside each step. Do not change the
source image hash: it detects accidental use of observations with different pixels.

## Command line

```sh
npm run studio:builder -- build /path/to/instructions.pdf --out output/my-build
npm run studio:builder -- build /path/to/page-1.png /path/to/page-2.png --out output/my-build
npm run studio:builder -- build /path/to/instructions.pdf --out output/my-build --parts 3001,3004,3020
```

To search all locally catalogued parts, use `--catalog-limit 0`. For a short trial,
use `--max-steps 3`. The default collision check uses bounding boxes; add
`--mesh-collision` to request the existing Node mesh collision oracle. Its actual
availability is recorded in the report.

Correct `output/my-build/observations.json`, then rebuild using the same folder:

```sh
npm run studio:builder -- build --observations output/my-build/observations.json --out output/my-build
```

Set `confirmed: true` on reviewed part observations to retain your correction
instead of replacing it with an automatic suggestion. A corrected part requires
both its LDraw ID and LDraw color code. `repeat` defaults to 1 and `scope` to
`main`; repeated/callout scopes currently stop reconstruction and are reported.

## Files and status

- `observations.json`: source hashes, OCR, page/step crop boxes, identities and alternatives.
- `model.mpd`: inferred assembly with explicit `0 STEP` separators and review flags.
- `report.json`: counts, diagnostic messages, collision mode, per-step camera and image agreement.
- `review.html`: source/reconstruction/overlay comparisons, usable offline.
- `checkpoint.json`: placements and diagnostics through the last attempted build step.
- `pages/`, `crops/`, `comparisons/`: normalized images and visual evidence.

The CLI returns 0 for a completed **review-required** build and 2 for an incomplete
build. Operational errors are nonzero and do not leave an earlier successful MPD
as the apparent result. A completed build is never labelled verified. Thumbnail
and solver scores are uncalibrated ranking signals, not correctness probabilities.

## Current support

Automatic extraction targets large numbered Studio steps with light parts panels
above the assembly view. It supports vertically/horizontally separated step
cells when their labels and quantities can be read. It does not promise arbitrary
custom page layouts, reliable recognition of printed parts, flexible pieces,
callout hierarchies, exploded views, or unique recovery of invisible geometry.
Unparsed pages remain visible in diagnostics. The first build step defines the
model coordinate frame; subsequent placements are relative to it. Poor image
agreement or missing placements stops the build instead of silently skipping
the step and continuing on an incomplete assembly.

The previous step's fitted camera is tried first and released when image
agreement drops. This avoids compensating for a wrong placement by rotating the
camera, while still allowing Studio's per-step view changes.

For unusual layouts, correct the observations. For ambiguous hidden placements,
review the MPD in BrickMotion. A real Studio-exported user booklet is still needed
to measure real-world accuracy; the included smoke example is a generated raster
fixture with two ordinary bricks, not a claim of general reconstruction accuracy.

## Dependencies and smoke example

The launcher uses `python/.venv/bin/python` or `INSTRUCTIONS_PYTHON`. Required
packages are the project's Python dependencies plus the `vision` extra
(OpenCV and SciPy). Tesseract must be installed separately. On the current Mac
these dependencies are already available.

```sh
cd python
uv sync --extra vision
# macOS, if needed: brew install tesseract
```

Generate a small image-only PDF fixture and reconstruct it:

```sh
PYTHONPATH=python python/.venv/bin/python -m studio_builder.demo output/studio-builder-demo/source
npm run studio:builder -- build output/studio-builder-demo/source/studio-demo.pdf --out output/studio-builder-demo/build --parts 3001,3004,3020
```

The fixture generator's `expected-for-evaluation.json` is only an evaluation key;
the build command does not read it. The optional part shortlist constrains shape
recognition and supplies no coordinates, colors, quantities or step assignments.

Run the focused tests:

```sh
PYTHONPATH=python python/.venv/bin/python -m pytest python/tests/test_studio_builder.py -q
```
