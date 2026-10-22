import * as THREE from 'three';
import { expect, test } from 'vitest';
import { fitDistance, sphericalPosition } from '../../src/anim/camera';

test.each([
  [30, 42],
  [55, 42],
  [170, 30],
])('box fits the frame at azimuth %d elevation %d', (az, el) => {
  const box = new THREE.Box3(new THREE.Vector3(-10, 0, -6), new THREE.Vector3(14, 9, 20));
  const target = box.getCenter(new THREE.Vector3());
  const d = fitDistance(box, 30, 9 / 16, az, el);
  const cam = new THREE.PerspectiveCamera(30, 9 / 16, 0.1, 10000);
  cam.position.copy(sphericalPosition(target, d, az, el));
  cam.lookAt(target);
  cam.updateMatrixWorld();
  let maxAbs = 0;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(cam);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1 + 1e-6);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1 + 1e-6);
        maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
      }
  expect(maxAbs).toBeGreaterThan(0.95); // tight, not just "far away"
});
