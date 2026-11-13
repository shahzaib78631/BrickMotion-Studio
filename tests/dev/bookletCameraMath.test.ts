import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bookletCamera, perspectiveRadii, rasterScale, screenOffset, type BookletCamera } from '../../src/dev/bookletCameraMath';

const centre = new THREE.Vector3(30, -17, 90);
const base: BookletCamera = { yaw: 37, pitch: 35, roll: 8, scale: 2, cx: 137, cy: 79, up: 1, persp: 0, offsets: [] };
const pixel = (p: THREE.Vector3, cam: THREE.Camera) => {
  const v = p.clone().project(cam); return [(v.x + 1) * 200, (1 - v.y) * 150];
};
describe('booklet image registration', () => {
  for (const persp of [0, 8]) it(`projects the target at the requested crop centre (perspective=${persp})`, () => {
    const cam = bookletCamera({ ...base, persp }, centre, 100, 400, 300);
    const [x, y] = pixel(centre, cam);
    expect(x).toBeCloseTo(base.cx, 8); expect(y).toBeCloseTo(base.cy, 8);
  });
  for (const turned of [false, true]) it(`preserves image offsets and camera depth (turned=${turned})`, () => {
    const cam = bookletCamera(base, centre, 100, 400, 300);
    const offset = new THREE.Vector3(...screenOffset(cam, base.scale, 23.5, -12.75, turned));
    if (turned) offset.applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    const a = pixel(centre, cam), b = pixel(centre.clone().add(offset), cam);
    expect(b[0] - a[0]).toBeCloseTo(23.5, 8); expect(b[1] - a[1]).toBeCloseTo(-12.75, 8);
    expect(offset.clone().applyQuaternion(cam.quaternion.clone().invert()).z).toBeCloseTo(0, 8);
  });
  it('keeps one eye distance in LDU whatever the model radius, so near parts grow the same in every step', () => {
    const near = centre.clone().add(new THREE.Vector3(120, 0, 90));      // towards the camera
    const proj = (radius: number) => pixel(near, bookletCamera({ ...base, persp: perspectiveRadii(6850, radius) }, centre, radius, 400, 300));
    const [a, b] = [proj(80), proj(400)];
    expect(a[0]).toBeCloseTo(b[0], 6); expect(a[1]).toBeCloseTo(b[1], 6);
    const ortho = pixel(near, bookletCamera(base, centre, 80, 400, 300));
    expect(Math.hypot(a[0] - base.cx, a[1] - base.cy)).toBeGreaterThan(Math.hypot(ortho[0] - base.cx, ortho[1] - base.cy));
    expect(perspectiveRadii(0, 50)).toBe(0);
  });
  it('shares printed scale across differently rasterized crops', () => {
    expect(rasterScale(2, 0.5, 0.25)).toBe(4);
    expect(rasterScale(2)).toBe(2);
  });
});
