# Measured connector catalogue

Date: 2026-10-23

Two data sets replace hand-maintained guesses:

1. `src/data/wheelSeats.generated.ts` — tyre bores, rim seats, wheel axes and
   seat widths measured from LDraw geometry.
2. `src/data/flexibleParts.ts` — a data-only catalogue of cloth, hose, string
   and rubber parts classified from LDraw titles and categories.

Neither file changes the LDCad shadow data. Connector matching in
`src/data/connectorLibrary.ts` still prefers hand entries and LDCad, then uses
the generated seats.

## Wheel seats

`scripts/measure-wheels.ts` scans `public/ldraw/parts`, selects tyres and wheel
rims by title, and writes `wheelSeats.generated.ts`:

```
npx tsx scripts/measure-wheels.ts
```

Scanned 182 parts: 94 tyres and 88 rims. 173 measured seats are emitted
(91 tyres, 82 rims, 13.6 KB). Nine parts are omitted because LDCad already
describes their rim connector group and remains authoritative:

`30027a`, `32003`, `32004b`, `32019`, `32020`, `3641`, `4624`, `6014a`,
`86652`.

### Measurement

- The wheel axis is found from rotational symmetry, not the bounding box. The
  script cuts the mesh into thin cross-sections for each candidate axis and
  measures how much the outer radius varies with angle; a body of revolution is
  circular. This matters for small rims such as `30027a`, `6014a` and `74967`,
  whose axle makes the width as large as the diameter, so a smallest-bbox rule
  picks the wrong axis.
- A tyre bore is the mode of the inner radii near the bead, ignoring the open
  middle of the tyre. A rim seat is the mode of the outer radii, ignoring
  narrow flanges. Width is the extent along the measured axis.
- LDCad detection uses the raw part shadow (`ownSnaps`), not the flattened
  connector list. The flattened list already contains the hand entries, so
  using it would make the script exclude its own outputs.

### Validation

The script replays the tyre/rim pairs that LDCad describes and tunes two
thresholds: radius tolerance and width tolerance. With a radius tolerance of
4 LDU and a width tolerance of 12 LDU:

| Metric | Value |
|---|---:|
| Ground-truth pairs | 6 |
| True positives | 6 |
| False positives | 0 |
| False negatives | 0 |
| Precision | 1.00 |
| Recall | 1.00 |

The six pairs are `32003|32004b`, `32019|32020`, `32019|86652`,
`3641|30027a`, `3641|4624` and `3641|6014a`.

Four LDU is larger than the direct seats need (`51011` 13.86 against `42610`
13.99, and `61254` 21.62 against `13971` 21). The extra room is required by
`6014a`, a composite rim whose global outer radius is 13 but whose LDCad group
inherits the `4624` seat of about 10; the script therefore measures 13 against
the `3641` tyre bore of 9.87. The generated file does not contain `6014a`, so
runtime matching only sees its LDCad data. All non-composite validation pairs
fit within about 1 LDU.

### Runtime use

- `wheelSeatFor(part)` and `wheelSeatTolerance` expose the generated data.
- `supplementarySnapsFor(part)` keeps the hand groups and their historical
  names for `51011`/`42610` and `61254`/`13971`; a generated part gets one
  `measured…` group with a seat-length cylinder, female on a tyre and male on a
  rim.
- `rigidWheelPairs` first keeps the `6014`/`6015` special case, then the LDCad
  `rim…` groups, then pairs any other measured tyre/rim when the measured radii
  are within tolerance, the rim is coaxial within 1 LDU, and its centre lies on
  the tyre seat. The axial check reads the seat start as one end of the
  cylinder, so a rim at `z=±6` is still rejected by the 6-LDU `51011` seat.

## Flexible parts

`scripts/measure-flexible.ts` reads only part titles and `!CATEGORY` and writes
`src/data/flexibleParts.ts`:

```
npx tsx scripts/measure-flexible.ts
```

282 parts are classified:

| Kind | Parts | Examples |
|---|---:|---|
| cloth | 104 | `50231` cape, `u767` sail, `48298` net |
| hose | 125 | `27328` hose, `22678` ribbed hose, `22296` flex-system hose |
| string | 23 | `56823` thin string, `14225` braided string, `2549` rope bridge |
| rubber | 30 | `85543` rubber belt, `55709` flexible axle, `45590` flexible axle joiner |

`flexibleKind(part)` normalises paths and `.dat` suffixes and returns `null`
for anything not in the catalogue. The classifier is deliberately
conservative: `Hose Reel`, `Hose Air Pump`, `Hose Joiner`, `Rubber Band Holder`,
`Rubber Foot`, `Technic Flex-System Pin Connector`, `Minifig Cloth Wrap` and
tyres/rims return `null`. Formed variants are included when their title names a
flexible base part.

This catalogue is data only. It does not attempt to simulate bending, and it
does not feed the construction planner yet.

## Verification

- `npx tsc --noEmit` passes.
- `npx vitest run tests/anim/rigidHardware.test.ts tests/ldraw/connectorLibrary.test.ts tests/anim/flexibleParts.test.ts`
  passes 19 tests, including a generated seat pair, a generated radius
  mismatch, both hand pairs, the `z=±6` slide rejection and rigid look-alikes.
- `npx vitest run --exclude "tests/diagnostics/**"` passes 267 of 269 tests. The
  two failures are pre-existing and unrelated:
  `minifigInsertion.test.ts` ("every minifig piece goes on along a way its real
  shape allows", part `3815` coming from below) and `timeline.test.ts` ("within
  a step a piece flies in after the piece it rests on").
- `FORCE_REPLAN=1 npx vitest run tests/diagnostics/uncertified.test.ts --silent=false`
  re-planned in 108 s and reports 27 uncertified units / 85 pieces out of 619.
  Units 109 and 114 are still the two-piece wheel units containing `13971` plus
  its tyre; no new units appeared and no final seat was hard-rejected.
