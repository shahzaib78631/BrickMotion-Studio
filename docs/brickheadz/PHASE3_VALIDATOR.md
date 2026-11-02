# BrickHeadz Phase 3 — Mesh Certification

Phase 3 runs every generated candidate through the studio's **real** collision
oracle and its connection checker, so a model is only accepted when its pieces
genuinely do not interpenetrate and it is one connected, grounded mass.

## Usage

```bash
npm run brickheadz:sample     # generate 20 random characters → .cache/brickheadz/gen
npm run brickheadz:verify     # certify them with the MeshOracle; non-zero exit if any fails

# or directly
npx tsx scripts/validate-brickheadz.ts public/ldraw .cache/brickheadz/gen
npx tsx scripts/validate-brickheadz.ts public/ldraw tests/fixtures/brickheadz/bh-sample.mpd
npx tsx scripts/validate-brickheadz.ts public/ldraw .cache/brickheadz/gen --json=report.json
```

`<file-or-dir>` accepts a `.mpd`, a `.plan.json`, or a directory of both.

## How it works

`src/anim/brickheadz/mesh.ts::certifyModel` is pure (caller supplies measured
parts + colours) and is driven by both the CLI and tests:

- **Interpenetration** — builds `modelFromPlan`, constructs the studio's
  `MeshOracle`, and runs `oracle.clear(a, b, 0, 0, 0)` over every candidate pair
  from `possibleFinalContacts` (the same sweep-and-prune broad phase the
  planners use). A false result is a real triangle-level overlap, not a
  bounding-box touch.
- **Connection / floating** — runs the studio's own `validate(assemble(plan))`,
  which unions pieces by contact and by LDCad connector mating and reports any
  piece that cannot reach its ground.
- **Verdict** — `CLEAR` only when there are zero mesh overlaps and zero floating
  pieces; otherwise `BLOCKED` (with the offending piece ids and parts).

`scripts/brickheadz-node.ts` does the node-side loading (filesystem LDraw library
+ vendored LDCad shadow metadata) so no browser or rendering is involved.

## What it caught, and the structural fixes

Running the generator through the oracle exposed two real defects that the
grid-level validator could not see:

1. **`22885` body placement.** The head brick's AABB is asymmetric (its side stud
   protrudes on one face). The generator centred the *full* box on the footprint,
   shifting the body 2 LDU off-cell and interpenetrating its neighbours. Fixed by
   measuring the **body box** — the full box with each outward male stud pulled
   back — exactly as the studio's metrics do. A related bug (a spurious
   non-unit male snap on `3001` being read as a second stud face, and eight
   studs each shrinking the box) was fixed by requiring unit cardinal axes and
   adjusting each face once.
2. **Side-stud parts on the grid.** The studio's plan format re-derives a grid
   item's matrix from the part's body box, which for `22885` includes the side
   stud — so a grid placement still shifted the body. The generator now emits
   side-stud parts as raw `{ ldu, matrix }` items (its own computed matrix),
   which the studio imports verbatim. The MPD path was already matrix-exact.

These are root-cause fixes in the generator, not tolerances in the checker:
after them the oracle certifies the models outright.

## Results

- `brickheadz:verify` over a 20-model random batch → **20/20 CLEAR**
  (0 overlaps, 0 floating).
- The committed fixture (`tests/fixtures/brickheadz/bh-sample.mpd` and its
  `.plan.json`) certifies **CLEAR**, asserted by `tests/brickheadz/mesh.test.ts`.

## Limitations

- The oracle certifies the studio's **render meshes** (triangle SAT at a 0.02 LDU
  skin), not watertight CAD solids, and it is a static-pose check — not a
  buildability or stability simulation. It complements, and does not replace,
  the planners.
- The check depends on `public/ldraw` and `vendor/LDCadShadowLibrary`; when those
  are absent the test skips (the library is an on-demand download).
- No automatic geometric repair: a `BLOCKED` model is rejected and, for this
  template generator, the defect is fixed in the generator rather than patched
  in the output.

## What comes next

Phase 4 trains a learned layer on the Phase-1 dataset, wrapped in the same
certify-or-reject loop; Phase 5 adds inventory/colour/dimension constraints;
Phase 6 adds the studio panel that generates, certifies and imports a model.
