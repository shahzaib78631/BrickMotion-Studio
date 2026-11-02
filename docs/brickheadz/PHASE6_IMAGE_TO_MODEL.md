# BrickHeadz Phase 6 — Photo + Parts → Model

The full "less data" pipeline: given **one front photo** and a **parts inventory**,
produce a certified BrickHeadz you can build. No MPD, no per-brick labels, no big
training set — colours and proportions come from the image (or a vision model),
geometry from the template, and the discrete choices from an offline
render-and-match search.

```
photo + inventory ─▶ spec (colours, proportions, hints) ─▶ inventory-constrained build
                  ─▶ render-and-match over proportions + headwear ─▶ certify (mesh oracle)
                  ─▶ plan + MPD
```

## Usage

```bash
cd python

# derive the spec: offline colours, optionally a vision model for hair/face/prop
uv run python -m brickheadz spec --image hero.png --inventory parts.json --out spec.json
uv run python -m brickheadz spec --image hero.png --inventory parts.json --vision   # needs ANTHROPIC_API_KEY

# full pipeline + certification (from the repo root)
npm run brickheadz:fit -- hero.png tests/fixtures/brickheadz/inventory.json
npm run brickheadz:fit -- clip.mp4 tests/fixtures/brickheadz/inventory.json   # a video
```

`brickheadz:fit` runs `fit` (search), then the Phase-3 mesh oracle, repairing only
flagged pattern pieces until CLEAR, then emits the MPD **from the certified plan**
through the studio's own placement.

## Image → spec (`image_spec.py`)

Offline (PyMuPDF + NumPy, no new dependency): the subject is separated from the
background, split into vertical regions (hair / face / body / legs / base), and
each region's median colour is mapped to the **nearest LDraw colour that is in your
inventory palette**; the aspect ratio sets a head-course hint.

## Vision hints (`vision_hints.py`)

With `--vision`, a vision model reads the photo and returns the design choices
offline analysis can't get: **hair style, eyes, head size, head courses, body
height, and colours** (constrained to your palette), plus free-text
`headwear_name`, `face_notes`, `prop_name` that are recorded on the spec.

It calls the Anthropic Messages API over plain HTTP (`urllib`, no new dependency);
set `ANTHROPIC_API_KEY`, or override the model with `--vision-model`. The network
call is injectable, so it is unit-tested without a key. A `--hints` file supplies
the same fields by hand.

## Render-and-match (`render_match.py`)

Optimisation at inference time instead of learned generation:

- **Coarse render** — each candidate is rasterised from the front (piece boxes
  projected to the photo's plane with their colours, back-to-front).
- **Score** — normalised silhouette **IoU** plus per-pixel **colour agreement**
  (both quantised to the inventory palette); lower is better.
- **Search** — a widened discrete space: head courses × body height × every usable
  learned headwear pattern (plus the procedural baseline). On the fixture that is
  **32 candidates**.

## Video → model (`video.py`)

A build/orbit clip is just many photos, so `video` ingests a clip end to end:

- **Extract** — samples frames across the clip with ffmpeg (needs `ffmpeg`/`ffprobe`).
- **Select** — scores each frame for a good front "hero" shot: subject coverage,
  left-right symmetry, centring, aspect and edge clipping; the best frame wins
  (usually a late, fully-assembled one). The chosen frame is saved beside the
  model for reference.
- **Build** — that frame drives spec → render-match → certified plan/MPD.

```bash
npm run brickheadz:fit -- clip.mp4 parts.json          # whole chain + certification
cd python && uv run python -m brickheadz video --video clip.mp4 --inventory parts.json --out ../.cache/brickheadz/video
```

`--frames N` sets how many frames to sample; `--vision` infers hints from the
chosen frame; `--hints` supplies them by hand.

**Result:** five real 720×1280 clips (12–17 s) each produced a **CLEAR** plan and
studio-emitted **CLEAR** MPD (44–56 pieces, within inventory), certified with no
repairs.

## Accent trim

Small colour details from the photo can be placed as legal accents:

- **`trim_collar` / `trim_belt`** — a thin 1-plate colour band at the top / bottom
  of the torso (a jacket collar, a belt).
- **`trim_center` / `trim_center_width`** — a vertical colour stripe down the
  centre of the torso's front face (tiled from 1×1 pieces, so it is per-cell).
- **`trim_clip`** — a `98138` 1×1 round tile mounted on the head's **front studs**
  as a hair clip (uses the real side stud, so it grips).
- **`color_face`** — the head's **front panel** in a different colour from the
  hood/shell (a silver faceplate inside a green hood).
- **`trim_arm`** — a 1×1 plate on each side at shoulder height (arms / hands, or
  trans-green energy claws).
- **`prop_cape`** — a thin plate wall one stud behind the torso (a cape).

They are spec fields (`-1` = none), set from the vision read or by hand. The
Doctor Doom example uses a **Dark Green** hood (`2`/`288`) with a **Light Bluish
Grey** faceplate, grey chest bar/belt/centre panel, **Trans-Bright-Green** claws
and a green cape — 80 pieces, plan and MPD **CLEAR**.

## Emitting the MPD

`fit` writes the **plan** (the studio-consistent artifact). The certify step then
runs `exportLDraw` on the certified plan (the printer `--emit-mpd` on
`validate-brickheadz.ts`), so the MPD uses the studio's exact placement — this
matters for parts with unusual origins (some slopes), where a Python-side matrix
can differ by a couple of LDU and clash.

## Results

- `brickheadz:fit` on a synthetic photo + the fixture inventory: **32 candidates**
  searched, best cost **0.40**; plan **CLEAR** and studio-emitted MPD **CLEAR**,
  52 pieces, within inventory, certified with 0 repairs.
- `--vision` request shape and hint parsing are unit-tested with an injected
  network call; the no-key path raises a clear error.

## Honest limitations

- **One photo is underdetermined** — the match constrains the front silhouette and
  colours, not the back or depth; those are invented by the template.
- The renderer is a **coarse box projection**, swappable for the studio's real
  three.js renderer.
- The discrete search chooses among **existing** headwear patterns and proportions;
  it does not invent new shapes. `prop_name`/`headwear_name` are recorded but not
  yet built.

## Next

- Use the real renderer for a stronger match signal.
- Turn `prop_name`/`headwear_name` into actual side-builds and bespoke headwear.
- Extend the discrete search to torso motifs and head width once 6-wide patterns exist.
