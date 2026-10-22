import { expect, test } from 'vitest';
import type { Box } from '../../src/ldraw/flatten';
import type { Mat3 } from '../../src/ldraw/parse';
import { gridToPlacement, placementToGrid, rotatedBox, type Rot } from '../../src/plan/placement';

const body3001: Box = { min: [-40, 0, -20], max: [40, 24, 20] };

test('2x4 brick at origin', () => {
  expect(gridToPlacement({ x: 0, y: 0, z: 0, rot: 0 }, body3001)).toEqual({ pos: [40, -24, 20], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
});

test('rotated 90', () => {
  const p = gridToPlacement({ x: 0, y: 0, z: 0, rot: 90 }, body3001);
  expect(p.pos).toEqual([20, -24, 40]);
  expect(p.m).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
});

test('plate stacked on a brick', () => {
  expect(gridToPlacement({ x: 0, y: 3, z: 0, rot: 0 }, { min: [-40, 0, -20], max: [40, 8, 20] }).pos[1]).toBe(-32);
});

test('off-centre part origin still lands on the footprint', () => {
  // slope 3039: body x -20..20, z -30..10
  const p = gridToPlacement({ x: 1, y: 0, z: 1, rot: 0 }, { min: [-20, 0, -30], max: [20, 24, 10] });
  const rb = rotatedBox({ min: [-20, 0, -30], max: [20, 24, 10] }, p.m);
  expect(rb.min[0] + p.pos[0]).toBe(20);
  expect(rb.min[2] + p.pos[2]).toBe(20);
});

test('round trip grid → placement → grid for all rotations', () => {
  for (const rot of [0, 90, 180, 270] as Rot[]) {
    const g = { x: 3, y: 2, z: -1, rot };
    expect(placementToGrid(gridToPlacement(g, body3001), body3001)).toEqual(g);
  }
});

test('placementToGrid returns null for a 45° rotation', () => {
  const c = Math.SQRT1_2;
  const m: Mat3 = [c, 0, c, 0, 1, 0, -c, 0, c];
  expect(placementToGrid({ pos: [0, 0, 0], m }, body3001)).toBeNull();
});

test('placementToGrid returns null when off the grid', () => {
  expect(placementToGrid({ pos: [45, -24, 20], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, body3001)).toBeNull();
});
