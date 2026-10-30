/** Syntax-only check for the V7 app modules. Not a typecheck or build. */
require('./syntax-check.cjs')('V7',[
 'src/anim/motion/kinematics/spatialModel.ts',
 'src/anim/motion/spatial/spatialSweep.ts',
 'src/anim/motion/spatial/spatialRig.ts',
 'src/anim/motion/spatial/spatialAdapter.ts',
 'src/anim/motion/spatial/spatialMechanicProposal.ts',
 'src/state/mechanismLab.ts',
 'src/ui/SpatialMechanicsDesigner.tsx',
 'src/ui/MechanismLabPanel.tsx',
 'src/ui/Viewport.tsx',
]);
