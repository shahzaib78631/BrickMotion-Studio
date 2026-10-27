import { beforeAll, expect, test } from 'vitest';
import { buildTimeline } from '../../src/anim/timeline';
import { dropTarget, packRows, partClips, pulledAhead, pushedBack, type PartClip } from '../../src/anim/partClips';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { insertItem, modelSteps, moveItemTo } from '../../src/plan/ops';
import type { Plan, PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const brick = (x: number, y: number, z: number): PlanItem => ({ part: '3001', color: 4, x, y, z, rot: 0 });
const plan = (): Plan =>
  ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brick(0, 0, 0), brick(4, 0, 0)] }, { pieces: [brick(0, 3, 0), brick(4, 3, 0), brick(2, 6, 0)] }] });
const timeline = (p: Plan) => buildTimeline(assemble(p, metrics, fixtureColors), metrics, { targetSeconds: 15, heroOrbit: true });

test('one clip per piece, in its step, during its flight', () => {
  const p = plan();
  const tl = timeline(p);
  const clips = partClips(tl, p.steps);
  expect(clips.map((c) => [c.step, c.index])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1], [1, 2]]);
  for (const c of clips) {
    expect(c.end).toBeGreaterThan(c.start);
    const span = tl.steps.find((s) => s.model === '' && s.index === c.step)!;
    expect(c.start).toBeGreaterThanOrEqual(span.start - 1e-6);
    expect(c.start).toBeLessThanOrEqual(span.end + 1e-6);
  }
});

test('overlapping flights stack into rows, capped', () => {
  const clips = [0, 0.1, 0.2, 2].map((start, k) => ({ id: `${k}`, step: 0, index: k, start, end: start + 1, row: 0 }));
  expect(packRows(clips, 0.1, 6)).toBe(3);
  expect(clips.map((c) => c.row)).toEqual([0, 1, 2, 0]);
  expect(packRows(clips, 0.1, 2)).toBe(2);
});

test('dropping at a time picks the step there and the arrival position in it', () => {
  const p = plan();
  const tl = timeline(p);
  const clips = partClips(tl, p.steps);
  const second = clips.filter((c) => c.step === 1);
  // just before the 2nd piece of step 2 → becomes its 2nd piece
  expect(dropTarget(tl, p.steps, clips, second[1].start - 0.01)).toEqual({ step: 1, index: 1 });
  // after everything → last of the last step
  expect(dropTarget(tl, p.steps, clips, tl.duration)).toEqual({ step: 1, index: 3 });
  // moving the last piece of step 2 to the very start of step 2
  expect(dropTarget(tl, p.steps, clips, second[0].start - 0.01, second[2].id)).toEqual({ step: 1, index: 0 });
});

test('moveItemTo reorders within a step and moves across steps; insertItem places a new piece', () => {
  const p = plan();
  const [a, b] = p.steps[0].pieces.map((i) => i.id!);
  const c = p.steps[1].pieces[2].id!;
  const reordered = moveItemTo(p, '', b, 0, 0);
  expect(reordered.steps[0].pieces.map((i) => i.id)).toEqual([b, a]);
  const moved = moveItemTo(p, '', c, 0, 1);
  expect(moved.steps[0].pieces.map((i) => i.id)).toEqual([a, c, b]);
  expect(moved.steps[1].pieces).toHaveLength(2);
  expect(moveItemTo(p, '', a, 0, 0)).toBe(p); // no change, same plan
  const added = insertItem(p, '', 1, { id: 'new', ...brick(8, 0, 0) }, 1);
  expect(modelSteps(added, '')[1].pieces.map((i) => i.id)[1]).toBe('new');
});

test('a dropped clip reports the pieces put after it that the build still brings in first', () => {
  const clip = (id: string, start: number): PartClip => ({ id, step: 0, index: 0, start, end: start + 1, part: id, row: 0 });
  // dropped "top" first, but the replanned build still lays "base" before it
  const clips = [clip('base', 0), clip('top', 1), clip('side', 2)];
  expect(pulledAhead(clips, 'top', new Set(['base', 'side'])).map((c) => c.id)).toEqual(['base']);
  // everything after it really comes after it: nothing to explain
  expect(pulledAhead(clips, 'base', new Set(['top', 'side']))).toEqual([]);
  // the moved clip is gone (deleted meanwhile): nothing to say
  expect(pulledAhead(clips, 'gone', new Set(['base']))).toEqual([]);
});

test('a base moved later reports the pieces put before it that now follow it', () => {
  const clip = (id: string, start: number): PartClip => ({ id, step: 0, index: 0, start, end: start + 1, part: id, row: 0 });
  // "base" was dropped after "top", which rests on it, so "top" now goes on after it
  const clips = [clip('side', 0), clip('base', 1), clip('top', 2)];
  expect(pushedBack(clips, 'base', new Set(['side', 'top'])).map((c) => c.id)).toEqual(['top']);
  expect(pushedBack(clips, 'top', new Set(['side', 'base']))).toEqual([]);
});
