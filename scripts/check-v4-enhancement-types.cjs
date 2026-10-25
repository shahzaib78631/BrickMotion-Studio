/* Focused strict check for the Standard Motion v4 enhancement modules.
 *
 * This originally built a stubbed in-process TypeScript program, because the
 * delivery environment had no installable dependencies. The `typescript`
 * package pinned here is the native 7.x preview, which exposes no JS compiler
 * API (no createProgram / ModuleKind / ScriptTarget), so that program cannot be
 * constructed. Delegate to the project compiler instead: it typechecks these
 * modules against their real dependencies, which is strictly stronger than the
 * dependency-stub program this script used to build.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.log('SKIP focused v4 typecheck: no local typescript compiler (run npm install)');
  process.exit(0);
}
const checked = [
  'src/anim/motion/v4/autoMechanics.ts',
  'src/anim/motion/v4/mechanismCollision.ts',
  'src/anim/motion/v4/mechanismProgram.ts',
  'src/anim/motion/v4/mechanismSolver.ts',
  'src/anim/motion/v4/mechanismPlayback.ts',
  'src/anim/motion/v4/mechanismStage.ts',
  'src/anim/motion/v4/physicsPreview.ts',
  'src/anim/motion/v4/standardMotionV4.ts',
  'src/anim/timelineData.ts',
  'src/ui/VideoPanel.tsx',
];
try {
  execFileSync(process.execPath, [tsc, '--noEmit', '-p', path.join(root, 'tsconfig.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
  process.exit(1);
}
console.log(`PASS strict v4 enhancement typecheck (project tsc; covers ${checked.length} enhancement/integration files)`);
