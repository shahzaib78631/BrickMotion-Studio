import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { decodeTimeline, encodeTimeline } from '../../src/anim/timelineCodec';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

test('a timeline survives the trip to and from the planner worker', () => {
  const brick = (x: number, y: number) => ({ part: '3001', color: 4, x, y, z: 0, rot: 0 as const });
  const plan = ensureIds({
    format: 'brickmotion-plan', version: 1, name: 't',
    steps: [{ pieces: [brick(0, 0), { submodel: 'top', x: 0, y: 3, z: 0, rot: 0 }] }],
    submodels: { top: { steps: [{ pieces: [brick(0, 0)] }, { pieces: [brick(0, 3)] }] } },
  });
  const tl = buildTimeline(assemble(plan, metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: true });
  const back = decodeTimeline(structuredClone(encodeTimeline(tl)));
  expect(back.duration).toBe(tl.duration);
  expect([...back.tracks.keys()]).toEqual([...tl.tracks.keys()]);
  for (let t = 0; t <= tl.duration; t += 0.37) {
    const a = poseAt(tl, t), b = poseAt(back, t);
    for (const key of tl.tracks.keys()) {
      const ma = a(key), mb = b(key);
      expect(mb === null).toBe(ma === null);
      if (ma && mb) ma.elements.forEach((v, i) => expect(mb.elements[i]).toBeCloseTo(v, 6));
    }
  }
});
