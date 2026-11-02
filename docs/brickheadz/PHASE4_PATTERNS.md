# BrickHeadz Phase 4 — Learned Construction Patterns

Phase 4 adds creativity by **learning reusable headwear/hair sub-assemblies from
the corpus and recombining them onto generated figures** — the "learn the
construction rules, not the characters" goal. It is the data-appropriate form of
learning here: the corpus is 78 models, far too few to train a generative network
from scratch, but more than enough to learn a library of real, valid construction
patterns. The same pattern representation is what a neural layer would consume
later, so nothing is thrown away.

## Usage

```bash
npm run brickheadz:patterns   # learn the pattern library from .cache/brickheadz/records.jsonl
npm run brickheadz:cast       # generate 20 cast figures, certify, repair, re-certify
bash scripts/brickheadz-cast.sh 40 21 --face   # larger batch, with learned faces
```

`generate --cast` (and `sample --cast`) compose a learned headwear/hair pattern
onto the procedural base; `--face` also uses a learned face pattern.

## Module map (`python/brickheadz/`)

| module | responsibility |
| --- | --- |
| `patterns.py` | extract / read headwear & face patterns in a head-local frame |
| `recombine.py` | anchor, orient, seat and repair a pattern onto a generated head |

## How patterns are learned

Each model's `hair`/`face` pieces (from the Phase-1 semantic decomposition) are
captured in a canonical frame whose origin is the **centre of the head's top
face**:

- The **size key** is the true head footprint (`headCube`), so a 4-wide head gets
  4×4 patterns — over the current corpus: **58 hair patterns at 4×4** and **68
  face patterns at 4×4**.
- The **anchor** is the head top, laterally centred on the `22885` shell (not the
  decorated head region, whose bbox is skewed by protruding face parts).
- Each piece keeps its exact **relative 4×4 matrix** (including SNOT rotations),
  so curved slopes and side strands transfer verbatim.
- The source model's facing is recorded so the pattern can be rotated forward.

## Recombination

1. **Anchor** — re-anchor on the generated head's top-face centre (measured to the
   cap's stud tips, to match how the corpus is measured).
2. **Orient** — rotate the pattern about Y so its source facing lands on -Z.
3. **Seat** — try a few small vertical nudges and keep the one with the least
   interpenetration (transferred patterns can sit a few LDU high or low).
4. **Repair** — drop only the placed pieces that visibly interpenetrate (a large
   share of the smaller piece's volume inside another) or that end up
   disconnected, keeping the bulk of the headwear.

## The generate -> certify -> repair loop

The mesh certifier (Phase 3) is the authority. `brickheadz:cast` runs:

```
sample --cast  ->  validate-brickheadz (--repairs)  ->  repair  ->  validate
```

`validate-brickheadz.ts --repairs` writes the **node ids** of the offending
pieces; `python -m brickheadz repair` drops exactly those, and only when they are
pattern pieces (`assembly.role` `headwear`/`generic`) — the body, head and base
are never touched. This iterates until every model certifies CLEAR.

## Results

- `npm run brickheadz:cast` (20 models) -> **20/20 CLEAR** after one repair pass.
- A 40-model batch -> 29/40 on first certification, **40/40 CLEAR** after two
  passes (26 pattern pieces dropped across 11 models).
- Every emitted model keeps a real headwear/hair pattern (mean ~6 pieces); the
  committed `tests/fixtures/brickheadz/bh-cast.plan.json` certifies CLEAR.

## Toward the reference models

The patterns are learned from the official corpus, so they cover the **hair /
headwear variety** official BrickHeadz is rich in — long hair (Elsa, Hermione),
hats, caps and helmets — plus **face feature layouts**. That is the class of the
reference images: layered hair with side-locks, headwear shells, and custom faces.

Not yet covered, and the honest next steps:

- **Bespoke full-shell headwear** (Doom's hood with a recessed faceplate,
  Deadpool's wrap-around mask) — these need parametric headwear templates, as the
  corpus thins out for that exact shape.
- **Side props** (energy hands, katanas, capes) — the corpus has very few labelled
  accessories, so these need their own pattern source.

Both build on the same pattern/recombination machinery; they extend the library,
not the architecture.

## Limitations

- Transfer is geometric: a pattern from a head of another height can sink a few
  LDU, which the seat + repair step trims rather than fixes exactly.
- Faces are the least robust feature (they mount on front studs at half-plate
  heights); `--face` works but drops more pieces than hair.
- Patterns are keyed by head footprint (4×4, some 6×6), not by colour; a pattern
  brings its source colours.

## What comes next

Phase 5 adds inventory / colour-palette / dimension constraints; Phase 6 adds the
studio panel that generates, certifies and imports a model. A neural layer, when
the dataset grows, would predict pattern *choices* over this same library.
