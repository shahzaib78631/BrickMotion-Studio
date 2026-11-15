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
| OMR | 914 | 80.3% | 37.3% | 226 / 43 | 10,675 / 169,974 |
| Reference sets | 6 | 84.4% | 34.5% | 1 / 0 | 97 / 2,428 |
| MOC | 12 | 75.3% | 59.8% | 0 / 0 | 419 / 1,541 |
| BrickNet | 2,000 | 98.0% | 78.6% | 1,780 / 637 | 2,436 / 9,624 |

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
