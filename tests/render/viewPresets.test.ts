import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { expect, test } from 'vitest';
import {
  OPPOSITE_VIEW,
  VIEW_DIRS,
  frameBox,
  offsetOf,
  orbitOffset,
  oppositeOffset,
  orthoHalfHeight,
  sphericalOf,
  viewAt,
  wrapPi,
} from '../../src/render/viewPresets';

const dirOf = (v: THREE.Vector3) => v.clone().normalize();
const close = (a: number, b: number, digits = 9) => expect(a).toBeCloseTo(b, digits);

test('view directions follow the app convention (front on +Z, right on +X)', () => {
  expect(VIEW_DIRS.front).toEqual([0, 0, 1]);
  expect(VIEW_DIRS.back).toEqual([0, 0, -1]);
  expect(VIEW_DIRS.right).toEqual([1, 0, 0]);
  expect(VIEW_DIRS.left).toEqual([-1, 0, 0]);
  expect(VIEW_DIRS.top).toEqual([0, 1, 0]);
  expect(VIEW_DIRS.bottom).toEqual([0, -1, 0]);
  for (const [name, opposite] of Object.entries(OPPOSITE_VIEW) as [keyof typeof VIEW_DIRS, keyof typeof VIEW_DIRS][]) {
    const [x, y, z] = VIEW_DIRS[name];
    const [ox, oy, oz] = VIEW_DIRS[opposite];
    expect(x + ox).toBe(0);
    expect(y + oy).toBe(0);
    expect(z + oz).toBe(0);
  }
});

test('sphericalOf and offsetOf round-trip', () => {
  for (const offset of [new THREE.Vector3(3, 4, 5), new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 2, 0), new THREE.Vector3(-1, -2, -3)]) {
    const { az, pol, dist } = sphericalOf(offset);
    const back = offsetOf(az, pol, dist);
    expect(back.distanceTo(offset)).toBeLessThan(1e-9);
  }
  // straight up is a degenerate azimuth, still a valid top view
  expect(sphericalOf(new THREE.Vector3(0, 5, 0)).pol).toBeCloseTo(0);
  expect(sphericalOf(new THREE.Vector3(0, -5, 0)).pol).toBeCloseTo(Math.PI);
});

test('viewAt names axis presets and user orbits', () => {
  expect(viewAt(new THREE.Vector3(0, 0, 12))).toBe('front');
  expect(viewAt(new THREE.Vector3(0, 0, -12))).toBe('back');
  expect(viewAt(new THREE.Vector3(12, 0, 0))).toBe('right');
  expect(viewAt(new THREE.Vector3(-12, 0, 0))).toBe('left');
  expect(viewAt(new THREE.Vector3(0, 12, 0))).toBe('top');
  expect(viewAt(new THREE.Vector3(0, -12, 0))).toBe('bottom');
  expect(viewAt(new THREE.Vector3(3, 2, 1))).toBe('user');
  // just off a preset (beyond ~1.1°) is already user
  const tilted = offsetOf(THREE.MathUtils.degToRad(5), Math.PI / 2, 10);
  expect(viewAt(tilted)).toBe('user');
});

test('15° orbit steps land exactly on the axis views', () => {
  const rad = Math.PI / 180;
  let offset = new THREE.Vector3(0, 0, 10); // front
  for (let i = 0; i < 6; i++) offset = orbitOffset(offset, 15 * rad, 0);
  expect(viewAt(offset)).toBe('right');
  expect(dirOf(offset).x).toBeCloseTo(1);
  for (let i = 0; i < 6; i++) offset = orbitOffset(offset, -15 * rad, 0);
  expect(viewAt(offset)).toBe('front');
  for (let i = 0; i < 6; i++) offset = orbitOffset(offset, 0, 15 * rad);
  expect(viewAt(offset)).toBe('top');
  for (let i = 0; i < 12; i++) offset = orbitOffset(offset, 0, -15 * rad);
  expect(viewAt(offset)).toBe('bottom');
  // orbit down clamps at Bottom, orbit up clamps at Top
  expect(viewAt(orbitOffset(offset, 0, -15 * rad))).toBe('bottom');
  expect(viewAt(orbitOffset(new THREE.Vector3(0, 10, 0), 0, 15 * rad))).toBe('top');
});

test('oppositeOffset flips the view through the target', () => {
  expect(viewAt(oppositeOffset(new THREE.Vector3(0, 0, 10)))).toBe('back');
  expect(viewAt(oppositeOffset(new THREE.Vector3(0, 10, 0)))).toBe('bottom');
  const offset = new THREE.Vector3(2, 3, 5);
  expect(oppositeOffset(offset).add(offset).length()).toBeLessThan(1e-9);
});

test('orthoHalfHeight matches the perspective framing at the target plane', () => {
  const fov = 30;
  const dist = 40;
  // a perspective camera at `dist` sees 2·tan(fov/2)·dist of height at the target
  close(orthoHalfHeight(fov, dist), Math.tan((fov * Math.PI) / 360) * dist);
  expect(orthoHalfHeight(30, 40)).toBeCloseTo(Math.tan(THREE.MathUtils.degToRad(15)) * 40, 6);
});

test('frameBox keeps the perspective fit the viewport always used', () => {
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
  camera.position.set(0, 0, 100);
  const controls = new OrbitControls(camera);
  const box = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
  frameBox(camera, controls, box);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fov = (30 * Math.PI) / 180;
  const dist = (sphere.radius / Math.sin(Math.min(fov, fov * 1) / 2)) * 1.15;
  expect(controls.target.distanceTo(sphere.center)).toBeLessThan(1e-9);
  expect(camera.position.distanceTo(sphere.center)).toBeCloseTo(dist, 6);
  // the direction out of the box is kept
  expect(camera.position.z).toBeGreaterThan(0);
  expect(camera.position.x).toBeCloseTo(0, 6);
});

test('frameBox frames the orthographic camera through setOrthoHeight', () => {
  // 16:9-wide frustum, as created by the studio (aspect 9/16 for portrait video)
  const camera = new THREE.OrthographicCamera(-9, 9, 16, -16, 0.1, 4000);
  camera.position.set(0, 0, 50);
  camera.updateProjectionMatrix();
  const controls = new OrbitControls(camera);
  let height = 0;
  const box = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  frameBox(camera, controls, box, (h) => {
    height = h;
    camera.top = h / 2;
    camera.bottom = -h / 2;
    camera.left = (-h / 2) * (9 / 16);
    camera.right = (h / 2) * (9 / 16);
    camera.updateProjectionMatrix();
  });
  // sphere fits the narrow screen axis with the same 1.15 margin
  const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
  close(height, (sphere.radius / Math.min(1, aspect)) * 1.15 * 2);
  expect(camera.zoom).toBe(1);
  expect(camera.position.distanceTo(sphere.center)).toBeCloseTo(Math.max(sphere.radius * 4, 12), 6);
  // the far plane still covers the scene
  expect(camera.far).toBeGreaterThanOrEqual(camera.position.distanceTo(sphere.center) + sphere.radius);
});

test('wrapPi takes the shortest arc', () => {
  close(wrapPi(0), 0);
  close(wrapPi(Math.PI + 0.1), -Math.PI + 0.1);
  close(wrapPi(-Math.PI - 0.1), Math.PI - 0.1);
});
