import { expect, it } from 'vitest';
import * as THREE from 'three';
import { diskRadiance, bakeMouldNormals, pathTraceColor } from '../../src/dev/eyesightScene';
it('preserves normal-incidence irradiance as disk angle changes', () => {
  for (const angle of [0.1, 0.5, Math.PI / 2]) {
    expect(diskRadiance(2.1, angle) * Math.PI * Math.sin(angle / 2) ** 2).toBeCloseTo(2.1, 10);
  }
});
it('bakes finite unit shading normals without changing geometry positions', () => {
  const geometry = new THREE.BoxGeometry(2, 3, 4, 4, 4, 4);
  const positions = Array.from(geometry.getAttribute('position').array);
  bakeMouldNormals(geometry);
  expect(Array.from(geometry.getAttribute('position').array)).toEqual(positions);
  const n = geometry.getAttribute('normal');
  for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 6);
});

it('uses unquantized Studio linear red and switches explicitly to the LDraw value', () => {
  const red = { code: 4, name: 'Red', hex: '#C91A09', edge: '#333333', alpha: 255, finish: 'solid' as const };
  const studio = pathTraceColor(red, 'studio');
  expect(studio.r).toBeCloseTo(0.6, 8);
  expect(studio.g).toBeCloseTo(0.007843138, 8);
  expect(pathTraceColor(red, 'ldraw').getHexString()).toBe('c91a09');
  expect(studio.equals(pathTraceColor(red, 'ldraw'))).toBe(false);
});
