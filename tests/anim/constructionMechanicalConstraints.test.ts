import { describe, it, expect } from 'vitest';
import { placeSnap, type CylSnapDef, type Snap } from '../../src/ldraw/shadow';
import { worldSnaps } from '../../src/anim/snapMates';
import { profiledCylinderMate } from '../../src/anim/construction/profiledCylinderMate';
import { buildMechanicalConstraintGraph, explainMissingMechanicalMate } from '../../src/anim/construction/mechanicalConstraintGraph';
import { MeshOracle } from '../../src/anim/construction/collision';
import { modelFromNodes } from '../../src/anim/construction/input';
import { planConstruction } from '../../src/anim/construction/planner';
import type { ANode } from '../../src/model/assemblyTypes';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { V3 } from '../../src/anim/construction/math';

const M=[1,0,0,0,1,0,0,0,1] as const;
const ID = [1,0,0,0,1,0,0,0,1,0,0,0,0,0,0,1];
const def=(gender:'M'|'F',secs:{shape:string;radius:number;length:number}[],offset:V3=[0,0,0]):CylSnapDef=>({kind:'cyl',gender,caps:'one',slide:false,center:false,secs,frames:[{m:[...M],pos:offset}]});
const male=placeSnap(def('M',[{shape:'R',radius:10,length:3},{shape:'R',radius:6,length:4}]),[...M],[0,0,0])[0];
const female=placeSnap(def('F',[{shape:'R',radius:6,length:5}],[0,-3,0]),[...M],[0,0,0])[0];
const single=(snap:Snap,m=ID)=>worldSnaps([snap],m)[0];
const CUBE_VERTS=[[-12,-12,-12],[12,-12,-12],[12,12,-12],[-12,12,-12],[-12,-12,12],[12,-12,12],[12,12,12],[-12,12,12]];
const FACES=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const CUBE=new Float32Array(FACES.flatMap(i=>CUBE_VERTS[i]));
const B={min:[-12,-12,-12] as V3,max:[12,12,12] as V3};
const part=(id:string,x:number):ANode=>({kind:'piece',itemId:id,model:'demo',step:0,order:0,part:id,color:16,grid:false,placeholder:false,body:B,local:{pos:[x,0,0],m:[...M]}});
const metric=(id:string):PartMetrics=>({id,body:B,full:B,footprint:{w:1,d:1},heightPlates:3,mesh:CUBE,placeholder:false,snaps:id==='male'?[male]:[female]});

describe('Construction V3: profile-aware mechanical constraints',()=>{
  it('preserves individual LDCad sections and rejects the oversized shoulder when engaged',()=>{
    expect(male.sections).toEqual([{shape:'R',radius:10,start:0,length:3},{shape:'R',radius:6,start:3,length:4}]);
    expect(profiledCylinderMate(single(male),single(female))?.length).toBeCloseTo(4);
    const bad=placeSnap(def('F',[{shape:'R',radius:6,length:5}],[0,0,0]),[...M],[0,0,0])[0];
    expect(profiledCylinderMate(single(male),single(bad))).toBeNull();
  });
  it('rejects gender, axis-offset and incompatible section shapes',()=>{
    const f=single(female);
    expect(profiledCylinderMate(f,f)).toBeNull();
    expect(profiledCylinderMate(single(male),single(female,[...ID.slice(0,12),5,0,0,1]))).toBeNull();
    const axle=placeSnap(def('F',[{shape:'A',radius:6,length:5}],[0,-3,0]),[...M],[0,0,0])[0];
    expect(profiledCylinderMate(single(male),single(axle))).toBeNull();
  });
  it('accepts LDCad chamfered round edges (_L) on both sides, as on a 3403/3404 turntable',()=>{
    // Turntable ring: plain round for 11 LDU, then a 4 LDU chamfered lip.
    const ring=(gender:'M'|'F')=>placeSnap(def(gender,[{shape:'R',radius:10,length:11},{shape:'_L',radius:11,length:4}]),[...M],[0,0,0])[0];
    expect(profiledCylinderMate(single(ring('M')),single(ring('F')))?.length).toBeCloseTo(15);
    // Still round only: a chamfered lip never fits a cross hole.
    const cross=placeSnap(def('F',[{shape:'A',radius:12,length:15}]),[...M],[0,0,0])[0];
    expect(profiledCylinderMate(single(ring('M')),single(cross))).toBeNull();
  });
  it('transforms connector frames before generating a world-space joint',()=>{
    const turned=[0,0,-1,0,0,1,0,0,1,0,0,0,34,20,-60,1];
    const a=single(male,turned),b=single(female,turned);
    const joined=profiledCylinderMate(a,b);
    expect(joined).not.toBeNull();
    expect(joined!.origin).toEqual([34,17,-60]);
    expect(joined!.length).toBeCloseTo(4);
  });
  it('provides typed graph hints, but cannot authorize an intersection outside the local connector',()=>{
    const model=modelFromNodes([part('male',0),part('female',0)],metric);
    const graph=buildMechanicalConstraintGraph(model);
    expect(graph.joints.length).toBeGreaterThan(0);
    expect(graph.connections.every(c=>c.staticOnly===true)).toBe(true);
    expect(graph.joints[0].engagement).toBeGreaterThan(0);
    const stats={states:0,candidates:0,backtracks:0,meshPairs:0,trianglePairs:0,cacheHits:0,milliseconds:0};
    const oracle=new MeshOracle(model,stats);
    const policy=graph.connections[0];
    expect(oracle.clear(policy.child,policy.parent,[0,0,0],[0,0,0],[0,0,0],policy)).toBe(false);
    expect(()=>planConstruction(model,{algorithm:'guided-v3',maxMilliseconds:4000})).toThrow(/unresolved-final-contact/);
  });
  it('explains why metadata cannot certify off-axis final contacts',()=>{
    const off=part('female',0);off.local.pos=[0,0,0];
    const model=modelFromNodes([part('male',0),off],metric);
    const graph=buildMechanicalConstraintGraph(model);
    expect(explainMissingMechanicalMate(model.parts.get('male')!,model.parts.get('female')!,graph)).toMatch(/Compatible connection metadata/);
  });
});
