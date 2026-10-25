# Standard Motion — part-by-part editable assembler

**Status (v3):** Connection-first visual-preview engine with alternative assembly orders, connector-guided routes, sampled collision advisories and editable per-leaf keys. It is not a physics, IK or mesh-certified collision solver.

## Quick start

1. Set up and start BrickMotion Studio (`npm install`, `npm run setup`, `npm run dev`).
2. Import or create a model, select **Video → Planner → Standard Motion v3 — logical connections + editable keys (preview)**.
3. Preview the automatic build in the **Build** workspace. Standard Motion retains Standard staging, group/submodel handling and final transforms but compares connection-first assembly orders before choosing routes.
4. Click **Edit all part keyframes** or select the **Timeline** workspace. Standard Motion automatically bakes an independent track for each valid visible leaf (including leaves inside submodels). This only fills missing tracks and will **never automatically replace a hand-edited track**.
5. Search for a brick or expand a part row in the Dope Sheet. It has a *Location X/Y/Z, Rotation X/Y/Z, Scale X/Y/Z and Visibility* channel, with independent diamond keyframes. Drag frames, correct transforms then use **Review routes** (for generated paths) and **Check motion** (for edited paths) before choosing **Timeline** export for the edited animation.
6. If the new engine reports an **editable fallback**, review the affected trajectories. It still reaches each valid leaf's exact authored destination, but has not proved that the brick can get there physically.

## What it does

- **Independent engine:** `planner: 'standard-motion'` routes through `src/anim/motion/standardMotion.ts`; original Standard (`planner: 'legacy'`) is unchanged. Planner selection survives app settings and saved timeline settings. The new mode is handled in the existing Web Worker and timeline codec (including move pose paths).
- **Mechanical hints:** Matches final world-space LDCad shadow connectors using the existing mechanical-constraint graph. Where the host brick has already landed and a free single leaf can move, the planner proposes **both swing directions** about a hinge/clip pivot or ball-joint tangent, and **both insertion directions** along a stud/pin/axle/cylindrical connector. A keyed axle never receives a fictional screw rotation. Every path starts at the Standard staging pose and ends at the precise authored matrix. If connector metadata is absent or ambiguous, Standard remains available. Joint approaches modify only a free leaf in the main assembly context; temporary workbench submodel motions retain Standard paths instead of incorrectly using final-world connector pivots. Rigid groups remain intact.
- **Sampled spatial review (v2):** A bounded uniform-grid broad phase scores alternative candidate paths against parts installed before each flight. Extremely large part bounds are held as global candidates rather than allocated into millions of cells. It prefers the lower-interference hint; if an ordinary route is obstructed, it also tests four alternative approach directions. The nested temporary-workbench motions are excluded from this final-world occupancy check, since their final-world boxes would be wrong. Other flights are evaluated using sampled part bounds and approximate swept AABBs only, and deliberately discounts final insertion contacts. Unresolved reports are stored per brick (maximum 200 listed) with the relevant time, unit, and possible blockers. Click a report in **Timeline → Review routes** to filter and expand that brick and seek to the suspect frames. The approach does not test mesh triangles, other simultaneously flying pieces, elastic deformation or full mechanical articulation; no zero-warning status guarantees safety.
- **Completeness over certification:** Standard supplies staging, workbenches, and the build; Standard Motion can reorder recognized connected groups before it routes them. Dependency problems that prevent a complete Standard plan use deterministic, individually animated, unverified per-leaf staging paths. A partial Standard result also gets the complete fallback. Invalid/non-finite/singular transforms and duplicate IDs remain errors rather than fabricated poses. Fallback reuses 32 floor cells, delaying reused cells until a previous piece has lifted.
- **Keyframe conversion:** `src/anim/motion/autoBake.ts` uses the existing `bakeBuildFlights` transform and visibility samplers and creates standalone `source: 'baked-flight'` tracks. Native frames sample actual pose animation, then simplify per channel within tolerances. Baked leaves do not need a live generated Build during playback/export. If only some tracks were generated, a linked Build is retained for the remaining parts. All user-authored tracks are preserved. Timeline MP4 export detects baked tracks and reuses the Build camera, so framing follows the assembled model and the configured hero orbit instead of fitting the whole staging floor.
- **Review and export:** All parts require review because neither the basic Standard planner nor the new kinematic hint stage performs full physical collision certification. Joint-modified and failed-route flights carry `uncertified` hints. Timeline's existing broad-phase collision preflight checks manual edits before export.

## Boundaries and safety

- A proposal is **not** a rigid-body dynamics engine, articulated rig/IK solver, gear constraint solver, gravitational simulation or collision certificate. It is a per-part animated assembly preview with connector-guided motion. Coupled mechanisms (gears, linkages, suspension) need hand-edited keys. Sliding, rotating and hinged motion may intersect surrounding geometry and must be visually corrected.
- Pieces with missing library assets use the app's existing placeholders; a corrupt source model or singular transform cannot always be animated reliably. The visual fallback cannot repair missing *geometry* or a broken imported hierarchy.
- Automatic native baking retains resource guards: up to **10,000** total object tracks, **1.5 million** sampled poses and **1.5 million** keyframes per bake; each channel also retains its original safety caps. Scenes still cannot exceed the project's **20,000-frame** editor limit. When hit, the procedural Build preview remains usable; shorten the scene/FPS or split the model and retry. A failed batch does not partially overwrite the project.
- Baking unusual shear or non-rigid transforms may generate best-effort approximate intermediate keys. The status reports these parts for inspection; original final placements remain unchanged in the Build model.

## Source and tests

- `src/anim/motion/standardMotion.ts`: alternate-order planning, installed-part eligibility, candidate scoring, report metadata, incomplete-graph fallback.
- `src/anim/motion/logicalConnections.ts`: scoped connection-hub detection, non-mutating attachment precedence proposals, explicit-dependency protection, candidate sequences.
- `src/anim/motion/kinematicCandidates.ts`: hinge, clip, ball, stud, pin, axle and cylindrical end-effector approach alternatives, exact end poses.
- `src/anim/motion/routeSelection.ts`: installed-brick spatial-indexed sampled broad-phase advisories for candidate ranking.
- `src/model/spatialHash.ts`: reusable bounded AABB query for large assemblies, including oversized shapes without unbounded grid allocations.
- `src/anim/motion/autoBake.ts`: native per-leaf keyframe generation without clobbering existing edits.
- `src/anim/bakeBuild.ts`: best-effort affine-frame handling and bounded large-model keyframe generation; normal strict baking remains unchanged.
- `src/App.tsx`, `src/ui/VideoPanel.tsx`, `src/anim/timeline.ts`, state/settings/types: new menu/workspace wiring, serialization and preview stats.
- `tests/anim/standardMotion.test.ts`, `tests/anim/standardMotionJoints.test.ts` and `tests/anim/standardMotionRoutes.test.ts`: complete coverage, bad dependency fallback, codec round trip, independent keyframe channels and preservation of user keys, connector pivot arc, final pose.

After installing Node dependencies, run:

```bash
npm run typecheck
npm test -- tests/anim/standardMotion.test.ts tests/anim/standardMotionJoints.test.ts tests/anim/standardMotionRoutes.test.ts
npm run build
```

The supplied project archive did not contain installed npm dependencies. The earlier v2 source and tests were TypeScript-syntax checked, and the real motion planner was exercised in offline mocked-Three smoke checks: hinge-guided route selection, a blocked straight path versus clear detour, future-obstacle filtering, and the complete valid-leaf fallback on Standard failure. The oversized spatial-hash path was smoke-tested independently. The npm registry failed DNS resolution here, so the full typecheck, Vitest suite and Vite build have **not** been run. They require `npm install` with working registry access.

## Connection-first ordering (v3)

Standard Motion now plans *which part joins which and in what order* **before**
choosing each flight. If two legs connect to one hips part, it proposes
**leg A → hips → leg B**, **leg B → hips → leg A**, and (if accessible)
**hips → leg A → leg B**. This prevents automatically locking both sides of a
joint before its centre can be installed. The same bridge rule can apply to a
small two-sided mechanical connector hub when typed LDCad joints are available.
Minifigure hips/legs are recognized by part ID without connector downloads.

The proposals operate on cloned assembly nodes, preserve saved explicit
`after`/`attachTo` requirements, and do not modify the Standard engine or
original model. For these selected articulated groups, inferred bounding-box
support edges no longer force both legs underneath the hips. Each proposal is
replanned, and its motion evaluated against parts installed at that point in
the *candidate* order; when the connector library is missing, a topology-guided
side-entry path is preferred over a straight drop. Contacts with the intended
mating part are excluded from that candidate score, because a pin or axle must
overlap its socket while it seats; interference with every other installed
brick still counts. In the absence of any complete Standard plan,
the fully keyed visual fallback also follows the selected host dependencies.

Video, Build Timeline and Keyframe Timeline show the chosen connection order;
route conflicts remain available through **Timeline → Review routes**. This
is a *bounded preview planner*, not a continuous-triangle collision, structural
stability, or full articulating mechanism certificate. Sampled AABB warnings
may be false positives around pins/studs; no warnings is not proof of access.
Explicit user dependencies are authoritative, including when they deliberately
require a less favorable order.

Tests: `tests/anim/standardMotionLogic.test.ts` covers chain detection,
reversed and hub-first proposals, explicit order, nested scopes, exact final
poses, fallbacks, and per-part keyframe coverage.
