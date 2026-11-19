import { expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { referenceFramePolicy } from '../../scripts/lib/reference-frame-policy';
import type { Mat3, Vec3 } from '../../src/ldraw/parse';

const local = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3, pos: [0, 0, 0] as Vec3 };
it('enforces axial and symmetric radial inheritance permissions', () => {
  const check = (x: number, y: number, z: number, scale?: string) =>
    referenceFramePolicy(new Matrix4().makeScale(x, y, z), local, { scale });
  expect(check(1, 2, 1).matrix).toBeUndefined();
  expect(check(1, 2, 1, 'YOnly').matrix).toBeDefined();
  expect(check(2, 1, 2, 'ROnly').matrix).toBeDefined();
  expect(check(2, 2, 2, 'ROnly').matrix).toBeUndefined();
  expect(check(2, 3, 2, 'YandR').matrix).toBeDefined();
  expect(check(2, 3, 1, 'YandR').matrix).toBeUndefined();
});

it('rejects shear even when axis lengths could pass a scale policy', () => {
  const shear = new Matrix4().set(1, 0.2, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  expect(referenceFramePolicy(shear, local, { scale: 'YandR' }).reason).toBe('Sheared inherited frame');
});

it('corrects inherited reflections while retaining source-local handedness', () => {
  const reflected = new Matrix4().makeScale(-1, 1, 1);
  expect(referenceFramePolicy(reflected, local, { mirror: 'none' }).matrix).toBeUndefined();
  expect(referenceFramePolicy(reflected, local, { mirror: 'corZ' }).matrix!.determinant()).toBe(1);
  const ownReflection = { ...local, m: [-1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3 };
  expect(referenceFramePolicy(new Matrix4(), ownReflection, { mirror: 'none' }).matrix!.determinant()).toBe(-1);
});
