import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addPosedItems, commitPose } from '../../src/plan/commitPose';
import { assemble } from '../../src/model/assemble';
import { findItem } from '../../src/plan/ops';
import type { Pose } from '../../src/plan/placementEngine';
import type { Plan, PlanItem } from '../../src/plan/types';
import type { Box } from '../../src/ldraw/flatten';

const body: Box = { min: [-10, 0, -10], max: [10, 8, 10] };
const metrics = () => ({ id: 'x', body, full: body, footprint: { w: 1, d: 1 }, heightPlates: 1, placeholder: false });
const piece = (id: string, x: number): PlanItem => ({ id, part: '3024', color: 4, x, y: 0, z: 0, rot: 0 });
const plan = (steps: PlanItem[][]): Plan => ({ name: 't', steps: steps.map((pieces) => ({ pieces })) } as Plan);
const pose = (m: THREE.Matrix4, owners: string[] = []): Pose => ({ delta: m.elements.slice(), mated: owners.length, owners, valid: true, handle: 0, yaw: 0, at: null });
const nodes = (p: Plan) => assemble(p, metrics as never, new Map()).nodes;

describe('committing a pose', () => {
  it('keeps a whole-stud upright result as a Grid item', () => {
    const p = plan([[piece('a', 1)]]);
    const out = commitPose(p, '', ['a'], nodes(p), pose(new THREE.Matrix4().makeTranslation(40, 0, 0)), () => 0);
    const a = findItem(out, '', 'a')!.item as { x: number; rot?: number };
    expect(a.x).toBe(3);
    expect(a.rot).toBe(0);
  });

  it('stores a half-stud result as Raw', () => {
    const p = plan([[piece('a', 1)]]);
    const out = commitPose(p, '', ['a'], nodes(p), pose(new THREE.Matrix4().makeTranslation(10, 0, 0)), () => 0);
    const a = findItem(out, '', 'a')!.item as Record<string, unknown>;
    expect(a.ldu).toEqual([40, -8, 10]);
    expect('rot' in a).toBe(false);
  });

  it('moves a piece to the later step it now rests on', () => {
    const p = plan([[piece('a', 1)], [], [piece('top', 5)]]);
    const out = commitPose(p, '', ['a'], nodes(p), pose(new THREE.Matrix4().makeTranslation(80, 0, 0), ['top']), (o) => (o === 'top' ? 2 : 0));
    expect(findItem(out, '', 'a')!.step).toBe(2);
  });

  it('leaves the step alone when resting on an earlier piece', () => {
    const p = plan([[piece('low', 5)], [piece('a', 1)]]);
    const out = commitPose(p, '', ['a'], nodes(p), pose(new THREE.Matrix4().makeTranslation(80, 0, 0), ['low']), (o) => (o === 'low' ? 0 : 1));
    expect(findItem(out, '', 'a')!.step).toBe(1);
  });

  it('adds new items at their posed placement', () => {
    const p = plan([[piece('a', 1)]]);
    const out = addPosedItems(p, '', 0, [piece('n', 0)], pose(new THREE.Matrix4().makeTranslation(60, -8, 20)), () => body);
    const n = findItem(out, '', 'n')!.item as { x: number; y: number; z: number };
    expect([n.x, n.y, n.z]).toEqual([3, 1, 1]);
  });
});
