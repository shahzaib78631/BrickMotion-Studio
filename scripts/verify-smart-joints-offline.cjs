/* Pure, deterministic robotics/connector verification without npm downloads.
 * Full Vitest + browser build remains required for final release QA. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, transpile, typecheck } = require('./offline-ts.cjs');
const files=['src/ldraw/parse.ts','src/ldraw/attachmentHints.ts','src/ldraw/attachments.ts',
  'src/model/attachmentPlacements.ts','src/anim/snapMates.ts',
  'src/anim/construction/math.ts','src/anim/construction/toleratedFit.ts',
  'src/anim/construction/profiledCylinderMate.ts','src/plan/smartJoints.ts','src/plan/rotationSweep.ts'];
const errors = typecheck(files);
if (errors) { console.error(errors); process.exit(1); }
for (const f of ['src/ui/SelectionCage.ts','src/ui/Viewport.tsx','src/ui/ViewportChrome.tsx','src/state/store.ts',
  'src/state/guard.ts','src/state/editing.ts','tests/plan/smartJoints.test.ts','tests/ui/SelectionCage.test.ts']) transpile(f);
// the modules under test import each other with plain relative specifiers, and
// registering the .ts extension is what lets Node resolve those too
require.extensions['.ts']=(mod,filename)=>mod._compile(transpile(filename),filename);
const {solveCut,detectEditorJoints,guideSelection,analyseSelection,rigidModule,twistNullspace,connectorFreedom}=require('../src/plan/smartJoints.ts');
const {rotationSweepAngles,angularStepForRadius}=require('../src/plan/rotationSweep.ts');
const joint=(a,b,kind,pivot=[0,0,0],axis=[0,1,0])=>({a,b,kind,pivot,axis,mates:1,evidence:'ldcad-shadow'});
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const box={min:[-5,-5,-5],max:[5,5,5]};
const part=(id,shape='R',radius=4,length=10,gender='M')=>({
  id,part:id,world:I,worldBox:box,snap:{kind:'cyl',gender,start:[0,0,0],axis:[0,1,0],length,radius,shapes:[shape],slide:true},
});
const metric=(m)=>({id:m.part,body:box,full:box,placeholder:false,footprint:{w:1,d:1},heightPlates:1,snaps:[m.snap]});
let passed=0;const check=(name,cb)=>{cb();passed++;console.log('  PASS '+name);};
check('free selection has exactly six degrees',()=>assert.equal(twistNullspace([]).length,6));
check('one verified hinge rotates only about its axis',()=>{
  const r=solveCut([joint('a','b','revolute',[3,-9,7],[0,0,1])]);
  assert.equal(r.kind,'revolute');assert.ok(Math.abs(Math.abs(r.axis[2])-1)<1e-7);
  assert.ok(Math.hypot(...r.pivot.map((x,k)=>x-[3,-9,7][k]))<1e-6);
});
check('offset parallel bearings eliminate rotation',()=>assert.equal(solveCut([
  joint('a','b','revolute',[0,0,0],[0,1,0]),joint('a','c','revolute',[10,0,0],[0,1,0])]).kind,'locked'));
check('coaxial spaced bearings preserve one real rotation',()=>assert.equal(solveCut([
  joint('a','b','revolute',[0,0,0],[0,1,0]),joint('a','c','revolute',[0,20,0],[0,1,0])]).kind,'revolute'));
check('two ball joints make a line hinge, not a free ball',()=>{
  const r=solveCut([joint('a','b','ball',[0,0,0]),joint('a','c','ball',[0,0,18])]);
  assert.equal(r.kind,'revolute');assert.ok(Math.abs(Math.abs(r.axis[2])-1)<1e-6);
});
check('three noncollinear ball joints lock the rigid body',()=>assert.equal(solveCut([
  joint('a','b','ball',[0,0,0]),joint('a','c','ball',[0,0,18]),joint('a','d','ball',[8,0,18])]).kind,'locked'));
check('prismatic guide blocks twist, allows linear travel',()=>{
  const r=solveCut([joint('a','b','prismatic',[2,3,4],[1,0,0])]);
  assert.equal(r.kind,'prismatic');assert.ok(Math.abs(Math.abs(r.axis[0])-1)<1e-7);
});
check('mixed incompatible slider and hinge lock',()=>assert.equal(solveCut([
  joint('a','b','prismatic',[0,0,0],[1,0,0]),joint('a','c','revolute',[0,0,0],[1,0,0])]).kind,'locked'));
check('verified cylindrical joint retains slide and rotation',()=>assert.equal(solveCut([
  joint('a','b','cylindrical',[0,0,0],[0,1,0])]).kind,'cylindrical'));
check('rigid selection suggestions never change explicit selection',()=>{
  const g=guideSelection(['a'],[],[joint('a','b','fixed'),joint('b','c','fixed'),joint('c','d','revolute')]);
  assert.equal(g.kind,'locked');assert.deepEqual(g.selected,['a']);assert.deepEqual(new Set(g.rigidGroup),new Set(['a','b','c']));
  assert.equal(guideSelection(g.rigidGroup,[],[joint('a','b','fixed'),joint('b','c','fixed'),joint('c','d','revolute')]).kind,'revolute');
});
check('world shadow mates match aligned round pin/bearing',()=>{
  const a=part('pin'),b=part('hole','R',4,10,'F');
  const p=detectEditorJoints([a,b],id=>metric(id==='pin'?a:b));
  assert.equal(p.length,1);assert.equal(p[0].kind,'revolute');
  assert.equal(analyseSelection([a,b],['pin'],id=>metric(id==='pin'?a:b)).kind,'revolute');
});
check('square/cross axle joints remain nonrotating',()=>{
  const a=part('axle','A'),b=part('socket','A',4,10,'F');
  assert.equal(analyseSelection([a,b],['axle'],id=>metric(id==='axle'?a:b)).kind,'locked');
});
check('SNAP_CYL slide flag alone is not a mechanical slider',()=>{
  const a=part('pin'),b=part('hole','R',4,10,'F');
  const guide=analyseSelection([a,b],['pin'],id=>metric(id==='pin'?a:b));
  assert.equal(guide.kind,'revolute');
});
check('verified type-specific motion override enables slider',()=>{
  const a=part('pin'),b=part('hole','R',4,10,'F');
  const guide=analyseSelection([a,b],['pin'],id=>metric(id==='pin'?a:b),[
    {parts:['pin','hole'],kind:'prismatic',evidence:'verified',note:'Bench-tested straight slider'}]);
  assert.equal(guide.kind,'prismatic');
});
check('missing connectors do not fabricate a joint',()=>{
  const a=part('pin'),b=part('hole','R',4,10,'F');
  assert.equal(analyseSelection([a,b],['pin'],()=>({...metric(a),snaps:[]})).kind,'free');
});
check('generic tyre and rim connector does not imply a ball socket',()=>{
  const a=part('tyre'),b=part('rim','R',4,10,'F');
  a.snap.kind='gen';b.snap.kind='gen';a.snap.shapes=['GEN:cyl'];b.snap.shapes=['GEN:cyl'];
  a.snap.group=b.snap.group='tyre-rim';
  assert.equal(detectEditorJoints([a,b],id=>metric(id==='tyre'?a:b))[0].kind,'fixed');
});
check('explicit freely placed paired generic ball connectors allow socket rotation',()=>{
  const a=part('ball'),b=part('socket','R',4,10,'F');
  a.snap.kind='gen';b.snap.kind='gen';a.snap.shapes=['GEN:sph'];b.snap.shapes=['GEN:sph'];
  a.snap.group=b.snap.group='socket';a.snap.placement=b.snap.placement='free';
  assert.equal(connectorFreedom(a.snap,b.snap),'ball');
});
check('one-sided generic freedom never generates a ball joint',()=>{
  const a=part('ball'),b=part('socket','R',4,10,'F');
  a.snap.kind=b.snap.kind='gen';a.snap.placement='free';
  assert.equal(connectorFreedom(a.snap,b.snap),'fixed');
});
check('a snapped 15 degree hinge turn samples three intermediate poses',()=>{
  const angles=rotationSweepAngles(0,Math.PI/12);
  assert.equal(angles.length,3);
  assert.ok(Math.abs(angles[1]-Math.PI/18)<1e-9);
  assert.ok(Math.abs(angles[2]-Math.PI/12)<1e-9);
});
check('large jumps and invalid sweep input are rejected, never silently skipped',()=>{
  assert.equal(rotationSweepAngles(0,Math.PI),null);
  assert.equal(rotationSweepAngles(0,Infinity),null);
  assert.equal(rotationSweepAngles(0,1,0),null);
  assert.deepEqual(rotationSweepAngles(1,1),[]);
});
check('long beam rotational steps satisfy endpoint chord travel budget',()=>{
  const a=angularStepForRadius(30);
  assert.ok(a<Math.PI/36);
  assert.ok(2*30*Math.sin(a/2)<=.35000001);
  assert.ok(Math.abs(angularStepForRadius(1)-Math.PI/36)<1e-9);
});
console.log(`Smart joint constraints: ${passed} offline regression checks passed.`);
