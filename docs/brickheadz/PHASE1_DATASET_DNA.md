# BrickHeadz Phase 1 — Dataset Intelligence & Semantic DNA

Phase 1 of the BrickHeadz generative construction engine. It turns the official
OMR BrickHeadz MPD corpus into a structured, machine-readable dataset and derives
a construction **grammar** that later phases (procedural generator, learned
model) consume. It is pure extraction and analysis: **no synthesis and no
learned model**.

## Why this exists

The end goal is an engine that invents **new, structurally valid BrickHeadz** and
emits real LDraw/MPD models. Prior art (BrickGPT / LegoGPT, ICCV 2025; BrickWright)
shows the winning pattern is *generate → validate → repair* against a physical
validator. BrickMotion Studio already owns the validator half (LDraw parsing,
LDCad connectors, the `MeshOracle` collision oracle, assembly graphs). What it
lacked was any understanding of *what a BrickHeadz is made of*. Phase 1 builds
that semantic layer.

## Pipeline

```
corpus MPDs ─▶ dat.load_pieces ─▶ semantics.analyze ─▶ dna.build_dna ─▶ report.build_grammar
   (78 files)     (placed pieces)    (component labels)   (feature vector)    (grammar + markdown)
```

Run the whole thing:

```bash
npm run brickheadz:build          # cd python && uv run python -m brickheadz all ...
# or directly:
cd python
uv run python -m brickheadz all --corpus ../dist/ldraw_brickheadz --out ../.cache/brickheadz
uv run python -m brickheadz extract --model ../40859-batman.mpd   # one model to stdout
```

Outputs to `.cache/brickheadz/` (git-ignored):

| file | contents |
| --- | --- |
| `records.jsonl` | one `brickheadz.record.v1` per model |
| `grammar.json` | the `brickheadz.grammar.v1` construction grammar |
| `report.md` | human-readable summary |
| `summary.json` | run stats / failures |

## Module map (`python/brickheadz/`)

| module | responsibility |
| --- | --- |
| `dat.py` | MPD → placed pieces (world matrices). Correct `.ldr` vs `.dat` classification. |
| `geometry.py` | world mesh/AABB per piece, world snaps, stud/plate constants. |
| `semantics.py` | connector/geometry-driven component decomposition + front detection. |
| `dna.py` | per-model feature vector (proportions, construction, colour, vocabulary, face). |
| `report.py` | aggregate records into the grammar + markdown report. |
| `corpus.py` | corpus discovery + manifest provenance. |
| `schema.py` | the `record.v1` contract (column-major matrices, LDU, y-down downstream). |
| `cli.py` | `all` / `extract` / `report`. |

## The loader rule that matters

The OMR files mix two kinds of embedded sections. `.ldr` sections are **submodels**
and must be recursed; `.dat` sections are **embedded decorated parts** and their
`sXX` subparts and must stay **atomic** (otherwise a printed tile explodes into
its primitives and part/colour fidelity is lost). This mirrors the app's own rule
in `src/io/ldrawImport.ts` and deliberately differs from
`assembly_model.model.load_model`, which recurses into every section ref. The base
library id is recovered by stripping the OMR `"<set> - "` prefix and the `p<print>`
suffix (`41585-1 - 87079pz0.dat` → `87079`).

## Semantic decomposition

The head is anchored on **side-stud bricks** — bricks whose male studs point
sideways. `22885` (1×2 brick with side studs) is the signature and appears in
**100%** of the corpus. The head shell is the connected cluster of these bricks
nearest the top; the head band runs from its base to the figure top. Then:

- **face** — small pieces protruding beyond the tight head box on the front side;
  the front is the face with the most such details.
- **hair** — pieces above the head.
- **torso** — the body mass above the leg band.
- **arms** — pieces protruding sideways from the torso band (non-front axes).
- **legs** — the grounded bottom band (≤ 3.5 plates).
- **base** — a wide grounded plate (the BrickHeadz stand, typically `3958`).
- **accessory** — detached connected components (props, extra characters).

Heuristics are best-effort and every result carries a consistency warning. Raw
part, colour and matrix are always preserved — semantics is an *added layer*.

## Measured coverage (78 MPDs on disk)

- records produced: **78 / 78**
- head detected: **78 (100%)**
- face detected: **77 (99%)**
- fallback head detections: **4** (honestly flagged in `warnings`)

Canonical proportions (median, w×d studs, h plates): head `6.15 × 5.2 × 18.25`,
torso `4.0 × 4.29 × 12.25`, legs `4.0 × 4.0 × 2.5`, base `6.0 × 6.0 × 1.5`.
Top head brick is `22885` (944×); the eye/detail brick `98138` (1×1 round tile)
leads the face role; `3958` (6×6 plate) leads the base. The palette is the
familiar BrickHeadz one (black, light-bluish-grey, white, reddish-brown, tan).

## Limitations

- The head **cube** dimension is the extent of the side-stud-brick shell, which
  includes the SNOT stud bumps; treat it as a robust relative measure, not an
  exact stud count.
- Head/torso/leg boundaries are heuristic. Models without a `22885`-style shell
  (4 currently) fall back to a top-of-figure box and are flagged.
- Multi-character sets are split into figures by connectivity; model-level
  proportions include all figures side by side.
- Snaps come from the bundled LDCad shadow metadata; parts without it use
  geometric fallbacks only.

## TypeScript contract

`src/anim/brickheadz/artifact.ts` mirrors `record.v1` and `grammar.v1` with zod
(same pattern as `src/anim/assemblyPlan/artifact.ts`), so the studio can consume
the artifacts without a contract change. `tests/brickheadz/artifact.test.ts`
validates the schema and, when `.cache/brickheadz/` exists, the real output.

## What comes next

Phase 2 consumes `grammar.json` to build the procedural template generator;
Phase 3 validates its output with `MeshOracle`; Phase 4 adds the learned layer.
See `~/.commandcode/plans/brickheadz-phase1-dataset-dna.md` for the full roadmap.
