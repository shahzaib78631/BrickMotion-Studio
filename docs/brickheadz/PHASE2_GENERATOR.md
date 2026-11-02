# BrickHeadz Phase 2 — Procedural Generator

Phase 2 turns the Phase-1 construction grammar into an engine that builds a
**new, structurally valid BrickHeadz** on the stud grid and writes a **studio
plan** (the studio emits the MPD from it). It is the template/procedural core:
valid by construction, learned creativity comes later.

## Usage

```bash
cd python && uv sync          # once

# a random character (spec sampled inside the learned distribution)
uv run python -m brickheadz generate --seed 1 --name MyHero --out ../.cache/brickheadz/gen

# a specific character
cat > hero.json <<'JSON'
{ "name": "ForestWizard", "head": 4, "body": 4, "body_h": 12, "head_courses": 3,
  "leg_h": 2, "base": true, "hair": "cap", "eyes": "round",
  "color_head": 14, "color_body": 2, "color_hair": 15, "color_eye": 0, "color_accent": 71 }
JSON
uv run python -m brickheadz generate --spec hero.json --out ../.cache/brickheadz/gen

# print an MPD to stdout, or validate a batch
uv run python -m brickheadz generate --seed 1 --stdout
uv run python -m brickheadz sample --count 30 --seed 7   # → ok rate + plan files per model
```

`generate` writes `<name>.plan.json` and exits non-zero if the structural validator
rejects the model; the MPD is emitted from the plan by the certify step
(`validate-brickheadz --emit-mpd`), so both use identical placement.

## Module map (`python/brickheadz/`)

| module | responsibility |
| --- | --- |
| `parts.py` | curated studs-up brick vocabulary; footprints/heights measured from the library |
| `spec.py` | the character spec + `random_spec` sampling (dimensions, colours, hair, eyes) |
| `builder.py` | grid + placement math, region tiling, and the BrickHeadz build (base, legs, body, head, face, hair) |
| `validate.py` | overlap / connection / support checks on plate-cell occupancy |
| `export.py` | MPD and studio-plan-JSON writers, coordinate normalisation |

## How the figure is built

Everything is placed on an integer grid: **x/z in studs, y in plates, +y up**,
using the studio's own convention (a grid item's `x/y/z` is the min corner of its
rotated footprint, bottom of the piece). Part orientation is never guessed —
`info(lib, part)` measures each part's footprint and height from the LDraw
geometry, so a `3001` is correctly known to be 4×2.

- **Stand** — a `3958` 6×6 plate at the ground.
- **Legs/feet** — two short 2×2 brick stacks.
- **Body** — a `body_h`-plate cube filled with bricks, then plates for the
  remainder (brick bond by running the tiler per course).
- **Head** — the BrickHeadz core idea, `head_courses` tall:
  - a bottom plate that bridges everything above it,
  - each course = a **SNOT ring** of `22885` (Brick 1×2×1.667 with 4 studs on one
    side) facing outward on all four faces, around a studs-up **core**,
  - a top plate capping the head (tiles, for a smooth crown).
- **Face** — two `4073` round plates mounted on the upper front studs of the
  head. These are off-grid (a side stud sits at a half-plate height), so they are
  placed by **explicit matrix**: the decoration's contact face is set flush on
  the stud tip with its bottom rotated to face the head.
- **Hair** — `flat` (a tiled cap), `cap` (a raised crown), or `none`.

## Placement & export

- Studs-up pieces carry a grid pose `(x, y, z, rot)` and are exported as grid
  items in the plan JSON; their LDraw matrix is computed with the same formula as
  the studio (`src/plan/placement.ts::gridToPlacement`), verified by round-trip.
- SNOT/mounted pieces carry an explicit 4×4 matrix and are exported as raw
  `{ ldu, matrix }` items (the plan format's shape for off-grid pieces).
- `export.normalize` shifts the figure so the footprint's min x/z is 0.

## Validation

`validate` works on the plate-cell occupancy of the studs-up pieces:

- **overlap** — no cell is booked twice (the builder also enforces this);
- **connection** — the whole figure must form a single face-adjacent component;
- **support** — that component must reach the ground.

Mounted decorations are attached by construction and counted separately. This is
the cheap first line of defence; Phase 3 adds mesh-level certification with the
studio's `MeshOracle`.

## Measured results

- `sample --count 30` → **30/30** models validate (overlap-free, connected,
  grounded).
- A generated default model (48 pieces) round-trips through the MPD loader
  unchanged, forms a single connected assembly, and re-reads through the Phase-1
  analyzer with a **4.2×4.2-stud head cube** and two detected face tiles.
- Every fixture plan passes the studio's own `parsePlan` schema, and the MPD
  imports cleanly through `importLDraw` (`tests/brickheadz/plan.test.ts`).

## Limitations

- The model is a compact template (~40–70 pieces), not a full-detail replica of
  a licensed set; hair/arms/accessories are still simple.
- Only axis-aligned figures (no side-mounted arms yet) and three hair styles.
- `validate` is grid-level, not mesh-level: interpenetration of mounted
  decorations is checked by construction, not certified.
- Colour choice comes from a small curated palette, not the full LDConfig table.

## What comes next

Phase 3 wires the generator's output into the studio `MeshOracle` +
connector/assembly graph for real collision certification; Phase 4 trains a
learned layer on the Phase-1 dataset; Phase 6 adds the studio panel.
