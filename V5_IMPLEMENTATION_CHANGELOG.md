# BrickMotion V5 — implementation changelog

This source archive builds directly on the previous enhanced BrickMotion Studio. It retains its existing LDraw and BrickLink Studio `.io` import, construction, keyframe editor, camera, motion V4 verifier and render pipeline. **This is a first incremental implementation, not a completed Kinebrick-equivalent full-mechanism engine.**

## Added and wired into the UI

- `src/anim/motion/v4/transmissionNetwork.ts`: algebraic constraints for spur gears, crossed/uncrossed belts, chains, multi-start worm gears, rack and pinion, screw actuators, differentials, and engageable clutches. Multivariate minimum-change projection preserves exact ratios and fails on contradictions. Dimensioned LDU/radian coordinates and interval joint stops.
- `src/anim/motion/v4/transmissionComposer.ts`: author multiple related transmission edges as a connected network sharing the exact same shaft coordinates. Prevent incompatible joint types/axes and splitting fixed connector clusters; estimate rack travel tangentially to a selected pinion axis.
- `src/anim/motion/v4/mechanismProgram.ts`, `mechanismSolver.ts`: backward-compatible V5 transmission schema and `solveInputs` multi-motor API with closed-loop corrections constrained to the ideal transmission manifold. Optional saved secondary motor curves.
- `src/ui/TransmissionDesigner.tsx`: multi-coupling network builder in the Mechanism Lab; select placed parts, tune ratios, add/remove linkages, preview, store in V4 renderer, export JSON. All authored links are visually labelled unverified.
- `src/ui/MechanismLabPanel.tsx`, `src/ui/Viewport.tsx`, `src/state/mechanismLab.ts`: secondary motor locks, live clutch engagement, accurate live pose invalidation on state changes.
- `src/anim/motion/v4/autoMechanics.ts`: review-only worm, rack, pulley and sprocket suggestions based on part descriptions and proximity.
- `src/anim/motion/v4/mechanismSweep.ts`: round-trip, 49-position sampled kinematic diagnostic for limits, equations and fixed connection separation; JSON export.
- `src/anim/motion/v4/mechanismStage.ts`, `src/anim/timelineData.ts`, `src/ui/VideoPanel.tsx`: V5 stages compile through existing non-destructive playback/collision review, with algebraic residual diagnostics. Additional independent motor sine tracks can be baked with their own amplitudes/cycle counts (maximum 8).

## Validation performed in the packaging environment

- `npm run verify:v5:offline`: **42 passed**, 0 failed. Includes 10 inherited V4 regression checks and 32 focused V5 checks (mathematical transmission checks, multiple driven shafts, differential, shared-shaft networks, rack tangent, stop/closure failures, and stage playback).
- `npm run typecheck:v5:core`: passed strict typecheck for the pure transmission equation and program contract modules.
- TypeScript/TSX syntax was checked by an offline transpiler (not a full React bundle).
- Full `npm run build` and package-based Vitest could **not** be performed because the npm packages were not installed and downloads were unavailable. The complete application is **not** verified to build or run in a real browser in this environment.

## Limits; do not overstate

The solver uses authored mathematical ideal ratios, not automatic whole-set mechanism reconstruction or physical torque/friction dynamics. Worm self-locking, flexible belts/strings/tracks, universal joints, wheel-ground roll, and all dynamic contact remain future work. Functional hints are not proof of mechanical engagement. Sampled kinematic checks cannot replace independent continuous collision review. No head-to-head Kinebrick accuracy benchmarks were run.

See `V5_TRANSMISSION_ENGINE.md` for equations, exact workflows, API shape and the next engineering milestones.
