import { expect, test } from 'vitest';
import type { Box } from '../../src/ldraw/flatten';
import {
  duplicateItems,
  deleteItems,
  deleteStep,
  insertStep,
  moveItems,
  moveItemsToStep,
  reorderStep,
  rotateItems,
  setColor,
  setPart,
  addItem,
} from '../../src/plan/ops';
import type { Plan, PlanItem } from '../../src/plan/types';

const g = (id: string, x = 0, z = 0): PlanItem => ({ id, part: '3001', color: 4, x, y: 0, z, rot: 0 });
const plan = (): Plan => ({
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  submodels: { engine: { steps: [{ pieces: [g('e1')] }] } },
  steps: [{ pieces: [g('a'), g('b')] }, { pieces: [g('c')] }, { pieces: [g('d')] }],
});
const fp = (i: PlanItem) => ('rot' in i && i.rot % 180 === 0 ? { w: 4, d: 2 } : { w: 2, d: 4 });
const body = (): Box => ({ min: [-40, 0, -20], max: [40, 24, 20] });

test('move grid and raw items', () => {
  const p = moveItems(plan(), '', ['a'], { x: 1, y: 0, z: 0 });
  expect(p.steps[0].pieces[0]).toMatchObject({ x: 1 });
  const raw: Plan = { ...plan(), steps: [{ pieces: [{ id: 'r', part: '3001', color: 4, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] }] };
  expect(moveItems(raw, '', ['r'], { x: 0, y: 1, z: 0 }).steps[0].pieces[0]).toMatchObject({ ldu: [0, -8, 0] });
});

test('rotate keeps the footprint centre', () => {
  const p = rotateItems(plan(), '', ['a'], fp, body);
  expect(p.steps[0].pieces[0]).toMatchObject({ rot: 90, x: 1, z: -1 });
  let q = plan();
  for (let k = 0; k < 4; k++) q = rotateItems(q, '', ['a'], fp, body);
  expect(q.steps[0].pieces[0]).toEqual(g('a'));
});

test('rotate raw item about its body centre', () => {
  const raw: Plan = { ...plan(), steps: [{ pieces: [{ id: 'r', part: '3001', color: 4, ldu: [100, 0, 50], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] }] };
  const r = rotateItems(raw, '', ['r'], fp, body).steps[0].pieces[0];
  expect(r).toMatchObject({ ldu: [100, 0, 50], matrix: [0, 0, 1, 0, 1, 0, -1, 0, 0] });
});

test('delete, color, part', () => {
  expect(deleteItems(plan(), '', ['a']).steps[0].pieces.map((i) => i.id)).toEqual(['b']);
  expect(setColor(plan(), '', ['a'], 'Red').steps[0].pieces[0]).toMatchObject({ color: 'Red' });
  expect(setPart(plan(), '', ['a'], '3002').steps[0].pieces[0]).toMatchObject({ part: '3002', x: 0 });
});

test('add item, appending a new step', () => {
  const p = addItem(plan(), '', 3, g('n'));
  expect(p.steps).toHaveLength(4);
  expect(addItem(plan(), '', 1, g('n')).steps[1].pieces.map((i) => i.id)).toEqual(['c', 'n']);
});

test('step operations', () => {
  expect(moveItemsToStep(plan(), '', ['a'], 2).steps.map((s) => s.pieces.map((i) => i.id))).toEqual([['b'], ['c'], ['d', 'a']]);
  expect(reorderStep(plan(), '', 0, 2).steps.map((s) => s.pieces.map((i) => i.id))).toEqual([['c'], ['d'], ['a', 'b']]);
  expect(insertStep(plan(), '', 1).steps.map((s) => s.pieces.length)).toEqual([2, 0, 1, 1]);
  expect(deleteStep(plan(), '', 0).steps.map((s) => s.pieces.map((i) => i.id))).toEqual([['a', 'b', 'c'], ['d']]);
  expect(deleteStep(plan(), '', 2).steps.map((s) => s.pieces.map((i) => i.id))).toEqual([
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('submodel ops leave the main model untouched', () => {
  const p0 = plan();
  const p = moveItems(p0, 'engine', ['e1'], { x: 2, y: 0, z: 0 });
  expect(p.submodels!.engine.steps[0].pieces[0]).toMatchObject({ x: 2 });
  expect(p.steps).toBe(p0.steps);
});

test('ops never mutate the input', () => {
  const p0 = plan();
  const snap = JSON.stringify(p0);
  moveItems(p0, '', ['a'], { x: 1, y: 1, z: 1 });
  rotateItems(p0, '', ['a'], fp, body);
  deleteStep(p0, '', 0);
  expect(JSON.stringify(p0)).toBe(snap);
});

test('duplicate copies items into the same step, right after the originals, shifted', () => {
  let n = 0;
  const { plan: p, ids } = duplicateItems(plan(), '', ['a', 'c'], () => `n${++n}`, { x: 4, y: 0, z: 0 });
  expect(ids).toEqual(['n1', 'n2']);
  expect(p.steps[0].pieces.map((i) => i.id)).toEqual(['a', 'n1', 'b']);
  expect(p.steps[1].pieces.map((i) => i.id)).toEqual(['c', 'n2']);
  expect(p.steps[0].pieces[1]).toMatchObject({ part: '3001', color: 4, x: 4, z: 0 });
  expect(duplicateItems(plan(), 'engine', ['e1'], () => 'x', { x: 0, y: 1, z: 0 }).plan.submodels!.engine.steps[0].pieces[1]).toMatchObject({ id: 'x', y: 1 });
});

test('rotate turns an imported piece at an odd angle to the next square angle first', () => {
  // 10156's truck: placed turned 30° (cos 30° = 0.86603), so 90° steps never faced front
  const m30 = [0.86603, 0, -0.499992, 0, 1, 0, 0.499992, 0, 0.86603] as const;
  const truck: Plan = { ...plan(), steps: [{ pieces: [{ id: 't', part: '3001', color: 4, ldu: [128, -24, 53], matrix: [...m30] }] }] };
  const box: Box = { min: [-40, -60, -100], max: [60, 0, 80] };
  const centre = (i: PlanItem) => {
    if (!('matrix' in i)) throw new Error('raw item expected');
    const c = [10, -30, -10];
    return [0, 1, 2].map((k) => i.ldu[k] + i.matrix[k * 3] * c[0] + i.matrix[k * 3 + 1] * c[1] + i.matrix[k * 3 + 2] * c[2]);
  };
  const c0 = centre(truck.steps[0].pieces[0]);
  let q = rotateItems(truck, '', ['t'], fp, () => box);
  const first = q.steps[0].pieces[0];
  expect('matrix' in first && first.matrix).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  centre(first).forEach((v, k) => expect(v).toBeCloseTo(c0[k], 3));
  const seen = [JSON.stringify((first as { matrix: number[] }).matrix)];
  for (let k = 0; k < 3; k++) {
    q = rotateItems(q, '', ['t'], fp, () => box);
    seen.push(JSON.stringify((q.steps[0].pieces[0] as { matrix: number[] }).matrix));
  }
  // four exact square angles, then back to facing front
  expect(new Set(seen).size).toBe(4);
  q = rotateItems(q, '', ['t'], fp, () => box);
  expect((q.steps[0].pieces[0] as { matrix: number[] }).matrix).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
});
