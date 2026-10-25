import { describe, expect, it } from 'vitest';
import { findCertifiedDetour } from '../../src/anim/construction/configurationSpace';
import { authoredStepModules } from '../../src/anim/construction/stepModules';
import { shiftBox, sweptBox, sub, type V3 } from '../../src/anim/construction/math';
import type { Box } from '../../src/ldraw/flatten';
import type { ConstructionNode, Connection } from '../../src/anim/construction/types';

const moving: Box = {min:[-1,-1,-1],max:[1,1,1]};
const obstacles: Box[] = [
  {min:[3,-3,-4],max:[6,2,8]},
  {min:[5,-3,8],max:[20,2,11]},
  {min:[-3,-3,11],max:[8,2,13]},
];
const start:V3=[0,0,0],target:V3=[15,0,15];
const certified=(a:V3,b:V3) => !obstacles.some(o=>sweptBox(shiftBox(moving,a),o,sub(b,a),-1e-6));
const plan=()=>findCertifiedDetour({start,moving,obstacles,
  scope:{min:[-10,-10,-10],max:[20,2,20]},sky:-8,floor:3,
  clearEdge:certified,complete:at=>certified(at,target)?[target]:null});
const node=(id:string,step=0,model='main'):ConstructionNode=>({id,part:'brick',model,step,order:0,
  matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],bounds:moving,body:moving,leaves:[id]});
const mate:Connection={id:'profiled:a:b',parent:'a',child:'b',kind:'mechanical',confidence:'inferred',
  staticOnly:true,outward:[0,-1,0],regions:[{origin:[0,0,0],axis:[0,1,0],length:4,radius:6}]};

describe('V3 certified constrained translation search',()=>{
  it('finds a multi-turn route without permitting a blocked edge',()=>{
    expect(certified(start,target)).toBe(false);
    const r=plan(); expect(r).not.toBeNull();
    expect(r!.waypoints.length).toBeGreaterThanOrEqual(4);
    for(let i=1;i<r!.waypoints.length;i++)
      expect(certified(r!.waypoints[i-1],r!.waypoints[i])).toBe(true);
    expect(r!.waypoints.at(-1)).toEqual(target);
  });
  it('does not confuse a search limit with a valid route',()=>{
    expect(findCertifiedDetour({start,moving,obstacles,scope:{min:[-10,-10,-10],max:[20,2,20]},
      sky:-8,floor:3,clearEdge:certified,complete:()=>null,maxExpanded:1,maxEdges:1})).toBeNull();
  });
  it('is deterministic for the same collision scene',()=>{
    expect(plan()?.waypoints).toEqual(plan()?.waypoints);
  });
});

describe('V3 authored step modules',()=>{
  it('groups only profiled, connected, same-step instances',()=>{
    const result=authoredStepModules([node('a'),node('b'),node('c',1)],[mate],[]);
    expect(result.modules).toBe(1);
    expect(result.nodes.map(n=>n.leaves)).toContainEqual(['a','b']);
    expect(result.nodes.find(n=>n.leaves.length===2)?.children?.map(n=>n.id)).toEqual(['a','b']);
  });
  it('never groups metadata-less or cross-model contacts',()=>{
    expect(authoredStepModules([node('a'),node('b',0,'other')],[mate],[]).modules).toBe(0);
    expect(authoredStepModules([node('a'),node('b')],[{...mate,staticOnly:false}],[]).modules).toBe(0);
  });
  it('preserves outside prerequisites, rejecting an unsafe grouping',()=>{
    expect(authoredStepModules([node('a'),node('b')],[mate],
      [{parent:'outside',child:'b',reason:'build-step'}]).modules).toBe(0);
  });
});
