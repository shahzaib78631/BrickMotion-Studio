import { describe, it, expect } from 'vitest';
import { ScopeSceneIndex } from '../../src/anim/construction/sceneIndex';
import { guidedDirections, nearDistances, farExits } from '../../src/anim/construction/nearFar';
import { overlaps, sweptBox, identity, rigidDelta, centre, point } from '../../src/anim/construction/math';
import { stagedBounds } from '../../src/anim/construction/rigidStaging';
import { modelFromNodes } from '../../src/anim/construction/input';
import { planConstruction } from '../../src/anim/construction/planner';
import { ConstructionError } from '../../src/anim/construction/types';
import { compileConstruction } from '../../src/anim/construction/compile';
import type { ConstructionNode } from '../../src/anim/construction/types';
import type { ANode } from '../../src/model/assemblyTypes';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { V3 } from '../../src/anim/construction/math';

const UNIT: V3 = [1,1,1];
const M = [1,0,0,0,1,0,0,0,1] as [number,number,number,number,number,number,number,number,number];
const B = {min: [-1,-1,-1] as V3, max:[1,1,1] as V3};
const vertices = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const faces = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const C = Float32Array.from(faces.flatMap(i => vertices[i]));
const metrics = (_: string): PartMetrics => ({id:'cube', body:B, full:B, footprint:{w:1,d:1},heightPlates:1,placeholder:false,mesh:C,studs:[]});
const part = (id: string, x: number, z: number, step: number): ANode => ({kind:'piece',itemId:id,model:'demo',step,order:0,part:'cube',color:16,grid:false,placeholder:false,body:B,local:{pos:[x,0,z],m:M}});
const node = (id: string, offset: V3): ConstructionNode => ({id,model:'test',part:'cube',step:0,order:0,matrix:rigidDelta(offset),bounds:{min:offset.map(v => v-1) as V3,max:offset.map(v => v+1) as V3},body:B,leaves:[id]});

const score = (names: string[]) => names.sort().join('|');

describe('Construction V3: deterministic broad phase and candidate generation', () => {
  it('matches exhaustive swept and rotation box checks for randomized layouts', () => {
    const nodes = Array.from({length:80},(_,i) => node(`n${i}`,[(i*23)%43*3, -((i*7)%5)*3, (i*47)%31*3]));
    const scopes = nodes.slice(0,65), staged = nodes.slice(65).map(n => ({node:n,pose:rigidDelta([3,-12,9])}));
    const ix = new ScopeSceneIndex(scopes,staged,identity());
    for (let i=0;i<48;i++) {
      const at = nodes[i].bounds;
      const delta:V3 = [((i*13)%19)-10, -((i*3)%5), ((i*17)%23)-11];
      const expected = [...scopes.map(node=>({node,box:node.bounds})),...staged.map(s=>({node:s.node,box:stagedBounds(s.node.bounds,s.pose)}))];
      expect(score(ix.swept(at,delta,nodes[i].id).map(x=>x.node.id)))
        .toBe(score(expected.filter(x=>x.node.id!==nodes[i].id && sweptBox(at,x.box,delta,-1e-6)).map(x=>x.node.id)));
      const searchBox = stagedBounds(at,rigidDelta([3,0,7]));
      expect(score(ix.touching(searchBox,nodes[i].id).map(x=>x.node.id)))
        .toBe(score(expected.filter(x=>x.node.id!==nodes[i].id && overlaps(searchBox,x.box)).map(x=>x.node.id)));
    }
  });

  it('ranks a declared withdrawal axis first, without treating candidates as certificates', () => {
    const n = {...node('move',[0,0,0]), hints:{insertionAxis:[0,-1,0] as V3}};
    const dirs = guidedDirections(n, [],[[1,0,0],[0,-1,0],[0,0,1]],[]);
    expect(dirs[0]).toEqual([0,-1,0]);
    // Known mechanical insertion axes are tried alone in the cheap pass.
    // A complete exhaustive search is still available if guided routes fail.
    expect(dirs).toHaveLength(1);
    const distances = nearDistances(n,[0,-1,0],[],[],{min:[-100,-80,-100],max:[100,0,100]});
    expect(distances.length).toBeLessThanOrEqual(4);
    expect(distances.every(d=>d>0 && Number.isFinite(d))).toBe(true);
    expect(farExits(n.bounds,{min:[-10,-10,-10],max:[10,0,10]})).toHaveLength(5);
  });

  it('fully compiles independently rotated bays using guided planning and unchanged collision replay', () => {
    for (const angle of [15,45,90,180]) {
      const a=part('a',0,0,0), b=part('b',15,0,0), c=part('c',70,60,1);
      const sub: ANode = {kind:'sub',itemId:'assembly',model:'demo',submodel:'assembly',step:0,order:0,body:B,
        children:[a,b],local:{pos:[0,0,0],m:M},assembly:{buildSpot:{x:8,z:-6,angle}}};
      const model = modelFromNodes([sub,c],metrics);
      const construction = planConstruction(model,{algorithm:'guided-v3',mechanicalSubassemblies:false,maxMilliseconds:8000});
      const clip = compileConstruction(construction,{targetSeconds:15,heroOrbit:false});
      expect(clip.units.length).toBeGreaterThan(0);
      expect(construction.parts).toHaveLength(3);
      expect(construction.operations.some(op=>op.rigidPath?.length)).toBe(true);
      expect(construction.stats.guidedCandidates).toBeGreaterThan(0);
      expect(construction.operations.every(o=>o.check.method==='continuous-triangle-sat')).toBe(true);
      expect(construction.parts.every(p => p.final.every((x,i)=>x===model.parts.get(p.key)!.matrix[i]))).toBe(true);
      expect(point(construction.operations.find(o=>o.id==='construct:assembly')!.rigidPath![0],centre(model.nodes[0].bounds))[0]).toBeCloseTo(160);
    }
  });

  it('honors explicit cancellation instead of misclassifying it as a route failure', () => {
    const model = modelFromNodes([part('a',0,0,0),part('b',25,0,1)],metrics);
    let calls = 0;
    try {
      planConstruction(model,{algorithm:'guided-v3',cancelled:()=>++calls > 2});
      throw new Error('Expected explicit cancellation');
    } catch (error) {
      expect(error).toBeInstanceOf(ConstructionError);
      expect((error as ConstructionError).code).toBe('cancelled');
    }
  });

  it('never accepts overlapping solid geometry as a certified build', () => {
    const model = modelFromNodes([part('a',0,0,0),part('b',0,0,1)],metrics);
    expect(()=>planConstruction(model,{algorithm:'guided-v3',maxMilliseconds:3000})).toThrow(/unresolved-final-contact|no-supported-rigid-route/);
  });
});
