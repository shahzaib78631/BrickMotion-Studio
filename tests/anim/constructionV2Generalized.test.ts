import { describe, expect, it } from 'vitest';
import { semanticComposites } from '../../src/anim/construction/semanticComposites';
import { possibleFinalContacts } from '../../src/anim/construction/contactBroadphase';
import { overlaps } from '../../src/anim/construction/math';
import { MeshOracle } from '../../src/anim/construction/collision';
import { modelFromNodes } from '../../src/anim/construction/input';
import { eligibleForPreview, previewProvenance } from '../../src/anim/construction/previewFallback';
import { ConstructionError } from '../../src/anim/construction/types';
import type { ConstructionNode, SearchStats } from '../../src/anim/construction/types';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { ANode } from '../../src/model/assemblyTypes';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const stats = (): SearchStats => ({ states: 0, candidates: 0, backtracks: 0, meshPairs: 0, trianglePairs: 0, cacheHits: 0, milliseconds: 0 });
const box = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
const vertices = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
const mesh = Float32Array.from(faces.flatMap(i => vertices[i]));
const metrics = (description: string): PartMetrics => ({ id: 'test', description, body: box, full: box, mesh, placeholder: false, studs: [], heightPlates: 1, footprint: { w: 1, d: 1 } });
const item = (id: string): ANode => ({ kind: 'piece', itemId: id, model: '', step: 0, order: 0, part: 'cube', body: box, local: { pos: [0, 0, 0], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, color: 16, grid: false, placeholder: false });
const segment = (i: number, step = 0, model = ''): ConstructionNode => ({
  id: `segment-${i}`, model, part: 'hose-section', step, order: i,
  matrix: identity.map((x, k) => k === 13 ? i * 4 : x),
  bounds: { min: [-1, i * 4 - 1, -1], max: [1, i * 4 + 1, 1] },
  body: { min: [-1, i * 4 - 1, -1], max: [1, i * 4 + 1, 1] },
  leaves: [`segment-${i}`],
});

describe('Construction V2 general model coverage', () => {
  it('treats neighboring render segments of a preformed flexible hose as one atomic object', () => {
    const parts = Array.from({ length: 12 }, (_, i) => segment(i));
    const { nodes, groups, segments } = semanticComposites(parts, () => metrics('Flexible Hose Segment'));
    expect({ groups, segments }).toEqual({ groups: 1, segments: 12 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].atomic).toBe('preformed-flexible');
    expect(nodes[0].leaves).toEqual(parts.map(p => p.id));
    expect(nodes[0].children).toHaveLength(12);
  });

  it('never merges separate steps, model hierarchies or ordinary rigid pieces', () => {
    const separateSteps = Array.from({ length: 4 }, (_, i) => segment(i, i));
    const separated = semanticComposites(separateSteps, () => metrics('Flexible Hose Segment'));
    expect(separated.groups).toBe(0);
    expect(separated.nodes).toHaveLength(4);
    const ordinary = semanticComposites(Array.from({ length: 4 }, (_, i) => segment(i)), () => metrics('Technic Axle Connector'));
    expect(ordinary.groups).toBe(0);
  });

  it('broad-phase pruning finds exactly the same candidate contacts as a quadratic scan', () => {
    const parts = Array.from({ length: 96 }, (_, i) => {
      const p = segment(i);
      const x = (i * 37 % 101) * 2, y = (i * 17 % 29) * 3, z = (i * 47 % 79) * 2;
      return { ...p, bounds: { min: [x, y, z] as [number, number, number], max: [x + 11, y + 5, z + 19] as [number, number, number] } };
    });
    const expected = new Set<string>();
    parts.forEach((a, i) => parts.slice(i + 1).forEach((b, j) => {
      if (overlaps(a.bounds, b.bounds, -1e-6)) expected.add(`${i}-${i + j + 1}`);
    }));
    const index = new Map(parts.map((p, i) => [p, i]));
    const actual = new Set([...possibleFinalContacts(parts)].map(([a, b]) =>
      `${Math.min(index.get(a)!, index.get(b)!)}-${Math.max(index.get(a)!, index.get(b)!)}`));
    expect(actual).toEqual(expected);
  });

  it('checks triangles across differently oriented assembly bays instead of rejecting their AABBs alone', () => {
    const model = modelFromNodes([item('a'), item('b')], () => metrics('Brick'));
    const oracle = new MeshOracle(model, stats());
    const movingPose = [...identity]; movingPose[12] = -5;
    const rotated = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
    expect(oracle.clearPosed('a', 'b', movingPose, rotated, [10, 0, 0])).toBe(false);
    const away = [...rotated]; away[14] = 20;
    expect(oracle.clearPosed('a', 'b', movingPose, away, [10, 0, 0])).toBe(true);
    // Surface tolerance is never permission to pass through a solid mesh.
    expect(oracle.clearPosed('a', 'b', movingPose, rotated, [10, 0, 0], {
      id: 'fake', parent: 'b', child: 'a', kind: 'surface', confidence: 'inferred',
      surfaceTolerance: 20, outward: [1, 0, 0],
    })).toBe(false);
  });

  it('allows only expected planning limitations to trigger an explicit uncertified fallback', () => {
    expect(eligibleForPreview('unresolved-final-contact')).toBe(true);
    expect(eligibleForPreview('search-budget-exhausted')).toBe(true);
    expect(eligibleForPreview('no-supported-rigid-route')).toBe(true);
    expect(eligibleForPreview('missing-geometry')).toBe(false);
    expect(eligibleForPreview('invalid-input')).toBe(false);
    expect(eligibleForPreview('cancelled')).toBe(false);
    const error = new ConstructionError('search-budget-exhausted', 'Unable to finish rigid-route search', {
      scope: 'truck', stats: { ...stats(), states: 37 },
      blockages: [{ moving: 'axle', obstacle: 'gear', stage: 'withdrawal', detail: 'Solid collision' }],
    });
    expect(previewProvenance(error)).toMatchObject({
      planner: 'construction-v2', mode: 'uncertified-preview', code: 'search-budget-exhausted',
      scope: 'truck', searchStates: 37, contacts: [{ moving: 'axle', obstacle: 'gear', stage: 'withdrawal' }],
    });
  });
});
