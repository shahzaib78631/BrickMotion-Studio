/** Syntax-only check for the V8 modules. Not a typecheck or browser test. */
require('./syntax-check.cjs')('V8',[
 'src/anim/motion/v6/spatialConstraints.ts',
 'src/anim/motion/v6/spatialSweep.ts',
 'src/anim/motion/v6/spatialAdapter.ts',
 'src/anim/motion/v6/spatialRig.ts',
 'src/anim/motion/v6/geometryScreen.ts',
 'src/anim/motion/v8/mechanismLaws.ts',
 'src/anim/motion/v8/spatialClip.ts',
 'src/ui/SpatialMechanicsDesigner.tsx',
 'src/ui/MechanismLabPanel.tsx',
]);
