import { expect, test } from 'vitest';
import * as THREE from 'three';
import { shapeOf, passesThrough } from '../../src/anim/shapes';
import { segmentTouchesSurface, maximumLinearScale } from '../../src/anim/surfaceContact';

const cubeMesh = (x = 5, y = 5, z = 5) => {
  const geometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed().translate(x, y, z);
  const points = new Float32Array(geometry.getAttribute('position').array);
  geometry.dispose();
  return points;
};
const cube = shapeOf(cubeMesh());

test('a tangent face slide is contact, not an initial solid penetration', () => {
  expect(passesThrough(cube, [0, 2, 2], [0, 1, 0], .3, 20)).toBe(false);
  expect(passesThrough(cube, [0, 8, 2], [0, -1, 0], .3, 20)).toBe(false);
});
test('a small near-surface tolerance cannot waive deep material', () => {
  expect(passesThrough(cube, [.1, 2, 2], [0, 1, 0], .3, 20)).toBe(false);
  expect(passesThrough(cube, [1, 2, 2], [0, 1, 0], .3, 20)).toBe(true);
});
test('solid-wall entry and starting in material remain blocked', () => {
  expect(passesThrough(cube, [-5, 5, 5], [1, 0, 0], .3, 20)).toBe(true);
  expect(passesThrough(cube, [5, 5, 5], [1, 0, 0], .3, 20)).toBe(true);
});
test('a wall after a legitimate contact must still be checked', () => {
  const first = cubeMesh(), next = cubeMesh(0, 17, 5);
  const both = new Float32Array(first.length + next.length); both.set(first); both.set(next, first.length);
  expect(passesThrough(shapeOf(both), [0, 2, 2], [0, 1, 0], .3, 30)).toBe(true);
});
test('contact certification covers the whole segment, not just its midpoint', () => {
  expect(segmentTouchesSurface(cube, [0, -20, 5], [0, 1, 0], 0, 50, .3)).toBe(false);
});
test('normal motion does not receive a tangent contact waiver', () => {
  expect(segmentTouchesSurface(cube, [-.1, 5, 5], [1, 0, 0], 0, .2, .3)).toBe(false);
});
test('scaling does not increase world-space contact tolerance', () => {
  const scale = maximumLinearScale(new THREE.Matrix4().makeScale(10, 10, 10).elements);
  expect(scale).toBe(10);
  expect(passesThrough(cube, [.1, 2, 2], [0, 1, 0], .3, 20, .3 / scale)).toBe(true);
});
test('invalid contact inputs fail closed', () => {
  expect(segmentTouchesSurface(cube, [NaN, 2, 2], [0, 1, 0], 0, 3, .3)).toBe(false);
  expect(segmentTouchesSurface(cube, [0, 2, 2], [0, 0, 0], 0, 3, .3)).toBe(false);
});
