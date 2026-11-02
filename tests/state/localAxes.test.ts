import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { runCommand } from '../../src/state/editing';
import { findItem } from '../../src/plan/ops';
import type { Mat3 } from '../../src/ldraw/parse';
import type { Plan, PlanItem } from '../../src/plan/types';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

/** a piece off the stud grid, turned by any angle: only a Raw placement can hold that */
const turned = (id: string, deg: number): PlanItem => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const m = [c, 0, s, 0, 1, 0, -s, 0, c].map((v) => Math.round(v * 1e6) / 1e6) as unknown as Mat3;
  return { id, part: '3001', color: 4, ldu: [0, 0, 0], matrix: m };
};
const load = (pieces: PlanItem[], select: string[]) => {
  const s = useStudio.getState();
  s.setPlan({ name: 't', steps: [{ pieces }] } as Plan, { resetHistory: true });
  s.select(select);
};
const item = (id: string) => findItem(useStudio.getState().plan, '', id)!.item as Record<string, unknown>;
const ldu = (id: string) => item(id).ldu as number[];

describe('moving along the piece’s own axes', () => {
  beforeAll(async () => { if (ready) await useAppParts(['3001']); }, 60_000);
  beforeEach(() => {
    useAppSettings.getState().set({ collision: true });
    useStudio.getState().setSmartJointsEnabled(false);   // the joint gate is not this test's subject
    useStudio.getState().setGizmoSpace('world');
  });

  it.skipIf(!ready)('steps a piece turned 45° out along its own x, not the world’s', () => {
    load([turned('a', 45)], ['a']);
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    expect(ldu('a')[0]).toBeCloseTo(20, 6);              // world axes: one stud along x

    useStudio.getState().setGizmoSpace('local');
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    const [x, , z] = ldu('a');
    expect(x).toBeCloseTo(20 + 20 * Math.SQRT1_2, 3);     // its own x, 45° across the world
    expect(z).toBeCloseTo(-20 * Math.SQRT1_2, 3);
  });

  it.skipIf(!ready)('keeps a quarter-turn step whole-studded', () => {
    load([{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 90 }], ['a']);
    useStudio.getState().setGizmoSpace('local');
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    // a quarter turn about the vertical sends the piece's own x along the world −z
    expect([item('a').x, item('a').z]).toEqual([0, -1]);
  });

  it('toggles the axes in one call, with or without a selection', () => {
    useStudio.getState().setGizmoSpace('world');
    runCommand({ kind: 'axes' });
    expect(useStudio.getState().gizmoSpace).toBe('local');
    runCommand({ kind: 'axes' });
    expect(useStudio.getState().gizmoSpace).toBe('world');
  });
});
