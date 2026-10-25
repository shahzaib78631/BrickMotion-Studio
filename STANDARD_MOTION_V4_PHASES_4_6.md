# Standard Motion v4 — Phases 4, 5 and 6

**Scope:** opt-in, post-assembly mechanical demonstration layer built over the existing v4 phases 1–3 (rigid connector graph, continuous assembly-flight mesh checks, and authored joint stops). V3 and all Construction modes are untouched. **Status:** integrated with Standard Motion v4, focused offline numerical checks pass; full npm/Vitest/browser runtime verification is pending because the dependencies were unavailable in the build environment.

## Phase 4 — gear trains, rigid followers, and closed-chain kinematics

Main modules: `src/anim/motion/v4/mechanismProgram.ts`, `mechanismSolver.ts`, `mechanismStage.ts`.

- A mechanism program refers to **exact unique instance keys**, not DAT filenames. Every moving body has one revolute or prismatic joint, a declared world-space axis (and world pivot for revolute motion), optional assembled-space parent, and optional measured signed joint stops. The reference coordinate is the finished/rest assembly and all joint coordinates are zero in the authored rest pose.
- Pairs of parallel shaft joints can be linked by measured/user-supplied gear tooth counts. Externally meshing gears have opposite rotation in a consistently oriented basis, internally meshing gears have the same rotation. Reversed shaft-axis declarations reverse the signed relationship. Consistency of entire connected gear loops is checked; contradictory loops stop the build. Optional pitch module checks shaft separation **both at rest and while a carrier moves**. This does **not** prove correct tooth phases, helix profile, backlash, interference or real manufactured fit.
- Joint ownership is topologically sorted, driving hierarchical rigid transforms. `rigidFollowers` attach further instance bodies to a leader using the exact same world delta. Fixed-connector edges are checked before generating a demonstration; incompatible fixed welds reject a program.
- Closed loops use endpoint-anchor residuals in **LDU** and a damped least-squares continuation solver with limits and an explicit iteration cap. Every closure has its own tolerance; non-closing or overconstrained poses **fail closed**. This is an articulated kinematics solver with one independent driver per program, not a general-purpose gear/physics CAD system. Explicit relation to an unmoving frame is allowed via a fixed body instance.
- No gear, axle, hinge, joint range, centre of mass, or inertial property is silently inferred from an LDraw rendering mesh. A program with invalid evidence or missing instance keys is rejected.

## Phase 5 — optional constrained gravity dynamics

Main module: `src/anim/motion/v4/physicsPreview.ts`.

- `mode:"gravity"` opts in to a **deterministic reduced-coordinate simulation** of the configured articulated mechanism *after* assembly; no loose part falls during the build. Gravity is a 3D acceleration in SI units, positive Y points down in LDraw world space, and 1 LDU is taken as 0.4 mm. Joint displacement remains in radians or LDU. Explicit positive mass is required for **every moving part**, including welded followers; a part's centre of mass can be specified in its local coordinates. Rotational inertia may be supplied, or a box approximation is reported as an approximation.
- Generalized gravitational force and effective inertia are calculated by finite perturbations through the linkage+gear kinematic solver, with damping, optional scalar motor input and a fixed small simulation timestep. Authored stops limit travel; unreachable linkage poses do not masquerade as impact contacts.
- **Not yet included:** arbitrary free rigid-body motion, Rapier, collisions/contact impulses, support forces, restitution, bounce, Coulomb friction, wheel/ground interactions, gyro forces, gear backlash, damping calibration, or full articulated multibody mass-matrix dynamics. This phase implements the scoped constrained-gravity preview, **not** a full rigid-body simulation. There is also a visually controlled but explicitly **nonphysical return-to-rest** at the end of a demonstration, after release simulation.

## Phase 6 — deterministic timeline, viewport, export, editable keys

Main modules: `mechanismPlayback.ts`, `mechanismStage.ts` and integration in `src/anim/timeline.ts`, `timelineData.ts`, `timelineCodec.ts`, `bakeBuild.ts`, `src/ui/VideoPanel.tsx`.

- The compiled post-build stage saves timestamped **world rigid deltas relative to exact authored part transforms**, as plain numeric matrix arrays. The same serialized data is used in viewport playback, codec/worker round trips and keyframe baking, so playback isn't independently regenerated with an unrelated physics solver.
- Translations interpolate linearly and rotations use quaternion slerp instead of interpolating matrix entries. Stage returns the exact identity delta at both endpoints, so final placements remain bit-for-bit authored. Sampling is configurable at 24–120 Hz; the interpolated between-sample pose is **not** a mathematical proof of continuous loop closure or mesh clearance.
- Standard Motion v4 adds the post-build stage before the final hold/outro, expands camera bounds, and allows existing Build → Rebake to create individually editable per-piece location/rotation/scale keyframes. Older v3 generated motions and imported manual tracks are not silently replaced. Save/restore preserves the program in video settings, and cache keys include the program.
- Before exporting a build that includes a stage, the Video panel requests explicit review. Stage `collisionStatus` is always **unverified**. AABB checks over staged/moving/static bodies are **advisories only**, not triangle-mesh collision certificates. Exact mesh checks from phases 1–3 continue applying to assembly flights, not to dynamic coupled mechanisms.

## How to use

1. Select **Video → Planner → Standard Motion v4**.
2. Open **V4 mechanical demonstration**. Paste JSON from `samples/mechanisms/*.example.json`, replacing each placeholder with an actual instance key and adapting to your assembled model's poses. Apply the program.
3. Optionally enter separate explicit v4 joint-limit rules. Generate the Build and inspect the stage diagnostics, clearances and moving parts.
4. If all motion looks acceptable, explicitly acknowledge that the demo mesh sweep is **unverified**, then export. Use the existing *Rebake all* or selected-part baking to create native editable keys. Back up manual keys before rebaking.
5. To turn the feature off, choose **Disable demonstration**. The normal v4 assembly remains unchanged.

### Compact gear-pair example

```json
{
  "mode": "kinematic",
  "duration": 4,
  "sampleHz": 60,
  "joints": [
    {
      "id": "gear-a",
      "body": "GEAR_INSTANCE_A",
      "kind": "revolute",
      "axis": [
        0,
        0,
        1
      ],
      "pivot": [
        0,
        0,
        0
      ]
    },
    {
      "id": "gear-b",
      "body": "GEAR_INSTANCE_B",
      "kind": "revolute",
      "axis": [
        0,
        0,
        1
      ],
      "pivot": [
        8,
        0,
        0
      ]
    }
  ],
  "gears": [
    {
      "a": "gear-a",
      "b": "gear-b",
      "teethA": 8,
      "teethB": 24,
      "mesh": "external",
      "moduleLdu": 0.5,
      "source": "user"
    }
  ],
  "driver": {
    "joint": "gear-a",
    "amplitude": 1.5707963267948966,
    "cycles": 1
  }
}
```

**Coordinates and units:** `axis` is a nonzero signed **world-space LDraw vector**, `pivot` is world LDU, `local` closure anchors and `centreLocal` masses are **local part coordinates**, angular `amplitude`, `releaseAt` and revolute limits are radians, slider values are LDU, `duration` in seconds, `massKg` in kg, `acceleration` in m/s², `inertiaKgM2` in kg·m². `source` on gear/joint metadata documents where the assertion came from; setting it to `verified` is an authored assertion rather than automatic evidence checking.

## 5590 MPD and LDraw part needs

- Supplied 5590 MPD: 1,258 part references and 133 distinct directly used DAT filenames. The minimal library covers all DAT filenames and its underlying primitive/subpart references (4,563 dependencies were resolved during the phases 1–3 audit). **No additional geometry DAT files are required** for this sample.
- To build a *physically meaningful* 5590 mechanical program, we need **per-instance pivot/axis coordinates and rotation ranges** and any verified LDCad snapping/joint metadata not already captured in supplied files. High-priority part families for validating mechanisms are `3403.dat`/`3404.dat` (turntables), `4275b.dat`/`4276b.dat` and `2440.dat` (hinges), `2458.dat` (connector/axle interface), and `3647.dat` (gear-like part). These are **metadata requirements**, not missing geometry.
- Coupled motion of assembled hoses/cables or deformable items (such as the 5590 flexible assemblies) is outside this rigid-link solver. Neither a complete 5590 working-mechanism demo nor a full-model continuous collision certificate is claimed.

## Tests and limitations

```bash
npm ci
npm run test:v4:mechanisms            # Real Vitest / three.js suite
npm run typecheck
npm run build
npm run verify:v4:mechanisms:offline # Lightweight synthetic three.js verifier
npm run verify:v4:offline            # Previous v4 phases 1-3 collision suite
```

New Vitest suite: `tests/anim/standardMotionV4Mechanisms.test.ts`. It checks signed gears, inconsistent gear loops, world pivots, closed linkages, mass+inertia and stops, timeline encoding/playback, final rest, fixed joints and validation; the portable offline script runs a focused subset with a **minimal THREE shim**, not the actual rendering runtime. Full end-to-end browser / LEGO 5590 benchmark, multi-body collision certification, and true free-body physics remain outstanding.

## Upgrade from the earlier phases-1-to-3 archive

The separately delivered patch `Standard_Motion_v4_Phases_4_to_6.patch` is a relative unified diff against the previous phases-1-to-3 project. From the root of that existing `brickmotion-v4` project, run:

```bash
patch -p2 < ../Standard_Motion_v4_Phases_4_to_6.patch
```

The complete `BrickMotion_Standard_Motion_v4_Phases_1_to_6.zip` already includes all changes; it does not need the patch. Keep a copy of your existing project and manually edited keyframes before upgrading. The patch was tested against the previously released v4 archive.

**Engineering rule:** mechanistically inconsistent, non-finite, limit-violating or unknown-data operations must fail with a useful error. Mathematically valid and visually acceptable mechanical animation is **not** automatically a claim of physical clearance or functional fit.


## Subsequent mechanism collision and auto-detection upgrade

The initial phases 4–6 release described post-build collision verdicts as universally `unverified`. That limitation has now been improved: an opt-in mechanism stage is conservatively checked using continuous playback mesh envelopes. It may return **clear**, **blocked** or **unverified**, and incomplete, tightly touching or already-interpenetrating mates remain **unverified**. Automatic, evidence-labelled LDraw/LDCad identification and guarded opt-in mechanism suggestions were also added. See [STANDARD_MOTION_V4_COLLISION_AUTODETECTION.md](STANDARD_MOTION_V4_COLLISION_AUTODETECTION.md) for current details and limits.
