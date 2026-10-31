import * as THREE from 'three';
import { expect, test } from 'vitest';
import { sweepFacing, sweepFor, sweepGeometry, sweepProfile } from '../../src/render/sweep';
import { FLOORS, sanitizeMaterials } from '../../src/render/looks';

test('the profile runs flat under the model, curves smoothly and rises into the wall', () => {
  const s = sweepFor(10);
  const p = sweepProfile(s);
  // flat floor under the model's centre
  expect(p.filter(([z]) => z >= -(s.back - s.curve)).every(([, y]) => y === 0)).toBe(true);
  // always moving back and never down
  for (let i = 1; i < p.length; i++) {
    expect(p[i][0]).toBeLessThanOrEqual(p[i - 1][0] + 1e-9);
    expect(p[i][1]).toBeGreaterThanOrEqual(p[i - 1][1] - 1e-9);
  }
  // no kink: neighbouring curve segments turn by a few degrees at most
  const dir = (i: number) => Math.atan2(p[i + 1][1] - p[i][1], p[i][0] - p[i + 1][0]);
  for (let i = 3; i < p.length - 3; i++) expect(Math.abs(dir(i + 1) - dir(i))).toBeLessThan(0.12);
  // ends in a tall wall behind the model
  expect(p.at(-1)).toEqual([-s.back, s.height]);
  expect(s.back).toBeGreaterThan(10);
});

test('the surface faces the model: up on the floor, forward on the wall', () => {
  const g = sweepGeometry(sweepFor(10));
  const n = g.getAttribute('normal'), pos = g.getAttribute('position');
  let floorUp = 0, wallForward = 0;
  for (let i = 0; i < n.count; i++) {
    if (pos.getY(i) === 0 && pos.getZ(i) > 0) floorUp = Math.min(floorUp || 1, n.getY(i));
    if (pos.getY(i) > sweepFor(10).height * 0.5) wallForward = Math.min(wallForward || 1, n.getZ(i));
  }
  expect(floorUp).toBeGreaterThan(0.99);
  expect(wallForward).toBeGreaterThan(0.99);
});

test('the wall turns to stay behind the model from the camera', () => {
  const c = new THREE.Vector3(0, 0, 0);
  // camera on +Z: no turn (the wall is already toward −Z)
  expect(sweepFacing(c, new THREE.Vector3(0, 5, 30))).toBeCloseTo(0, 6);
  // camera on +X: the wall swings round to −X
  const yaw = sweepFacing(c, new THREE.Vector3(30, 5, 0));
  const wall = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  expect(wall.x).toBeCloseTo(-1, 6);
});

test('"Curved sweep" is a floor choice that survives saving', () => {
  expect(FLOORS.some((f) => f.id === 'sweep')).toBe(true);
  expect(sanitizeMaterials({ floor: 'sweep' }).floor).toBe('sweep');
});

test('floor colour: picked, else the scene colour; bad values from storage are dropped', async () => {
  const { floorColorOf, sceneOf, takesFloorColor } = await import('../../src/render/looks');
  expect(floorColorOf('soft', { floorColor: '#112233' })).toBe('#112233');
  expect(floorColorOf('soft', { floorColor: null })).toBe(sceneOf('soft').floorColor);
  expect(sanitizeMaterials({ floorColor: '#ABCDEF' }).floorColor).toBe('#abcdef');
  expect(sanitizeMaterials({ floorColor: 'red' }).floorColor).toBeNull();
  expect(sanitizeMaterials({ sweepCurve: 5 }).sweepCurve).toBe(1);
  expect(sanitizeMaterials({}).sweepCurve).toBe(0.6);
  expect(takesFloorColor('sweep') && takesFloorColor('matte') && !takesFloorColor('shadow')).toBe(true);
});

test('the curve setting goes from a tight bend to a long soft one', () => {
  expect(sweepFor(10, 0).curve).toBeLessThan(sweepFor(10, 1).curve);
  // even the longest curve starts behind the model's centre, never under it
  expect(sweepFor(10, 1).curve).toBeLessThanOrEqual(sweepFor(10, 1).back);
});
