# Standard Motion v4 — phases 1–3 implementation

**Release scope:** independent Standard Motion v4 planner; inherits Standard Motion v3 sequencing, staging, connector-guided candidate generation, continuous fixed-pivot hinge/ball approaches, axial insertion, and editable per-part baked keyframes. Standard Motion v3 and the Construction planners remain selectable.

This release implements three *engineering subsystems* and integrates them into the video planner, while retaining explicit unverified outcomes rather than pretending unsupported motions are certified. It is **not a rigid-body dynamics simulator or a CAD-grade geometric theorem prover**. Real-world clearance, tolerances, compliant snaps, missing mechanical metadata, and coupled-linkage feasibility may remain unresolved.

## Phase 1 — mechanical constraint graph

**Module:** `src/anim/motion/v4/mechanismGraph.ts`

- Ingests LDCad Shadow Library `MechanicalJoint` observations in world coordinates.
- Discards malformed axes/centres or orphaned endpoint references.
- Records typed connections with provenance (`ldcad-shadow`), normalized joint axes, centres, and directed instance keys.
- Groups leaves connected by explicitly fixed joints using union-find, without conflating a fixed connector with an already-moving preassembled animation cluster.
- Checks whether a proposed pivot/slider motion is compatible with all *installed, engaged* joints, including aligned multiple hinges and conflicting crossings.
- Rejects kinematic candidates if their claimed pivot/axis is inconsistent with the matched connector.
- Reports unmatched bodies as **unknown**, not freely articulated.

**Boundary:** A matching connector hint is not proof of a legal physical fit, load path, real clutch, joint stop, or working multi-body inverse kinematics. Closed chains and gears are reserved for later phases. Inferred fixed clusters are used for mobility analysis; v4 does not yet re-animate a whole closed rigid cluster as one articulated body.

## Phase 2 — time-aware continuous mesh verification

**Module:** `src/anim/motion/v4/meshCertifier.ts`

Every animated moving leaf is checked against **installed**, **staged/parked**, and **simultaneously flying** parts. For each occupied interval, v4 separates route candidates into:

- `clear`: Continuous conservative swept envelopes do not overlap, **or** an appropriate existing triangle-mesh narrow-phase proof clears a straight translation or a supported fixed-pivot arc against a stationary obstacle. AABB checks alone can only *prove separation*; overlap cannot be accepted on sampled negatives.
- `blocked`: An actual narrow-phase triangle/solid intersection is witnessed at a sampled pose inside a potentially intersecting interval. V4 then seeks an alternative route.
- `unverified`: Safe motion cannot be demonstrated with the available data, an unsupported path family is used, a mesh or timeline track is missing, a fixed/rigid subassembly relationship is unresolved, contacts at connector seating are ambiguous, or a work budget runs out. This result is **never silently promoted to clear**.

Specific safeguards:

1. Fully continuous AABB bounds for corner arcs use analytical angular extrema, not a few keyframes.
2. Straight translation versus a truly stationary triangle mesh reuses Construction's continuous SAT/containment checker.
3. Hinge arcs use the conservative triangle-arc checker with correctly transformed non-origin world pivots. A late-arc triangle-culling shortcut in the shared oracle was removed because it could omit an intermediate hit.
4. Rotating generic visual flights get a conservative shape-preserving bounding-sphere enclosure instead of a false swept-translation proof.
5. Pairs of concurrently animated bodies are recursively time-subdivided and either proven separated or left unresolved; a midpoint collision is a blocker witness, not a clearance certificate.
6. Numerical rounding allowance, finite-transform checks, per-flight work budgets, and bounded pair-cache memory prevent accidental clearance certification from malformed input or exhausted shared resources.
7. Final selected trajectories are rechecked together, so correcting an earlier path can expose newly conflicting later motion.
8. In Video, exporting v4 Build motion with unresolved or blocked routes requires explicit acknowledgement. Route statuses and example blocker keys are available in Timeline → Review routes.

**Safety policy:** v4 can **render** unresolved routes as editable previews but does not label them physically safe. Contact tolerance for the inherited mesh SAT checker is approximately **0.02 LDraw units**. LDraw meshes are rendering surfaces, not watertight manufactured solids, and not every curved/simultaneous contact admits a finite exact certificate. In particular, mesh-based clearance is not proof of true mechanical assembly fit or of zero interpenetration under all tolerances.

## Phase 3 — signed joint limits

**Module:** `src/anim/motion/v4/jointLimits.ts`

- Validates actual user-provided or externally verified limits. No default 90° hinge or arbitrary slider travel is invented.
- Takes signed bounds in **radians** for revolute motion and **LDraw units (LDU)** for prismatic motion, referenced to **assembled pose = joint coordinate zero**.
- Matches a rule to its **exact moving and installed host instance keys**, optionally restricting by connector type. Overlapping/contradictory selectors are rejected.
- For connector-constrained final-approach segments, computes joint travel, rejects incompatible motions, and **reconstructs all affected waypoint transforms with forward kinematics** if the opening needs to be reduced. It never independently clamps orientation and position to inconsistent values.
- Preserves the exact final authored placement; checks every joint-space segment lies within the provided bounds; persists rules in Video settings and includes them in the timeline cache key.
- Keeps limit-check coverage and adjusted/rejected candidate counts in `timeline.motion.v4.limits`.

Example UI input (**illustrative keys and dimensions — replace these with actual instance keys and manufacturer-authorized limits**):

```json
[
  {
    "moving": "moving-piece-instance-key",
    "host": "installed-host-instance-key",
    "type": "hinge",
    "kind": "revolute",
    "min": -1.0471975511965976,
    "max": 0,
    "source": "user"
  }
]
```

Save under **Video → Planner → Standard Motion v4 → V4 joint limits → Apply joint limits**. The signed interval has to include zero. Rules are applied to the *connector-controlled final seating phase*, not unrelated free-air staging motion or a hypothetical postassembly physics simulation. If a joint lacks reliable measured stops, keep its limits unknown rather than guessing. Because render geometries and Shadow metadata lack part-specific joint stops, no 5590 physical stop values are prefilled.

## Files and integration

| Area | Changes |
| --- | --- |
| Motion system | `src/anim/motion/v4/{mechanismGraph,jointLimits,meshCertifier,standardMotionV4}.ts` |
| Shared continuous mesh oracle | `src/anim/construction/collision.ts`: remove unsound late-arc triangle culling |
| Planner selection | `src/anim/timeline.ts`, `src/anim/pacing.ts`, `src/anim/motion/standardMotion.ts` |
| Saved options/cache | `src/state/{appSettings,timelineService}.ts`, `src/storage/settings.ts` |
| Timeline/status | `src/anim/timelineData.ts`, `src/ui/{VideoPanel,BuildTimeline,KeyframeTimeline}.tsx` |
| Regression tests | `tests/anim/standardMotionV4.test.ts`; `scripts/verify-v4-offline.cjs` |

## Included LEGO 5590 fixture and LDraw request

Original user-supplied MPD: `samples/5590_-_whirl_n_wheel_super_truck.mpd`. The minimal LDraw library is supplied both as `samples/5590-minimal-ldraw.zip` and already unpacked into `public/ldraw/`. `public/data/ldcad-shadow.json` was generated from the bundled LDCad Shadow Library, licensed CC BY-SA 4.0 with its attribution in the JSON. This allows geometry and available connector metadata to be loaded without running the network-dependent LDraw setup for this particular model.

Audit: **1,258 DAT part instances**, **133 unique directly used DAT filenames**; **0 missing directly used DAT files** and **0 unresolved references across 4,563 internal DAT/primitive/subfile references** in the supplied library. The bundled LDCad Shadow Library has **no direct shadow file for 42 of those 133 DAT names (562 model instances)**. This does **not** prove that their snap metadata is missing: many derive snaps from included primitives or child parts. See `samples/5590-ldraw-audit.json`.

**What would improve the physical result:**

- Part-specific, measured hinge/turntable angular stops for `3403.dat`/`3404.dat`, `4275b.dat`/`4276b.dat`, and `2440.dat` if these joints are intentionally articulated.
- Any additional LDCad `!LDCAD SNAP_*` connector definitions for mechanically important parts that are still unmatched after inherited snaps are resolved, notably `2458.dat`; these are `.dat` **metadata** files, not replacement LDraw geometry. Some direct shadow entries are absent for `3647.dat` (8-tooth gear) and `2696.dat` (tyre), which matter for future mechanical gear/wheel simulation rather than phase 3 limits.
- Verified axle/slider insertion stops and the relevant instance pairs, if particular mechanisms cannot slide freely along the nominal axis. `3708.dat` geometry itself does not define the stop range of an entire assembled linkage.

**No additional ordinary LDraw DAT geometry files are required for 5590 as supplied.** New gear teeth, mesh constraints, rack motion, mass, friction, gravity, coupled linkages and dynamic joint motors are **not** included in these three phases.

## Install and verify

Requires Node.js 22+; run `npm ci` on a machine with access to npm and then `npm run dev`. Import the included MPD from the samples folder, choose **Standard Motion v4** in the Video panel, and regenerate Build. Re-bake generated keyframes when you want the v4 routes transferred to edited Timeline tracks (make a copy of manually altered tracks first).

When dependencies are installed:

```bash
npm run typecheck
npm run test:v4
npm run verify:v4:offline
npm run build
```

**Validation performed in this delivery environment:** focused offline TypeScript-transpiled numerical and geometry checks passed for graph mobility, signed joint limits, analytical hinge envelopes, continuous triangle sweeps, parked pieces, concurrent motion, missing meshes, translated hinge pivots, and the v4 planner's alternative-route selection. Previous v3 hinge/playback/worker-codec and path-regression checks also passed. The new Vitest source is included and syntax transpiled. **A complete application TypeScript typecheck, Vitest suite, browser export run, or full 5590 runtime planning benchmark could not be performed** because Node dependencies were not available to install here. Those checks should be completed in a dependency-enabled environment before production use.


## Subsequent phases

Phases 4–6 are implemented as optional post-assembly mechanisms; see [STANDARD_MOTION_V4_PHASES_4_6.md](STANDARD_MOTION_V4_PHASES_4_6.md). Earlier phase-1-to-3 collision certification continues to cover assembly flights, not post-assembly gear/linkage/gravity motion, whose collision status remains unverified.
