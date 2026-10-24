import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { sceneSpot, useBox } from '../../src/plan/assemblySpots';
import { setSubmodelBuildSpot } from '../../src/plan/pieceActions';
import { instancePlacements, placedBox, placedMatrix, sourceEditDelta, viewPlacement } from '../../src/ui/modelPlacement';
import type { Plan, PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let measured: Metrics;
beforeAll(async () => { measured = await fixtureMetrics(['3020']); });

const part = (id: string, x = 0, z = 0): PlanItem =>
  ({ id, part: '3020', color: 4, x, y: 0, z, rot: 0 });
const sub = (id: string, name: string, x = 0, z = 0, angle = 0): PlanItem => ({
  id, submodel: name, x: 0, y: 0, z: 0, rot: 0,
  assembly: { buildSpot: { x, z, angle } },
});
const doc = (steps: Plan['steps'], submodels: NonNullable<Plan['submodels']>): Plan =>
  ({ format: 'brickmotion-plan', version: 1, name: 'placed', steps, submodels, showModelAtSpot: true });
const assembled = (plan: Plan): Assembly => assemble(plan, measured, fixtureColors);
const eps = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);
const centre = (b: { min: number[]; max: number[] }) => [
  (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
];
function footprintAt(asm: Assembly, plan: Plan, path: string, spot: { x: number; z: number; angle: number }) {
  const poses = instancePlacements(plan, '', asm);
  const members = asm.instances.filter(i => i.key.startsWith(`${path}/`));
  expect(members.length).toBeGreaterThan(0);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const inst of members) {
    const b = placedBox(inst, poses);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]);
    }
  }
  const shown = sceneSpot(plan, asm.bounds, { model: '', id: path.split('/')[0] }, spot);
  const c = centre({ min, max });
  eps(c[0], shown.x * 20);
  eps(c[2], shown.z * 20);
  eps(max[1], asm.bounds!.max[1]); // base of the object rests on the marked floor
  return poses;
}

describe('placed submodels in Build viewport', () => {
  it('moves a submodel to its own marker and leaves unplaced parts unchanged', () => {
    const place = { x: 16, z: 2, angle: 0 };
    const plan = doc([{ pieces: [part('loose'), sub('truck', 'truck-body', place.x, place.z)] }],
      { 'truck-body': { steps: [{ pieces: [part('a'), part('b', 2, 0)] }] } });
    const asm = assembled(plan);
    const saved = asm.instances.map(i => i.world.clone());
    const map = footprintAt(asm, plan, 'truck', place);
    expect(map.has('loose')).toBe(false);
    expect(map.has('truck/a')).toBe(true);
    expect(map.has('truck/b')).toBe(true);
    for (const [i, inst] of asm.instances.entries()) expect(inst.world.equals(saved[i])).toBe(true);
    expect(placedMatrix(asm.instances.find(i => i.key === 'loose')!, map).equals(saved[0])).toBe(true);
  });

  it('shows a newly dropped marker immediately even while cached assembly metadata is stale', () => {
    const plan = doc([{ pieces: [part('loose'), {
      id: 'truck', submodel: 'truck-body', x: 0, y: 0, z: 0, rot: 0,
    }] }], { 'truck-body': { steps: [{ pieces: [part('a'), part('b', 2, 0)] }] } });
    const asm = assembled(plan);
    // useModel intentionally reuses source geometry for metadata-only edits.
    const placed = setSubmodelBuildSpot(plan, '', 'truck', { x: 16, z: 2, angle: 90 });
    footprintAt(asm, placed, 'truck', { x: 16, z: 2, angle: 90 });
    expect(asm.nodes.find(n => n.itemId === 'truck')?.assembly?.buildSpot).toBeUndefined();
  });

  it.each([15, 45, 90, 180, -60])('uses the entire rotated footprint at %d degrees', angle => {
    const place = { x: -9, z: 13, angle };
    const plan = doc([{ pieces: [sub('truck', 'truck-body', place.x, place.z, angle)] }],
      { 'truck-body': { steps: [{ pieces: [part('a'), part('b', 3, 1)] }] } });
    const asm = assembled(plan);
    footprintAt(asm, plan, 'truck', place);
    const raw = useBox(asm, 'truck')!;
    const matrix = instancePlacements(plan, '', asm).get('truck/a')!;
    const v = new THREE.Vector3(raw.min[0], raw.min[1], raw.min[2]).applyMatrix4(matrix);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
  });

  it('moves the main model and its bay together when loose-pieces-follow is on', () => {
    const place = { x: 16, z: 2, angle: 30 };
    const plan = { ...doc([{ pieces: [part('loose'), sub('truck', 'truck-body', place.x, place.z, place.angle)] }],
      { 'truck-body': { steps: [{ pieces: [part('a'), part('b', 1, 0)] }] } }),
      assemblySpot: { x: -7, z: 11, angle: 90 } };
    const asm = assembled(plan);
    footprintAt(asm, plan, 'truck', place);
    const map = instancePlacements(plan, '', asm);
    expect(map.has('loose')).toBe(true);
    expect(map.get('loose')!.equals(map.get('truck/a')!)).toBe(false);
  });

  it('keeps fixed bays in the original world frame when loose pieces do not follow', () => {
    const place = { x: 16, z: 2, angle: 0 };
    const plan = { ...doc([{ pieces: [part('loose'), sub('truck', 'truck-body', place.x, place.z)] }],
      { 'truck-body': { steps: [{ pieces: [part('a'), part('b', 1, 0)] }] } }),
      assemblySpot: { x: 30, z: 10, angle: 45 }, loosePiecesFollow: false };
    const asm = assembled(plan);
    const map = footprintAt(asm, plan, 'truck', place);
    expect(map.get('loose')!.equals(map.get('truck/a')!)).toBe(false);
  });

  it('respects nested independent bays; unplaced descendants inherit their parent bay', () => {
    const plan = doc([{ pieces: [sub('outer', 'outer-body', 10, 6, 45)] }], {
      'outer-body': { steps: [{ pieces: [part('root-piece'), sub('inner', 'inner-body', -8, -4, -90),
        { id: 'automatic', submodel: 'auto-body', x: 0, y: 0, z: 0, rot: 0 }] }] },
      'inner-body': { steps: [{ pieces: [part('nested')] }] },
      'auto-body': { steps: [{ pieces: [part('auto-leaf')] }] },
    });
    const asm = assembled(plan), map = instancePlacements(plan, '', asm);
    footprintAt(asm, plan, 'outer/inner', { x: -8, z: -4, angle: -90 });
    expect(map.get('outer/root-piece')!.equals(map.get('outer/automatic/auto-leaf')!)).toBe(true);
    expect(map.get('outer/root-piece')!.equals(map.get('outer/inner/nested')!)).toBe(false);
  });

  it('does not apply placement at all when disabled or editing a definition', () => {
    const plan = doc([{ pieces: [sub('truck', 'truck-body', 10, 2)] }],
      { 'truck-body': { steps: [{ pieces: [part('a')] }] } });
    const asm = assembled(plan);
    expect(instancePlacements({ ...plan, showModelAtSpot: false }, '', asm).size).toBe(0);
    expect(instancePlacements(plan, 'truck-body', asm).size).toBe(0);
  });

  it('preserves the exact world gesture after undoing a bay-view transform', () => {
    const plan = doc([{ pieces: [sub('truck', 'truck-body', 16, 2, 90)] }],
      { 'truck-body': { steps: [{ pieces: [part('a')] }] } });
    const asm = assembled(plan), transform = instancePlacements(plan, '', asm).get('truck/a')!;
    const move = new THREE.Matrix4().makeTranslation(2, 0, -3);
    const source = sourceEditDelta(move, transform);
    const w = viewPlacement(transform);
    const expected = move.clone().multiply(w);
    w.clone().multiply(source).elements.forEach((n, i) => eps(n, expected.elements[i]));
  });
});
