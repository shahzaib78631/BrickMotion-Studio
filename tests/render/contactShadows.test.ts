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

test('stationary bricks reuse contact shadows; pose, structure, transform and settings redraw them', () => {
  let draws = 0;
  const renderer = {
    autoClear: true,
    getRenderTarget: () => null,
    getClearAlpha: () => 1,
    getClearColor: (color: THREE.Color) => color.set(0),
    getScissorTest: () => false,
    setScissorTest: () => {},
    setClearColor: () => {},
    setRenderTarget: () => {},
    render: () => { draws++; },
  } as unknown as THREE.WebGLRenderer;
  const shadow = new ContactShadows(32);
  const bricks = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(bricks);
  const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  shadow.fitTo(box, 0);
  const redraw = (structure: number, pose: number) => {
    const before = draws;
    shadow.update(renderer, bricks, structure, pose);
    expect(draws).toBeGreaterThan(before);
    expect(bricks.parent).toBe(scene);
  };
  redraw(1, 1);
  const first = draws;
  for (let frame = 0; frame < 60; frame++) shadow.update(renderer, bricks, 1, 1);
  expect(draws).toBe(first);
  redraw(1, 2);
  redraw(2, 2);
  bricks.position.x = 1;
  redraw(2, 2);
  shadow.set(0.5, '#123456');
  redraw(2, 2);
  shadow.setWide(2, 0.3);
  redraw(2, 2);
  shadow.fitTo(box, -1);
  redraw(2, 2);
  // Offscreen callers without version tracking retain the unconditional path.
  const before = draws;
  shadow.update(renderer, bricks);
  shadow.update(renderer, bricks);
  expect(draws).toBeGreaterThan(before);
  shadow.dispose();
});
