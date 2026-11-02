import * as THREE from 'three';
import { expect, test } from 'vitest';
import type { PartGeometry } from '../../src/ldraw/geometry';
import type { Instance } from '../../src/model/assemble';
import { BrickRenderer } from '../../src/render/bricks';
import { wireMaterial } from '../../src/render/materials';

/** A part with a face and an outline, so the faces and the wireframe can be told apart. */
const geometry: PartGeometry = {
  main: new THREE.BoxGeometry(20, 24, 20),
  mainDoubleSided: null,
  fixed: [],
  edges: new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 20, 24, 20], 3)),
};
const instance: Instance = {
  key: 'p', itemId: 'p', model: '', part: '3001', color: 4, world: new THREE.Matrix4(),
  worldBox: { min: [0, -24, 0], max: [20, 0, 20] }, placeholder: false, grid: true,
};
const build = () => {
  const bricks = new BrickRenderer(() => geometry, new Map());
  bricks.setInstances([instance]);
  const faces = bricks.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
  const edges = bricks.root.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
  return { bricks, faces, edges };
};

test('a wireframe hides the faces and draws every outline in one ink', () => {
  const { bricks, faces, edges } = build();
  expect(faces).toHaveLength(1);
  expect(edges).toHaveLength(1);
  expect(faces[0].visible).toBe(true);

  bricks.setWireframe(true, 0x123456);
  expect(bricks.wireframe()).toBe(true);
  expect(faces[0].visible).toBe(false); // outlines only
  expect(edges[0].visible).toBe(true);
  expect((edges[0].material as THREE.LineBasicMaterial).color.getHex()).toBe(0x123456);
  expect(edges[0].material).toBe(wireMaterial(0x123456));

  bricks.setWireframe(false);
  expect(faces[0].visible).toBe(true);
  expect(edges[0].material).not.toBe(wireMaterial(0x123456)); // back to the part's own edge ink
});

test('the wireframe still picks pieces, so selection keeps working', () => {
  const { bricks } = build();
  // the renderer turns LDraw into view space: the brick lies at x 0..1, y −1.2..0, z −1..0
  const ray = new THREE.Raycaster(new THREE.Vector3(0.5, -0.6, 5), new THREE.Vector3(0, 0, -1));
  expect(bricks.pick(ray)).toBe('p');
  bricks.setWireframe(true);
  expect(bricks.pick(ray)).toBe('p'); // invisible faces are still ray-cast
  bricks.setWireframe(false);
  expect(bricks.pick(ray)).toBe('p');
});

test('edges stay hidden in solid mode when the edge switch is off, and wireframe overrides it', () => {
  const { bricks, edges } = build();
  bricks.setEdges(false);
  expect(edges[0].visible).toBe(false);
  bricks.setWireframe(true);
  expect(edges[0].visible).toBe(true);
  bricks.setWireframe(false);
  expect(edges[0].visible).toBe(false);
});

test('a rebuild keeps the wireframe on', () => {
  const bricks = new BrickRenderer(() => geometry, new Map());
  bricks.setInstances([instance]);
  bricks.setWireframe(true);
  bricks.setInstances([instance]);
  const faces = bricks.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
  const lines = bricks.root.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
  expect(faces.every((m) => !m.visible)).toBe(true);
  expect(lines.every((l) => l.visible)).toBe(true);
});
