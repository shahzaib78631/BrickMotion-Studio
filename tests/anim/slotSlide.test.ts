import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan } from '../../src/plan/types';
import { buildTimeline } from '../../src/anim/timeline';
import { plannedWay } from '../../src/anim/flightDirection';
import { attachmentLocalMatrix } from '../../src/model/attachmentPlacements';
import { attachmentSlotsFor } from '../../src/ldraw/attachments';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';
import { realMetrics, realPartsReady as ready } from '../helpers/realParts';

let metrics: Metrics;
beforeAll(async () => { metrics = await fixtureMetrics(); });

/** the scabbard on a grid spot, the katana seated in its documented sword slot */
const seated = async (): Promise<{ plan: Plan; metrics: Metrics }> => {
  const real = await realMetrics(['19141', '21459', '30173a']);
  const m = attachmentLocalMatrix(attachmentSlotsFor('19141', '30173')[0]);
  const sword = { ldu: [19.826, -19, 55.1], matrix: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]] };
  return {
    metrics: real,
    plan: ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [
      { pieces: [{ part: '19141', color: 308, x: 0, y: 0, z: 0, rot: 0, id: 'scabbard' }] },
      { pieces: [{ part: '21459', color: 0, id: 'sword', ...sword } as never] },
    ] }),
  };
};

/** a brick on a brick: a plain stud joint, which must keep dropping straight on */
const stacked = (): Plan => ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [
  { pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0, id: 'a' }] },
  { pieces: [{ part: '3001', color: 1, x: 0, y: 3, z: 0, rot: 0, id: 'b' }] },
] });

test.skipIf(!ready)('a sword goes into its slot up its own blade, not straight down', async () => {
  const { plan, metrics: real } = await seated();
  const tl = buildTimeline(assemble(plan, real, fixtureColors), real, { targetSeconds: 10, heroOrbit: false });
  // sideways along the sword, not from above
  const way = plannedWay(tl, 'sword')!;
  expect(Math.abs(way[1])).toBeLessThan(0.05);
  expect(Math.hypot(way[0], way[2])).toBeGreaterThan(0.95);
  // and it really slides: the entry is a sideways push along the blade, not a zero-length drop
  const entry = tl.tracks.get('sword')!.moves[0].entry;
  expect(Math.hypot(entry[0], entry[2])).toBeGreaterThan(2);
  expect(Math.abs(entry[1])).toBeLessThan(0.5);
}, 120_000);

test('a stud joint still comes straight down', () => {
  const tl = buildTimeline(assemble(stacked(), metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: false });
  const way = plannedWay(tl, 'b')!;
  expect(Math.abs(way[1])).toBeCloseTo(1, 3);
  expect(Math.hypot(way[0], way[2])).toBeLessThan(0.05);
}, 60_000);

test.skipIf(!ready)('a scabbard turned on its belt still takes the sword up its blade', async () => {
  // the exact arrangement from the reported project: the scabbard turned on the belt, the katana
  // seated in its mirrored slot — 0.00 LDU and 0.0° from the documented pose
  const real = await realMetrics(['19141', '21459', '30173a']);
  const plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [
    { pieces: [{ part: '19141', color: 308, id: 'in', ldu: [140, -86, -154], matrix: [-0.76222, 0, -0.64732, 0.64732, 0, -0.76222, 0, -1, 0] } as never] },
    { pieces: [{ part: '21459', color: 0, id: 'ix', ldu: [166.64129, -108.85356, -149], matrix: [0, 0.75081, -0.66052, 0, -0.66052, -0.75081, 1, 0, 0] } as never] },
  ] });
  const tl = buildTimeline(assemble(plan, real, fixtureColors), real, { targetSeconds: 12, heroOrbit: false });
  const way = plannedWay(tl, 'ix')!;
  // the sword's own long axis in the model, so it comes in blade first rather than straight down
  const m = [0, 0.75081, -0.66052, 0, -0.66052, -0.75081, 1, 0, 0];
  const blade = [m[1], m[4], m[7]];
  expect(Math.abs(way[0] * blade[0] + way[1] * blade[1] + way[2] * blade[2])).toBeGreaterThan(0.99);
  const entry = tl.tracks.get('ix')!.moves[0].entry;
  expect(Math.hypot(entry[0], entry[2])).toBeGreaterThan(2);
}, 120_000);
