import { beforeAll, expect, test } from 'vitest';
import type { Metrics } from '../../src/model/assemble';
import { autoSplitSteps, autoStepPlan, modelsWithoutSteps } from '../../src/plan/autoSteps';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const brick = (x: number, y: number, z: number): PlanItem => ({ part: '3001', color: 4, x, y, z, rot: 0 });
/** a 3-layer wall of 2x4 bricks, listed top layer first (the worst order to build in) */
const wall = (perLayer: number) => [2, 1, 0].flatMap((layer) => Array.from({ length: perLayer }, (_, k) => brick(k * 4, layer * 3, 0)));
const plan = (pieces: PlanItem[], sub?: PlanItem[]): Plan =>
  ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces }], submodels: sub ? { sub: { steps: [{ pieces: sub }] } } : undefined });

test('splits one big step bottom-up, keeping every piece exactly once', () => {
  const p = plan(wall(12));
  const out = autoSplitSteps(p, '', metrics, fixtureColors, 10);
  expect(out.steps.length).toBeGreaterThan(2);
  const flat = out.steps.flatMap((s) => s.pieces);
  expect(flat.map((i) => i.id).sort()).toEqual(p.steps[0].pieces.map((i) => i.id).sort());
  // y is in plates, up positive: layers must never go down from one step to the next
  const lowest = out.steps.map((s) => Math.min(...s.pieces.map((i) => ('y' in i ? i.y : 0))));
  for (let k = 1; k < lowest.length; k++) expect(lowest[k]).toBeGreaterThanOrEqual(lowest[k - 1]);
  expect(Math.max(...out.steps.map((s) => s.pieces.length))).toBeLessThanOrEqual(20);
});

test('only step-less models are split on import; authored steps are left alone', () => {
  const big = wall(12);
  const p = plan(big.slice(0, 3), big);
  expect(modelsWithoutSteps(p)).toEqual(['sub']);
  const r = autoStepPlan(p, metrics, fixtureColors);
  expect(r.models).toEqual(['sub']);
  expect(r.plan.steps).toBe(p.steps);
  expect(r.plan.submodels!.sub.steps.length).toBeGreaterThan(1);
});

test('a small model is returned unchanged', () => {
  const p = plan(wall(1));
  expect(autoSplitSteps(p, '', metrics, fixtureColors, 10)).toBe(p);
});
