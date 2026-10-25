/** Dependency-free scene-studio checks for environments without npm packages.
 * Uses a constrained Three MathUtils mock ONLY to test pure scene document maths.
 * Full WebGL/React integration still requires npm ci && npm run build. */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
// esbuild ships with Vite; the `typescript` package here is the native 7.x
// preview, which no longer exposes transpileModule/ModuleKind/ScriptTarget.
const esbuild = require('esbuild');
const source = path.join(__dirname, '../src/render/sceneSetup.ts');
const js = esbuild.transformSync(fs.readFileSync(source, 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'node20', sourcefile: source }).code;
const math = { MathUtils: { clamp: (value, lo, hi) => Math.max(lo, Math.min(hi, value)) } };
// esbuild's CJS output reassigns `module.exports`, so keep the sandbox's module
// object and read the result back from it rather than from a captured `exports`.
const sandbox = { module: { exports: {} }, exports: {}, require: () => math,
  crypto: { randomUUID: () => 'test-uuid' }, Date, Math };
vm.runInNewContext(js, sandbox);
const s = sandbox.module.exports;
let pass = 0;
const check = (description, fn) => { fn(); ++pass; console.log(`PASS: ${description}`); };
check('empty setup retains procedural-camera fallback', () => assert.equal(s.activeSceneCamera(s.sceneSetupOf()), null));
check('reverse drag coordinates are normalized', () => {
  const r = s.regionFromDrag([.7, .8], [.2, .3]);
  assert.ok(Math.abs(r.x - .2) < 1e-9 && Math.abs(r.y - .3) < 1e-9);
});
check('short accidental drags never save', () => assert.equal(s.regionFromDrag([.1, .1], [.101, .102]), null));
check('region respects camera edges', () => {
  const r = s.regionFromDrag([-.7, -.8], [5, 6]);
  assert.equal(r.width, 1); assert.equal(r.height, 1);
});
check('crop keeps output aspect unchanged', () => {
  const r = s.cameraCrop({ x: .75, y: .1, width: .20, height: .5 });
  assert.equal(r.width, r.height);
  assert.ok(r.x + r.width <= 1 && r.y + r.height <= 1);
});
check('portrait camera frame fits viewport', () => {
  const f = s.cameraFrame(960, 540, 9/16);
  assert.ok(f.width > 0 && f.height > 0 && f.x >= 0 && f.y >= 0 && f.y + f.height <= 540);
});
check('landscape camera frame fits viewport', () => {
  const f = s.cameraFrame(540, 960, 16/9);
  assert.ok(f.width > 0 && f.height > 0 && f.x + f.width <= 540);
});
check('removing active camera selects next available camera', () => {
  const doc = { ...s.sceneSetupOf(), cameras: [{id:'a'},{id:'b'}], activeCameraId: 'a', lights: [] };
  assert.equal(s.removeObject(doc,'a').activeCameraId,'b');
});
check('deleting a light preserves current camera ID', () => {
  const doc = { ...s.sceneSetupOf(), cameras: [{id:'a'}], activeCameraId:'a', lights:[{id:'light'}]};
  assert.equal(s.removeObject(doc,'light').activeCameraId,'a');
});
check('only matching instance gets edited', () => {
  const doc = { ...s.sceneSetupOf(), cameras:[{id:'a',name:'A'},{id:'b',name:'B'}], lights:[] };
  const updated=s.updateObject(doc,'b',(p)=>({...p,name:'Close'}));
  assert.equal(updated.cameras[0].name,'A'); assert.equal(updated.cameras[1].name,'Close');
});
check('camera crop invokes Three view offset with consistent fraction', () => {
  for (const aspect of [9/16, 16/9]) {
    const cam = { aspect, clearViewOffset(){ this.clear=true; }, setViewOffset(...args){this.args=args;} };
    s.applyCameraCrop(cam,{...s.sceneSetupOf(),cropToRegion:true,region:{x:.2,y:.2,width:.5,height:.5}});
    assert.ok(Math.abs(cam.args[0]/cam.args[1]-aspect)<1e-9,'crop must keep the actual output aspect');
    assert.ok(Math.abs(cam.args[2]/cam.args[0]-.2)<1e-9);
    assert.ok(Math.abs(cam.args[4]/cam.args[0]-.5)<1e-9);
    assert.ok(Math.abs(cam.args[5]/cam.args[1]-.5)<1e-9);
  }
});
check('legacy projects remain usable without scene setup', () => {
  assert.equal(s.sceneSetupOf(undefined).lights.length,0);
  assert.equal(s.sceneSetupOf(undefined).useCameraForVideo,true);
});
check('scene-production edits do not replan the build or change planner cache fingerprints', () => {
  const hook=fs.readFileSync(path.join(__dirname,'../src/state/useTimeline.ts'),'utf8');
  const service=fs.readFileSync(path.join(__dirname,'../src/state/timelineService.ts'),'utf8');
  assert.match(hook,/key === 'sceneSetup'/);
  assert.match(service,/sceneSetup: _scene/);
});
const files=['src/render/studio.ts','src/render/sceneLights.ts','src/ui/SceneTools.tsx','src/ui/sceneControls.ts',
 'src/ui/sceneViewState.ts','src/ui/Viewport.tsx','src/ui/PreviewPlayer.tsx','src/export/exportVideo.ts','src/plan/schema.ts','src/state/useTimeline.ts','src/state/timelineService.ts'];
for (const rel of files) {
  const file=path.join(__dirname, '..',rel);
  // esbuild fails on the same syntax errors the TypeScript transpile reported,
  // and independently rejects TSX fed to the plain TS loader.
  esbuild.transformSync(fs.readFileSync(file,'utf8'),
    { loader: rel.endsWith('.tsx') ? 'tsx' : 'ts', format: 'esm', target: 'node20', sourcefile: file });
}
console.log(`PASS: ${files.length} integration source files transpile`);
console.log(`TOTAL: ${pass + 1} offline checks passed; full browser build requires dependencies.`);
