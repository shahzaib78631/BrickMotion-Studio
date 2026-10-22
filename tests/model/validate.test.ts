import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { validate } from '../../src/model/validate';
import { ensureIds } from '../../src/plan/ids';
import type { PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const brick = (x: number, y: number, z = 0, part = '3001'): PlanItem => ({ part, color: 4, x, y, z, rot: 0 });
const run = (items: PlanItem[], extra?: Record<string, PlanItem[]>) =>
  validate(
    assemble(
      ensureIds({
        format: 'brickmotion-plan',
        version: 1,
        name: 't',
        steps: [{ pieces: items }],
        submodels: extra && Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { steps: [{ pieces: v }] }])),
      }),
      metrics,
      fixtureColors,
    ),
  );

test('two bricks in the same spot overlap', () => {
  const w = run([brick(0, 0), brick(0, 0)]);
  expect(w).toHaveLength(1);
  expect(w[0].kind).toBe('overlap');
  expect(w[0].itemIds).toHaveLength(2);
});

test('a plate resting on a brick is fine', () => {
  expect(run([brick(0, 0), brick(0, 3, 0, '3020')])).toEqual([]);
});

test('a plate in mid-air floats', () => {
  const w = run([brick(10, 0), brick(0, 10, 0, '3020')]);
  expect(w.map((x) => x.kind)).toEqual(['floating']);
});

test('a brick attached to the side of a tower does not float', () => {
  expect(run([brick(0, 0), brick(0, 3), brick(0, 6), brick(4, 6)])).toEqual([]);
});

test('unknown parts are reported', () => {
  expect(run([brick(0, 0, 0, 'zzz')]).map((x) => x.kind)).toEqual(['unknown-part']);
});

test('assembly problems become warnings', () => {
  expect(run([{ submodel: 'ghost', x: 0, y: 0, z: 0, rot: 0 }]).map((x) => x.kind)).toEqual(['missing-submodel']);
});

test('3,000 bricks validate quickly', () => {
  const items: PlanItem[] = [];
  for (let y = 0; y < 10; y++) for (let i = 0; i < 15; i++) for (let j = 0; j < 20; j++) items.push(brick(i * 4, y * 3, j * 2));
  const asm = assemble(ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: items }] }), metrics, fixtureColors);
  const t = performance.now();
  const w = validate(asm);
  const ms = performance.now() - t;
  expect(w).toEqual([]);
  expect(ms).toBeLessThan(300);
});
