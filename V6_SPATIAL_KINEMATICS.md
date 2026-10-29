# BrickMotion Studio V6 — Spatial Linkages, Geometry Evidence & Ideal Rolling

This is an **incremental implementation** built on the V5 transmission upgrade and the existing V4 animation/collision pipeline. It is not a general contact-dynamics engine and it has not been benchmarked head-to-head against Kinebrick's LEGO-set corpus.

## Implemented and user-facing

1. **Spatial Linkage Workbench — Mechanisms tab.** Choose a *detected* LDCad hinge/slider edge and explicitly choose which connected part/rigid cluster is ground. The workbench collects the entire connected motion component, groups parts by fixed snap connections, and constructs a bounded spatial constraint model. Invalid/unanchored/oversized components are rejected instead of dropping them silently.
2. **6-DOF rigid-body solver (experimental).** Solve 3 translations (LDU) + 3 rotations (radians) per free rigid body simultaneously. Supported ideal constraints:

   | Constraint | Conditions | Relative free motion before loops / motors |
   |---|---|---|
   | Ball | Coincident 3D anchor points | Three rotations |
   | Hinge | Coincident anchor and aligned shaft axes | One rotation |
   | Slider | Fixed relative orientation and transverse position | One axial translation |
   | Weld | Fixed relative rigid pose | None |
   | Fixed-distance link | Constant separation between body anchors | Five unconstrained directions |

   Loop closure uses a damped, finite-difference Jacobian, bounded steps and deterministic continuation. It can handle two independently driven joints if the constraints permit it. A singularity, contradictory command or excessive residual is **reported as failure**; the last successful solver state is retained. The viewport changes **only GPU part matrices**; no LDraw placements, project plans or keyframes are edited.
3. **33-position forward/reverse linkage sweep.** Run in the workbench and export the diagnostic JSON. Samples `0 → +amplitude → 0 → −amplitude → 0`; reports checked frames, constraint residual, estimated unconstrained DoF, and the first failing input. Sampled kinematics are **not** continuous collision/contact certificates.
4. **Geometry-screened mechanism hypotheses.** Gear, rack, worm, pulley/belt and sprocket/chain proposals are screened against actual assembled part boxes and any known LDCad shaft axes. Checks include axes, pitch-distance corridor, plane separation, rack tangent, relative worm shaft geometry and conflicts within the same fixed cluster. Both accepted **review required** and rejected candidates carry evidence/reasons in Mechanism Lab, JSON, and Graphviz diagnostics. No bounding-box check proves tooth engagement. If pulley/sprocket ratios are unknown, users must supply the effective counts manually (the preview will **not** invent a ratio).
5. **Ideal wheel-ground rolling.** The V5 Transmission Workshop now has `wheel-ground`: a rotating wheel on a translating chassis, with signed no-slip linear displacement `chassis travel = ± wheel radius (LDU) × wheel angle (radians)`. The wheel is parented to the chassis so it translates as well as rotates. This is a flat, straight-line, user-authored constraint—no tyre friction, steering/slip, ground contact detection or suspension physics.
6. **Reviewed spatial rig JSON import/export.** Export an editable spatial rig for a selected detected linkage. If connector metadata is missing, author a rig manually using exact placed instance keys and load it in **Mechanisms → V6 spatial linkage workbench → Import reviewed V6 spatial rig JSON**. The importer validates JSON format, bounds, body/constraint topology, explicit ground, every body-to-part mapping, duplicate membership and closure at rest. It does not edit the model and does not assert the rig's physical correctness.

### JSON spatial rig interchange

The file has this shape:

```json
{
  "format": "brickmotion-v6-spatial-rig",
  "version": 1,
  "model": {
    "bodies": [
      { "id": "frame", "fixed": true, "rest": { "p": [0,0,0], "q": [0,0,0,1] } },
      { "id": "arm", "rest": { "p": [10,0,0], "q": [0,0,0,1] } }
    ],
    "constraints": [{
      "id": "shaft", "kind": "hinge",
      "a": { "body": "frame", "local": [0,0,0] },
      "b": { "body": "arm", "local": [-10,0,0] },
      "axisA": [0,0,1], "axisB": [0,0,1]
    }]
  },
  "members": { "frame": ["placed-leaf-key-frame"], "arm": ["placed-leaf-key-arm"] },
  "driver": "shaft"
}
```

Replace the `members` values with the **exact instance keys** from your actual imported model (shown in the mechanism JSON diagnostic). `rest.p` values are world LDraw coordinates, `rest.q` uses `(x,y,z,w)` unit quaternions, and each constraint anchor is in its owning body's local coordinates. Hinge motor input uses radians; slider motor input uses LDU. The solver does **not** infer an imported JSON rig's truth from file format alone.

Also see [`samples/mechanisms/four-bar.spatial-rig.example.json`](samples/mechanisms/four-bar.spatial-rig.example.json) for a four-body closed-loop mathematical example. Its sample member keys need to be mapped to real imported parts before use in the GUI.

## Architecture / implementation map

| File | Responsibility |
|---|---|
| `src/anim/motion/v6/spatialConstraints.ts` | 6-DOF body model, validation, numerical residual solver, local mobility estimate |
| `src/anim/motion/v6/spatialAdapter.ts` | Rigid-cluster graph bridge to spatial bodies, strictly bounded, review-only |
| `src/anim/motion/v6/spatialSweep.ts` | Round-trip sampled linkage validation and JSON evidence |
| `src/anim/motion/v6/spatialRig.ts` | Editable/validated spatial model import/export |
| `src/anim/motion/v6/geometryScreen.ts` | Geometry-based candidate acceptance/rejection with reasons |
| `src/anim/motion/v4/transmissionComposer.ts` | Existing V5 composer plus wheel-to-moving-chassis topology |
| `src/anim/motion/v4/transmissionNetwork.ts` | Existing algebraic V5 network plus no-slip rolling equation |
| `src/ui/MechanismLabPanel.tsx` | Candidate explorer, linkage workbench, diagnostics, JSON rig interface |
| `src/ui/Viewport.tsx` | Non-destructive V6 spatial body pose preview |
| `src/ui/TransmissionDesigner.tsx` | Wheel rolling authoring fields in the V5 network editor |

## Verification available

After `npm install`, run:

```bash
npm run verify:v4:mechanisms:offline
npm run verify:v5:offline
npm run verify:v6:offline
npm run typecheck:v5:core
npm run typecheck:v6:math
npm run build
```

The offline V6 suite intentionally works with a minimal 3D math stub when `three` is not installed. It tests closed four-bar loops, multiple motors, ball/slider/weld/link constraints, physically impossible motion rejection, rest closure and ground checks, geometry cases, wheel/chassis coupling, graph-adapter limits, reviewed rig import and 33-frame sweeps. It is **not** a browser/video or real-LEGO-set benchmark.

## Honest current limits

- **No automatic full LEGO Technic reconstruction.** LDCad shadows can describe some snaps but do not prove bearings, stops, tooth engagement, ratchets or load transfer. Imported JSON rigs require the author's mechanical review.
- **No nonlinear contacts or flexible-body dynamics.** No wheel slip, nonholonomic arbitrary vehicle paths, deforming belts/tracks, strings, shafts under torsion, force/torque, friction or collision response in V6.
- **No V6 spatial animation bake to saved video yet.** V6 is an interactive GPU viewport preview only. Existing V4/V5 authored mechanisms still go through the saved V4 render pipeline and separate conservative collision review.
- **No continuous collision guarantee for sampled V6 sweeps.** This new evidence is strictly an ideal-constraint diagnostic, and cannot inherit V4 clearance certification without a dedicated spatial animation/staging bridge.
- **No Kinebrick functional pass-rate claim.** The 186-set / 1,224-tagged-function reference corpus would need to be imported and run under matched model, drive, and success criteria before comparing percentages. The included regression suite uses synthetic known mechanisms, not Kinebrick's official-set outcomes.
- **Bounded solver.** Up to 16 bodies mathematically; the automatic UI adapter limits connected components to 13 rigid bodies and 180 placed parts, with at most 42 adapter constraints. Slow or singular large constraints can still fail; reduce to a smaller linkage. Hinge motors are limited to < π absolute rotation per solve and require continuation for longer turns.

## Next research milestones

1. Connector-role/mesh contact metadata for reliable automatic bearing and transmission discovery, with uncertainty propagation.
2. Spatial solver continuation across singularity branches, richer limits, user-authored multi-motor UI and performance profiling on dense linkages.
3. Ground-truth LEGO Technic test set catalog with actual model files and per-function expected motion; track false positives and exact pass/fail results.
4. Nonholonomic vehicle steering and tyre contact plus flexible track/chain/string motion.
5. Spatial animation/keyframe/video bake with the V4 collision reviewer receiving the true multi-body swept geometry.

Kinebrick was used as architectural inspiration (source: https://github.com/erik-larsen/kinebrick and https://github.com/erik-larsen/kinebrick/blob/main/docs/mechanisms/README.md). No code was copied into the new spatial modules; the design and tests here are BrickMotion-specific.
