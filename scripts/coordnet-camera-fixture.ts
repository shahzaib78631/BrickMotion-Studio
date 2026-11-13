/**
 * Reference projections from the booklet-camera page's own camera (src/dev/bookletCameraMath.ts), for the
 * Python port's test (python/tests/test_coordnet_camera.py).
 *
 * npx tsx scripts/coordnet-camera-fixture.ts > python/tests/data/coordnet_camera_fixture.json
 */
import * as THREE from 'three';
import { bookletCamera, perspectiveRadii, type BookletCamera } from '../src/dev/bookletCameraMath';

const cases: { cam: Omit<BookletCamera, 'offsets' | 'persp'> & { eye: number }; centre: number[]; radius: number; W: number; H: number; turned: boolean }[] = [
  { cam: { yaw: 36.84, pitch: 35.15, roll: 1.34, scale: 1.7111, cx: 412.5, cy: 186.4, up: 1, eye: 5120 }, centre: [0, -4, 10], radius: 300, W: 810, H: 375, turned: true },
  { cam: { yaw: 36.84, pitch: 35.15, roll: 1.34, scale: 1.7111, cx: 470.2, cy: 300.1, up: 1, eye: 5120 }, centre: [0, 2, -60], radius: 420, W: 856, H: 483, turned: false },
  { cam: { yaw: 141, pitch: 28, roll: -2.5, scale: 2.3, cx: 300, cy: 260, up: 1, eye: 0 }, centre: [15, -30, 5], radius: 120, W: 640, H: 480, turned: false },
  { cam: { yaw: -20, pitch: 50, roll: 0, scale: 0.9, cx: 200, cy: 150, up: 1, eye: 2500 }, centre: [100, -200, 40], radius: 600, W: 500, H: 330, turned: true },
];
const rng = (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
const out = cases.map((c) => {
  const centre = new THREE.Vector3(...c.centre);
  const pts = Array.from({ length: 40 }, () => [(rng() - 0.5) * 2 * c.radius, (rng() - 0.5) * 2 * c.radius, (rng() - 0.5) * 2 * c.radius]);
  // the page turns the model (scene.rotation.x = PI) and its centre with it
  const turn = (v: THREE.Vector3) => (c.turned ? v.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI) : v.clone());
  const cam = bookletCamera({ ...c.cam, persp: perspectiveRadii(c.cam.eye, c.radius), offsets: [] }, turn(centre), c.radius, c.W, c.H);
  const uv = pts.map((p) => {
    const w = turn(new THREE.Vector3(...p));
    const v = w.clone().project(cam);
    const depth = -w.clone().applyMatrix4(cam.matrixWorldInverse).z;
    return [(v.x + 1) * c.W / 2, (1 - v.y) * c.H / 2, depth];
  });
  return { ...c, pts, uv };
});
console.log(JSON.stringify(out));
