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
