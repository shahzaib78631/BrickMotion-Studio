# V7 implementation changelog

## Core
- `src/anim/motion/v6/spatialConstraints.ts` — expanded spatial joints (cylindrical, universal, planar), mechanical relation union, joint coordinates, multi-revolution continuation, simultaneous nonlinear coupling, spur/internal/bevel and planetary gears, wheel rolling and Ackermann steering, bounded stops/pawl state, clutch, brake, geometry-agnostic validation.
- `src/anim/motion/v6/spatialSweep.ts` — optional secondary drives and one-way permitted-direction sweep, evidence format retained for V6 readers.
- `src/anim/motion/v6/spatialRig.ts` — V7 format v2 export/import, V6 v1 read compatibility, new joint family checks, rig validation.
- `src/anim/motion/v6/spatialMechanicProposal.ts` — strict review-only mapping from geometry-screened candidate part keys to unambiguous spatial joint IDs; narrowed TypeScript guard for bridge safety.
- `src/anim/motion/v6/spatialAdapter.ts` — narrow actual supported driver joints after broadening the spatial constraint union.

## App integration
- `src/ui/SpatialMechanicsDesigner.tsx` — new authoring controls for V7 mechanics and engageable clutch/brake/ratchet toggles.
- `src/ui/MechanismLabPanel.tsx` — network composer, reviewed geometry proposal attachment, independent spatial motor inputs, active rig/sweep export, reset/one-way controls, error messages.
- `src/state/mechanismLab.ts` — secondary motor support for spatial preview mode.
- `src/ui/Viewport.tsx` — pass all author-locked spatial motors to one coupled solver.

## Regression tests and samples
- `scripts/verify-v7-mechanics-offline.cjs` — standalone ideal mechanics and spatial integration checks.
- `samples/mechanisms/gear-fourbar.v7-mechanics-rig.example.json` — gearbox driving a closed four-bar with stops.
- `samples/mechanisms/cam-follower.v7-mechanics-rig.example.json` — cam driving guided slider with limits.
- `samples/mechanisms/vehicle-steering-rolling.v7-mechanics-rig.example.json` — two-input Ackermann steering and ideal straight-line wheel rolling.
- `tsconfig.v7.json` — dependency-light core math typecheck.
- `scripts/verify-v7-integration-syntax.cjs` — syntax AST checks for the modified UI and TypeScript modules (not a full typecheck).
- `V7_MECHANICS_KINEMATICS.md` — user guide, supported formulae, limitations and safety caveats.

## Scope intentionally unchanged
Original V4 collision verification and V4/V5 saved animation mechanisms remain intact. This pass does **not** supply a new collision detector, certified dynamics, real-set auto-recognition benchmark or V7 baked-video exporter.
