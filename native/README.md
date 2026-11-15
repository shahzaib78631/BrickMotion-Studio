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

`bm joints <file> [--why <part>]` lists a model's joints and, for pieces that joined nothing, the nearest
connectors and why each was rejected. `bm audit` adds joint columns and writes `unjoined-parts.json`.

Connector data: the LDCad shadow library (`BM_SHADOW_DIR`, default `vendor/LDCadShadowLibrary`, CC BY-SA 4.0)
and measured tyre bores and rim seats (`native/data/wheel-seats.json`, exported from
`src/data/wheelSeats.generated.ts`).

Pieces in the largest connected group, on models both engines measured:

| Source | Models | Native | Web | Fully joined models, native / web |
|---|---|---|---|---|
| OMR | 768 | 65.9% | 37.4% | 116 / 39 |
| Reference sets | 6 | 77.6% | 34.5% | 0 / 0 |
| MOC | 12 | 69.2% | 59.8% | 0 / 0 |
| BrickNet | 2,000 | 96.6% | 78.6% | 1,620 / 637 |

Whole corpus (3,854 models, 872,970 pieces), native:

- 154,064 pieces are stretches of hoses, cables and strings, or bare primitives, placed as pieces. They are
  marked as segments and are not expected to connect one by one.
- Of the remaining pieces, **97.8% have at least one joint**.
- 1,905 models are a single connected group.
- The joint graph takes a median of 2.9 ms per model (95th percentile 54 ms, measured while the baseline job
  was also running).

A model file often holds several separate things (minifigures, spare builds), so 100% in one group is not
the target for every file; "pieces with at least one joint" is the cleaner measure.

### What is still unjoined

About 16,000 non-segment pieces, from `unjoined-parts.json`:

- **Has connectors, mated nothing (10,933):** Technic pins `2780` (756) sitting in holes of parts with no hole
  data; tyres `6015`, `3641`, `30028`, `3139`, `87697` whose wheels have no seat data; round 1x1 parts `98138`,
  `6141`, `3062b` (hollow-stud primitives `stud4`/`stud4a` carry no connector); hinge parts `43722`/`43723`,
  `4593`. Some are genuinely built at angles no connection allows (`6141` at 15 degrees in 10037).
- **No connector data at all (5,231):** chain links `30104k02`, window glass `4862`/`60602`, parts embedded
  under names the data does not know, a few custom parts.

Not read yet, and what each should add: BrickLink Studio connectivity (studs and anti-studs for about 9,200
parts, installed at `/Applications/Studio 2.0/ldraw/connectivity`), BrickNet joint labels (hinges and balls
for 1,524 parts), Kinebrick connections, and detection on the part mesh for parts no source covers.
Flexible segments still need grouping into one part with connectors at its two ends.

### Rules the corpus corrected

- Axes within 3.5 degrees count as parallel (was 2): minifig hands and arms are stored with rounded angles.
- Hinge fingers mate when one half's fingers sit in the other half's gaps. `genderOfs` says what the
  sequence starts with, not which half it is, and fingers are centred on their position.
- A shadow file pulled in with `SNAP_INCL` brings its `SNAP_CLEAR` with it (pin `2780` includes `3673`).
- A part embedded in a model as `<set> - <part>.dat` uses `<part>`'s connector data.
- A piece whose library description starts with `~`, or that is a primitive, is a segment, not a part.
