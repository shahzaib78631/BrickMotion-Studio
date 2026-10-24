# Construction V2: general-model hardening and adaptive planning

**Updated:** 24 October 2026

## User-facing planner choices

In **Video > Planner** choose:

- **Standard — flexible preview:** existing construction animation builder; some motions may not be collision-certified.
- **Adaptive — V2, then uncertified preview:** attempts strict V2 first. If V2 returns a recognized geometrical or search limitation, builds a Standard visual preview. It **marks EVERY operation uncertified**, preserves the V2 reason/stage/blockers in saved timelines, displays an unmistakable warning in Build and Video, and requires acknowledgement before MP4 export. It **never** reports the fallback as collision-certified.
- **Construction V2 — certified only:** the rigid planner and strict replay. If it cannot certify a route under the configured budget or constraints, it reports the failure and generates no certified clip.

The default Standard choice is retained for project compatibility; Adaptive is opt-in. Switching the planner causes the worker and cache to produce a distinct timeline.

## Changes to the geometry / planning core

1. **Semantic composite workpieces** (`semanticComposites.ts`). Recognizes a contiguous run of LDraw-described flexible hose/cable render segments in the same authored step/model, provided the segments share compatible centerline directions and nearby endpoints. They are staged and carried as ONE *preformed* workpiece, without animating fictitious flights for each render segment. Their meshes are retained; only contacts between parts of that exact composite are ignored during completed-pose internal-overlap validation. Every collision against other pieces remains checked. This supports *preformed rigid transport*, not hose deformation, bending, tubing creation, or a physical flexible-part simulator.
2. **Static gear-tooth engagement** (`meshingContacts.ts`). For explicitly described gear/rack parts with distinct centers, the existing triangle oracle must find a shallow, separable final-pose contact before a **staticOnly** mesh certificate is permitted. Static gear contact is never mechanical support and never permits a swept collision exemption. Rotating or meshing gears dynamically is not simulated.
3. **Rotated staging-bay narrow phase** (`collision.ts`). Continuous translation between meshes held in different orientations now uses transformed triangle BVHs through `clearPosed`, rather than rejecting any overlapping AABBs without a mesh test. A nontrivial rigid rotation still uses the conservative continuous sphere envelope. The existing connector-surface policy cannot blindly exempt a length of travel.
4. **Spatial contact broad phase** (`contactBroadphase.ts`). Sweep-and-prune enumerates only possible AABB contacts. It preserves the exact original three-axis overlap criterion, without dropping any genuine candidate. It does not eliminate expensive narrow-phase triangle tests when hundreds of parts physically touch.
5. **Scope-local graph indexing** (`planner.ts`). Dependencies and mechanical neighbors are indexed once per disassembly scope and used for each candidate choice; avoid rescanning all edges across hundreds of candidates.
6. **Actionable failure stage** (`types.ts`, `planner.ts`). Budget/cancellation failures identify whether V2 stopped in `connections`, `final-contact-audit`, `route-search`, or `forward-replay`, along with scope, search statistics, and available obstruction pairs.
7. **Cache safety**. The IndexedDB timeline fingerprint version is bumped to 5. Newly certified clips carry `certificationVersion: 2`; older embedded V2 construction certificates are not silently reused from `.brickmotion` project files. They are skipped and re-planned. Standard saved clips are unaffected.

## Why “any model” does not mean a collision-certified route

A model with articulated steering/gears, genuinely deforming hoses, opaque custom parts without LDraw meshes, internally intersecting authored geometry, insufficient contact descriptions, or an assembly that cannot be built by extracting each part along the allowed rigid axes may have no certifiable rigid-only assembly route. Even a physically buildable model may exceed search or triangle-validation budgets. **The Adaptive choice still provides a visibly labeled preview when Standard can plan the model, but that preview is not a certified solution**. Missing collision geometry and malformed input remain hard errors (they must not be made safe by a silent fallback).

## LEGO 5590 validation (real model and supplied part definitions)

The user's MPD has 1,258 part instances, three top-level submodels, and 133 unique directly referenced LDraw part types. The supplied minimal dependency bundle resolves all geometry. The improved planner recognizes hose segments as two preformed clusters in the 554-part truck submodel, and recognizes shallow gear engagement where the actual meshes justify static contact.

- **Truck alone:** exact-geometry V2 passes the previously failing preflight into actual route search (over 450 disassembly candidates after semantic grouping). With a 15-second V2 budget, it stops with `search-budget-exhausted` during route search (20 states, 16,865 route candidates, no backtracks). **No certified complete truck timeline was obtained.**
- **Full 5590:** exact-geometry V2 still exceeds the default resource budget during the final-contact audit (1,258 parts; at 24 seconds budget it reports `search-budget-exhausted`, `states=0`, with millions of triangle candidates checked). **No certified complete full-set timeline was obtained.**
- **Adaptive mode:** fallbacks are implemented and marked explicitly. End-to-end Standard preview generation for 5590 has **not** been verified in a browser here, because application dependencies and the browser asset package are unavailable. Do not interpret success in strict subtests as a full 5590 success.

## Verification

- 13 independent assertions ran successfully using locally compiled TypeScript: a 3-piece strictly planned and compiled animation, rigidly rotated collision checks, no `surfaceTolerance` crossing exemption, positive/negative hose grouping, broadphase equivalence, and adaptive fallback metadata/eligibility.
- The sweep-and-prune broad phase enumerated exactly the same 2,066 possible contacts as an O(n²) reference scan for a deterministic 1,200-node synthetic scene.
- The entire dependency-free Construction V2 core passed `tsc -p tests/tsconfig.construction.json` with strict types. Source-syntax parsing was also run across the application.
- New Vitest tests are provided in `tests/anim/constructionV2Generalized.test.ts` and `tests/io/projectFile.test.ts`; they have **not** been executed with Vitest in this environment.
- The real LEGO 5590 MPD and its needed LDraw parts were used for planner repro, but are not bundled with the source archive. The repo includes the MPD diagnostic CLI in `scripts/diagnose-construction-mpd.ts`.

## Next research steps

True articulated-motion planning (hinges/gears), procedural hose deformation, semantic contact libraries for all part families, support for intentionally intersecting authored geometry, and optimized incremental GPU/mesh-level collision search remain separate research/engineering efforts. Automatic full certification cannot be guaranteed for arbitrary LDraw models.
