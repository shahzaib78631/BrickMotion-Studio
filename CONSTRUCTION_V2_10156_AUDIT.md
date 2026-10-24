# Construction V2: 10156-1 failure investigation (2026-10-24)

## Scope and evidence

The screen capture shows a 10156-1 LEGO Truck project with **113 pieces**, **two submodels**, one build step, and a manual spot for the truck at **X=16 studs, Z=2 studs, 0 degrees**. Planning ends in `no-supported-rigid-route`, with recent `floor` contacts such as `i0/i32` and `i0/i31`.

The actual edited `.brickmotion`, `.ldr`, or `.mpd` model **was not attached in the conversation**. An independently published OMR model exists at https://library.ldraw.org/omr/sets/659, but the binary MPD could not be retrieved into this environment. Therefore the exact mesh collisions, authored hierarchy, and route failure remain **unreproduced**. Do not represent the synthetic test below as an exact 10156 run.

A controlled proxy test with 113 separated cube meshes, two submodels, and the same manual truck spot **passed**, producing **115 operations** with zero backtracks. This isolates the problem: group count and the selected spot alone do not make Construction V2 fail. The unresolved failure must be investigated with the real meshes, contacts, dependencies, and placements.

## Confirmed bugs fixed in this release

1. **Unsafe contact exemption** (`src/anim/construction/collision.ts`). A `surfaceTolerance` metadata value could skip an unchecked prefix of a moving brick's path. A test with two solid overlapping cubes moved through one another returned `true` with the policy and `false` without it. This shortcut has been removed: only an independently localized, continuously checked connector region may relax contact along an actual path.
2. **Vacuous empty contact polygon** (`collision.ts`). The contact-region validator could accept `[].every(...)` when clipping yielded no polygon. Empty polygons no longer certify motion.
3. **Requested video duration ignored** (`compile.ts`). Fixed minimum 0.35s moves plus 0.03s gaps made 100 operations run 39.47 seconds for a requested 20s clip. Operations and gaps now share the selected build-time budget. Also, the pacing allocator counts **authored steps**, rather than incorrectly treating each generated operation as a distinct step and reserving ghost pauses.
4. **Unhelpful V2 error diagnosis** (`planner.ts`). The error previously displayed the *last four search contacts*, frequently only attempts to move a part below the floor. Failures now prioritize non-floor obstructions, identify the affected scope, and provide the pieces remaining in the deepest explored search state. This is a diagnostic aid, **not** proof that any particular piece makes the build impossible.
5. **No useful action after failure** (`BuildTimeline.tsx`, `App.tsx`). A confirmed, explicitly labeled Standard-planner switch has been added to the Build timeline's error state. This is opt-in and warns that Standard may generate uncertified flights.

## Remaining real-model and architectural constraints

- Construction V2 supports rigid moves only: it cannot physically solve every tire snap fit, hinge, hand articulation, or interlocking geometry. Uncertified fallback is deliberately prohibited inside V2.
- Differently oriented objects often use conservative swept axis-aligned bounds rather than exact cross-orientation mesh clearance. Thus a real safe path may be rejected as unproven.
- The route family is finite: fixed departure axes, straight corridor variants, lift, and bounded turns; it is not a general 6-DOF configuration-space motion planner.
- Renderer geometry is not necessarily watertight collision geometry. Connector and surface metadata cannot be used as general permissions to disregard solid intersections.
- The screenshot's **floor** messages are *search probes*, not evidence that the parts themselves are under the floor at their final pose.
- Without the actual saved project, the specific obstruction at `i0/i31` and `i0/i32` cannot be determined, and the updated V2 planner has **not** been shown to solve 10156-1.

## Verification

- Dependency-free Construction V2 TypeScript project: strict typecheck passed.
- Standalone overlapping-cube regression: before `policy:true`, now `policy:false`.
- Standalone 100-operation video: before `39.47s`, now approximately `20.0s`.
- Standalone rotated-bay planner/compiler checks: 8/8 angles passed (15, 30, 45, 90, 135, 180, -45, 270 degrees).
- Synthetic 113-piece, two-submodel, X16/Z2 truck layout: successful, 115 operations, zero backtracks.
- New Vitest regressions included under `tests/anim/constructionV2Audit.test.ts` (not executed here; Vitest dependency unavailable).
- Syntax parsing and TS core checks passed. Full browser build, real MP4 and model-specific reproduction remain unverified.

## Exact reproduction instructions

1. Save the failing project from BrickMotion Studio as a `.brickmotion` project (preferred), or export the exact `.mpd`/`.ldr` source **together with the build spot settings**.
2. Run with Construction V2 enabled. Preserve the reported scope, remaining parts and non-floor obstructions.
3. Identify the pair's final geometry, insertion axis, and any actual connector. Check narrow-phase contacts using the authoritative LDraw parts, not generic proxy cubes.
4. Only add a new route or connector contact if the *entire sweep* is certified. Never widen `surfaceTolerance`, hide a blocked piece, or silently teleport it.
5. Until then, a user can explicitly try Standard planning, with uncertified routes flagged and inspected before export.
