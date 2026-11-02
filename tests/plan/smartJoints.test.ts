import { describe, expect, it } from 'vitest';
import { connectorFreedom, detectEditorJoints, guideSelection, rigidModule, solveCut, twistNullspace, type EditorJoint } from '../../src/plan/smartJoints';
import { angularStepForRadius, rotationSweepAngles } from '../../src/plan/rotationSweep';
import type { Snap } from '../../src/ldraw/shadow';
import type { PartMetrics } from '../../src/ldraw/metrics';

const joint = (a:string,b:string,kind:EditorJoint['kind'],pivot:[number,number,number]=[0,0,0],axis:[number,number,number]=[0,1,0]): EditorJoint =>
  ({a,b,kind,pivot,axis,evidence:'ldcad-shadow',mates:1});
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const box={min:[-6,-6,-6] as [number,number,number],max:[6,6,6] as [number,number,number]};
const snap=(gender:'M'|'F',kind:Snap['kind']='cyl',shape='R',placement?:string):Snap=>({
  gender,kind,start:[0,0,0],axis:[0,1,0],length:10,radius:4,shapes:[shape],slide:true,placement,
});
const part=(id:string,s:Snap)=>({id,part:id,world:identity,worldBox:box,s});
const metrics=(parts:ReturnType<typeof part>[]) => (id:string):PartMetrics=>({
  id,body:box,full:box,heightPlates:1,footprint:{w:1,d:1},placeholder:false,snaps:[parts.find(p=>p.id===id)!.s],
} as unknown as PartMetrics);

describe('connected-piece constrained motion',()=>{
  it('solves six unconstrained dimensions before adding any joint',()=>expect(twistNullspace([])).toHaveLength(6));
  it('places an isolated hinge pivot at its real shaft, not at the selection centre',()=>{
    const g=solveCut([joint('a','b','revolute',[12,8,-27],[1,0,0])]);
    expect(g.kind).toBe('revolute');
    expect(Math.hypot(...g.pivot!.map((x,i)=>x-[12,8,-27][i]))).toBeLessThan(1e-6);
    expect(Math.abs(g.axis![0])).toBeCloseTo(1);
  });
  it('two offset parallel revolute contacts form a rigid lock',()=>{
    expect(solveCut([joint('a','b','revolute'),joint('a','c','revolute',[20,0,0])]).kind).toBe('locked');
  });
  it('coaxial bearings at different axial positions preserve one rotational DoF',()=>{
    expect(solveCut([joint('a','b','revolute'),joint('a','c','revolute',[0,14,0])]).kind).toBe('revolute');
  });
  it('one ball is three-dimensional rotation; two spaced balls produce a hinge',()=>{
    expect(solveCut([joint('a','b','ball')]).kind).toBe('ball');
    expect(solveCut([joint('a','b','ball'),joint('a','c','ball',[0,0,30])]).kind).toBe('revolute');
  });
  it('a prismatic constraint and a hinge on the same cut have no common motion',()=>{
    expect(solveCut([joint('a','b','prismatic'),joint('a','c','revolute')]).kind).toBe('locked');
  });
  it('selecting one piece does not silently move its rigid neighbours',()=>{
    const joints=[joint('arm','nut','fixed'),joint('nut','pin','fixed'),joint('pin','base','revolute')];
    const g=guideSelection(['arm'],[],joints);
    expect(g.kind).toBe('locked');
    expect(g.selected).toEqual(['arm']);
    expect(new Set(g.rigidGroup)).toEqual(new Set(['arm','nut','pin']));
    expect(guideSelection(rigidModule(['arm'],joints),[],joints).kind).toBe('revolute');
  });
  it('SNAP_CYL slide=true never automatically grants translation',()=>{
    const a=part('a',snap('M')), b=part('b',snap('F'));
    expect(detectEditorJoints([a,b],metrics([a,b]))[0].kind).toBe('revolute');
  });
  it('SNAP_GEN is only a ball when both ends explicitly permit free placement',()=>{
    expect(connectorFreedom(snap('M','gen','GEN:cyl'),snap('F','gen','GEN:cyl'))).toBe('fixed');
    expect(connectorFreedom(snap('M','gen','GEN:sph','free'),snap('F','gen','GEN:sph','free'))).toBe('ball');
    expect(connectorFreedom(snap('M','gen','GEN:sph','free'),snap('F','gen','GEN:sph'))).toBe('fixed');
    expect(connectorFreedom(snap('M','gen','GEN:box','free'),snap('F','gen','GEN:box','free'))).toBe('fixed');
  });
  it('hard cross axle profiles are locked rather than treated as round bearings',()=>{
    expect(connectorFreedom(snap('M','cyl','A'),snap('F','cyl','A'))).toBe('fixed');
  });
});

describe('bounded collision-path sampling',()=>{
  it('checks the whole snapped 15-degree arc at 5-degree intervals',()=>{
    const steps=rotationSweepAngles(0,Math.PI/12)!;
    expect(steps).toHaveLength(3);
    expect(steps[0]).toBeCloseTo(Math.PI/36);
    expect(steps[2]).toBeCloseTo(Math.PI/12);
  });
  it('correctly samples backwards and does not sample zero motion',()=>{
    expect(rotationSweepAngles(0,0)).toEqual([]);
    expect(rotationSweepAngles(0,-Math.PI/12)!).toHaveLength(3);
    expect(rotationSweepAngles(Math.PI/8,0)!.at(-1)).toBeCloseTo(0);
  });
  it('reduces the angular step for long beams while keeping a 5-degree cap',()=>{
    expect(angularStepForRadius(1)).toBeCloseTo(Math.PI/36);
    expect(angularStepForRadius(30)).toBeLessThan(Math.PI/50);
    const safe=angularStepForRadius(30);
    expect(2*30*Math.sin(safe/2)).toBeLessThanOrEqual(.35000001);
  });
  it('fails closed for unsampled long leaps or invalid values',()=>{
    expect(rotationSweepAngles(0,Math.PI,Math.PI/36,12)).toBeNull();
    expect(rotationSweepAngles(0,Infinity)).toBeNull();
    expect(rotationSweepAngles(0,1,0)).toBeNull();
  });
});
