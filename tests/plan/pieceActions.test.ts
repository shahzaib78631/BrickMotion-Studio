import { describe, expect, it } from 'vitest';
import { modelSteps } from '../../src/plan/ops';
import { movePiecesToNewStep, movePiecesToStep, similarIds, stepsOf } from '../../src/plan/pieceActions';
import type { Plan } from '../../src/plan/types';

const piece = (id: string, part = '3001', color: number = 4) => ({ id, part, color, x: 0, y: 0, z: 0, rot: 0 as const });
const plan = (): Plan => ({
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  steps: [
    { title: 'Base', pieces: [piece('a'), piece('b', '3003')] },
    { pieces: [piece('c', '3001', 1)] },
    { title: 'Roof', pieces: [piece('d', '3003', 1), piece('e')] },
  ],
  submodels: { wheel: { steps: [{ pieces: [piece('w1')] }, { pieces: [piece('w2')] }] } },
});
const ids = (p: Plan, m = '') => modelSteps(p, m).map((s) => s.pieces.map((i) => i.id));

describe('moving pieces between steps', () => {
  it('moves pieces into another step', () => {
    const r = movePiecesToStep(plan(), '', ['a', 'e'], 1);
    expect(ids(r.plan)).toEqual([['b'], ['c', 'a', 'e'], ['d']]);
    expect(r.step).toBe(1);
  });

  it('removes a step the move empties and reports where the target went', () => {
    const r = movePiecesToStep(plan(), '', ['c', 'd', 'e'], 0);
    expect(ids(r.plan)).toEqual([['a', 'b', 'c', 'd', 'e']]);
    expect(r.step).toBe(0);
    const later = movePiecesToStep(plan(), '', ['c'], 2);
    expect(ids(later.plan)).toEqual([['a', 'b'], ['d', 'e', 'c']]);
    expect(later.step).toBe(1);
    expect(modelSteps(later.plan, '')[1].title).toBe('Roof');
  });

  it('moves pieces into a new step before, after or at the end', () => {
    expect(ids(movePiecesToNewStep(plan(), '', ['b'], 0).plan)).toEqual([['b'], ['a'], ['c'], ['d', 'e']]);
    const after = movePiecesToNewStep(plan(), '', ['a'], 1);
    expect(ids(after.plan)).toEqual([['b'], ['a'], ['c'], ['d', 'e']]);
    expect(after.step).toBe(1);
    const end = movePiecesToNewStep(plan(), '', ['c'], 3);
    expect(ids(end.plan)).toEqual([['a', 'b'], ['d', 'e'], ['c']]);
    expect(end.step).toBe(2);
  });

  it('works inside a submodel and leaves the others alone', () => {
    const r = movePiecesToStep(plan(), 'wheel', ['w2'], 0);
    expect(ids(r.plan, 'wheel')).toEqual([['w1', 'w2']]);
    expect(ids(r.plan)).toEqual(ids(plan()));
  });
});

describe('selecting similar pieces', () => {
  it('finds the same part, colour, step or everything', () => {
    const p = plan();
    expect(similarIds(p, '', 'a', 'part')).toEqual(['a', 'c', 'e']);
    expect(similarIds(p, '', 'c', 'color')).toEqual(['c', 'd']);
    expect(similarIds(p, '', 'd', 'step')).toEqual(['d', 'e']);
    expect(similarIds(p, '', 'a', 'all')).toHaveLength(5);
    expect(similarIds(p, '', 'nope', 'all')).toEqual([]);
    expect(stepsOf(p, '', ['e', 'a', 'b'])).toEqual([0, 2]);
  });
});
