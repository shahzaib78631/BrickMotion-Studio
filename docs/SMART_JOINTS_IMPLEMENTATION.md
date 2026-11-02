# Smart Joint Editing + Oriented Selection Cage

**Status:** implemented in BrickMotion Studio's Build editor; compile/smoke-test in a fully installed browser environment before release. Previous **precision attachments** implementation is preserved.

## User experience

1. Click a LEGO part in **Build → Edit**. A thin, bright cyan **oriented bounding cage** surrounds the part even if the transform handles are not active. Multi-selection uses the first selected leaf's local orientation, with bounds projected from every selected leaf's eight *true local-body* corners. The cage is editor-only: no pickable LEGO mesh, no video or export output, and no expensive geometry rebuild during a drag.
2. Activate **Rotate** (ring icon) or **Move** (arrows). The **Joints** toggle is on by default. For a recognized single-axis hinge, the rotation ring is centered on the real connector pivot and aligned to its real shaft, including models displayed at an assembly/work-bay spot. The pivot is marked amber. Drag the ring; rotation snaps to 15°; hold **Shift** to turn continuously. The live readout shows degrees.
3. For an exact relative joint turn, enter an angle in the **Joint** status panel (e.g., `12.5`) and click **+ Turn** / **− Turn**. Numeric turns and ring turns use the same joint axis and collision policy. A negative numeric input is treated as magnitude; use the buttons for direction.
4. A linear joint shows translation **only along its verified axis**, rounded to one LDraw unit (LDU); a cylindrical joint can turn or slide (use the Move/Rotate tools); a ball joint rotates around its socket center; locked cuts hide the transform controls. Unconstrained pieces can use either **World** or **Local** axes.
5. When a piece is rigidly connected to neighbours, **Select rigid module** explicitly expands the selection across fixed connectors. The app never silently moves extra pieces. **Joints** off is the explicit manual override to detach/reposition despite incomplete or incorrect metadata; collision checking is a separate safety toggle.
6. A direct free-moving drag, keyboard nudge, or 90° shortcut no longer sneaks around the constraints: with Smart joints on, those operations select the relevant joint tool instead. Arbitrary programmatic LDraw edits are still possible and are not a physics simulation.

## Research and mechanical model

Sources:

- BrickLink Studio [Rotating and hinging parts](https://studiohelp.bricklink.com/hc/en-us/articles/5411433123351-Rotating-and-hinging-parts) — hinge arrows, yellow pivot markers, rotation circles and unavailable angles when the assembly cannot rotate.
- Three.js [TransformControls](https://threejs.org/docs/pages/TransformControls) — local/world transform space, hide individual axes, rotation snapping and pointer event signals.
- LDCad [LDCad meta specifications](https://www.melkert.net/LDCad/tech/meta) — `SNAP_CYL`, `SNAP_FGR`, `SNAP_CLP`, `SNAP_GEN` and their different matching semantics. `SNAP_GEN` is used for many non-ball connections such as tyres/rims.
- Melkert's [LDCad FAQ](https://www.melkert.net/LDCad/faq) — snapping metadata and part geometry are not a guaranteed physically correct solution in every case; manual placement is still needed.
- Lynch & Park, [Modern Robotics §2.2](https://hades.mech.northwestern.edu/images/7/7f/MR.pdf) — constraints on a 6D rigid-body twist: hinge/prismatic 1 DoF, cylindrical 2 DoF, spherical 3 DoF, fixed 0 DoF.

The model is **relative instantaneous kinematic constraint analysis**, not a contact mechanics simulator. Each candidate connection contributes linear restrictions on a twist vector `q = [wx, wy, wz, vx, vy, vz]`. For a stationary connector at `p`:

```
Fixed:       wx = wy = wz = vx = vy = vz = 0
Ball:        v + (w × p) = 0
Revolute:    v + (w × p) = 0;  w perpendicular to axis = 0
Prismatic:   w = 0;             v perpendicular to axis = 0
Cylindrical: v + (w × p) perpendicular to axis = 0;
             w perpendicular to axis = 0
```

All interfaces crossing the cut between selected and unselected parts are stacked into one constraint matrix. Its **six-column nullspace** determines permissible instantaneous motion. This handles:

- One rotating pin/clip/hinge, and multiple **coaxial** pin contacts retaining one rotational DoF.
- Two **offset** parallel pins locking a rigid component, rather than falsely claiming either pin rotates independently.
- Two spaced ball joints yielding a single hinge axis; three noncollinear ball joints locking a rigid body.
- Independent hinge+slider cuts with no common permitted motion.
- Explicitly reviewed prismatic/cylindrical motion rules without mistaking `SNAP_CYL [slide=true]` (a snap-placement rule) for free physical travel.

The editor deliberately does **not** solve coupled multi-body linkages, deformable beams, cables, gears, motor dynamics or dynamic loop closure during dragging. The existing mechanism engine remains the place for those simulations.

### Trust and connector classification

- Reviewed **nonmirrored** exact placements (e.g. sword 19141/30173 from the earlier implementation) may form fixed assembly relationships. Reflected/unreviewed `!HELP` hints do not grant physical motion.
- `SNAP_GEN` is *not* synonymous with ball joint: only a compatible point/sphere pair with explicit `placement=free` on both definitions is interpreted as spherical; other matched generics default fixed. Tyres/rims cannot spin arbitrarily as a 3D ball.
- Cross/square axles and the standard stud-size friction engagement are treated as fixed unless separately validated; round shaft/hinge contacts can rotate; `SNAP_FGR` and compatible clips are rotational. These are **metadata-based approximations**, not torque or friction measurements.
- Verified custom motion rules can be passed to `analyseSelection(parts, selection, metrics, verifiedRules)`; they must have the exact two part identifiers, `evidence:'verified'`, a human evidence note and one of `revolute`/`prismatic`/`cylindrical`. The built-in app adds **no unverified slider catalog**. No silent geometry-only mating heuristic is activated.
- Missing metadata results in a **free/unclassified** selection with an explicit explanation. Not finding a mate is *not* evidence that parts are disconnected physically.

## Collision-screening and interactive performance

- A **sorted AABB sweep** considers geometrically neighbouring pairs; each part's transformed shadow connections are computed only once during a detection pass.
- The cage is a reusable `LineSegments` geometry with one transform per drag; the pivot marker and axis guide are separate helper primitives.
- A gizmo gesture creates a **stationary collision world once**, keeping the initial overlaps as a baseline. Subsequent samples rebuild only the moving piece's candidate solids. Existing collision semantics are retained.
- For rotation, check not just the final pose but sample positions along the arc. The angular step is at most 5°, additionally bounded so the farthest selected corner travels roughly **≤0.35 stud** from one sample to the next. A live pointer event is limited to **24 samples**; numeric exact turns permit **96 samples**. Oversized jumps fail closed and should be performed incrementally. Collision OFF also disables swept sampling.
- These are **discrete contact samples**, not an exact continuous swept volume. Narrow obstacles can still slip between samples, and results depend on mesh precision and the chosen collision model. True certified continuous collision detection and end-stop/limit metadata are future work.

## Files and tests

| File | Responsibility |
|---|---|
| `src/plan/smartJoints.ts` | Connector matching, mating graph, 6D twist solver, rigid module suggestions, review-gated motion rules |
| `src/plan/rotationSweep.ts` | Deterministic arc subdivision, collision budget and adaptive angle recommendation |
| `src/ui/SelectionCage.ts` | Depth-visible cyan oriented selection box and amber pivot/axis overlay |
| `src/ui/Viewport.tsx` | In-editor transform interaction, displayed spot frame correctness, drag gating, exact degrees and collision probes |
| `src/ui/ViewportChrome.tsx` | Joints & World/Local controls; explicit rigid-module selection |
| `src/state/store.ts` | Editor-only Smart joints and transform-space controls |
| `src/state/editing.ts` | Prevent keyboard/move commands from bypassing joint awareness |
| `src/state/guard.ts` | Memoized stationary collision probe for sampled arcs |
| `src/ui/app.css` | Joint metadata HUD and exact-angle controls |
| `scripts/verify-smart-joints-offline.cjs` | No-npm TypeScript pure-module check plus 21 native Node tests |
| `tests/plan/smartJoints.test.ts`, `tests/ui/SelectionCage.test.ts`, `tests/state/guard.test.ts` | Vitest suites for DoF, OBB, arc sampling and cached collision equivalence |

Run:

```sh
npm run verify:smart-joints:offline  # works without installed project dependencies if global tsc available
npm run verify:attachments:offline   # existing 19141 precision attachments
npm ci
npm run test:smart-joints            # needs node_modules and the LDraw test assets
npm run typecheck
npm run build
```

**QA status:** The native offline solver checks and legacy offline suites are tracked in the delivery response. Full app type checking, Vite build and real-browser interaction tests require npm dependencies, which were not present in the editing environment. Do not describe offline syntax checks as successful browser tests.

## Limitations & next steps

- Do not assume an LDCad snap defines collision-free mechanics, freedom from clutch friction, part legality or bending strength.
- Single-stud and other ambiguous rotating/friction joints remain conservative; verify them in a curated catalog rather than fabricating movement.
- Multi-body articulated movements need a component-level joint graph, grounded-body selection, forward/inverse kinematics, closed-loop solving and real joint limits. These are distinct from the current **selected rigid-body vs stationary environment** solver.
- For LEGO Studio parity or superiority, benchmark a maintained physical compatibility set (part revisions, axle/clip/ball variants, valid and invalid placements, speed, UI usability), and continuously inspect false-positive/false-negative classifications. No such broad benchmark has yet been run.
