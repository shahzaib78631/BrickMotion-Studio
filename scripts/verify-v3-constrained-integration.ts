/** Dependency-free Construction V3 integration checks for release gating. */
import { strict as assert } from 'node:assert';
import { authoredStepModules } from '../src/anim/construction/stepModules';
import { planConstruction } from '../src/anim/construction/planner';
import { modelFromNodes } from '../src/anim/construction/input';
import { compileConstruction } from '../src/anim/construction/compile';
import type { V3 } from '../src/anim/construction/math';
import type { ConstructionNode, Connection, Dependency } from '../src/anim/construction/types';
import type { PartMetrics } from '../src/ldraw/metrics';
import type { ANode } from '../src/model/assemblyTypes';
const verts=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const tris=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const mesh=Float32Array.from(tris.flatMap(i=>verts[i]));
const box={min:[-1,-1,-1] as V3,max:[1,1,1] as V3};
const metrics=(id:string):PartMetrics=>({id,body:box,full:box,mesh,footprint:{w:1,d:1},heightPlates:1,placeholder:false,studs:[]});
const basis=[1,0,0,0,1,0,0,0,1] as [number,number,number,number,number,number,number,number,number];
const piece=(id:string,x:number,z:number):ANode=>({kind:'piece',itemId:id,model:'test',step:0,order:0,part:'box',color:16,
  grid:false,placeholder:false,body:box,local:{pos:[x,0,z],m:basis}});
const model=modelFromNodes(Array.from({length:6},(_,i)=>piece(`p${i}`,i*11,i%2*13)),metrics);
for(const experimental of [false,true]) {
  const plan=planConstruction(model,{algorithm:'guided-v3',mechanicalSubassemblies:false,
    enableStepModules:experimental,enableConfigurationDetours:true,maxMilliseconds:7000});
  assert.equal(plan.operations.length,6);
  assert.equal(plan.stats.peakRemovedLeaves,6);
  assert.equal(plan.operations.every(op=>op.check.method==='continuous-triangle-sat'),true);
  const timeline=compileConstruction(plan,{targetSeconds:12,heroOrbit:false});
  assert.equal(timeline.units.length,6);
  assert.ok(timeline.duration>=12);
}
const m=(id:string,step=1,model='test'):ConstructionNode=>({
  id,part:'box',model,step,order:id.charCodeAt(0),matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
  bounds:box,body:box,leaves:[id],
});
const c=(parent:string,child:string):Connection=>({id:`profiled:${parent}:${child}`,parent,child,kind:'mechanical',
  confidence:'inferred',staticOnly:true,outward:[0,-1,0],regions:[{origin:[0,0,0],axis:[0,1,0],radius:6,length:4}]});
const nodes=[m('a'),m('b'),m('c',2),m('d',1,'other')];
const grouped=authoredStepModules(nodes,[c('a','b'),c('b','c'),c('a','d')],[]);
assert.equal(grouped.modules,1,'only same model+step may group');
assert.equal(grouped.members,2);
assert.equal(grouped.nodes.length,3);
assert.ok(grouped.nodes.some(n=>n.leaves.includes('a')&&n.leaves.includes('b')&&!!n.children));
assert.equal(authoredStepModules(nodes,[{...c('a','b'),staticOnly:false}],[]).modules,0);
assert.equal(authoredStepModules(nodes,[c('a','b')],[{parent:'unbuilt',child:'b',reason:'hard'}]).modules,0,
  'external prerequisites of non-root children must not be moved to workbench');
assert.equal(authoredStepModules(nodes,[c('a','b')],[],1).modules,1,
  'module cap is always at least two');
const invalid=modelFromNodes([piece('a',0,0),piece('b',0,0)],metrics);
assert.throws(()=>planConstruction(invalid,{algorithm:'guided-v3',maxMilliseconds:3000}),/unresolved-final-contact|no-supported-rigid-route/);
console.log(JSON.stringify({passed:true,checks:14,smoke:'plan + compile + authored module grouping + collision rejection'}));
