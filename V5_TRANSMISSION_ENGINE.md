# BrickMotion Studio V5 — Transmission network & Mechanism Lab

This is an incremental upgrade to the existing standard-motion V4 / Mechanism Lab stack. It is *inspired by* Kinebrick's mechanism catalogue, constraint-first approach and model-level functional analysis, but implements its own small, explicit algebraic transmission layer. **It is not a port of Kinebrick's generalized full-body solver.** It does not claim to outperform Kinebrick's verified real-set motion coverage.

Sources studied:
- https://github.com/erik-larsen/kinebrick
- https://github.com/erik-larsen/kinebrick/blob/main/ARCHITECTURE.md
- https://github.com/erik-larsen/kinebrick/blob/main/docs/mechanisms/README.md

## Delivered

1. **V5 transmission constraints** (`src/anim/motion/v4/mechanismProgram.ts`, `transmissionNetwork.ts`). Supports authored external spur gear, uncrossed/crossed belt, chain, multi-start worm gear, rack-and-pinion, screw/linear actuator, open differential, and switchable clutch constraints. These are relative to the initial assembled model. Values are rotational radians and LDraw units (LDU). Relative orientations are set by the authored axes/direction flags; no actual tooth contact is assumed.
2. **Generalized multi-input kinematics** (`mechanismSolver.ts`). The existing V4 gear groups and FK/IK solver remain supported. V5 constraints are reduced into independent V4 gear-group coordinates. A rank-aware orthogonal projection keeps exact algebraic equations, rejects contradictory loops, checks physical joint stop intervals, and minimizes changes from the last valid pose when underdetermined. `solveInputs({ jointID: position, ... }, {engagements?: { clutchID: boolean }})` permits independently driven joint coordinates. The ordinary `solve(position)` and export pipeline remain backwards-compatible.
3. **Interactive multi-link Transmission Workshop** (`src/ui/TransmissionDesigner.tsx`, `transmissionComposer.ts`). Select actual placed model instances, choose coupling type, enter teeth/lead/radius, and **add multiple couplings into one authored network** (up to 64 couplings / 32 distinct moving shaft coordinates). A part selected in more than one coupling shares one joint coordinate, enabling chains of transmissions, gearboxes feeding differentials, and coupling branches. Preview the complete network, remove edges, save to the V4 render planner, or export JSON. Rigidly connected followers move together where the graph is small enough. Same-cluster opposing shafts, mixed sliding/rotating roles, inconsistent axes, and contradictory driven networks are rejected. Rack translation uses an explicitly unverified tangent estimate from the pinion axis and rack placement.
4. **Live secondary-motor and clutch controls** (`src/state/mechanismLab.ts`, `src/ui/MechanismLabPanel.tsx`, `src/ui/Viewport.tsx`). Secondary drives are *optional* locks, not assumed motor powers. Engaging conflicting motors causes a visible solver error; a clutch may be toggled during live inspection. Nonzero live secondary motor settings can also become independent periodic animation tracks when sent to the render planner. No source LDraw matrices are modified.
5. **Mechanism-family hints** (`autoMechanics.ts`). Adds conservative review-only proximity hypotheses for worm+gear, gear+rack, pulley pairs and chain sprockets. Hints are explicitly labelled `part-description-proximity`, never silently promoted to trusted joint connections or certified gear meshes. Selecting one preloads its parts into the Transmission Workshop.
6. **49-position kinematic sweep and exports** (`mechanismSweep.ts`). Checks the authored program from zero to +amplitude to zero to -amplitude to zero for joint-stop violations, algebraic transmission consistency, sampled loop closure, legacy gear centre separation, and fixed-connector ownership. Reports `sampled-pass` or `sampled-fail`, the first failing driver coordinate, numerical residuals, sampled travel ranges, and an intentionally qualified DOF estimate. Exports as JSON.
7. **Saved video integration and diagnostics** (`mechanismStage.ts`, `timelineData.ts`, `VideoPanel.tsx`, `BuildTimeline.tsx`). Existing Stage Compiler encodes the V5 poses in the same non-destructive timeline representation and passes output to the old continuous collision certifier. Diagnostics distinguish `gearPairs` (legacy) from `transmissionConstraints` (V5). The stage compiler now accepts up to 8 **independent secondary sinusoidal motors**, each with amplitude and integer cycle count, and validates every saved frame against the same algebraic constraints. The Mechanism Lab render action transfers nonzero locked secondary-motor values as one-cycle amplitudes. The primary motor plus any secondary tracks must be mutually compatible. Arbitrary user-keyed motor curves and phase offsets are not yet supported.

## Fundamental equations

All coordinates are *displacements* from the initial assembled pose (not absolute wheel phases). Every equation is homogeneous and idealized:

| Mechanism | Constraint |
|---|---|
| External gear | `teethB*qB + teethA*qA = 0` |
| Normal belt / chain | `teethB*qB - teethA*qA = 0` |
| Crossed belt | `teethB*qB + teethA*qA = 0` |
| Worm gear | `wheelTeeth*qWheel - starts*qWorm = 0` (direction flag reverses sign) |
| Rack and pinion | `slideLDU - pitchRadiusLDU*rotationRad = 0` |
| Screw actuator | `slideLDU - leadLduPerTurn*rotationRad/(2*pi) = 0` |
| Open differential | `qLeft + qRight - 2*qCarrier = 0` |
| Engaged clutch | `qB - qA = 0` (optional reverse); disengaged: no coupling equation |

The solver reduces these into existing V4 gear-group roots, then uses modified Gram-Schmidt with reorthogonalization to identify independent constraints, detect contradictory redundant equations and project the previous valid state onto the feasible affine subspace. A bounded active set enforces joint limits. Nonlinear loop-closure IK projects each candidate step back into the transmission manifold. The model's original source transforms remain immutable.

## User workflow

1. In the project directory, run `npm install`, `npm run setup`, `npm run dev`.
2. Import `.ldr` / `.mpd` / Studio `.io` (the previously delivered importer is retained).
3. Open **Mechanisms** in the left rail. Review detected meshes and weak functional hints.
4. Expand **Transmission workshop · V5 authoring**. Select the input/output (and for a differential, third) instance, axis and relevant ratio or lead. Click **Add coupling to network** repeatedly to build a multi-part mechanical system; shared selected parts reuse the same shaft. A single coupling can also be previewed without adding it.
5. Press **Preview network** (or **Preview coupling** with no queued network). Scrub the primary motor. For multi-input tests, expand **Independent motor controls** under the live driver and lock additional joint positions. Toggle clutch engagement if applicable. With nonzero secondary positions, **Use as V4 render demo** bakes those settings into compatible secondary periodic motor tracks.
6. Press **Run 49-sample sweep** to diagnose sampling errors. Export the diagnostic JSON for reproducibility. This is *not* a collision certificate.
7. Press **Use as V4 render demo** or **Save V4 demo**, then run the Standard Motion V4 pipeline for its separate continuous-mesh collision review.

### Sample V5 mechanism program

```json
{
  "mode": "kinematic", "duration": 3, "sampleHz": 60,
  "joints": [
    {"id":"pinion","body":"model/pinion-instance","kind":"revolute","axis":[0,0,1],"pivot":[0,0,0]},
    {"id":"rack","body":"model/rack-instance","kind":"prismatic","axis":[1,0,0]}
  ],
  "transmissions": [
    {"id":"mesh-1","kind":"rack-pinion","a":"pinion","b":"rack","pitchRadiusLdu":10,"source":"user"}
  ],
  "driver":{"joint":"pinion","amplitude":0.3}
}
```

`model/...` instance keys and world pivots above are illustrative; replace them with actual keys and measured world-space centres. The workshop generates these using the loaded model.

## Verification

```bash
npm run verify:v5:offline
npm run typecheck:v5:core
npm run test:v5:kinematics  # requires installed npm deps
npm run build               # requires installed npm deps
```

The bundled offline verifier uses a deliberately small matrix/vector stub. It tests mathematical invariants, not WebGL, actual Three.js rendering, collisions or the full React app. The complete suite/build could not be run in the packaging environment because npm dependencies could not be retrieved. **Do not describe the full build as validated.**

## Known gaps / next engineering priorities

- Automatic joint and rigid-body recognition for a real whole Technic set remains substantially less comprehensive than Kinebrick's LDCad connector/part-role system. Workshop hints do not replace robust topology discovery.
- Axes and relative directions for authored rack/worm/belt connections are not yet checked for geometric engagement, physical mount compatibility or motion-induced detachment. The existing V4 collision verifier supplies independent path clearance evidence but does not certify an inferred tooth mesh.
- V5 relationships are ideal, zero-offset, non-slipping. No backlash, tyre-ground constraints, track/string paths, universal joint angular-speed effects, clutches slipping under load, contact forces or force-based self-locking.
- The open differential does not include torque distribution or differential carrier geometry. Saved secondary motor playback supports sinusoidal amplitudes and integer cycles, not arbitrary per-motor keyframes or real motor speed/torque curves. The sweep diagnostic tests only the primary motor; the stage compiler separately validates multiple motors along its sampled render timeline.
- Bound projection uses a limited active-set strategy (best for modest constrained joints), not a guaranteed global solution for arbitrary large inequality networks.
- This release does **not** claim a measurable accuracy or speed advantage over Kinebrick without running exactly the same official-set test corpus.

Next steps: (1) connector/role-aware component decomposition; (2) geometry-qualified rack/bevel/worm tooth and gear meshes; (3) multi-body 6DOF constraint solver and verified closed-loop linkages; (4) flexible path, universal joint, ground and rolling constraints; (5) real LEGO set golden-motion corpus / Kinebrick-style functional accuracy dashboards; (6) physical dynamics and live swept-collision integration. Only after benchmarking can we quantify comparative improvement.
