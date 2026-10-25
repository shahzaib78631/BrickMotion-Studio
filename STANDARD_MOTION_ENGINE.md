# Standard Motion — part-by-part editable assembler

**Status (v3, mechanics/kinematics revision):** Connection-first visual-preview engine with exact-pivot joint-space swings, axis-locked insertions, conflicting-constraint rejection, time-aware sampled/swept collision review, obstacle-sized detours and editable per-leaf keys. It is not a physics, multi-body IK or mesh-certified collision solver.

## Quick start

1. Set up and start BrickMotion Studio (`npm install`, `npm run setup`, `npm run dev`).
2. Import or create a model, select **Video → Planner → Standard Motion v3 — mechanics + kinematics (editable preview)**.
3. Preview the automatic build in the **Build** workspace. Standard Motion retains Standard staging, group/submodel handling and final transforms but compares connection-first assembly orders before choosing routes.
4. Click **Edit all part keyframes** or select the **Timeline** workspace. Standard Motion automatically bakes an independent track for each valid visible leaf (including leaves inside submodels). This only fills missing tracks and will **never automatically replace a hand-edited track**.
5. Search for a brick or expand a part row in the Dope Sheet. It has a *Location X/Y/Z, Rotation X/Y/Z, Scale X/Y/Z and Visibility* channel, with independent diamond keyframes. Drag frames, correct transforms then use **Review routes** (for generated paths) and **Check motion** (for edited paths) before choosing **Timeline** export for the edited animation.
6. If the new engine reports an **editable fallback**, review the affected trajectories. It still reaches each valid leaf's exact authored destination, but has not proved that the brick can get there physically.

## What it does

- **Independent engine:** `planner: 'standard-motion'` routes through `src/anim/motion/standardMotion.ts`; original Standard (`planner: 'legacy'`) is unchanged. Planner selection survives app settings and saved timeline settings. The new mode is handled in the existing Web Worker and timeline codec (including move pose paths).
- **Mechanical hints:** Matches final world-space LDCad shadow connectors using the existing mechanical-constraint graph. Where the host brick has already landed and a free single leaf can move, the planner proposes **both swing directions** about a hinge/clip pivot or ball-joint tangent, and **both insertion directions** along a stud/pin/axle/cylindrical connector. A keyed axle never receives a fictional screw rotation. Every path starts at the Standard staging pose and ends at the precise authored matrix. If connector metadata is absent or ambiguous, Standard remains available. Joint approaches modify only a free leaf in the main assembly context; temporary workbench submodel motions retain Standard paths instead of incorrectly using final-world connector pivots. Rigid groups remain intact.
- **Mechanics and joint-space kinematics (v3 upgrade):** Compatible hinge/clip approaches use fixed-pivot world revolute motion, ball/socket approaches tilt about the ball centre, and pins/axles/studs/cylinders seat by pure translation along their connector axis. Generated `kinematicSegments` are evaluated continuously as rigid transformations during flight sampling, not as endpoint position/chord interpolation. Rejected degrees of freedom (misaligned hinge barrels, skewed insertions, extra fixed connectors and multiple distinct ball centres) revert conservatively to editable generic paths. Neither angles nor engagement distances are guaranteed physical limits. See [STANDARD_MOTION_V3_MECHANICS_KINEMATICS.md](STANDARD_MOTION_V3_MECHANICS_KINEMATICS.md).
- **Time-aware spatial review (v3 revision):** Bounded spatial indices test the moving part's full bounds against **already assembled bricks, occupied staging positions, and other parts flying at the same time**. Relative motion is tested with continuous linear AABB sweeps between sampled poses, with denser sampling at the corners of multi-pose routes and within real joint-space arcs. Future bricks are *not* incorrectly treated as occupying their eventual destination before arrival. Replanned flights are reindexed so later candidates see their actual chosen paths; all final diagnostics are recomputed after route selection, avoiding obsolete reports. Extremely large bounds are treated as global candidates without allocating millions of cells. These are AABB advisories, not triangle-mesh penetration tests or a guarantee for rotations, mixed-geometry contact or physical assembly.
- **Automatic obstruction avoidance:** When a standard or joint route still has potential interference, the engine offers an overhead path sized to the local obstacle height plus ten face/diagonal approach alternatives whose clearance is based on neighboring part extents, rather than only four small fixed offsets. The lower-interference checked route is selected while keeping the exact authored final matrix. Known mates are discounted **only when seating close to their destination**, not during the full transit through the host. If every candidate is obstructed, the best available preview remains editable and is flagged for review instead of falsely claiming a verified collision-free path. The original Standard, rigid subassembly motions and workbench handling are unchanged.
- **Per-piece reports:** Remaining possible overlaps appear in **Timeline → Review routes** (maximum 200 listed), with the relevant time, unit and possible blockers. Click one to seek to the suspected frames. No zero-warning status guarantees geometric clearance.
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
- `src/anim/motion/kinematicCandidates.ts`: hinge/clip/ball/stud/pin/axle/cylindrical approach alternatives, exact joint-space segment data and obstacle-sized detours; exact end poses.
- `src/anim/motion/jointKinematics.ts`: revolute/prismatic rigid-body FK and conservative locked-constraint filtering.
- `src/anim/motion/routeSelection.ts`: indexed, time-aware installed/staging/in-flight AABB scoring, reindexing and sampled/swept review.
- `src/model/spatialHash.ts`: reusable bounded AABB query for large assemblies, including oversized shapes without unbounded grid allocations.
- `src/anim/motion/autoBake.ts`: native per-leaf keyframe generation without clobbering existing edits.
- `src/anim/bakeBuild.ts`: best-effort affine-frame handling and bounded large-model keyframe generation; normal strict baking remains unchanged.
- `src/App.tsx`, `src/ui/VideoPanel.tsx`, `src/anim/timeline.ts`, state/settings/types: new menu/workspace wiring, serialization and preview stats.
- `tests/anim/standardMotion.test.ts`, `tests/anim/standardMotionJoints.test.ts`, `tests/anim/standardMotionKinematics.test.ts` and `tests/anim/standardMotionRoutes.test.ts`: completeness, bad dependency fallback, codec round trip, independent keyframe channels, connector paths, exact final pose and new time-aware route regressions (simultaneous crossing, staging occupancy, tall wall, host tunneling, final re-audit).

After installing Node dependencies, run:

```bash
npm run typecheck
npm test -- tests/anim/standardMotion.test.ts tests/anim/standardMotionJoints.test.ts tests/anim/standardMotionKinematics.test.ts tests/anim/standardMotionRoutes.test.ts
npm run build
```

The supplied project archive did not contain installed npm dependencies. For this v3 revision, all modified TypeScript files were syntax-checked, and the actual route-scoring/candidate-selection modules were run in a translation-only, mocked-Three offline harness: simultaneous flights, parked staging parts, a tall/wide wall, deliberate host tunneling, and full planner rerouting/final diagnostics passed. These runtime checks do **not** substitute for the real Three.js + Vitest integration suite. The npm registry was unreachable in this environment, so full typecheck, Vitest tests and Vite build have **not** been run; install project dependencies to run those commands locally.

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
replanned, and its motion evaluated against occupied pieces at relevant times
in the *candidate* order. When the connector library is missing, a topology-guided
side-entry path is preferred over a straight drop. Close-to-destination contacts
with a recognized mate may be discounted because a pin/axle must overlap its
socket while it seats. Earlier travel through the host still counts, along with
interference with other occupied pieces and concurrent flights. In the absence of any complete Standard plan,
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

## Applying an updated engine to an existing project

Regenerate the Build plan to use the new path planner. Existing native keyframe
tracks are deliberately preserved and **will not change on their own**. To use
the newly routed motion as editable keys, choose the Timeline's intentional
**Rebake all** operation after saving a backup of any manual keyframe edits
(which rebaking may overwrite). Recheck **Review routes** and **Check motion**.
