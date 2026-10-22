import * as THREE from 'three';
import { beforeAll, expect, test } from 'vitest';
import { buildPartGeometry, type PartGeometry } from '../../src/ldraw/geometry';
import { PartLibrary } from '../../src/ldraw/library';
import type { Instance } from '../../src/model/assemble';
import { BrickRenderer } from '../../src/render/bricks';
import { fixtureFetchText } from '../helpers/fixtureLibrary';
import { fixtureColors } from '../helpers/fixtureMetrics';

const geoms = new Map<string, PartGeometry>();
beforeAll(async () => {
  const lib = new PartLibrary(fixtureFetchText);
  for (const id of ['3001', '3020']) geoms.set(id, buildPartGeometry((await lib.loadPart(id))!));
});

const inst = (key: string, part: string, color: number, x: number): Instance => ({
  key,
  itemId: key,
  model: '',
  part,
  color,
  world: new THREE.Matrix4().makeTranslation(x + 40, part === '3001' ? -24 : -8, 20),
  worldBox: { min: [x, part === '3001' ? -24 : -8, 0], max: [x + 80, 0, 40] },
  placeholder: false,
  grid: true,
});

const make = () => new BrickRenderer((p) => geoms.get(p) ?? null, fixtureColors);

test('instances are grouped by part and color', () => {
  const r = make();
  r.setInstances([inst('a', '3001', 71, 200), inst('b', '3001', 71, 300), inst('c', '3001', 71, 400), inst('d', '3020', 0, 0)]);
  expect(r.meshCount()).toBe(2);
});

test('picking returns the instance key', () => {
  const r = make();
  r.setInstances([inst('a', '3001', 71, 200), inst('d', '3020', 0, 0)]);
  r.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(2, 10, -1), new THREE.Vector3(0, -1, 0));
  expect(r.pick(ray)).toBe('d');
});

test('a null matrix hides the instance', () => {
  const r = make();
  r.setInstances([inst('a', '3001', 71, 0)]);
  r.setMatrices(() => null);
  const mesh = r.root.children[0] as THREE.InstancedMesh;
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  // three's decompose() reports scale 1 for singular matrices, so read the basis columns directly
  const e = m.elements;
  expect(Math.hypot(e[0], e[1], e[2]) + Math.hypot(e[4], e[5], e[6]) + Math.hypot(e[8], e[9], e[10])).toBe(0);
});

test('3,000 instances of one part share one mesh', () => {
  const r = make();
  r.setInstances(Array.from({ length: 3000 }, (_, i) => inst('k' + i, '3001', 71, i * 80)));
  expect(r.meshCount()).toBe(1);
});

test('unknown parts render as placeholder boxes', () => {
  const r = make();
  r.setInstances([{ ...inst('x', 'nope', 71, 0), placeholder: true }]);
  expect(r.meshCount()).toBe(1);
});
