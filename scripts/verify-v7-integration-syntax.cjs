/** Syntax-only check for the V7 app modules. Not a typecheck or build. */
require('./syntax-check.cjs')('V7',[
 'src/anim/motion/v6/spatialConstraints.ts',
 'src/anim/motion/v6/spatialSweep.ts',
 'src/anim/motion/v6/spatialRig.ts',
 'src/anim/motion/v6/spatialAdapter.ts',
 'src/anim/motion/v6/spatialMechanicProposal.ts',
 'src/state/mechanismLab.ts',
 'src/ui/SpatialMechanicsDesigner.tsx',
 'src/ui/MechanismLabPanel.tsx',
 'src/ui/Viewport.tsx',
]);
