# BrickHeadz Phase 5 — Inventory-Constrained Generation

Phase 5 makes the generator **build from the parts you actually have**. Given a
parts inventory, it produces a BrickHeadz that uses only those shapes and colours
— the guarantee you need when the MPD is what you're trying to create.

## Usage

```bash
# generate a character that fits a parts list
python -m brickheadz generate --inventory parts.json --out .cache/brickheadz/inv

# optionally compose learned headwear too
python -m brickheadz generate --inventory parts.json --cast --out .cache/brickheadz/inv
```

`--inventory` accepts the Rebrickable parts export the instructions pipeline
already writes (`[{"part":"3001","color":4,"quantity":2,"spare":false}, ...]`),
a `{part: qty}` JSON object, or `part,color,quantity` CSV/lines.

## Module map (`python/brickheadz/`)

| module | responsibility |
| --- | --- |
| `inventory.py` | parse a parts list; shape/colour availability; palette |
| `constrained.py` | restrict the build to the inventory; adaptive dimensions; report |

## How it works

- **Shapes** — the tiling vocabulary is restricted to shapes in the inventory. When
  a shape runs out mid-build the tiler substitutes another available shape
  (plate↔tile, larger↔smaller) instead of exceeding the count.
- **Counts** — a per-build budget is consumed as pieces are placed; nothing is
  used beyond what the list contains (mounted eyes and pattern pieces are skipped
  if their shape is absent).
- **Colours** — every colour is drawn from the inventory's palette.
- **Head shell** — the SNOT head (`22885` ring) is used only if the list has those
  bricks; otherwise a plain studs-up head, still with a mountable top.
- **Adaptive dimensions** — if the parts can't support the requested size, the
  builder tries progressively smaller figures (fewer head courses, shorter body,
  no legs, no stand) until one fits, and reports the spec it settled on.
- **Report** — pieces used, shapes used vs available, any over-budget shape, and
  `withinInventory`.

## Results

- The committed fixture inventory (`tests/fixtures/brickheadz/inventory.json`)
  builds a full 4-wide figure: **within inventory and valid, 6/6 seeds**.
- A **real BrickHeadz inventory** (40859 Batman, 218 pieces, 50 shapes) now builds
  **full-size** — body 12 plates, 3 head courses, 62 pieces — **within inventory
  and valid, 6/6 seeds**.

## Using the whole inventory (slopes and curves as structure)

Two things make tight, slope-heavy sets build full-size:

- **Any solid shape by measured height.** The fill vocabulary is bucketed by
  height in plates, not limited to plain bricks: plates, slopes and curved slopes
  of 1–3 plates all serve as structure, chosen by their footprint. Part names come
  from the catalog and fall back to the LDraw header (following `~Moved to` alias
  stubs, which had silently dropped common parts such as `3023`).
- **Courses chosen by what can actually tile.** Filling a region tries the tallest
  height first and drops to shorter courses when the inventory can't cover the
  rectangle, so 7 three-plate bricks and 31 two-plate slopes fill a 12-plate body
  as `2,2,2,2,2,2` rather than failing at `3,3,3,3`.

## Honest limitation

Round/technic-motion parts (wheels, pins, axles, gears, dishes) are excluded from
structure because they leave gaps or have no flat top; a set that is *only* those
still shrinks. Very small sets without enough 1-plate parts raise a clear
"inventory too small" error instead of emitting an invalid model.

## Where this fits the plan

This is the "buildable from your parts" half of the image+inventory goal. It pairs
with the image→spec step (a single front photo + the inventory → colours, hair,
face, prop) so that `inventory + one photo → certified MPD` becomes the pipeline.
Because dimensions and headwear adapt to what's on hand, the same engine also
does free generation constrained to an inventory.

## What comes next

1. Image → spec (vision + inventory fusion).
2. Render-and-match refinement over the discrete choices against the photo.
3. Richer inventory vocabulary (slopes/curves as fill) so tight sets build full-size.
