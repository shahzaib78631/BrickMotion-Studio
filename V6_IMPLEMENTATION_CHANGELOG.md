# V6 implementation changelog

**Base:** BrickMotion Studio V5 Transmission Upgrade. Existing import, V4/V5 editors, render stages and collision-review code retained.

## Added
- `v6/spatialConstraints.ts`: explicit-ground spatial 6-DOF body constraints, linkage loop correction, multiple joint drives, rank/constraint residual diagnostics and last-successful-state preservation.
- `v6/spatialAdapter.ts`: connector-defined fixed-cluster → movable-body review bridge; no silent component truncation.
- `v6/geometryScreen.ts`: pitch, shaft and bounding-box-geometry-based *screening* for gear, rack, worm, belt and chain candidates with auditable rejection reasons.
- `v6/spatialSweep.ts`: 33-frame sampled forward/reverse linkage-motion diagnostics with bounded failure and JSON export.
- `v6/spatialRig.ts`: defensive, explicit-ground authored rig JSON import/export for models without reliable connector metadata.
- `wheel-ground` coupling in existing `v4/transmissionNetwork.ts`, `transmissionComposer.ts`, `mechanismProgram.ts`, `TransmissionDesigner.tsx`: no-slip straight-line rolling and a chassis-parented wheel; measured radius entered by user.
- `MechanismLabPanel.tsx`, `Viewport.tsx`, `state/mechanismLab.ts`: V6 geometry evidence views, spatial linker, live non-destructive pose preview, sampled sweeps and reviewed JSON interface.
- `scripts/verify-v6-offline.cjs`, `tsconfig.v6.json`: synthetic closed-loop, false-positive, impossible mechanism and JSON validation regression checks.
- A source type hole in the V4 detector-failure fallback was repaired (missing `parts` and `functionalHints`).

## Boundaries
- Spatial V6 cannot yet bake multi-body loops to final video; V4/V5 animation export remains available.
- Wheel rolling is ideal and straight-line. No slip, ground-contact mesh, tyre load or vehicle-turning physics.
- Geometry-screened results are **review required**, not verified contact. Unknown pulley ratios must be authored, not guessed.
- Synthetic offline checks are not full browser/real-set benchmarks. See `V6_SPATIAL_KINEMATICS.md` for architecture and commands.
