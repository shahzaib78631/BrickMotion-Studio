import * as THREE from 'three';
import { expect, test } from 'vitest';
import { ContactShadows } from '../../src/render/contactShadows';
import { Sweep } from '../../src/render/sweep';

test('contact shadows follow the cove and retain floor-camera texture coordinates', () => {
  const shadow = new ContactShadows(32), sweep = new Sweep();
  const box = new THREE.Box3(new THREE.Vector3(-3, 0, -2), new THREE.Vector3(3, 10, 2));
  shadow.fitTo(box, 0, 17.5, 7);
  sweep.fit(box, 0);
  sweep.mesh.rotation.y = 0.7;
  shadow.setSurface(sweep.mesh);
  const geometry = shadow.plane.geometry;
  const p = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  const source = sweep.mesh.geometry.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const expected = new THREE.Vector3().fromBufferAttribute(source, i).applyMatrix4(sweep.mesh.matrixWorld);
    const actual = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(shadow.plane.matrixWorld);
    expect(actual.x).toBeCloseTo(expected.x, 4);
    expect(actual.z).toBeCloseTo(expected.z, 4);
    expect(actual.y).toBeCloseTo(expected.y + 0.004, 4);
    expect(uv.getX(i)).toBeCloseTo(p.getX(i) + 0.5, 5);
    expect(uv.getY(i)).toBeCloseTo(p.getY(i) + 0.5, 5);
  }
  shadow.setSurface(sweep.mesh);
  expect(shadow.plane.geometry).toBe(geometry);
  shadow.setSurface(null);
  expect(shadow.plane.geometry.getAttribute('position').count).toBe(4);
  shadow.dispose(); sweep.dispose();
});
