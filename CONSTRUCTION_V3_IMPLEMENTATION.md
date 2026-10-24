# Construction V3 — guided rigid assembly planning

**Date:** 24 October 2026  
**Status:** Implemented and integrated as an opt-in planner, with independently measured geometry regressions. **Not** a universal certified solver. In particular, the full 1,258-piece LEGO 5590 MPD still cannot be collision-certified; the contact audit reports three unidentified helicopter interactions. See the measured results below.

## How to use

In **Video → Planner**, choose:

- **Construction V3 — guided, certified only**: attempt the new geometric route search, retain exact collision constraints, fail with a diagnostic if it cannot finish safely.
- **Construction V3 — guided, preview fallback**: try the same V3 certification first; on known geometric limitations/search budget exhaustion, generate a **visibly uncertified** Standard animation instead. Review the preserved failure reason before exporting. Missing geometry, cancelled work, and malformed inputs remain errors.
- **Construction V2 — certified only** and **Construction V2 Adaptive** remain for direct regression comparison. Existing projects default to their previous planner.

The **Construction search budget** panel offers Standard (20 s), Extended (60 s), and Diagnostic (120 s), with corresponding state and candidate bounds. Budgets control search effort **only**; no collision checker becomes permissive with a higher setting. Planning is already executed in a cancellable application Web Worker and does not block the 3D editor. Cache keys include the planner and budget; the timeline cache version is increased to 6 so old results are not silently misidentified as V3 results.

## What was implemented

### 1. Hierarchical model and dependency-aware candidate ordering

V3 uses the existing imported MPD submodels, instruction `STEP` ordering, group dependencies, and semantic composite-group extraction. A scope is solved independently, then its independently verified operation paths are replayed in the whole scene. The graph is indexed once per scope, and candidate bricks prefer later authored steps. Its per-state spatial index is rebuilt on successful removal, not on every trial. The existing support/fixture constraints still apply.

**Important:** This is not a new universal topology solver. It does not automatically infer hinge kinematics, construct articulated joints, or invent missing assembly relationships.

### 2. Geometry-guided NEAR and FAR motion proposals

`src/anim/construction/nearFar.ts` determines a small ordered list of directions from declared insertion axes, compatible connector outward directions, and exposed axes. It proposes extraction depths using connection regions, part extents, and actual nearby obstacle faces rather than a fixed Cartesian grid. Next, it proposes a direct free-space corridor and up to four work-area exit routes. This is **proposal generation, not a collision exemption**.

V3 tries guided routes for **all eligible pieces** in a state before falling back to exhaustive V2 routes. This two-pass policy is significant: doing exhaustive fallback immediately for each rejected brick caused the first V3 prototype to be slower than V2. Guided routes and the old routes still pass through the same continuous swept-mesh clearance checking, rotation-envelope safety checking, and forward replay.

### 3. Scope-local broad phase and indexed motion-contact policies

`sceneIndex.ts` implements an immutable AABB BVH containing already assembled and staged objects, honoring independently rotated submodel bay poses. Each continuous straight motion queries potentially intersecting obstacles before invoking the expensive triangle oracle; the full rotation sphere also queries nearby occupied boxes. Tests compare both queries to exhaustive box scans to ensure no potential obstacle was dropped.

Motion contact policies are indexed by directed part pair instead of searching the entire connector list on every triangle query. Connections and dependency edges are pre-indexed for each scope. These optimizations do not alter collision certification standards.

### 4. Enforced cancellation and budget checkpoints

Wall-clock and cancellation checks now occur inside expensive mesh BVH walks, triangle-pair loops, solid-construction loops, and containment/winding computations. They stop difficult local geometry queries at the configured budget rather than waiting for the whole operation to return. Each error preserves its stage (`connections`, `final-placement`, `route-search`, or `replay`), scope, obstruction pair(s), and accumulated search statistics where available. A user cancellation is **never** reclassified as a preview-eligible routing failure.

### 5. Diagnostics, replay, and serialization

V3 is a distinct planner in settings, planning request, cache key, Build/Video UI, and adaptive fallback provenance. New profiling counters cover guided and exhaustive candidates, broad-phase queries/hits, contact-audit time, and routing/replay time. The final animation uses the existing `continuous-triangle-sat` checks and construction compiler, including independently rotated submodel paths and camera/export integration. The keyframe Timeline can still link, bake, edit, and export V3-produced Build clips just as it does with V2 clips.

## Actual LEGO 5590 benchmark

Measured with the exact user-provided MPD and the self-contained 5590 LDraw dependency bundle, on the same local runner. These results are **not** browser frame-rate or MP4 benchmarks.

| Test | V2 | V3 |
|---|---:|---:|
| Truck, 20-second budget | ~27 removed units / 450 | **~35 removed units / 450** after cancellation hardening (31 in earlier prototype) |
| Route candidates (20s) | 61,113 | 63,793 after hardening (44,729 in earlier prototype) |
| Search completion | **No** | **No** |
| Result | `search-budget-exhausted` | `search-budget-exhausted` |
| Full model, 60-second budget | Three unexplained helicopter contact pairs | **Same three** before route search |

The truck shows modest improvement in units reached but **not** a general performance breakthrough: candidate counts can still be high and much work remains. The full-model contact audit takes approximately 30 seconds before failing on parts `4073`, `4349`, and `2462` in the helicopter. This is not a route-budget problem. V3 deliberately does **not** waive those static penetrations or misreport the model as certified.

### Reproduce

Once application dependencies and LDraw data are available:

```bash
npx tsx scripts/diagnose-construction-mpd.ts ./5590.mpd /path/to/ldraw truck ./truck-v2.json --engine=v2 --budget=standard
npx tsx scripts/diagnose-construction-mpd.ts ./5590.mpd /path/to/ldraw truck ./truck-v3.json --engine=v3 --budget=standard
npx tsx scripts/diagnose-construction-mpd.ts ./5590.mpd /path/to/ldraw full ./full-v3.json --engine=v3 --budget=extended
```

The full MPD and required LDraw definitions are intentionally **not** bundled in this source ZIP; use the originals supplied separately.

## Validation performed

- Dependency-free strict TypeScript check: `tsc -p tests/tsconfig.construction.json` — passed.
- TypeScript/TSX syntax check across source, tests, and scripts — passed.
- Standalone integration assertions: spatial-index equivalence to exhaustive swept/rotation boxes; connector-axis/depth priority; overlapping solid rejection; independently rotated-bay planning and compiled poses at 15°, 45°, 90°, 180° — passed.
- Same-geometry LEGO 5590 comparisons: 20-second V2 and V3 truck route search; 60-second full V3 audit — reproduced above.
- Focused automated Vitest tests added in `tests/anim/constructionV3Guided.test.ts` but Vitest execution, full app `npm run build`, interactive UI, and browser MP4 encoding could not be run here because npm dependencies and full browser LDraw assets are not present. **Do not treat syntax-only checks as a successful application build.**

## Outstanding limitations and the next highest-value work

1. **5590 helicopter contacts** `4073`↔`4349`, `4349`↔`2462`, `4073`↔`2462` require genuinely correct snap/interface metadata or measured solid-geometry clearance. They cannot be certified from guessed collision tolerances.
2. Very large models still suffer expensive narrow-phase contact auditing and combinatorial route exploration. A future version needs incremental clearance/constraint search with local provenance and more accurate acceleration of containment/contact classification.
3. Articulated gears, physical hinge articulation, and changing flexible-hose shapes need kinematic/flex-body solvers. The current pre-shaped composite hose representation is a **rigid approximation** and is labeled as such.
4. An exact mesh-swept test is only as physically faithful as the supplied triangle geometry and its manifold/winding consistency. Render-oriented LDraw geometry is not guaranteed to be a solid mechanical CAD representation.

A professional engine must fail clearly when certification is unavailable. **V3 does not guarantee a collision-certified construction for every valid MPD**; the Adaptive option makes visual completion possible when the Standard planner can animate the model, without making a false physical-safety claim.
