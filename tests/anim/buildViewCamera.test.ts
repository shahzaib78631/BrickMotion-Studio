import { expect, test } from 'vitest';
import * as THREE from 'three';
import { buildViewCamera } from '../../src/anim/camera';
import type { Timeline } from '../../src/anim/timeline';

/** The parts of a timeline the camera reads. */
const timeline = (overrides: Partial<Timeline> = {}): Timeline => ({
  intro: 1, buildEnd: 9, duration: 12, heroOrbit: true, camKeys: [], subBuilds: [], units: [],
  modelBox: { min: [-100, -60, -180], max: [100, 0, 180] },
  ...overrides,
} as unknown as Timeline);

const radius = (p: { position: THREE.Vector3; target: THREE.Vector3 }) => p.position.distanceTo(p.target);
const azimuth = (p: { position: THREE.Vector3; target: THREE.Vector3 }) =>
  (Math.atan2(p.position.x - p.target.x, p.position.z - p.target.z) * 180) / Math.PI;

const editor = { position: [260, -240, 260] as [number, number, number], target: [0, -30, 0] as [number, number, number], fov: 33 };
const editorRadius = Math.hypot(260, 210, 260);

test('the build is the editor shot exactly: same angle, distance and lens', () => {
  const at = buildViewCamera(timeline(), editor);
  const settled = at(1.2);
  expect(settled.position.x).toBeCloseTo(260, 3);
  expect(settled.position.y).toBeCloseTo(-240, 3);
  expect(settled.position.z).toBeCloseTo(260, 3);
  expect(settled.target.y).toBeCloseTo(-30, 3);
  expect(settled.fov).toBe(33);
  // and it does not drift or zoom during the build
  for (const t of [2, 5, 8.5]) {
    expect(radius(at(t))).toBeCloseTo(editorRadius, 3);
    expect(azimuth(at(t))).toBeCloseTo(azimuth(settled), 6);
  }
});

test('the intro pushes in to the editor shot instead of re-framing it', () => {
  const at = buildViewCamera(timeline(), editor);
  const first = at(0);
  expect(radius(first)).toBeGreaterThan(editorRadius * 1.1);
  expect(azimuth(first)).toBeCloseTo(azimuth(at(1.2)), 6);
  expect(first.fov).toBe(33);
});

test('the outro orbits your shot by the hero angle at your zoom', () => {
  const at = buildViewCamera(timeline(), editor);
  const end = at(12);
  expect(radius(end)).toBeCloseTo(editorRadius, 3);
  const turned = Math.abs(azimuth(end) - azimuth(at(9.4)));
  expect(turned).toBeGreaterThan(45);
});

test('without a hero orbit the outro still holds the editor shot', () => {
  const at = buildViewCamera(timeline({ heroOrbit: false }), editor);
  expect(at(11.5).position.distanceTo(at(9).position)).toBeLessThan(1e-6);
});

test('a landscape viewport shot is re-fitted to a portrait video at the same zoom', () => {
  // a long, low model: its width is what limits a portrait frame
  const tl = timeline({ modelBox: { min: [-3000, -60, -400], max: [3000, 0, 400] } } as Partial<Timeline>);
  const wide = { ...editor, aspect: 16 / 9 };
  const same = buildViewCamera(tl, wide, 16 / 9)(5);
  expect(radius(same)).toBeCloseTo(editorRadius, 3);
  const portrait = buildViewCamera(tl, wide, 9 / 16)(5);
  // a narrower frame must back off to keep the model's width in view, from the same angle
  expect(radius(portrait)).toBeGreaterThan(editorRadius * 1.2);
  expect(azimuth(portrait)).toBeCloseTo(azimuth(same), 6);
  expect(portrait.fov).toBe(33);
});
