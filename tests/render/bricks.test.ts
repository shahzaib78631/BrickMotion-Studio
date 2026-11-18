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

test('edge color and opacity are local to the renderer and preserve instancing', () => {
  const a = make(), b = make();
  a.setInstances([inst('a', '3001', 71, 0)]); b.setInstances([inst('b', '3001', 71, 0)]);
  const edge = (r: BrickRenderer) => r.root.children.find(o => (o as THREE.LineSegments).isLineSegments) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  const original = edge(b).material.color.getHexString(), pose = a.poseVersion;
  a.setEdgeStyle({ edgeColor: '#ef1234', edgeOpacity: 0.75 });
  expect(edge(a).material.color.getHexString()).toBe('ef1234'); expect(edge(a).material.opacity).toBeCloseTo(0.75);
  expect(edge(a).material.defines).toEqual({ USE_INSTANCING: '' });
  expect(edge(b).material.color.getHexString()).toBe(original); expect(edge(b).material.opacity).toBeCloseTo(0.3);
  expect(a.poseVersion).toBe(pose);
  a.setWireframe(true); a.setWireframe(false);
  expect(edge(a).material.color.getHexString()).toBe('ef1234');
  a.setInstances([inst('a', '3001', 71, 0)]);
  expect(edge(a).material.color.getHexString()).toBe('ef1234');
  a.dispose(); b.dispose();
});

test('matching edges follow each brick and span darker, exact, and lighter colors', () => {
  const r = make(); r.setInstances([inst('a', '3001', 71, 0), inst('b', '3001', 0, 100)]);
  const lines = r.root.children.filter(o => (o as THREE.LineSegments).isLineSegments) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>[];
  r.setEdgeStyle({ edgeMatch: true, edgeLightness: 0 });
  for (const line of lines) {
    const mesh = r.root.children.find(o => (o as THREE.InstancedMesh).isInstancedMesh && o.userData.brickColor === line.userData.edgeColor) as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
    expect(line.material.color.toArray()).toEqual(mesh.material.color.toArray());
  }
  r.setEdgeStyle({ edgeMatch: true, edgeLightness: -1 });
  expect(lines.every(line => line.material.color.getHex() === 0)).toBe(true);
  r.setEdgeStyle({ edgeMatch: true, edgeLightness: 1 });
  expect(lines.every(line => line.material.color.getHex() === 0xffffff)).toBe(true);
  r.setEdgeStyle({ edgeMatch: false, edgeColor: '#123456' });
  expect(lines.every(line => line.material.color.getHexString() === '123456')).toBe(true);
  r.dispose();
});

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

test('wireframe visibility invalidates shadow poses only when visibility changes', () => {
  const r = make();
  r.setInstances([inst('a', '3001', 71, 0)]);
  const before = r.poseVersion;
  r.setWireframe(true);
  expect(r.poseVersion).toBe(before + 1);
  r.setWireframe(true, 0xff0000);
  expect(r.poseVersion).toBe(before + 1);
  r.setWireframe(false);
  expect(r.poseVersion).toBe(before + 2);
  r.dispose();
});

test('replaying the same pose preserves GPU buffers, bounds and shadow revision', () => {
 const r = make();
 const instance = inst('a', '3001', 4, 0);
 r.setInstances([instance]);
 const transform = new THREE.Matrix4().makeTranslation(1/3, 4, 5);
 r.setMatrices(() => transform);
 const revision=r.poseVersion;
 const mesh=r.root.children.find(o=>(o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
 mesh.computeBoundingSphere();const bounds=mesh.boundingSphere,version=mesh.instanceMatrix.version;
 r.setMatrices(() => transform.clone());
 expect(r.poseVersion).toBe(revision);expect(mesh.instanceMatrix.version).toBe(version);expect(mesh.boundingSphere).toBe(bounds);
 r.setMatrices(() => transform.clone().setPosition(1,2,3));
 expect(r.poseVersion).toBe(revision+1);expect(mesh.boundingSphere).toBeNull();
 r.dispose();
});

test('selection invalidates appearance once without dirtying shadows or unchanged colours', () => {
 const r=make();r.setInstances([inst('a','3001',4,0)]);
 const before=r.appearanceVersion,pose=r.poseVersion;
 r.setHighlight(new Set(['a']),'select');
 expect(r.appearanceVersion).toBe(before+1);expect(r.poseVersion).toBe(pose);
 r.setHighlight(new Set(['a']),'select');expect(r.appearanceVersion).toBe(before+1);
 r.setHighlight(new Set(),'select');expect(r.appearanceVersion).toBe(before+2);
 r.dispose();
});
