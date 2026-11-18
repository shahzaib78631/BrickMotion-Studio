# BrickMotion — embedded custom geometry / collision integration validation

**18 November 2026.** Incremental change on top of `BrickMotion-Studio-Geometry-M1.zip`.
This is a correctness and diagnosability pass, not a claim of faster M1 planning.

## Problem addressed

A BrickLink Studio `.io` may contain a valid `CustomParts/*.dat` whose nested
primitive or subpart is missing from the embedded archive **and** the installed
LDraw library. That custom part can still generate some visible triangles, so
checking only whether the file loaded or whether the mesh is nonempty is
insufficient. The original `Model::report().missing` covers placed file
references, not all transitive dependencies of their flattened meshes.

This matters for collision-based planning: a partial mesh can silently omit a
blocking surface, leading the solver or certifier to approve an invalid flight.

## Implementation

1. **Opt-in `collide::auditGeometry()`** (`core/include/bm/collide/geometry_audit.h`,
   `core/src/collide/geometry_audit.cpp`): builds/validates every *distinct placed
   part type* once. It reuses the model's cached inline meshes and the supplied
   collision shape cache; reports missing transitive references (including
   cycles), empty collision shapes, number of instances and triangles, plus
   malformed embedded LDraw lines. Results are deterministic, sorted by part
   name. It is not called on ordinary loads, so regular load speed is unchanged.
2. **Importer diagnostics:** `LoadReport::studioCustomPartSkippedLines` tracks
   malformed commands in reachable embedded `.dat` files. The count is taken
   **before** the files are moved into `Library` to preserve correct ownership.
   Existing permissive LDraw parsing is unchanged; corruption remains observable
   during audit and is rejected by strict verification.
3. **CLI:** `bm load <file> --check-geometry --json` prints a `geometryAudit`
   object with `structurallyComplete`, issue details, timings and counts.
   `--strict-geometry` runs the same check and exits nonzero when incomplete.
   `structurallyComplete` is only a **necessary condition**: it does not establish
   watertight solids, exact physical mates or perfect rotational collision detection.
4. **Native Catch2 regression suite** (`tests/collide_studio_test.cpp`): a
   ZIP-embedded closed cube that references a nested subpart must pass import,
   mesh flattening, broad-phase, narrow-phase static intersection, straight
   sweep, the planner's `World::clearTravel`, and the **independent plan certifier**.
   A legitimate collision-free insertion must certify; changing only the flight
   to pass through the imported cube must fail, with the blocking piece index.
   Additional fixtures prove overlapping custom parts are detected and that
   partially missing or malformed geometry is rejected by structural checks.
5. **Concurrency check:** eight workers request a single model-scoped mesh/shape
   simultaneously; they must share the same immutable cached objects.
6. **Portable verifier** (`tools/perf/studio_collision_verify.sh`) for CI or
   Linux machines without Apple frameworks. It compiles the same core sources
   under `-Wall -Wextra -Werror` with a *test-only* zlib adapter for miniz and
   exercises all the cases above. Pass optional real `.mpd` / `.io` models for
   extra smoke coverage. Production still uses miniz 3.0.2, not this adapter.
7. **M1 verification helper** (`tools/perf/m1_validate_geometry.sh`): calls the
   native CLI on each supplied model, preserves a JSON report per model and
   creates `summary.csv`. Set `BM_FAIL_ON_INCOMPLETE=1` to fail CI on unresolved
   collision geometry. Optional `BM_RUN_OVERLAPS=1` runs expensive whole-scene
   overlap tests separately.

## Results obtained here (portable Linux, **not** Apple M1)

The Release and ASan/UBSan standalone verifiers passed. The synthetic fixture's
custom part produced 12 triangles (24 triangle **instances** in two placements),
`World::clearTravel` stopped a moving cube at about **80.45 LDU** before the
obstacle, and the sampled straight sweep detected the obstacle at about **0.55**
of the path. The alternate authored plan crossing that cube was rejected by the
independent certifier. Incomplete nested references and parse-skipped custom
commands were explicitly detected. The native Catch2 test file passed a C++
syntax check, but the actual macOS Catch2 executable was **not run**.

All five user-provided models were imported and used to build `World` instances
with the minimal repository test library, without a crash:

| Input | Expanded pieces | Custom `.dat` imported from Studio | Distinct placed model-scoped parts with empty collider |
|---|---:|---:|---:|
| `9093-1.mpd` | 82 | N/A | 0 |
| `76897-1.mpd` | 262 | N/A | 0 |
| `Simtek S941.io` | 789 | 124 | 0 (28 placed custom part types) |
| `5590 Super Truck.mpd` | 1,258 | N/A | 0 |
| `Ma Odele's.io` | 2,119 | 23 | 0 (8 placed custom part types) |

**Important qualification:** the repository fixture LDraw library is incomplete.
With it, the geometry audit correctly reports 153 incomplete / missing-shape
standard part types in Simtek S941 and 200 in Ma Odele's; this does **not** mean
these are problems in a complete, installed LDraw library. These models cannot
be certified end-to-end from this Linux environment. The verification only shows
that all *placed Studio-embedded custom parts* produced collision-shape nodes.

The portable verifier was additionally run under ASan/UBSan on both Studio files
with leak detection enabled, without a reported sanitizer error. This is useful
but is not a replacement for ThreadSanitizer or native platform testing.

## Run on your M1

Extract the **new** project and use a complete LDraw parts installation. Build
from its extracted root (not the parent directory):

```bash
export BM_LDRAW_DIR=/path/to/complete/ldraw
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 4
ctest --test-dir build --output-on-failure

# Test the full geometry of the supplied Studio model. Use one or more inputs.
build/tools/bm/bm load "/path/to/Ma Odele's.io" --check-geometry --json

bash tools/perf/m1_validate_geometry.sh build/tools/bm/bm \
  '/path/to/9093-1.mpd' '/path/to/76897-1.mpd' \
  '/path/to/MOC-272851_TheDeeGee_Simtek_S941.io' \
  '/path/to/5590_-_whirl_n_wheel_super_truck.mpd' \
  "/path/to/Ma Odele's.io"
```

Then compare `bm plan ... --threads 4 --budget 15` and `--threads 8` using
`tools/perf/m1_profile.sh`; run `bm overlaps <file>` on suspect models and
inspect the collision details. Keep the prior build, and use the same LDraw,
shadow and Studio connectivity libraries for before/after comparisons.

A `--strict-geometry` failure means a part has no usable collision shape,
references an unavailable dependency, or has parse-skipped Studio geometry.
Certain line-only decorative parts legitimately have no collision surface: review
those explicitly rather than assuming an importer defect. A structural pass
is **not** proof of physical correctness.

## Not yet validated

- Complete native M1 compilation, Catch2 suite, GUI/Metal rendering, memory
  usage and real-model planning/certification under a complete library.
- Studio proprietary `.conn` connector semantics and `.col` collider metadata.
- Collisions involving closed containment, non-watertight shells, fine
  rotational sweeps and the engine's existing tolerance policies.
- End-to-end performance changes. This pass intentionally did **not** change
  collision tolerances, BVH traversal, planning heuristics or search breadth.

**Recommended integration decision:** keep this as a validation branch until the
native M1 regression suite, geometry audits, plan certificates and actual
profiling results have been reviewed.
