import { describe, expect, test } from 'vitest';
import type { ANode } from '../../src/model/assemblyTypes';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Mat3 } from '../../src/ldraw/parse';
import { modelFromNodes } from '../../src/anim/construction/input';
import { MeshOracle } from '../../src/anim/construction/collision';
import { planConstruction } from '../../src/anim/construction/planner';
import { compileConstruction } from '../../src/anim/construction/compile';
import type { ConstructionPlan, Connection, SearchStats } from '../../src/anim/construction/types';

const body = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
const m: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const points = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const faces = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const mesh = Float32Array.from(faces.flatMap(i => points[i]));
const metrics = (_: string): PartMetrics => ({ id:'cube', body, full:body, mesh, placeholder:false, studs:[], heightPlates:1, footprint:{ w:1,d:1 } } as PartMetrics);
const piece = (id: string, at: [number,number,number]): ANode => ({ kind:'piece', itemId:id, model:'', step:0, order:0, part:'cube', body, local:{ pos:at, m }, color:16, grid:false, placeholder:false });

const stats = (): SearchStats => ({ states:0, candidates:0, backtracks:0, meshPairs:0, trianglePairs:0, cacheHits:0, milliseconds:0 });

describe('Construction V2 release-blocking regressions', () => {
  test('a surface overlap measurement does not allow sweeping through a solid obstruction', () => {
    const oracle = new MeshOracle(modelFromNodes([piece('a',[0,0,0]), piece('b',[0,0,0])], metrics), stats());
    const policy: Connection = { id:'surface-test', parent:'b', child:'a', kind:'surface', confidence:'inferred', outward:[1,0,0], surfaceTolerance:8 };
    expect(oracle.clear('a','b',[-4,0,0],[0,0,0],[8,0,0])).toBe(false);
    expect(oracle.clear('a','b',[-4,0,0],[0,0,0],[8,0,0],policy)).toBe(false);
  });

  test('100 operations respect 20 seconds without inventing 100 authored build steps', () => {
    const opCount = 100;
    const pos = (x:number) => [1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1];
    const operations = Array.from({length:opCount},(_,i)=> ({id:`o${i}`,kind:'place' as const, keys:[`p${i}`],scope:'$root',model:'',step:0,requires:i ? [`o${i-1}`]:[],connections:[],path:[[2,0,0],[0,0,0]] as [number,number,number][],check:{method:'continuous-triangle-sat' as const,contactPolicies:[],support:'table' as const}}));
    const parts = operations.map(op=> ({key:op.keys[0],part:'cube',final:pos(0),staged:pos(2),bounds:body}));
    const plan = { schema:'brickmotion-construction/v2',operations,parts,connections:[],dependencies:[],warnings:[],stats:stats(),ground:1,bounds:body,sceneBounds:body,capabilities:{rigidTranslation:true,rigidRotation:true,hierarchicalSubassemblies:true,articulation:false,deformation:false,physicalStability:false} } as ConstructionPlan;
    const tl = compileConstruction(plan,{targetSeconds:20,heroOrbit:false});
    expect(tl.pacing.stepPause).toBe(0);
    expect(tl.buildEnd).toBeCloseTo(19.5,5);
    expect(tl.duration).toBeCloseTo(20,5);
  });

  test('a 113-piece, two-submodel layout with a fixed truck bay can plan (proxy, not actual 10156 meshes)', () => {
    const truck = Array.from({length:109},(_,i)=>piece(`p${i}`,[(i%11)*4,0,Math.floor(i/11)*4]));
    const minifig = Array.from({length:4},(_,i)=>piece(`m${i}`,[(i%2)*4,0,Math.floor(i/2)*4]));
    const nodes: ANode[] = [
      {kind:'sub',itemId:'truck',model:'',submodel:'truck',step:0,order:0,children:truck,body,local:{pos:[0,0,0],m},assembly:{buildSpot:{x:16,z:2,angle:0}}},
      {kind:'sub',itemId:'minifig',model:'',submodel:'minifig',step:0,order:0,children:minifig,body,local:{pos:[-90,0,0],m}},
    ];
    const result = planConstruction(modelFromNodes(nodes,metrics),{maxMilliseconds:20_000});
    expect(result.parts.length).toBe(113);
    expect(result.operations.length).toBe(115);
    expect(result.operations.every(op=>op.check.method === 'continuous-triangle-sat')).toBe(true);
  },30_000);
});
