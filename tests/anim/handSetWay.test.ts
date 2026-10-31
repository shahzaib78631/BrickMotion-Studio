import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan } from '../../src/plan/types';
import { buildTimeline } from '../../src/anim/timeline';
import { plannedWay } from '../../src/anim/flightDirection';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => { metrics = await fixtureMetrics(); });

/** Two bricks side by side; the second is told to come in from +X (away from its neighbour). */
const plan = (axis?: [number, number, number]): Plan => ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [
  { pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0, id: 'a' }] },
  { pieces: [{ part: '3001', color: 1, x: 4, y: 0, z: 0, rot: 0, id: 'b', ...(axis ? { assembly: { insertionAxis: axis } } : {}) }] },
] });

for (const planner of ['legacy', 'standard-motion', 'standard-motion-v4'] as const) {
  test(`${planner}: a way in set by hand is the way the piece comes in`, () => {
    const asm = assemble(plan([1, 0, 0]), metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, { targetSeconds: 10, heroOrbit: false, planner });
    const way = plannedWay(tl, 'b')!;
    expect(way[0]).toBeCloseTo(1, 3);
    // and without it, the brick drops on
    const auto = buildTimeline(assemble(plan(), metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: false, planner });
    expect(plannedWay(auto, 'b')![0]).toBeCloseTo(0, 3);
  }, 60_000);
}

test('a sideways way in ends in a long straight push, not a short slide along the neighbour', () => {
  const asm = assemble(plan([1, 0, 0]), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, { targetSeconds: 10, heroOrbit: false });
  const entry = tl.tracks.get('b')!.moves[0].entry;
  expect(entry[0]).toBeGreaterThanOrEqual(40);
}, 60_000);
