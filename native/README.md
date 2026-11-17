# BrickMotion native engine

The C++ rewrite of BrickMotion Studio. Design: `docs/superpowers/specs/2026-11-15-native-rewrite-design.md`.

- `core/` — `bmcore`, the portable C++20 engine library (no Apple headers).
- `tools/bm/` — `bm`, the command-line tool; every engine feature runs from here.
- `tests/` — Catch2 tests.
- `corpus/` — the list of models both engines are measured on, and the web engine's baseline.

## Build and test

```bash
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
ctest --test-dir native/build --output-on-failure
```

Sanitizer builds for the tests: add `-DBM_SANITIZE=address` (ASan + UBSan) or `-DBM_SANITIZE=thread`
to a separate build directory, e.g. `-B native/build-asan`.

## Data

Read from outside this directory:

- `BM_LDRAW_DIR` — the LDraw library (default `<repo>/public/ldraw`).
- `BM_DATA_DIR` — the corpus (default `/Users/mac/Projects/BrickMotion-Data`).

Tests tagged `[data]` need `BM_LDRAW_DIR` and are skipped without it.

## Commands

```bash
native/build/tools/bm/bm load <file> [--json]
native/build/tools/bm/bm audit --manifest native/corpus/manifest.json [--tier smoke|full] [--out <dir>] [--threads N]
python3 native/tools/compare_scoreboards.py .cache/native-baseline <out>/rows.jsonl
```

`bm load` reads LDraw/MPD, plan JSON, `.brickmotion` projects and Studio `.io`. Flattened parts are
cached in `~/Library/Caches/BrickMotion/parts`.

## Phase 1 results (2026-11-15, M1 Pro, 10 threads)

Corpus: 3,854 models (1,833 OMR files, 2,000 BrickNet, 12 MOC, 6 reference, 3 fixtures), 872,970 pieces.

| | Result |
|---|---|
| Models that load | 3,854 / 3,854, no crashes |
| Whole corpus, empty part cache | 4.8 s (4,280 parts flattened) |
| Whole corpus, warm part cache | 3.2 s |
| Per model | median 2.5 ms, 95th percentile 51 ms |
| 5590 (1,258 pieces), cold | 161 ms, plus 199 ms to index the library |
| Unknown parts | 4 uses of 3 distinct parts, the same ones the web engine reports |

Against the web engine's baseline (2,077 models measured so far): piece counts are equal on 2,076.

**The one difference is a web-engine fault.** `omr/10143-1` (Death Star II) nests submodels 24 deep.
The web app stops at 16 levels (`MAX_DEPTH` in `src/model/assemble.ts`) and silently drops 224 of the
model's 3,457 pieces; the native engine expands to 64 levels and loads all of them. The true count
was confirmed with an independent script.

Sagrada 21065 is not in `samples/`, so its cold/warm load target (< 5 s / < 1 s) is not measured yet.

## Known differences from the web engine

- Colour 16 inside an LDraw submodel inherits the colour of the reference that places it (the LDraw
  rule). The web importer keeps 16 and shows it grey.
- A numeric colour code that is not in LDConfig is kept as it is; the web app turns it grey.
- Exact (`ldu`/`matrix`) placements in a plan are used as written; the web app snaps values that
  are within noise of a whole number.
- A reference to a model file under the library's `models/` folder is expanded as a submodel.

## Phase 2 results (2026-11-15): joints

```bash
native/build/tools/bm/bm joints <file> [--why <part>] [--groups] [--no-studio]
```

Lists a model's joints. `--why <part>` shows, for unjoined pieces of that part, the nearest connectors and
why each was rejected; `--groups` shows the largest groups and what nearly joins them. `bm audit` adds joint
columns and writes `unjoined-parts.json`.

### Connector sources

| Source | Where | What it gives |
|---|---|---|
| LDCad shadow library | `BM_SHADOW_DIR`, default `vendor/LDCadShadowLibrary` (CC BY-SA 4.0) | the primary source: 4,292 files, inherited through subfiles |
| BrickLink Studio connectivity | `BM_STUDIO_DIR`, default `/Applications/Studio 2.0/ldraw/connectivity` | 9,271 files: studs, anti-studs, pin holes, pins, axles, axle holes, paired hinge and wheel halves. Added only where the part has nothing doing the same job. Read from the installed app; not in this repository |
| Wheel seats | `native/data/wheel-seats.json` | measured tyre bores and rim seats for 173 parts |
| BrickNet joints | `native/data/bricknet-joints.json` (catalogue code MIT) | hinge and ball joints for 1,524 parts |

The Studio format is unpublished; `core/include/bm/connect/studio.h` lists the record types that are read
and the parts each was checked on. Every other record type is skipped.

### Against the web engine

Pieces in the largest connected group, on models both engines measured:

| Source | Models | Native | Web | Fully joined models, native / web | Groups, native / web |
|---|---|---|---|---|---|
| OMR | 1,833 | 80.1% | 36.2% | 461 / 55 | 17,721 / 304,623 |
| Reference sets | 6 | 84.5% | 34.5% | 1 / 0 | 93 / 2,428 |
| MOC | 12 | 75.3% | 59.8% | 0 / 0 | 419 / 1,541 |
| BrickNet | 2,000 | 98.0% | 78.6% | 1,786 / 637 | 2,421 / 9,624 |

(The web baseline finished on 2026-11-16, so this covers every model in the corpus.)

Whole corpus (3,854 models, 872,970 pieces), native:

- 98.7% of pieces have at least one joint; 2,232 models are one connected group.
- 154,064 pieces are stretches of hoses, cables and strings. Consecutive stretches are chained into one
  flexible element whose ends attach to the parts they meet (153,218 flexible joints).
- Joint kinds: 358,986 fixed, 343,359 revolute, 193,402 turning-and-sliding, 74,406 sliding, 1,710 ball.
- The joint graph takes a median of 2.7 ms per model, 95th percentile 53 ms; the whole corpus, loading
  included, takes 8.2 s on 10 threads.

Reference sets: 8880 is 96.8% one group with 99.2% of pieces attached; 42000 is 99.3%; the helicopter is
one group; every piece of 5590 is attached, in two groups.

A model file often holds several separate things (train cars, minifigures, two BrickHeadz), so one group
per file is not the target for every file. `moc/10001-1` is 53 groups because it is several vehicles.

### What is still unjoined: about 11,300 pieces (1.3%)

- **Has connectors, mated nothing (7,718).** Looked at with `--why`:
  - `2780` pins (756): the pin lies outside the hole it is next to, in a part with no hole data.
  - `98138`, `6141` round 1x1 parts (880): mostly placed 13 to 63 degrees off any stud, as decoration.
  - `3069b` tiles (172): placed half a stud off, which no stud holds.
  - `3062b` (180): placed 1 LDU above where a stud would reach.
  - Window glass `60602`, `4862` (373): glass sits in a frame's groove; there is no connector type for that yet.
- **No connector data (3,594):** chain links `30104k02`, embedded copies of parts under names no source knows
  (`42069 - 88323`), custom parts (`myrubbercyl`).
- `moc/modern_fighter_jet.mpd` is 28.6% attached: its pieces are not placed on each other's studs.

### Not done

- No check yet that the engine does not join things that are *not* joined. BrickNet's joint labels are the
  planned truth for that ("joint agreement" in the design).
- Kinebrick data and detection from the part mesh are not read. Studio record types `0xd0000`, `0xa0000`,
  `0xc0000` and others are not understood.
- A glass-in-frame connector, and magnets (train couplings), do not exist yet.
- A flexible element is attached by nearness at its ends, not by a typed end connector.

### Rules the corpus corrected

- Axes within 3.5 degrees count as parallel (was 2): minifig hands and arms are stored with rounded angles.
- Hinge fingers mate when one half's fingers sit in the other half's gaps. `genderOfs` says what the
  sequence starts with, not which half it is, and fingers are centred on their position.
- A shadow file pulled in with `SNAP_INCL` brings its `SNAP_CLEAR` with it (pin `2780` includes `3673`).
- A part embedded in a model as `<set> - <part>.dat` uses `<part>`'s connector data.
- A piece whose library description starts with `~`, or that is a primitive, is a segment, not a part.

## The web engine's baseline (finished 2026-11-16)

`native/corpus/baseline.json`, from `scripts/native/baseline-audit.ts`, default planner, 180 s limit per model.

| Source | Models | Planned | Timed out | Plan time, median / 95th pct | Placed pieces joined to nothing |
|---|---|---|---|---|---|
| OMR | 1,833 | 1,590 | 178 | 8.5 s / 92.8 s | 23.2% |
| Reference sets | 6 | 3 | 3 | 97.3 s / 137.6 s | 24.6% |
| MOC | 12 | 11 | 1 | 74.8 s / 154.6 s | 19.6% |
| BrickNet | 2,000 | 1,998 | 0 | 0.4 s / 6.4 s | 21.9% |

Across the corpus 3,394 of 3,854 models have at least one floating placement, 692 are fully joined, and
249 fail to plan (182 time-outs, 67 planning errors).

## Phase 3 results (2026-11-16): collision

```bash
native/build/tools/bm/bm overlaps <file> [--part <part>] [--triangles]
native/build/tools/bm/bm shape <part> [--at x y z]
```

`bm overlaps` lists the pieces of a model that pass through each other, how each pair is joined, and where
they cross. `bm shape` describes a part's collision shape. `bm audit` adds overlap columns and writes
`overlap-pairs.json`.

### How it works

- Each part has its **true surface** and an **inner surface**: every face moved inward by the skin (0.5 LDU)
  along its own normal and trimmed back from each edge by what the turn of the surface there requires
  (`skin * tan(angle / 2)`). A flat face made of several triangles is trimmed as one face.
- Two pieces interpenetrate when the inner surface of one crosses the true surface of the other. Pieces that
  touch, or overlap by less than the skin, do not.
- Joined pieces may cross inside each mate's **zone** (a stud in its socket, a bar in its clip), and
  elsewhere need two skins of overlap to count. A mate that holds by stretching (a tyre on a rim) exempts
  the pair.
- A model is checked with a sort-and-sweep over piece boxes, then tree against tree. `World::hits` and
  `World::sweep` answer for one more shape, still or moving (sampled every 0.5 LDU).

### What the corpus shows

| Source | Models | Models with no overlap | Pieces in an overlap |
|---|---|---|---|
| BrickNet | 2,000 | 1,953 | 0.27% |
| OMR | 1,833 | 573 | 4.99% |
| MOC | 12 | 2 | 7.47% |
| Reference sets | 6 | 0 | 9.43% |

25,086 overlapping pairs in 872,970 pieces; 402 exact duplicates. 95% of the pairs are between pieces that
are **not joined**, and the commonest are things the engine does not model yet, not faults in the test:

- **Gears in mesh** (`6589`, `32270`, `32269`, `4143`, `4019`, racks): teeth interleave. Needs gear recognition (phase 4).
- **Tread links and chains** (`57518` + `57519`/`57520`, `30104k02`): hinged to each other with no connector data.
- **Ball links** (`6628` + `32293`, tow balls): no ball data for these parts, so they are not joined.
- **Decoration placed through itself** (`98138`, `6141` round 1x1s): real overlaps in the files.
- **Window glass in a frame** (`3853` + `3004`/`3005`), minifig accessories over a torso (`3838`).

Reference sets: 5590 has 16 overlapping pairs in 1,258 pieces, 42000 has 32 in 1,377, 8880 has 109 in 1,410,
nearly all gears, pistons and links.

Whole corpus with loading, joints and collision: 78 s on 10 threads (collision is most of it; median 52 ms
per model, 95th percentile about 1.5 s).

### What the corpus corrected

- Moving shared corners inward (the first design) tilts a sloped face out through its own edge, which
  reported a stud resting under a sloped panel as an overlap. The inner surface is now built face by face.
- Pulling both pieces in equally cannot see two aligned bricks pushed into each other: their faces stay
  coplanar. One piece's inner surface is tested against the other's true surface.
- Studio stores a Technic hole as a bare length; a pin's collar needs the 2 LDU countersink at each mouth.
  This also joined the pins that phase 2 had left loose.

### Not done

- Clearance distance between shapes; a continuous sweep (it is sampled); a piece wholly inside another's solid.
- Speed: no SIMD, and joined pairs are searched linearly for their zones.
- The reference sets will not be clean until treads and chains are joints (gear meshes and ball links were done in phase 4).

## Phase 4 results (2026-11-16): kinematics, mechanisms, stability

```bash
native/build/tools/bm/bm mechanisms <file> [--truth <expected.json>] [--links] [--all] [--no-travel]
native/build/tools/bm/bm stability <file>
native/build/tools/bm/bm joints <file> --meshes
```

`bm mechanisms` lists what can move: bodies, links, gear trains with their ratios, shifts, and (with
`--truth`) the score against a hand-checked list in `benchmarks/mechanisms/`. `bm stability` says whether a
model stands. `bm audit` adds `meshes`, `movingBodies`, `links`, `freedoms`, `mechanisms`, `solved`, `kinMs`,
`stands`, `unsupportedPieces`, `tippingGroups` and `massGrams`.

### Mechanism truth

| Set | Scored checks passed | Web engine, as `benchmarks/mechanisms/README.md` records it | What is missed here |
|---|---|---|---|
| 5590 | 15 of 15 | 17 of 17 | nothing; 5 checks not scored (vehicle, scrub, suggestions) |
| 42000 | 20 of 20 | phase 3: 16 of 18 | nothing; 3 not scored (vehicle, bump steer) |
| 8880, axle-fix copy | 15 of 16 | phase 3: 7 of 9; gearbox modes 4 of 4 | steering wheel to the rear rack: a defect of the file, below |
| 8880, as published | 13 of 16 | phase 3: 7 of 9; gearbox modes 5 of 7 | the same, and 2nd and 4th gear, which the file cannot reach (a gear has no axle) |
| 8880, axle fix and rear rack one plate higher | 16 of 16 | — | nothing |

The two engines do not score the same set of checks, so the columns are not a like-for-like comparison.

The four 8880 ratios come out exact (2.25, 1.5, 0.75, 0.5), neutral is found at rest, and both rings are
found to couple both their clutch gears.

**Every check passes that the files allow.** The three that remain on 8880 are defects of the published file:

- **A gear with no axle** (known to the benchmark): the 8T `3647` at (-60, -14, -70). `samples/8880-1-axle-fix.mpd` adds it.
- **The rear rack does not reach its pinions.** The rack module (`8880 - step19.ldr`) is placed at y = -60 at
  the front and y = -64 at the rear, under pinions on the same axle height (y = -94). The front 16-tooth
  pinions mesh (2 LDU from the tooth line). The rear 8-tooth pinions' tips end at y = -82 and the rack's
  teeth start at y = -78: they do not touch. Placing the rear module one plate higher (line 299 of the
  axle-fix copy, `1 8 0 -64 430 ...` to `1 8 0 -72 430 ...`) puts the tooth line on the pinions' pitch
  line exactly, adds no overlap, and the steering wheel then moves both racks. The truth list's position for
  that rack has to move with it (`[-40, -71, 430]` to `[-40, -79, 430]`), so this copy is not committed;
  the mesh tolerance was not widened to 8 LDU to hide it.

What closed 42000's four misses, none of them by a rule about a part:

- **Rear wheel to crankshaft.** Constant-velocity joints are measured data (`cv-ball` and `cv-cup` rows in
  `native/data/extra-connectors.json`): a ball joint that also passes turning, one equation.
- **Left rear wishbone to its shock.** A shock absorber's rod is a "~" part, so its end was also attached as
  a flexible element to the nearest part, and that attachment replaced the pin joint between the same two
  pieces. A real joint now always wins.
- **Front shock rod.** It was right all along: the rod stands still and the cylinder moves. `slides` is now
  also met against what the piece slides in.
- **Rear wing actuator.** The housing swings only as the stroke grows (0.5 LDU after two turns of the knob).
  Function checks now drive up to eight turns, and a drive step closes when corrections stop helping.

### How it works

- Each part has its **true surface** and an **inner surface**: every face moved inward by the skin (0.5 LDU)
  along its own normal and trimmed back from each edge by what the turn of the surface there requires
  (`skin * tan(angle / 2)`). A flat face made of several triangles is trimmed as one face.
- Two pieces interpenetrate when the inner surface of one crosses the true surface of the other. Pieces that
  touch, or overlap by less than the skin, do not.
- Joined pieces may cross inside each mate's **zone** (a stud in its socket, a bar in its clip), and
  elsewhere need two skins of overlap to count. A mate that holds by stretching (a tyre on a rim) exempts
  the pair.
- A model is checked with a sort-and-sweep over piece boxes, then tree against tree. `World::hits` and
  `World::sweep` answer for one more shape, still or moving (sampled every 0.5 LDU).

### What the corpus shows

| Source | Models | Models with no overlap | Pieces in an overlap |
|---|---|---|---|
| BrickNet | 2,000 | 1,953 | 0.27% |
| OMR | 1,833 | 573 | 4.99% |
| MOC | 12 | 2 | 7.47% |
| Reference sets | 6 | 0 | 9.43% |

25,086 overlapping pairs in 872,970 pieces; 402 exact duplicates. 95% of the pairs are between pieces that
are **not joined**, and the commonest are things the engine does not model yet, not faults in the test:

- **Gears in mesh** (`6589`, `32270`, `32269`, `4143`, `4019`, racks): teeth interleave. Needs gear recognition (phase 4).
- **Tread links and chains** (`57518` + `57519`/`57520`, `30104k02`): hinged to each other with no connector data.
- **Ball links** (`6628` + `32293`, tow balls): no ball data for these parts, so they are not joined.
- **Decoration placed through itself** (`98138`, `6141` round 1x1s): real overlaps in the files.
- **Window glass in a frame** (`3853` + `3004`/`3005`), minifig accessories over a torso (`3838`).

Reference sets: 5590 has 16 overlapping pairs in 1,258 pieces, 42000 has 32 in 1,377, 8880 has 109 in 1,410,
nearly all gears, pistons and links.

Whole corpus with loading, joints and collision: 78 s on 10 threads (collision is most of it; median 52 ms
per model, 95th percentile about 1.5 s).

### What the corpus corrected

- Moving shared corners inward (the first design) tilts a sloped face out through its own edge, which
  reported a stud resting under a sloped panel as an overlap. The inner surface is now built face by face.
- Pulling both pieces in equally cannot see two aligned bricks pushed into each other: their faces stay
  coplanar. One piece's inner surface is tested against the other's true surface.
- Studio stores a Technic hole as a bare length; a pin's collar needs the 2 LDU countersink at each mouth.
  This also joined the pins that phase 2 had left loose.

### Not done

- Clearance distance between shapes; a continuous sweep (it is sampled); a piece wholly inside another's solid.
- Speed: no SIMD, and joined pairs are searched linearly for their zones.
- The reference sets will not be clean until treads and chains are joints (gear meshes and ball links were done in phase 4).

## Phase 4 results (2026-11-16): kinematics, mechanisms, stability

```bash
native/build/tools/bm/bm mechanisms <file> [--truth <expected.json>] [--links] [--all] [--no-travel]
native/build/tools/bm/bm stability <file>
native/build/tools/bm/bm joints <file> --meshes
```

`bm mechanisms` lists what can move: bodies, links, gear trains with their ratios, shifts, and (with
`--truth`) the score against a hand-checked list in `benchmarks/mechanisms/`. `bm stability` says whether a
model stands. `bm audit` adds `meshes`, `movingBodies`, `links`, `freedoms`, `mechanisms`, `solved`, `kinMs`,
`stands`, `unsupportedPieces`, `tippingGroups` and `massGrams`.

### Mechanism truth

| Set | Scored checks passed | Web engine, as `benchmarks/mechanisms/README.md` records it | What is missed here |
|---|---|---|---|
| 5590 | 15 of 15 | 17 of 17 | nothing; 5 checks not scored (vehicle, scrub, suggestions) |
| 8880, axle-fix copy | 15 of 16 | phase 3: 7 of 9; gearbox modes 4 of 4 | steering wheel to the rear rack |
| 8880, as published | 13 of 16 | phase 3: 7 of 9; gearbox modes 5 of 7 | the same, and 2nd and 4th gear, which the file cannot reach (a gear has no axle) |
| 42000 | 16 of 20 | phase 3: 16 of 18 | four checks, below; 3 not scored |

The two engines do not score the same set of checks, so the columns are not a like-for-like comparison.

The four 8880 ratios come out exact (2.25, 1.5, 0.75, 0.5), neutral is found at rest, and both rings are
found to couple both their clutch gears. The rear rack is missed because its 8-tooth pinion (at y = -94) sits
6 LDU from the rack's tooth line (y = -78) in the file, beyond the 4.5 LDU a rack mesh allows; whether the
file or the tolerance is at fault is not settled. The phase's goal, "8880 and 42000 cases pass", is **not met**: five
scored checks still miss.

42000's four misses:

- **Rear wheel to crankshaft**: the drive goes through CV joints, and no joint here passes turning across a bend.
- **Front shock rod**, **left rear wishbone to rocker and shock**: the suspension loop locks. Driving the
  wishbone gets 0.2 rad and stops. Not yet diagnosed.
- **Knob to the rear wing actuator**: with the selector shifted the piston moves, but the housing does not
  swing within one turn of the knob. The cover actuators on the other position pass.

### How it works

- **Gears** are data (`native/data/gears.json`, 163 parts, generated by `native/tools/gears_from_part_functions.py`).
  A mesh is a coupling, not a joint: one equation where the teeth meet. It is written in tooth counts when
  one body carries both shafts, so ratios are exact whatever the file's rounding.
- **Moving bodies.** Pieces joined rigidly are one body. A friction fit (keyed axle, snap lip, clip) holds.
  Any other slide is real only if the piece has 2 LDU of room, tested by collision. Two bodies turning on one
  shaft are joined through it.
- **Freedoms** are the null space of the joint and gear equations (six unknowns per body), solved group by
  group between the bodies that stand still. A body hanging on one link is set aside first: most freedoms in a
  model are a pin spinning in its hole.
- **Driving** steps along a freedom and closes the joints again by Newton iteration.
- **Screws** (linear actuators) are data (`native/data/screws.json`): the piston moves by the lead per turn of
  the input and does not turn in its housing.
- **Shifts.** A lipped hole on a ridged shaft has seats, computed from the two connector profiles; a driving
  ring on its joiner has three. At each seat the ring is turned once round its line: what stops it at some
  angles and not at others has it by the teeth and turns with it; what stops it at every angle is just in
  the way (the fork). No part number is consulted.
- **Ratios through a differential** take the differential as turning in one piece, as on a straight road.
- **Stability.** Each part is weighed from the volume its mesh encloses (ABS, 1.05 g/cm³). Pieces are grouped
  by their joints. A group that does not touch the floor is unsupported; one whose centre of mass falls
  outside what it stands on tips.

### What the corpus shows

Whole corpus, 3,854 models, with loading, joints, collision, kinematics and stability: **116 s** on 10 threads,
no failures. Kinematics: median 2.5 ms, 95th percentile 186 ms per model.

| Source | Models | With gear meshes | With a freedom that is more than one hanging body | Kinematics p95 |
|---|---|---|---|---|
| BrickNet | 2,000 | 9 | 443 | 10 ms |
| OMR | 1,833 | 294 | 1,178 | 412 ms |
| MOC | 12 | 1 | 10 | 819 ms |
| Reference sets | 6 | 4 | 6 | 3.5 s |

- 2,029 gear meshes found. Overlapping pairs in the reference sets fell from 16 to 15 (5590), 32 to 15 (42000)
  and 109 to 83 (8880); corpus-wide from 25,086 to 23,720. Treads and chains still account for most of the rest.
- The count of "mechanisms" (42,655) is not a count of real mechanisms. It includes every loop of loosely
  pinned pieces. Names for real ones (gear train, differential, steering) are not written yet.
- One model is not solved: `omr/10276-1` has a moving core over the 400-body limit. The slowest solved is
  `omr/10253-1` at 21 s; 8880 takes 3.4 s.
- Weights look right where known: 8880 comes to 1,530 g, 42000 to 992 g, the helicopter to 329 g.
- Stability on the corpus says more about the files than about the check. In the reference sets the
  unsupported pieces are exactly the unjoined ones (stickers, the 8880 gear with no axle, 5590's helicopter
  resting on the truck). OMR files hold several assemblies at different heights, so 47% of OMR pieces count
  as unsupported against one floor; BrickNet models are fragments and a quarter of them tip.

### What the corpus corrected

- Tolerances for meshes (spur 2, rack 4.5, bevel 3.5 LDU) are the web engine's observed ones; tighter values
  missed 8880's rack.
- A travel test that moved "the smaller body" and counted everything as an obstacle held an actuator's
  piston by the axle pinned through its eye. What the mover is linked to is now left to the equations.
- Choosing which of two bodies to move in a travel test gave different answers for an axle and its bush.
  Friction fits now always hold, and travel is tested only after those merges settle (42000: 4.7 s to 0.7 s).
- Ball links in files sit up to 6.8 LDU off their sockets; measured balls seat within 0.9 of their radius.
- A driving ring's keyed fit was taken as a friction fit, so no gearbox could shift. Its lips make it a
  detented slide instead.
- 8880's ratios came out at exactly half until the centre differential was taken as turning in one piece.
- Driving stalled on joints the file has a few millionths of an LDU out of line. A step now closes when no
  correction is left to make.

### Not done

- **Joint limits** (`range`): how far a freedom goes before pieces collide. Shock strokes, steering lock and
  hinge stops are unknown.
- **Tread links and chains on sprockets.** (Universal joints need nothing: their two pins are two hinges. CV joints are data.)
- **Names** for mechanisms, and so a meaningful mechanism count.
- **Joint strength** in stability (the linear program over stud forces), and pieces that rest on others
  without a joint. One floor per file is assumed.
- **Speed.** Dense QR per group: 8880 takes 3.4 s, a core over 400 bodies is refused. Finding shifts takes
  0.7 s per seat. Scoring a set against its truth list takes minutes because it drives freedoms: 42000 took about 6 minutes on a busy machine.
- Which way a linear actuator's input turns to extend is assumed (right-hand thread).
- Not scored against truth: `vehicle`, `scrub`, `bumpSteer`, `suggested`.
- Reviews were self-reviews. (207 tests pass; ASan with UBSan and TSan runs of the suite are clean.)

## Phase 5 results (2026-11-16): the assembly planner

```bash
native/build/tools/bm/bm plan <file> [--truth native/corpus/insertion-truth.json] [--explain <part>] [--out plan.json] [--budget <seconds>]
native/build/tools/bm/bm audit --manifest native/corpus/manifest.json --plan <seconds per model> [--only <id prefix>] [--no-kinematics]
```

`bm plan` prints the build: how many moves, how many the certifier passes, and the first moves it does not,
each with its reason. `--explain <part>` shows, for every piece of a part, how each of its mates comes apart,
which directions that leaves, and what is in the way.

### How it works

- **Releases.** Every mate records how it comes apart, read off the two connectors: a stud lifts off along its
  axis; a pin leaves the way its collar is, because the collar cannot be dragged through the hole; an axle
  through an open hole slides out either way; a bar leaves a clip sideways or along itself; a ball has no
  direction of its own.
- **Taking the model apart.** A unit can leave when one direction satisfies every release it has with what is
  still there, the sweep out of its seat is clear (its own mates' zones are carried along as a corridor;
  nothing else is exempt), a straight way or a way with one turn leads to open air, and what is left stays
  joined. Among the units that can leave it takes the one that continues the current submodel, then the latest
  file step, then the highest, then the outermost. The build is that order reversed.
- **Going in together.** When no single piece can leave, it tries the smallest submodel use that holds the
  piece, its rigid body, then a group grown from it until its mates agree on a direction. Such a unit gets its
  own sub-plan and is built first.
- **Never silently wrong.** A piece the planner cannot show going in is still placed, flagged with why
  (`blocked`, `no-direction`, `no-exit`, `unjoined`, `budget`), and does not fly: it appears at its seat.
- **The certifier** shares no code with the planner. It replays the finished plan and checks, for every move,
  that it lands joined to something built, that no sampled pose of its flight passes through a placed piece,
  and that its last leg satisfies every mate it makes. Only it may call a move certified.
- **The author's word stands:** a pinned step order, `after`, an insertion axis and a flight from the plan
  file are kept; a flight that passes through something is kept and flagged.
- **Timeline:** each unit waits at its own spot on the floor, lifts off, crosses above the model and follows
  the plan's path into its seat, holding still before the last leg. One camera key a second.

### What the corpus shows

Budget 20 s per model for BrickNet, 30 s for the OMR sample, 300 s for the reference sets; one planner thread
per model (the audit runs ten models at once).

| Source | Models | Every move certified | Moves | Certified | Flagged | Floating | Crossings | Off axis | Plan time, median / p95 | Web engine |
|---|---|---|---|---|---|---|---|---|---|---|
| BrickNet, all 2,000 | 2000 | 1608 | 52469 | 97.6% | 1246 | 0 | 4 | 0 | 0.48 s / 4.1 s | 0.36 s / 6.4 s; 11,384 floating; 2,243 flagged |

| OMR sample, 25 sets (2026-11-17) | 25 | 1 | 21142 | 94.3% | 1177 | 3 | 30 | 0 | 0.65 s / 6.1 s, one model at a time | 8.5 s / 92.8 s on all OMR; 178 time-outs |

The BrickNet row was measured on 2026-11-16, before the speed work below. The OMR row is after it: no model
runs out of its 30 s budget (10 of the 25 did on 2026-11-16, when the median was 16 s and 44% of moves were
certified). Planned ten at a time, as the audit does, the same 25 take a median of 1.3 s and a 95th percentile
of 9.1 s. The largest, 10030-1 (3,037 pieces), takes 12.1 s alone. Reference sets were not re-measured.

- **No piece is placed floating and none goes in off its connector's axis**, on any model planned. The web
  engine placed 11,384 of BrickNet's 51,916 pieces (22%) joined to nothing built.
- **Crossings are not zero.** On BrickNet the certifier finds 4 moves, all in one model (`sft_23628`, four
  `11090` bar holders against a dish), that the planner swept clear from the seat outward and the certifier,
  sampling the same line inward from the other end, does not. Both sample every 0.5 LDU; the two grids differ.
  Checked on the same world: the exit leg is clear sampled outward and blocked 21 LDU along sampled inward, so the
  piece grazes the dish over less than one 0.5 LDU step. This is the sampled sweep's known limit showing up,
  and it is why the certifier exists.
- Six hand-checked insertion cases pass (`native/corpus/insertion-truth.json`): a pin into beams, an axle
  through a beam, a bush onto an axle, bricks onto studs, and a plate onto a sideways stud.

### What the corpus corrected

- Groups of a file were planned as if each were alone. 71 BrickNet models then had flights passing through
  a group built earlier. What is built before a group now stands in its way.
- Sweeping a whole unit pose by pose spent nearly all its time on triangles of mated pairs. Sweeps are now
  pair by pair, sampled only where the two boxes can meet, and remembered: a model repeats the same pairs.
- The time was then not where it was thought to be (a piece sliding out of its own mate). A profile showed a
  handful of *unjoined* pairs passing each other without touching — round bricks past round bricks, a minifig
  hand inside a window frame — walked through the two trees again at every 0.5 LDU, tens of thousands of times.
  A sweep past another piece is now one walk for the whole way (`firstOverlap`): it finds when each pair of
  triangles can touch at all and looks only at those, and a test holds it to the answer of the pose-by-pose
  walk. Tree nodes carry one box per surface, so faces that only touch are parted at the top of the tree.
- Most of what remained was legs that are blocked: a piece shut in tries eight ways out and each was swept in
  full. A few points a skin inside the piece are now carried along the way first; one that passes through
  another piece's surface settles a leg that only has to get far enough, and bounds one that is measured.
  It is stricter than the samples, never more lenient: one crossing on 10129-1 went away with it.
- Attempts with a turn, and attempts to take pieces out together, were made again every round. They are kept
  until something that stopped them, or a mate, has gone.
- Finishing the large models showed what running out of time had hidden: 30 crossings and 3 floating
  placements on the 25 OMR sets (in 10143-1, 10030-1, 10124-1, 10134-1, 10019-1 and 10129-1). Not yet looked into.

### Not done

- **Speed: the target is met on the 25-set OMR sample** (median 0.65 s, 95th percentile 6.1 s, no time-outs;
  goal: under 1 s, under 10 s, none) **and not on all of OMR.** All 1,833 files, planned ten at a time with a
  30 s budget (2026-11-17, 11 minutes in all): median 0.59 s, 95th percentile 15.4 s, 43 out of time (the web
  engine: 8.5 s, 92.8 s, 178). The 43 are the largest sets (2,000 to 10,000 pieces) and some Technic sets
  (42000-1, 42039-1). They have not been timed one at a time, nor have the reference sets.
  Nothing here re-plans incrementally after an edit; the only memory is within one run.
- **Floating placements and crossings on OMR are not zero**: 73 floating placements in 48 files and 713
  crossings in 213 files, of 819,628 moves; 80.9% of moves are certified. The rule is none.
- **Curved and turning insertions** (a hinge swung shut, a tyre stretched on). Every leg is a straight line.
  These show up as `blocked` and `no-exit`.
- **A continuous sweep.** Flights are sampled every 0.5 LDU.
- **Writing the plan back into a plan file** for the app (`writeInto`); `bm plan --out` writes its own JSON.
  The legs of a flight before the plan's path (staging, lift, crossing) are not swept.
- **Insertion truth** has no clip, hand, sword, wheel, tyre, hinge or ball case, and none from the reference sets.
- Authored constraints inside submodels; detecting a loop among the author's `after` constraints.
- Tipping during the build is not reported. Stability is not a rule of the planner.
- Reviews were self-reviews.

## Phase 6 results (2026-11-17): the Metal viewport

```bash
native/build/render/bmshot <file> --out shot.png [--size WxH] [--frame N] [--azimuth a --elevation e] [--select 3,7] [--stats]
native/build/render/bmshot <file> --bench 600 [--repeat 2x2] [--size 1920x1200] [--no-edges|--no-shadows|--no-ao|--detail 0|1|2]
native/build/render/bmshot <file> --repeat 2x2 --save-model scene.ldr
native/build/render/bmview.app/Contents/MacOS/bmview <file> [--play]
```

`bmshot` draws one frame offscreen to a PNG; `--frame N` plans the model as `bm plan` does and poses it at that
frame of the build, with the timeline's camera. `--bench` orbits once round the model and prints frame times as
JSON. `bmview` is one window: left drag orbits, right drag or two fingers pan, pinch or the wheel zoom toward the
cursor, a click selects, a double-click frames the selection (or the model); space plays, the arrows step,
Home and End jump, F frames, E / S / A toggle edges, shadows and ambient occlusion, I the readout.

### How it works

- **Two halves.** `native/render/src/prep` is portable C++ with no Apple headers: render meshes, levels of
  detail, instance groups per (part, colour), poses per frame, culling. `src/metal` owns every Metal object.
  Nothing in `bmrender` changes engine state.
- **Shaders compile at run time** from text embedded in the library, because the offline Metal compiler is an
  optional download; a test compiles them, so a mistake fails the tests, not the first launch.
- **Normals are angle-weighted** (area weighting leaves a 16-sided cylinder's normals 3.8° off radial).
- **Three levels of detail per part**: full, the library's low-resolution primitives (`p/8`), and its box. Each
  part's mesh records how far its low-resolution primitives stray from the full ones (`Mesh::lowError`, part
  cache version 2). A part is drawn in full only while that error would cover half a pixel on its near side;
  boxes below 6 pixels. Outline edges are drawn while a stud spans 4 pixels, faded in up to 8 — the far
  42000-1 drawn in full had grey tyres, because black's LDraw edge colour is light grey.
- **Culling is on the CPU**, on the job pool: 12,000 boxes take well under a millisecond, so the spec's "GPU
  culling" was not worth it here (cpu p95 0.5 ms on the gate scene).
- **The frame**: reversed depth; 4× multisampling into memoryless tile targets; a 4096² key-light shadow map
  fitted and texel-snapped to where the shown pieces are now, 3×3 PCF; a floor that writes darkness as coverage
  and depth; ambient occlusion from the resolved depth at half size, applied only to the ambient share of each
  pixel; transparent pieces by weighted blended order-independent transparency whose layers are rounded to
  half and summed in 32 bits, with reveal as summed optical depth, so the picture does not depend on the order
  pieces are listed; a studio room with a softbox and two strip lights; a neutral tone curve.
- **The shadow map is kept while nothing moves**, and drawn again when a piece moves, appears or goes, or the
  casters' detail changes (selecting does not count).
- **Picking** draws piece numbers once per frame, on the first pick after it. The selection outline (2 px,
  #007AFF) is drawn from a mask without depth, so it shows where other pieces hide the selected one.
- **Instances are kept in three copies**, used in turn with frames in flight, so a pose change is never written
  into a buffer the GPU is reading.
- **Equivalence**: culled, level-of-detail frames are held to the full picture (mean difference under 0.5,
  no 8×8 block over 6.0) on the helicopter from four sides (worst block 4.75) and 42000-1 at six times the
  framing distance (worst block 4.12).

### Benchmark (M1 Pro, 1920×1200, 600 frames orbiting once, nothing moving)

| Scene | Pieces | Triangles drawn | cpu p50 / p95 ms | gpu p50 / p95 ms | frame p50 / p95 ms | Full / Low / Box |
|---|---:|---:|---|---|---|---|
| helicopter | 305 | 133,996 | 0.21 / 0.31 | 1.40 / 1.83 | 1.64 / 2.10 | 118 / 187 / 0 |
| 10030-1 | 3,037 | 2,343,801 | 0.30 / 0.54 | 2.90 / 3.43 | 3.23 / 3.90 | 20 / 3,017 / 0 |
| 10030-1 × 4 (gate), run 1 | 12,148 | 9,352,004 | 0.40 / 0.52 | 6.07 / 8.25 | 6.48 / **8.64** | 18 / 12,130 / 0 |
| 10030-1 × 4 (gate), run 2 | 12,148 | 9,352,004 | 0.35 / 0.48 | 5.40 / 7.24 | 5.75 / **7.63** | 18 / 12,130 / 0 |
| 10030-1 × 4 (gate), run 3 | 12,148 | 9,352,004 | 0.36 / 0.48 | 5.37 / 6.76 | 5.73 / **7.23** | 18 / 12,130 / 0 |

The gate is 8.33 ms (120 fps) at the 95th percentile. No complete Sagrada 21065 file exists, so the gate scene
is 10030-1 repeated 2×2. The machine was not quiet: leftover Python workers held load averages of 9 to 14.
Before the two fixes of this phase the gate scene's p95 was 17.4 ms; choosing detail by each part's own error
brought it to about 12, keeping the shadow map to the figures above. **While a build plays the shadow map is
drawn every frame**, and the gate scene's p95 was then 11.4 to 13.3 ms (measured before the map was kept, under
the same load).

### The 71-model smoke sweep

Every `smoke` model in the manifest (25 BrickNet, 25 OMR, 12 MOC, 6 reference, 3 fixtures; 39,210 pieces)
drawn with `bmshot --stats` at 640×400: all 71 exit 0 and write an image; piece counts equal `bm load`'s on all
71; no piece skipped; 98 placeholder boxes, all in moc/6389-1, whose `ls00.dat` is not in the library. The
first frame, which includes building every mesh's GPU buffers, takes a median 4.1 ms (most: 15.0 ms, the
Legopharos bell tower). The contact sheet of all 71 shows nothing wrong.

### What the corpus corrected

- Low detail keeps 50 to 80% of a part's triangles, not under 60% as planned: the gain from `p/8` is in studs and
  tubes. Choosing detail by screen size alone either broke equivalence (worst block 10.2) or kept too much in
  full; the recorded error per part fixed both.
- The first transparency sums in half precision changed 66 pixels by one level with the order pieces were
  listed.
- In an even room chrome was one flat grey; the strip lights were added for it.
- Real files use direct colours (`0x2RRGGBB`), now read.

### Not done

- **The gate holds in two of three runs** (p95 8.64, 7.63, 7.23 ms, on a loaded machine) **with nothing
  moving, and not during playback** (11.4 to 13.3 ms). The next fixes, not made: draw shadow casters as boxes
  below a size in the light's map, and draw edges for fewer pieces while moving; edges and the shadow pass are
  the largest costs left (about 6 and 4 ms of the 17.4 before the fixes).
- **bmview checked from the shell only**: the window shows the helicopter and the gate scene within 0.9 s;
  playback advances frames; idle after planning it uses 0.0% CPU and draws nothing. Not checked, because this
  session could not see the screen: smoothness and the readout on a 120 Hz display, pieces seating while
  scrubbing, the click outline in the window, full screen and moving between displays of different scale, and
  orbiting the gate scene in the window.
- Planning in bmview takes as long as `bm plan`; until it is done the title says "planning…" and space does
  nothing. Framing the selection uses the pieces' rest boxes, not where they are mid-flight.
- Not in this phase: bevels, contact shadows beyond the key light, HDRI files, depth of field, motion blur, looks,
  gizmos and overlays other than the selection outline and the readout. Transparent pieces cast no shadow and
  cull their back faces (thick glass looks lighter than in a path tracer). The look is matched by eye later.
- Reviews were self-reviews.
