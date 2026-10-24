import { describe, expect, it } from 'vitest';
import { mayReuseBlockedNearRay } from '../../src/anim/construction/routePruning';
import { planConstruction } from '../../src/anim/construction/planner';
import { modelFromNodes } from '../../src/anim/construction/input';
import { compileConstruction } from '../../src/anim/construction/compile';
import { ConstructionError } from '../../src/anim/construction/types';
import { previewProvenance } from '../../src/anim/construction/previewFallback';
import type { ANode } from '../../src/model/assemblyTypes';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { V3 } from '../../src/anim/construction/math';

const b = { min: [-1, -1, -1] as V3, max: [1, 1, 1] as V3 };
const verts = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const tris = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
const mesh = Float32Array.from(tris.flatMap(i => verts[i]));
const metrics = (id: string): PartMetrics => ({ id, body: b, full: b, mesh, footprint: { w:1,d:1 }, heightPlates:1, placeholder:false, studs:[] });
const basis = [1,0,0,0,1,0,0,0,1] as [number,number,number,number,number,number,number,number,number];
const piece = (id: string, x: number, z: number): ANode => ({
  kind: 'piece', itemId: id, model:'benchmark', step:0, order:0, part:'box', color:16,
  grid:false,placeholder:false, body:b, local:{pos:[x,0,z],m:basis},
});

describe('Construction V3 scalable route search', () => {
  it('reuses a rejection only while the same obstacle is still at the same pose', () => {
    const original = { depth: 4.05, obstacleId: 'obstacle', staged:false };
    expect(mayReuseBlockedNearRay(original, 10, id => id === 'obstacle', () => false)).toBe(true);
    expect(mayReuseBlockedNearRay(original, 10, () => false, id => id === 'obstacle')).toBe(false);
    expect(mayReuseBlockedNearRay(original, 3.5, id => id === 'obstacle', () => false)).toBe(false);
    expect(mayReuseBlockedNearRay(undefined, 10, () => true, () => true)).toBe(false);
    expect(mayReuseBlockedNearRay({ ...original, staged:true }, 10, () => true, () => false)).toBe(false);
    expect(mayReuseBlockedNearRay({ ...original, staged:true }, 10, () => false, id => id === 'obstacle')).toBe(true);
    expect(mayReuseBlockedNearRay({ depth:0.5, obstacleId:'floor', staged:false }, 5, () => false, () => false)).toBe(true);
  });

  it('completes a multi-part plan and compiles every accepted path unchanged', () => {
    const model = modelFromNodes(Array.from({length:8}, (_,i) => piece(`p${i}`, i*9, i%2*13)), metrics);
    let progressReports = 0;
    const plan = planConstruction(model, { algorithm: 'guided-v3', mechanicalSubassemblies:false,
      maxMilliseconds:8000, onProgress: () => { progressReports++; } });
    expect(plan.operations).toHaveLength(8);
    expect(plan.stats.peakRemovals).toBe(8);
    expect(plan.stats.directSkyAttempts).toBeGreaterThan(0);
    expect(progressReports).toBeLessThan(70);
    expect(plan.operations.every(o => o.check.method === 'continuous-triangle-sat')).toBe(true);
    expect(compileConstruction(plan,{targetSeconds:12,heroOrbit:false}).units.length).toBeGreaterThan(0);
  });

  it('retains V3 identity and search-depth diagnostics in an uncertified fallback', () => {
    const error = new ConstructionError('search-budget-exhausted', 'No certified route within the limit', {
      scope: 'truck', phase: 'route-search', stats: {
        states: 88, candidates: 12000, backtracks: 13, meshPairs: 0,
        trianglePairs: 0, cacheHits: 0, milliseconds: 20000,
        peakRemovals: 105, peakScopeUnits: 450, peakScope: 'truck',
      },
    });
    expect(previewProvenance(error, 'construction-v3')).toMatchObject({
      planner: 'construction-v3', mode:'uncertified-preview',
      peakRemovals:105, peakScopeUnits:450, searchStates:88,
      searchCandidates:12000, searchBacktracks:13,
    });
  });

  it('does not let pruning or cached blockers certify overlapping solid pieces', () => {
    const model = modelFromNodes([piece('a',0,0),piece('b',0,0)],metrics);
    expect(() => planConstruction(model,{algorithm:'guided-v3',maxMilliseconds:3000}))
      .toThrow(/unresolved-final-contact|no-supported-rigid-route/);
  });
});
