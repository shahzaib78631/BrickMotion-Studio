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
- **CV and universal joints**, **tread links and chains on sprockets**, hub ball data for 42000's `11949`.
- **Names** for mechanisms, and so a meaningful mechanism count.
- **Joint strength** in stability (the linear program over stud forces), and pieces that rest on others
  without a joint. One floor per file is assumed.
- **Speed.** Dense QR per group: 8880 takes 3.4 s, a core over 400 bodies is refused. Finding shifts takes
  0.7 s per seat. Scoring one set against its truth list takes about 2 minutes because it drives freedoms.
- Which way a linear actuator's input turns to extend is assumed (right-hand thread).
- Not scored against truth: `vehicle`, `scrub`, `bumpSteer`, `suggested`.
- Reviews were self-reviews. (207 tests pass; ASan with UBSan and TSan runs of the suite are clean.)
