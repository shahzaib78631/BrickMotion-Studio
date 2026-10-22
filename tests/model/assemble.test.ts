import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import type { Plan, PlanItem } from '../../src/plan/types';
import { ensureIds } from '../../src/plan/ids';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const plan = (steps: PlanItem[][], submodels?: Record<string, PlanItem[][]>): Plan =>
  ensureIds({
    format: 'brickmotion-plan',
    version: 1,
    name: 't',
    steps: steps.map((pieces) => ({ pieces })),
    submodels: submodels && Object.fromEntries(Object.entries(submodels).map(([k, v]) => [k, { steps: v.map((pieces) => ({ pieces })) }])),
  });

test('a brick at the origin', () => {
  const a = assemble(plan([[{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }]]), metrics, fixtureColors);
  expect(a.instances).toHaveLength(1);
  expect(a.instances[0].worldBox).toEqual({ min: [0, -24, 0], max: [80, 0, 40] });
  expect(a.instances[0].color).toBe(4);
  expect(a.bounds).toEqual({ min: [0, -24, 0], max: [80, 0, 40] });
});

test('a submodel placed twice', () => {
  const a = assemble(
    plan([[{ submodel: 'engine', x: 0, y: 0, z: 0, rot: 0 }, { submodel: 'engine', x: 10, y: 0, z: 0, rot: 0 }]], {
      engine: [[{ part: '3020', color: 72, x: 0, y: 0, z: 0, rot: 0 }]],
    }),
    metrics,
    fixtureColors,
  );
  expect(a.instances).toHaveLength(2);
  expect(a.instances[0].key).not.toBe(a.instances[1].key);
  expect(a.instances[0].key).toContain('/');
  expect(a.instances.map((i) => i.worldBox.min[0])).toEqual([0, 200]);
  expect(a.instances[0].model).toBe('engine');
  const sub = a.nodes[0];
  expect(sub.kind).toBe('sub');
  if (sub.kind === 'sub') expect(sub.children).toHaveLength(1);
});

test('submodel cycles are reported and terminate', () => {
  const a = assemble(
    plan([[{ submodel: 'a', x: 0, y: 0, z: 0, rot: 0 }]], {
      a: [[{ submodel: 'b', x: 0, y: 0, z: 0, rot: 0 }]],
      b: [[{ submodel: 'a', x: 0, y: 0, z: 0, rot: 0 }]],
    }),
    metrics,
    fixtureColors,
  );
  expect(a.problems.some((p) => p.kind === 'submodel-cycle')).toBe(true);
});

test('missing submodels are reported', () => {
  const a = assemble(plan([[{ submodel: 'ghost', x: 0, y: 0, z: 0, rot: 0 }]]), metrics, fixtureColors);
  expect(a.problems.map((p) => p.kind)).toEqual(['missing-submodel']);
  expect(a.instances).toHaveLength(0);
});

test('unknown parts become placeholders, unknown colors are reported', () => {
  const a = assemble(plan([[{ part: '3001x', color: 'no such color', x: 0, y: 0, z: 0, rot: 0 }]]), metrics, fixtureColors);
  expect(a.instances[0].placeholder).toBe(true);
  expect(a.instances[0].color).toBe(71);
  expect(a.problems.map((p) => p.kind)).toEqual(['unknown-color']);
});

test('main color 16 renders as light bluish grey', () => {
  const a = assemble(plan([[{ part: '3001', color: 16, x: 0, y: 0, z: 0, rot: 0 }]]), metrics, fixtureColors);
  expect(a.instances[0].color).toBe(71);
});

test('empty plan', () => {
  const a = assemble(plan([]), metrics, fixtureColors);
  expect(a.instances).toHaveLength(0);
  expect(a.bounds).toBeNull();
});
