import * as THREE from 'three';
import { beforeAll, expect, test } from 'vitest';
import { assemble, transformBox, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { applyFloorShifts, buildTimeline } from '../../src/anim/timeline';
import { encodeTimeline } from '../../src/anim/timelineCodec';
import type { AnimOptions } from '../../src/anim/pacing';
import { floorShiftsByKey, resetFloorShifts, shiftOnFloor } from '../../src/plan/pieceActions';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => { metrics = await fixtureMetrics(); });

const brick = (id: string, x: number, y: number, z: number, color = 4): PlanItem => ({ id, part: '3001', color, x, y, z, rot: 0 });
/** two layers of four bricks in alternating colours */
const house = (): Plan => ensureIds({
  format: 'brickmotion-plan', version: 1, name: 'h',
  steps: [
    { pieces: [brick('a', 0, 0, 0, 4), brick('b', 4, 0, 0, 1), brick('c', 0, 0, 2, 4), brick('d', 4, 0, 2, 1)] },
    { pieces: [brick('e', 0, 3, 0, 1), brick('f', 4, 3, 0, 4), brick('g', 0, 3, 2, 1), brick('h', 4, 3, 2, 4)] },
  ],
});
const opts: AnimOptions = { targetSeconds: 15, heroOrbit: false };
/** each piece's box while it waits on the floor (LDU) */
const waiting = (plan: Plan, o: Partial<AnimOptions> = {}) => {
  const asm = assemble(plan, metrics, fixtureColors);
  const tl = applyFloorShifts(buildTimeline(asm, metrics, { ...opts, ...o }), floorShiftsByKey(plan, ''));
  return { asm, tl, boxes: new Map(asm.instances.map((i) => [i.key, transformBox(metrics(i.part).body, tl.tracks.get(i.key)!.floor)])) };
};
const centre = (b: { min: number[]; max: number[] }, k: number) => (b.min[k] + b.max[k]) / 2;

test('pieces wait in front and behind by default, only in front, only behind, or at the sides', () => {
  const { asm, boxes } = waiting(house());
  const m = asm.bounds!;
  const front = (b: { max: number[] }) => b.max[2] <= m.min[2];
  const behind = (b: { min: number[] }) => b.min[2] >= m.max[2];
  expect([...boxes.values()].every((b) => front(b) || behind(b))).toBe(true);
  expect([...waiting(house(), { floorSides: 'front' }).boxes.values()].every(front)).toBe(true);
  expect([...waiting(house(), { floorSides: 'behind' }).boxes.values()].every(behind)).toBe(true);
  const sides = [...waiting(house(), { floorSides: 'sides' }).boxes.values()];
  expect(sides.every((b) => b.max[0] <= m.min[0] || b.min[0] >= m.max[0])).toBe(true);
});

test('sorted by colour, pieces of one colour lie next to each other', () => {
  const { asm, boxes } = waiting(house(), { floorSides: 'front', floorSort: 'colour' });
  // along the rows: the reds come before the blues, never mixed
  const order = [...asm.instances].sort((a, b) => centre(boxes.get(a.key)!, 2) - centre(boxes.get(b.key)!, 2) || centre(boxes.get(a.key)!, 0) - centre(boxes.get(b.key)!, 0)).map((i) => i.color);
  const changes = order.filter((c, i) => i > 0 && c !== order[i - 1]).length;
  expect(changes).toBe(1);
});

test('a dragged piece waits exactly that many studs away; the others keep their spots', () => {
  const before = waiting(house()).boxes;
  const moved = shiftOnFloor(house(), '', 'a', [3, -2])!;
  expect(moved.steps[0].pieces[0].assembly?.floorShift).toEqual([3, -2]);
  const after = waiting(moved).boxes;
  expect(after.get('a')!.min[0] - before.get('a')!.min[0]).toBeCloseTo(60);
  expect(after.get('a')!.min[2] - before.get('a')!.min[2]).toBeCloseTo(-40);
  for (const k of ['b', 'c', 'e', 'h']) expect(after.get(k)).toEqual(before.get(k));
  // dragging again adds up; dragging back removes the offset; reset clears it
  expect(shiftOnFloor(moved, '', 'a', [1, 1])!.steps[0].pieces[0].assembly?.floorShift).toEqual([4, -1]);
  expect(shiftOnFloor(moved, '', 'a', [-3, 2])!.steps[0].pieces[0].assembly).toBeUndefined();
  expect(resetFloorShifts(moved).steps[0].pieces[0].assembly).toBeUndefined();
});

test('a dragged spot never changes the plan: it is applied to the planned timeline', () => {
  const moved = shiftOnFloor(house(), '', 'a', [3, -2])!;
  const plain = (p: Plan) => JSON.stringify(encodeTimeline(buildTimeline(assemble(p, metrics, fixtureColors), metrics, opts)));
  expect(plain(moved)).toBe(plain(house()));
  // the flight starts where the piece waits now
  const { tl } = waiting(moved);
  const tr = tl.tracks.get('a')!;
  expect(tr.moves[0].from.elements).toEqual(tr.floor.elements);
});

test('a piece of a submodel is moved on its item in the submodel', () => {
  const plan = ensureIds({
    format: 'brickmotion-plan', version: 1, name: 's',
    steps: [{ pieces: [{ id: 'w', submodel: 'wheel', x: 0, y: 0, z: 0, rot: 0 }] }],
    submodels: { wheel: { steps: [{ pieces: [brick('r', 0, 0, 0)] }] } },
  });
  const out = shiftOnFloor(plan, '', 'w/r', [0, 2])!;
  expect(out.submodels!.wheel.steps[0].pieces[0].assembly?.floorShift).toEqual([0, 2]);
  expect(shiftOnFloor(plan, '', 'nope/r', [0, 2])).toBeNull();
  // a dragged piece is planned where it was put
  const shifted = waiting(out).boxes.get('w/r')!, base = waiting(plan).boxes.get('w/r')!;
  expect(shifted.min[2] - base.min[2]).toBeCloseTo(40);
  void THREE;
});
