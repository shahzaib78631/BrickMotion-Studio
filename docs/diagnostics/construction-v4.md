# Construction V4 — global-scene articulated planner (experimental)

Construction V4 is a new certified planner alongside Standard, V2 and V3. It is
available as `construction-v4` in the planner selector and as
`--engine=v4` in `scripts/diagnose-construction-mpd.ts`.

## What is implemented

- **One global scene.** Every cluster is installed at its authored pose or
  staged at a workbench slot. V4 never solves a submodel in isolation and never
  ignores a neighbouring scope.
- **Cluster decomposition.** Leaf parts, measured tyre/rim pairs, cross-step /
  cross-model preformed hose runs, and small authored submodel assemblies are
  planning units with their own swept bounds.
- **Joint graph.** LDCad cylinder, axle, pin, hinge, clip and ball evidence is
  converted into typed joints with axes, pivots, limits and confidence. Raw
  `caps`, `seq`, `scale`, `match` and `placement` fields are retained for
  future mechanism coverage.
- **Connector policies.** Every inferred joint contributes a localized,
  pose-anchored motion policy. Stud/socket and pin/hole policies allow only the
  measured connector material to overlap during the first disengagement or the
  final insertion; the rest of every sweep remains exact.
- **Final-pose surface audit.** Shallow authored render overlaps are measured
  with `MeshOracle.staticContact`, anchored at the exact relative pose, and
  recorded as insertion/withdrawal certificates. Deep penetration and
  unexplained contacts are hard failures. The helicopter audit currently
  resolves 18 surface contacts and leaves **0 unresolved** for the export in
  `/Users/mac/Downloads/helicopter.mpd`.
- **Continuous rotation certificate.** `MeshOracle.arcClear` computes exact
  per-triangle arc bounds (not samples) and rejects any surviving overlap;
  `annulusClear` uses exact radial/axial interval separation for free
  full-turn mechanisms such as rotors. Both operate in world space and use the
  same triangle meshes as translation checks.
- **Two search strategies.** A forward authored-step/module search with
  per-step backtracking, and the global backward disassembly search inherited
  from the V3 architecture. Forward gets 45% of the time budget before the
  backward search takes over. There is no uncertified fallback.
- **Independent compile path.** Accepted operations are emitted as standard
  `Operation`/`rigidPath` data and compiled by the existing
  `compileConstruction`; V4 plans carry their cluster/joint/proof metadata in
  `v4` and report `capabilities.articulation: true`.

## Verified results

| Model | Result |
|---|---|
| Synthetic 8-box assembly | Full forward plan, compiled timeline, 4 V4 tests pass |
| `modern_fighter_jet.mpd` (4 clusters) | Full certified plan |
| `helicopter.mpd` (305 pieces, 274 clusters) | Final-contact audit passes (18 surface certificates, 0 unresolved). The 300 s search is **not complete**: forward step-module ordering consumes its share, backward search reaches the deepest verified disassembly but does not finish. |
| 10156-1 (102 clusters) | Not complete inside the standard budget; explicit budget failure. |
| LEGO 5590 (1,258 pieces) | Not yet completed. The existing V2/V3 evidence and the interlocked truck/trailer mechanisms remain the hard blockers. |

V4 does **not** emit a partial or uncertified animation. A failed plan throws a
`ConstructionError` with the phase, unresolved items and search statistics.

## Why the large models still fail

The authored MPD STEP order is a human instruction order, not a rigid
assembly order. Several layers wrap around already-built structure and cannot
be inserted as one module; individual parts in a layer may have to interleave
with adjacent layers. The current search can try modular layer orders and
per-step individual backtracking, but it does not yet perform a global
part-level forward search with a blocking graph and subassembly decomposition.
That is the next engineering step, not a certificate relaxation.

## Usage

```bash
npx tsx scripts/diagnose-construction-mpd.ts model.mpd public/ldraw full \
  report.json --engine=v4 --budget=v4
```

`--budget=v4` is the 300 s / 100k-state acceptance budget. `--audit-only` is
V2/V3-specific; V4 always performs its final-contact audit before planning.
