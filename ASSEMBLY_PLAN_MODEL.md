# ASSEMBLY_PLAN_MODEL.md

Hybrid assembly-plan model for BrickMotion Studio: a deterministic,
certificate-based construction planner (Python, `python/assembly_model/`) with
an offline-trained learned ordering prior. The app does not learn at runtime.

## Goal

Plan how a LEGO model is physically built up piece by piece — which piece
lands, from which direction it is inserted, and whether that insertion is
*certified collision-free* — then export that plan for the studio timeline.
The prior's job is only to make the planner pick better first candidates; it
never approves or suppresses a step.

## Layout

```
python/
  assembly_model/
    schema.py    AssemblyPlan v1 JSON contract (shared with the studio app)
    ldraw.py     LDraw library loader: triangles, per-part AABBs, LDCad shadow snaps
    model.py     .mpd/.ldr flattening into placed Piece records (world matrices)
    geometry.py  AABBs, swept boxes, BoxGrid (cell broadphase for corridor tests)
    certify.py   swept-AABB corridor certification, face-contact area
    assembly.py  assembly graph: snap/socket/interlock/contact joints, support
    search.py    forward construction: candidates, certification, ranking, traces
    prior.py     feature vector + logistic prior; train from traces (pairwise)
    export.py    Result -> AssemblyPlan artifact
    cli.py       python -m assembly_model {plan,train}
  tests/
```

## Contract (`schema.AssemblyPlan`, v1)

`format: "brickmotion-assembly-plan"`, `version: 1`, units **LDU**
(stud pitch 20, plate 8, brick 24). LDraw native space: **up is -y**; the
ground plane of an assembled model is the max-y face of the model.

- `pieces[]` — `key` (`submodel/n`), `part`, `color`, `matrix` (column-major
  4x4, `THREE.Matrix4` compatible), `submodel`.
- `joints[]` — graph edges: `kind` (`cyl`, `socket`, `interlock`, `face`),
  `parent` (static side), `child` (travelling side), `axis` (child travel
  sign), `confidence` (`snap`, `implied`, `interlock`, `contact`).
- `steps[]` — order, `pieces`, `insertion` (axis, distance, origin,
  tier `snap|face|drop`), `certificate` (`kind`, `frames`, `margin`,
  `clear`, `blockers`), `uncertified`, `reason`.
- `stats` — pieces, placed, certified, forced (stall-breakers), tests, ms.

Certification tiers, in trust order:

1. `snap` — socket/peg relationship from LDCad shadow snaps or implied
   sockets. Box sweeps cannot certify these exactly (sockets interpenetrate),
   so the corridor tests every frame against all *non-mate* obstacles and
   forgives the mates along the whole path. Trust label remains `snap`.
2. `face` — flush stacking contact with placed pieces; every frame certified
   against everything (margin ~1.5 LDU during flight, 0 at touchdown).
3. `drop` — gravity-only fallback for pieces with no placed neighbours yet.

Any step that could not be certified within the time budget is either deferred
(skipped until its dependencies are in) or force-committed by the
stall-breaker with `certificate.clear = false` — the studio must render those
as a visible trust gap, not as a certified route.

## How planning works

1. `model.py` flattens the mpd into pieces with world matrices (type-1 line =
   9 rotation values + position; filenames may contain spaces, e.g. section
   refs like `10156 - truck.ldr`).
2. `assembly.py` builds the joint graph in four passes: explicit male/female
   snap matches (LDCad `SNAP_CYL` etc. via `ldcad-shadow.json`), implied
   sockets (a male seek landing on another piece's receiving face plane,
   emitted in both travel orientations), deep interlocks (minifig
   hips/torso/arm class, no snap or flush signal), and face contacts. The
   dual-orientation emission is deliberate: corridor certification picks the
   travel direction that is actually buildable.
3. `search.py` loops: every piece produces axis candidates (its snap-joint
   axes; else the vertical drop axis); each candidate is certified against
   the placed set (BoxGrid broadphase, sampled corridor, final frame margin
   0); supported = ground / joint / top-face support. Ranking:
   `(tier, -prior_score, -support_area, contacts, piece_key)` — deterministic.
4. Pieces failing certification on the current placed-set are skipped until
   the set grows (their candidates only change when a neighbour commits).
5. Two consecutive empty rounds trigger the stall-breaker force-commit.
6. Traces record every scored candidate per decision with features, prior,
   certified/supported flags and the chosen marker.

## Prior & training

Features (fixed order, `prior.FEATURES`): `tier0/tier1/tier2` one-hot,
`contacts`, `area/1000`, `lateral` (horizontal travel), `dist/100`.
`train_from_traces()` fits a pairwise logistic (chosen certified candidate =
positive, certified-not-chosen peers = negative) with L2 regularisation and
saves portable JSON `{"weights", "bias"}`. At plan time the prior only
influences tie-order within equal `tier`.

```
cd python
.venv/bin/python -m assembly_model plan  --model ../tests/fixtures/models/10156-1.mpd --out /tmp/plan.json --trace /tmp/trace.jsonl
.venv/bin/python -m assembly_model train --traces /tmp/trace.jsonl --prior /tmp/prior.json
.venv/bin/python -m assembly_model plan  --model ../tests/fixtures/models/10156-1.mpd --prior /tmp/prior.json
```

Fixture 10156-1 (111 pieces): 2.0s, 12k corridor tests, 100/111 certified on
the first pass; the 11 stall-breakers are the minifig interlock cluster plus
SNOT-shaped truck bits, which a v2 with socket-aware swept volumes should
recover.

## Honest limits (v1)

- Box-level certified corridors: triangle-precise machining (true irreversible
  sweep vs sockets) is future work; the studio treats non-.clear steps as
  approximate order hints.
- Repetitive subpart materials and stud-sharing clones are parsed but
  not yet deduplicated into groups.
- The prior is per-candidate static; the next step is rollout comparison
  (order the trace with the prior, compare certified counts vs baseline) so
  training signal becomes outcome-based instead of preference-only.

## Studio integration (implemented)

The app consumes artifacts through the existing construction pipeline:

- **Artifact reader** — `src/anim/assemblyPlan/artifact.ts` mirrors the v1
  contract with zod (`parseAssemblyArtifact`). `plan.assemblyPlan` carries the
  opaque artifact JSON on the model plan; `src/plan/schema.ts` keeps it through
  parse/roundtrip, and `.brickmotion` project files therefore save it too.
- **Certified-only bridge** — `src/anim/assemblyPlan/construction.ts` matches
  every artifact piece to its studio instance by normalized part name + world
  translation (tolerance 0.06 LDU) and verifies rotation elements (≤0.02). Each
  artifact step must be a single piece with `certificate.clear === true` and a
  unit insertion axis; the corridor's straight staged→final ray becomes one
  `place` operation (`staged = final − distance·axis`). Anything that moved
  since planning — or any stall-breaker step — is rejected with a
  `ConstructionError`, never re-estimated.
- **Planner option** — Video settings pick `Assembly artifact` as the assembly
  planner (`planner: 'assembly-artifact'`). `buildTimeline` parses the artifact,
  builds the `ConstructionPlan`, and `compileConstruction` validates/schedules
  it exactly like engine-made V2/V3/V4 plans (continuity, final pose, camera
  framing); the encoded timeline then flows through the same worker, cache and
  export paths. Artifact placements are never re-certified — the corridor was
  certified by the Python engine, and the studio animates the identical ray.
- **Import flow** —
  `cd python && .venv/bin/python -m assembly_model plan --model model.mpd --app-plan saved.plan.json --out model.assembly.json`.
  With `--app-plan` the artifact embeds the model plan (`appPlan`), so one file
  import opens model + artifact. Without it, import the model first, then the
  artifact (Projects → Import file); the artifact attaches to the open plan.
- **Smoke-verified end to end** — headless-Chrome run against the dev server:
  `10156-1.mpd` import → artifact attach → `assembly-artifact` planner →
  "111 certified placements" planned through the real worker → playback
  advanced over the 15 s timeline in the build view.

## Studio integration path (historical note)

`steps[]` maps 1:1 into the existing timeline planning pipeline
(`src/anim/timeline.ts` -> `planConstruction(V4)` family): the exporter gives
pieces + step order + certified corridors so the app can drive assembly
replays without re-deriving the order. Zod mirrors of `schema.py` will live in
`src/anim/plan/` and the timeline cache version bumps one minor level.
