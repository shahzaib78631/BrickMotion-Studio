import { beforeAll, expect, test } from 'vitest';
import * as THREE from 'three';
import { buildViewCamera, cameraAt, introInto } from '../../src/anim/camera';
import { buildTimeline, type Timeline } from '../../src/anim/timeline';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let tl: Timeline;
beforeAll(async () => {
  const metrics: Metrics = await fixtureMetrics();
  const brick = (x: number, y: number) => ({ part: '3001', color: 4, x, y, z: 0, rot: 0 as const });
  const plan: Plan = ensureIds({ format: 'brickmotion-plan', version: 1, name: 'wall', steps: [
    { pieces: [brick(0, 0), brick(4, 0), brick(8, 0)] }, { pieces: [brick(2, 3), brick(6, 3)] },
  ] });
  tl = buildTimeline(assemble(plan, metrics, fixtureColors), metrics, { targetSeconds: 12, heroOrbit: true });
});

const aspect = 9 / 16;
/** a close shot from the side, like a scene camera or a framed viewport */
const shot = () => ({ position: new THREE.Vector3(120, -90, 160), target: new THREE.Vector3(10, -20, 0), fov: 30 });

test('the intro opens on the same frame the Build view does', () => {
  expect(tl.intro).toBeGreaterThan(0);
  const auto = cameraAt(tl, 0, aspect);
  for (const at of [introInto(tl, shot(), aspect), buildViewCamera(tl, { position: [120, -90, 160], target: [10, -20, 0], fov: 30 }, aspect)]) {
    const first = at(0);
    expect(first.position.distanceTo(auto.position)).toBeLessThan(1e-6);
    expect(first.target.distanceTo(auto.target)).toBeLessThan(1e-6);
    expect(first.fov).toBeCloseTo(auto.fov, 6);
  }
});

test('the intro lands exactly on the shot, then holds it', () => {
  const at = introInto(tl, shot(), aspect);
  for (const t of [tl.intro, tl.intro + 0.5, tl.buildEnd]) {
    expect(at(t).position.distanceTo(shot().position)).toBeLessThan(1e-6);
    expect(at(t).fov).toBe(30);
  }
});

test('the intro moves smoothly into the shot, with no jump', () => {
  const at = introInto(tl, shot(), aspect);
  const dt = tl.intro / 200;
  let worst = 0;
  for (let t = 0; t < tl.intro + dt; t += dt) worst = Math.max(worst, at(t + dt).position.distanceTo(at(t).position));
  const travel = at(0).position.distanceTo(at(tl.intro).position);
  expect(travel).toBeGreaterThan(1);
  // no single frame step is more than a few times the average step
  expect(worst).toBeLessThan((travel / 200) * 6);
});
