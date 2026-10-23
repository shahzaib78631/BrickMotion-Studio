import { expect, test } from 'vitest';
import { snapsBetween, snapsOf } from '../../src/anim/snaps';
import type { Timeline } from '../../src/anim/timeline';

const tlOf = (flights: [number, number][]) =>
  ({ units: flights.map(([start, dur], i) => ({ kind: 'piece', keys: [`p${i}`], start, dur, step: 0 })) }) as unknown as Timeline;

test('a snap sounds where each flight ends, near-simultaneous landings merged', () => {
  const snaps = snapsOf(tlOf([[2, 1], [0, 1], [0.01, 1], [4, 0.5]]));
  expect(snaps.map((s) => [+s.t.toFixed(2), s.count])).toEqual([[1, 2], [3, 1], [4.5, 1]]);
});

test('snapsBetween takes the landings after `from`, up to and including `to`', () => {
  const snaps = snapsOf(tlOf([[0, 1], [1, 1], [2, 1]]));
  expect(snapsBetween(snaps, 1, 3).map((s) => s.t)).toEqual([2, 3]);
  expect(snapsBetween(snaps, 0.5, 0.9)).toEqual([]);
  expect(snapsBetween(snaps, 3, 1)).toEqual([]);
});
