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

test('each snap knows how big the landing part is, so it can sound like it', () => {
  const land = (w: number, h: number, d: number) => ({ min: [0, -h, 0], max: [w, 0, d] });
  const tl = { units: [
    { kind: 'piece', keys: ['a'], start: 0, dur: 1, step: 0, land: land(20, 8, 20) },   // 1x1 plate
    { kind: 'piece', keys: ['b'], start: 1, dur: 1, step: 0, land: land(80, 24, 40) },  // 2x4 brick
    { kind: 'piece', keys: ['c'], start: 1.01, dur: 1, step: 0, land: land(40, 8, 20) }, // lands with it
  ] } as unknown as Timeline;
  expect(snapsOf(tl)).toEqual([
    { t: 1, count: 1, studs: 1, height: 8 },
    { t: 2, count: 2, studs: 10, height: 24 },
  ]);
});
