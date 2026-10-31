import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { buildTimeline } from '../../src/anim/timeline';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => { metrics = await fixtureMetrics(); });

const plan = (steps: PlanItem[][]): Plan => ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: steps.map((pieces) => ({ pieces })) });
const brick = (x: number, y: number, z: number): PlanItem => ({ part: '3001', color: 4, x, y, z, rot: 0 });

/** Pieces that only ever stack straight up and down: every way in should be a drop. */
function lateralEntries(targetSeconds: number) {
  const layer = (y: number) => Array.from({ length: 16 }, (_, k) => brick((k % 4) * 4, y, Math.floor(k / 4) * 2));
  const asm = assemble(plan([layer(0), layer(3), layer(6)]), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, { targetSeconds, heroOrbit: false });
  let lateral = 0;
  for (const tr of tl.tracks.values()) for (const mv of tr.moves) if (Math.hypot(mv.entry[0], mv.entry[2]) > 1e-6) lateral++;
  return lateral;
}

test('a tightly packed layer of bricks drops on; none slides in from the side', () => {
  for (const seconds of [6, 10, 20]) expect(lateralEntries(seconds), `${seconds} s build`).toBe(0);
}, 120_000);
