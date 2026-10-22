import { beforeAll, expect, test } from 'vitest';
import { exportLDraw } from '../../src/io/ldrawExport';
import { importLDraw } from '../../src/io/ldrawImport';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const MPD = `0 FILE Jet.ldr
0 Jet
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 16 0 -24 0 1 0 0 0 1 0 0 0 1 Wing.ldr
0 STEP
0 NOFILE
0 FILE Wing.ldr
1 72 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 NOFILE
`;

test('imports an MPD with a submodel', () => {
  const p = importLDraw(MPD, 'jet.mpd');
  expect(p.name).toBe('jet');
  expect(p.steps).toHaveLength(2);
  expect(p.steps[1].pieces[0]).toMatchObject({ submodel: 'wing', ldu: [0, -24, 0] });
  expect(p.submodels!.wing.steps[0].pieces).toHaveLength(1);
  expect(p.steps[0].pieces[0]).toMatchObject({ part: '3001', color: 4, ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
});

test('trailing pieces after the last STEP form a final step, empty steps are dropped', () => {
  const p = importLDraw('0 STEP\n0 STEP\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n', 'a.ldr');
  expect(p.steps).toHaveLength(1);
});

const boxes = (plan: Plan) =>
  assemble(ensureIds(plan), metrics, fixtureColors)
    .instances.map((i) => JSON.stringify(i.worldBox) + i.color)
    .sort();

test('export → import keeps every piece in place', () => {
  const plan: Plan = {
    format: 'brickmotion-plan',
    version: 1,
    name: 'Mini Jet',
    submodels: { engine: { steps: [{ pieces: [{ part: '3020', color: 'Dark Bluish Grey', x: 0, y: 0, z: 0, rot: 90 }] }] } },
    steps: [
      { pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] },
      { pieces: [{ submodel: 'engine', x: 1, y: 3, z: 0, rot: 0 }, { part: '3001', color: 0, x: 4, y: 0, z: 0, rot: 270 }] },
    ],
  };
  const text = exportLDraw(plan, metrics, fixtureColors);
  expect(text).toContain('0 FILE engine.ldr');
  expect(text.indexOf('0 FILE Mini Jet.ldr')).toBe(0);
  const back = importLDraw(text, 'Mini Jet.mpd');
  expect(back.steps).toHaveLength(2);
  expect(boxes(back)).toEqual(boxes(plan));
});
