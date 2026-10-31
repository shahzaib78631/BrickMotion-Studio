import { describe, expect, it } from 'vitest';
import { visibleItemIds } from '../../src/plan/visible';
import type { Plan, PlanItem } from '../../src/plan/types';

const p = (id: string): PlanItem => ({ id, part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 });
const plan = { name: 't', steps: [{ pieces: [p('a'), p('b')] }, { pieces: [p('c')] }, { pieces: [p('d')] }] } as Plan;

describe('visible items', () => {
  it('shows every step when no step is picked, minus hidden pieces', () => {
    expect([...visibleItemIds(plan, '', null, ['b'])].sort()).toEqual(['a', 'c', 'd']);
  });
  it('shows only up to the picked step', () => {
    expect([...visibleItemIds(plan, '', 1, [])].sort()).toEqual(['a', 'b', 'c']);
  });
});
