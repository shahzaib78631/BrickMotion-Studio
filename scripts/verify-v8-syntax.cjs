/** Syntax-only check for the V8 modules. Not a typecheck or browser test. */
require('./syntax-check.cjs')('V8',[
 'src/anim/motion/kinematics/spatialModel.ts',
 'src/anim/motion/spatial/spatialSweep.ts',
 'src/anim/motion/spatial/spatialAdapter.ts',
 'src/anim/motion/spatial/spatialRig.ts',
 'src/anim/motion/spatial/geometryScreen.ts',
 'src/anim/motion/v8/mechanismLaws.ts',
 'src/anim/motion/v8/spatialClip.ts',
 'src/ui/SpatialMechanicsDesigner.tsx',
 'src/ui/MechanismLabPanel.tsx',
]);
