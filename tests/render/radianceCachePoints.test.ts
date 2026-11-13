import * as THREE from 'three';
import { expect, test } from 'vitest';
import { collectRadiancePoints, cellHash, normalCode, planeCode } from '../../src/render/radianceCachePoints';

function model() {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshPhysicalMaterial({ roughness: 0.35 })));
  return root;
}
test('world-space cache points follow transforms and retain unit normals', () => {
  const root = model(); root.position.set(-10, 4, 7); root.rotation.y = 0.4;
  const bounds = new THREE.Box3().setFromObject(root), points = collectRadiancePoints(root, bounds);
  for (let i = 0; i < points.count; i++) {
    const p = new THREE.Vector3().fromArray(points.positions, i * 4), n = new THREE.Vector3().fromArray(points.normals, i * 4);
    expect(bounds.clone().expandByScalar(1e-5).containsPoint(p)).toBe(true);
    expect(n.length()).toBeCloseTo(1, 5);
  }
});
test('opaque lighting cache excludes glass, metal and hidden singular meshes', () => {
  const root = model(); const box = new THREE.Box3().setFromObject(root);
  for (const material of [new THREE.MeshPhysicalMaterial({ transmission: 1 }), new THREE.MeshPhysicalMaterial({ metalness: 1 }), new THREE.MeshPhysicalMaterial({ transparent: true })]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    expect(() => collectRadiancePoints(mesh, box)).toThrow('No supported opaque surfaces');
  }
  root.scale.setScalar(0);
  expect(() => collectRadiancePoints(root, box)).toThrow('No supported opaque surfaces');
});
test('hash entries resolve to valid nearby surface samples, including negative cells', () => {
  const root = model(); root.position.set(-4, -3, -2);
  const points = collectRadiancePoints(root, new THREE.Box3().setFromObject(root));
  for (let i = 0; i < points.count; i++) {
    const j = i * 4, x = Math.floor(Math.fround(points.positions[j] / points.cellSize)), y = Math.floor(Math.fround(points.positions[j + 1] / points.cellSize)), z = Math.floor(Math.fround(points.positions[j + 2] / points.cellSize));
    const key = normalCode(points.normals[j], points.normals[j + 1], points.normals[j + 2]);
    const hash = cellHash(x, y, z, key, planeCode(new THREE.Vector3().fromArray(points.positions,j),new THREE.Vector3().fromArray(points.normals,j)));
    let found = false;
    for (let probe = 0; probe < 8; probe++) if (points.table[((hash + probe) & 16383) * 4 + 3] === i + 1) found = true;
    expect(found).toBe(true);
  }
});
test('point budget is bounded and padding contains valid rays', () => {
  const root = model(), points = collectRadiancePoints(root, new THREE.Box3().setFromObject(root), 67);
  expect(points.count).toBeLessThanOrEqual(67);
  expect(points.positions.length).toBe(points.width * points.height * 4);
  for (let i = points.count; i < points.width * points.height; i++) expect([...points.normals.slice(i * 4, i * 4 + 4)]).toEqual([...points.normals.slice(0, 4)]);
});
