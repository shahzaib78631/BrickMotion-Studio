import { expect, test } from 'vitest';
import * as THREE from 'three';

test('toolchain runs', () => {
  expect(1 + 1).toBe(2);
});

test('three is importable', () => {
  expect(new THREE.Vector3(1, 2, 3).length()).toBeCloseTo(3.742, 3);
});
