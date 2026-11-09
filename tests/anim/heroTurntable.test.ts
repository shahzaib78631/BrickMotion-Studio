import * as THREE from 'three';
import { expect, test } from 'vitest';
import { heroAround, DEFAULT_CAMERA_SETTINGS } from '../../src/anim/camera';
import { heroSpinAngle, spinMatrix, withTurntable } from '../../src/anim/heroTurntable';

const tl = { buildEnd: 10, duration: 16, heroOrbit: true, modelBox: { min: [-20, -40, -20] as [number, number, number], max: [60, 0, 100] as [number, number, number] } };
const still = (key: string) => (key === 'a' ? new THREE.Matrix4().makeTranslation(60, -40, 100) : null);

test('nothing turns before the outro, with the orbit off, or with the turntable off', () => {
  expect(heroSpinAngle(tl, 120, 9)).toBe(0);
  expect(heroSpinAngle({ ...tl, heroOrbit: false }, 120, 15)).toBe(0);
  expect(withTurntable(tl, { heroOrbitDegrees: 120, heroTurntable: false }, 15, still)).toBe(still);
  expect(withTurntable(tl, { heroOrbitDegrees: 120, heroTurntable: true }, 9, still)).toBe(still);
});

test('the turn ends at the full angle', () => {
  expect(heroSpinAngle(tl, 120, 16)).toBeCloseTo((120 * Math.PI) / 180, 9);
});

test('the model spins about its own centre, which stays fixed', () => {
  const centre = new THREE.Vector3(20, 0, 40);
  expect(centre.clone().applyMatrix4(spinMatrix(tl, 1.2)).distanceTo(centre)).toBeLessThan(1e-9);
  const m = withTurntable(tl, { heroOrbitDegrees: 120, heroTurntable: true }, 16, still)('a')!;
  const p = new THREE.Vector3().setFromMatrixPosition(m);
  expect(p.y).toBeCloseTo(-40, 6);
  expect(Math.hypot(p.x - 20, p.z - 40)).toBeCloseTo(Math.hypot(40, 60), 6);
  expect(withTurntable(tl, { heroOrbitDegrees: 120, heroTurntable: true }, 16, still)('missing')).toBeNull();
});

test('the camera holds still with the turntable on', () => {
  const shot = { position: new THREE.Vector3(0, 10, 30), target: new THREE.Vector3(), fov: 30 };
  const cam = heroAround(tl, shot, { ...DEFAULT_CAMERA_SETTINGS, heroTurntable: true })(16);
  expect(cam.position.distanceTo(shot.position)).toBeLessThan(1e-9);
  expect(heroAround(tl, shot, DEFAULT_CAMERA_SETTINGS)(16).position.distanceTo(shot.position)).toBeGreaterThan(1);
});

test('the spin matches the camera orbit it replaces: the camera sees the same picture', () => {
  // orbiting the camera by +a about the model centre looks the same as spinning the model by -a world
  // (LDU: x, -y, -z). Camera in front of a piece at the model's +x side, as the orbit advances.
  const a = 0.7;
  const toWorld = (v: THREE.Vector3) => new THREE.Vector3(v.x / 20, -v.y / 20, -v.z / 20);
  const piece = new THREE.Vector3(60, -40, 40);
  const spun = toWorld(piece.clone().applyMatrix4(spinMatrix(tl, a)));
  const c = toWorld(new THREE.Vector3(20, 0, 40));
  const orbitedCamera = new THREE.Vector3(0, 0, 30).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
  const orbitView = toWorld(piece).sub(c).applyAxisAngle(new THREE.Vector3(0, 1, 0), -a);
  // relative to the camera the spun piece (camera fixed) equals the orbited camera's view of the unmoved piece
  const fixedView = spun.sub(c);
  expect(fixedView.distanceTo(orbitView)).toBeLessThan(1e-9);
  expect(orbitedCamera.length()).toBeCloseTo(30, 9);
});
