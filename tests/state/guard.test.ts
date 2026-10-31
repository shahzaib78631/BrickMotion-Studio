import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { runCommand } from '../../src/state/editing';
import { guardedApply } from '../../src/state/guard';
import { moveItems, findItem } from '../../src/plan/ops';
import type { Plan, PlanItem } from '../../src/plan/types';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const piece = (id: string, part: string, x: number, y: number, z = 0): PlanItem => ({ id, part, color: 4, x, y, z, rot: 0 });
const load = (pieces: PlanItem[], select: string[]) => {
  const s = useStudio.getState();
  s.setPlan({ name: 't', steps: [{ pieces }] } as Plan, { resetHistory: true });
  s.select(select);
};
const at = (id: string) => findItem(useStudio.getState().plan, '', id)!.item as { x: number; y: number; z: number };

describe('collision guard', () => {
  beforeAll(async () => { if (ready) await useAppParts(['3001', '3023']); }, 60_000);
  beforeEach(() => useAppSettings.getState().set({ collision: true }));

  it.skipIf(!ready)('refuses an arrow move into a wall', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 8, 0)], ['a']);
    const r1 = guardedApply('', ['a'], (p) => moveItems(p, '', ['a'], { x: 2, y: 0, z: 0 }));
    expect(r1).toBe('ok');
    expect(at('a').x).toBe(2);
    const before = useStudio.getState().plan;
    expect(guardedApply('', ['a'], (p) => moveItems(p, '', ['a'], { x: 4, y: 0, z: 0 }))).toBe('blocked');
    expect(useStudio.getState().plan).toBe(before);
    expect(useStudio.getState().blocked?.ids).toEqual(['a']);
  });

  it.skipIf(!ready)('E on a plate under a brick lands on top of the brick', () => {
    load([piece('p', '3023', 0, 0), piece('b', '3001', 0, 1)], ['p']);
    runCommand({ kind: 'move', d: { x: 0, y: 1, z: 0 } });
    expect(at('p').y).toBe(4);
  });

  it.skipIf(!ready)('moves freely when collision is off', () => {
    useAppSettings.getState().set({ collision: false });
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    expect(at('a').x).toBe(1);
  });

  it.skipIf(!ready)('arrow keys refuse to push a brick into another', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    expect(at('a').x).toBe(0);
  });

  it.skipIf(!ready)('duplicate is collision-checked', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    runCommand({ kind: 'duplicate' });
    const copy = useStudio.getState().selection.ids[0];
    expect(copy).not.toBe('a');
    expect(at(copy).x).toBeGreaterThanOrEqual(8);
  });
});
