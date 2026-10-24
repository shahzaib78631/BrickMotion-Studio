import { beforeAll, expect, test } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan } from '../../src/plan/types';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { decodeTimeline, encodeTimeline } from '../../src/anim/timelineCodec';
import { projectToJson, readProjectFile } from '../../src/io/projectFile';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const brick = (x: number, y: number) => ({ part: '3001', color: 4, x, y, z: 0, rot: 0 as const });
const plan: Plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'tower', steps: [{ pieces: [brick(0, 0), brick(4, 0)] }, { pieces: [brick(2, 3)] }] });

test('a project file keeps the plan and plays the saved timeline exactly', () => {
  const tl = buildTimeline(assemble(plan, metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: true });
  const text = projectToJson(plan, [{ model: '', opts: 'k', timeline: encodeTimeline(tl) }]);
  const r = readProjectFile(text);
  if (!r.ok) throw new Error(r.errors.join());
  expect(r.plan).toEqual(plan);
  expect(r.skipped).toBe(0);
  expect(r.timelines.map((t) => [t.model, t.opts])).toEqual([['', 'k']]);
  const back = decodeTimeline(r.timelines[0].timeline);
  expect(back.duration).toBe(tl.duration);
  for (let t = 0; t <= tl.duration; t += 0.5)
    for (const key of tl.tracks.keys()) expect(poseAt(back, t)(key)?.elements).toEqual(poseAt(tl, t)(key)?.elements);
});

test('a damaged timeline is skipped, a damaged plan or other file is refused', () => {
  const tl = buildTimeline(assemble(plan, metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: true });
  const json = JSON.parse(projectToJson(plan, [{ model: '', opts: 'k', timeline: encodeTimeline(tl) }]));
  json.timelines[0].timeline.mats = 'AAAA';
  const r = readProjectFile(JSON.stringify(json));
  expect(r.ok && r.skipped).toBe(1);
  expect(readProjectFile(JSON.stringify({ ...json, plan: { nope: 1 } })).ok).toBe(false);
  expect(readProjectFile(JSON.stringify(plan)).ok).toBe(false);
  expect(readProjectFile('not json').ok).toBe(false);
});

test('a saved rigid flight validates its new matrix references and pivot', () => {
  const tl = buildTimeline(assemble(plan, metrics, fixtureColors), metrics, { targetSeconds: 10, heroOrbit: true });
  const file = JSON.parse(projectToJson(plan, [{ model: '', opts: 'k', timeline: encodeTimeline(tl) }]));
  const move = file.timelines[0].timeline.tracks[0][1].moves[0];
  move.rigidDeltas = [move.from, move.to];
  move.rigidBase = move.to;
  move.rigidPivot = [0, 0, 0];
  const valid = readProjectFile(JSON.stringify(file));
  expect(valid.ok && valid.skipped).toBe(0);
  move.rigidDeltas[0] = 999999;
  const damaged = readProjectFile(JSON.stringify(file));
  expect(damaged.ok && damaged.skipped).toBe(1);
});

test('a reopened project fingerprints the same, so its saved timelines are found', async () => {
  const { timelineFingerprint } = await import('../../src/storage/timelineCache');
  const r = readProjectFile(projectToJson(plan, []));
  if (!r.ok) throw new Error(r.errors.join());
  const reopened = ensureIds(r.plan);
  expect(JSON.stringify(reopened)).not.toBe(JSON.stringify(plan)); // fields come back in schema order
  const fp = (p: Plan) => timelineFingerprint({ plan: p, model: '', opts: 'k', shadow: true });
  expect(await fp(reopened)).toBe(await fp(plan));
  expect(await fp({ ...plan, name: 'other' })).not.toBe(await fp(plan));
});

test('the video settings a timeline was saved with are read back from its options key', async () => {
  const { optsKey, settingsFromOptsKey } = await import('../../src/state/timelineService');
  const { animOptions } = await import('../../src/state/appSettings');
  const settings = { targetSeconds: 42, heroOrbit: false, mode: 'piece' as const, introSeconds: 1.5, buildSeconds: null, outroSeconds: 2, bottomUp: false, planner: 'legacy' as const, constructionSupport: 'table' as const, floorSort: 'step' as const, floorSides: 'front-back' as const };
  const key = optsKey(animOptions(settings));
  expect(settingsFromOptsKey(key)).toEqual(settings);
  expect(optsKey(animOptions(settingsFromOptsKey(key)!))).toBe(key);
  // the floor layout options only change the key when they are not the default, so older keys stay valid
  expect(key.split('|')).toHaveLength(16);
  const floor = { ...settings, floorSort: 'colour' as const, floorSides: 'sides' as const };
  const floorKey = optsKey(animOptions(floor));
  expect(floorKey).not.toBe(key);
  expect(settingsFromOptsKey(floorKey)).toEqual(floor);
  // a key from before today's options were added still gives its settings
  expect(settingsFromOptsKey('30|true|auto||||true|true|legacy|2000|20000|fixture|true|12|4000')).toMatchObject({ targetSeconds: 30, mode: 'auto', planner: 'legacy' });
  expect(settingsFromOptsKey('k')).toBeNull();
});
