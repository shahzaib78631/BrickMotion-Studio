import { describe, expect, it } from 'vitest';
import { planConstructionV4 } from '../../src/anim/construction/v4/planner';
import { modelFromNodes } from '../../src/anim/construction/input';
import { compileConstruction } from '../../src/anim/construction/compile';
import { MeshOracle } from '../../src/anim/construction/collision';
import { ConstructionError } from '../../src/anim/construction/types';
import type { ANode } from '../../src/model/assemblyTypes';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { V3, M4 } from '../../src/anim/construction/math';
import type { SearchStats } from '../../src/anim/construction/types';

const box = { min: [-5, -5, -5] as V3, max: [5, 5, 5] as V3 };
const verts = [[-5,-5,-5],[5,-5,-5],[5,5,-5],[-5,5,-5],[-5,-5,5],[5,-5,5],[5,5,5],[-5,5,5]];
const tris = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const mesh = Float32Array.from(tris.flatMap(i => verts[i]));
const metrics = (id: string): PartMetrics => ({ id, body: box, full: box, mesh, footprint: { w:1,d:1 }, heightPlates:1, placeholder:false, studs:[] });
const basis = [1,0,0,0,1,0,0,0,1] as [number,number,number,number,number,number,number,number,number];
const piece = (id: string, x: number, z: number, step = 0): ANode => ({
  kind: 'piece', itemId: id, model:'v4-test', step, order:0, part:'v4-box', color:16,
  grid:false, placeholder:false, body:box, local:{pos:[x,-5,z],m:basis},
});
const identity: M4 = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const stats = (): SearchStats => ({ states:0,candidates:0,backtracks:0,meshPairs:0,trianglePairs:0,cacheHits:0,milliseconds:0 });

describe('Construction V4', () => {
  it('builds a certified forward plan and compiles it to a timeline', () => {
    const model = modelFromNodes(Array.from({ length: 8 }, (_, i) => piece(`p${i}`, i * 14, 0)), metrics);
    const plan = planConstructionV4(model, { maxMilliseconds: 12_000, maxStates: 500 });
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(plan.capabilities.articulation).toBe(true);
    expect(plan.operations.every(op => op.check.method === 'continuous-triangle-sat')).toBe(true);
    const timeline = compileConstruction(plan, { targetSeconds: 10, heroOrbit: false });
    expect(timeline.units.length).toBeGreaterThan(0);
    expect(timeline.duration).toBeGreaterThanOrEqual(10);
  });

  it('has no uncertified fallback: an unresolved model fails explicitly', () => {
    const model = modelFromNodes([piece('a', 0, 0), piece('b', 0, 0)], metrics);
    expect(() => planConstructionV4(model, { maxMilliseconds: 5_000, maxStates: 200 }))
      .toThrow(ConstructionError);
  });

  it('certifies a clear arc and rejects one that sweeps through a solid', () => {
    const model = modelFromNodes([piece('a', 0, 0), piece('b', 80, 0)], metrics);
    const oracle = new MeshOracle(model, stats());
    expect(oracle.arcClear('a', 'b', identity, identity, [0, 0, 0], [0, 1, 0], Math.PI / 2)).toBe(true);
    const blocked = modelFromNodes([piece('a', 0, 0), piece('b', 10, 0)], metrics);
    const blockedOracle = new MeshOracle(blocked, stats());
    expect(blockedOracle.arcClear('a', 'b', identity, identity, [0, 0, 0], [0, 1, 0], Math.PI / 2)).toBe(false);
  });

  it('does not accept a full rotation whose annulus contains an obstacle', () => {
    const model = modelFromNodes([piece('a', 0, 0), piece('b', 10, 0)], metrics);
    const oracle = new MeshOracle(model, stats());
    expect(oracle.annulusClear('a', 'b', identity, identity, [0, 0, 0], [0, 1, 0])).toBe(false);
  });
});
