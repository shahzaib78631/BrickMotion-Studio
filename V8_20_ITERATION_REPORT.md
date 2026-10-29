# BrickMotion Studio V8 — 20 executed engineering iterations

The input baseline is `BrickMotion_Studio_V7_Integrated_Mechanics_Kinematics.zip`.
These are **20 implemented, individually tested work items**, not 20 claims of completed independent physics engines.

## Iterations 1–10: audit, reproduce, correct, retest

| Iteration | Change implemented | Regression |
|---|---|---|
| 01 | Malformed/null spatial constraint records produce diagnostics instead of runtime crashes | `V8-I01` |
| 02 | Validate fixed-body flags and gear/engagement booleans rather than accepting strings or malformed JSON types | `V8-I02` |
| 03 | Reject non-integer, negative, NaN, infinite, and excessive numerical-solver iteration budgets and invalid tolerances | `V8-I03` |
| 04 | Snapshot rig topology at solver creation to prevent accidental external edits; retain legacy *engagement-only* live updates | `V8-I04`, V7 brake regression |
| 05 | Failed solves return the last accepted body pose and joint coordinates, while reporting residuals from the rejected trial | `V8-I05` |
| 06 | Repair nonlinear Cardan/universal-drive angle unwrapping across quadrants and multiple revolutions | `V8-I06` |
| 07 | Deduplicate repeated part identifiers and reject invalid gear tooth counts/overlapping pivots during geometric screening | `V8-I07` |
| 08 | Detect conflicting rigid-cluster part ownership instead of silently reassigning a part to a different cluster | `V8-I08` |
| 09 | Harden spatial-rig import against non-string/oversized files and invalid body/member count | `V8-I09` |
| 10 | Validate swept-motion options and motor containers; run complete V7 regression gate | `V8-I10`, V7 suite |

A further bug was discovered while testing the second phase: a numerical solution could arbitrarily rotate an unpowered gear inside its authored backlash gap. The V8 solver now keeps un-driven shafts near their last accepted pose while allowing motion when a tooth flank is reached. This is a **kinematic continuation preference**, not modeled friction or static torque. A small minimum-change optimization term also stabilizes other underconstrained mechanisms.

## Iterations 11–20: researched mechanical coverage and integration

| Iteration | Mechanic or integration delivered | Regression |
|---|---|---|
| 11 | Offset slider-crank law from exact connecting-rod closure; validate full-rotation rod length | `V8-I11` |
| 12 | Scotch yoke with sinusoidal crank-to-slider displacement and phase | `V8-I12` |
| 13 | Signed-ratio linear slider-to-slider coupling | `V8-I13` |
| 14 | Ideal incompressible hydraulic piston displacement/area coupling | `V8-I14` |
| 15 | Explicit gear backlash/deadband with last-pose continuation | `V8-I15` |
| 16 | Indexed hinge/slider detent locking with engage/release | `V8-I16` |
| 17 | Periodic, sampled, smooth-interpolated variable-lift cam profile | `V8-I17` |
| 18 | Intermittent indexed rotation with dwell and configurable engagement fraction | `V8-I18` |
| 19 | Two independently driven wheel angles coupled to ideal forward travel and yaw | `V8-I19` |
| 20 | Fail-closed sampled spatial pose-clip baking, versioned export, editor integration, fixtures, and CI gate | `V8-I20` |

The nine V8 mechanism families above add to—not replace—the existing V4–V7 types. They are authored in **Mechanisms → V8 mechanical network composer**, solved with the same simultaneous multi-body constraints as the previous spatial engine, and retained in V8 rig JSON. The **Bake sampled V8 pose clip JSON** action exports time-stamped 3D poses for each authored rigid body and a body-to-source-part map.

## Research and mathematical grounding

- [Kinebrick's architecture and mechanism catalog](https://github.com/erik-larsen/kinebrick): part-connection-based kinematics, mechanism categorization, selective grounding, and checking real model functions informed the direction of the upgrade. No Kinebrick source code is incorporated in this implementation.
- [Drake inverse-kinematics reference](https://drake.mit.edu/pydrake/pydrake.multibody.inverse_kinematics.html): keeping kinematic joint, lock and position constraints explicit, with validation of infeasible configurations.
- [Slider-crank and offset linkage derivation](https://symplectomorphism.github.io/teaching/ug_courses/kinematics/chapter04.html): right-branch rod closure under crank rotation and guide offset, with a conservative full-rotation length requirement.
- [MathWorks mobile robot kinematics](https://www.mathworks.com/help/robotics/ug/mobile-robot-kinematics-equations.html): ideal differential-wheel angular increments mapped to forward/yaw changes.

The V8 indexer is an **idealized C1 motion profile with dwell**, not exact Geneva wheel/pin contact. The cam follower assumes the prescribed lift is followed, without simulating return springs. Hydraulic coupling uses displacement-volume conservation without pressure/force, and differential-drive yaw/forward describe body-frame increments rather than integrated world-space curved motion.

## Acceptance summary

- **20/20** targeted V8 iteration regressions passed (`scripts/verify-v8-iterations-offline.cjs`).
- **6/6** additional V8 property tests passed, covering 200 randomized slider-crank geometries, periodicity, indexing, reversible wheel equations, and invalid-rig rejection.
- Legacy V4, V5, V6, V7 offline suites all passed after the edits.
- Dependency-light V8 solver/law/clip typecheck passed using an available TypeScript compiler.
- Syntax checks passed for nine edited TypeScript/React modules.
- Full npm/React/Vite build and interactive browser testing could not be completed because the environment could not download npm packages (`EAI_AGAIN`; `npm ci` failed). CI now runs these when registry access is available.

## Explicitly NOT completed or certified

This work does **not** demonstrate superior real-set accuracy to Kinebrick. V8 still needs large-scale LDraw/LDCad mechanism classification, validated multi-body contact modeling, flexible chain/track/rope constraints, collision-certified *spatial* clips, torque/friction/dynamics, and real LEGO Technic functional benchmarks. JSON motion clips are not automatically rendered through the existing V4 saved-video pipeline; the bridge remains a future engineering task. An isolated ideal mechanism passing a sampled sweep is not evidence that a real assembled LEGO model can move through the entire path.
