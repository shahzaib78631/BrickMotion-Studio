import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cameraTrackAt } from '../../../src/anim/cameraTrack/sample';
import type { CameraContext, CameraKey, CameraTrack, CameraTransition, TransitionSettings } from '../../../src/anim/cameraTrack/types';

const cube = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
const ctx: CameraContext = { aspect: 9 / 16, sensorMm: 36, duration: 10, modelBox: cube, buildBox: () => cube, pieceBox: () => null };

const key = (id: string, t: number, over: Partial<CameraKey> = {}): CameraKey => ({
  id, t, target: { kind: 'model' }, offset: [0, 0, 0], azimuth: 0, elevation: 30,
  distance: { fit: false, value: 10 }, roll: 0, lensMm: 50, focus: 0.5, blur: 0, origin: 'user', ...over,
});
const LINEAR: TransitionSettings = {
  curve: { kind: 'linear', strength: 0 }, path: 'arc', orbit: 'shortest', extraTurns: 0, overshoot: 0,
  motionBlur: 0, shake: { amount: 0, frequency: 1 }, cut: false, flowThrough: false,
};
const link = (from: string, to: string, s: Partial<TransitionSettings> = {}): CameraTransition =>
  ({ from, to, preset: 'glide', settings: { ...LINEAR, ...s }, origin: 'user' });
const track = (keys: CameraKey[], transitions: CameraTransition[] = []): CameraTrack => ({ keys, transitions, shutter: 0.5 });
const azOf = (s: { position: THREE.Vector3; target: THREE.Vector3 }) => {
  const d = s.position.clone().sub(s.target);
  return THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z));
};
const elOf = (s: { position: THREE.Vector3; target: THREE.Vector3 }) => {
  const d = s.position.clone().sub(s.target);
  return THREE.MathUtils.radToDeg(Math.asin(d.y / d.length()));
};
const mod360 = (a: number) => ((a % 360) + 360) % 360;

describe('cameraTrackAt', () => {
  it('turnLast holds the angle, then turns round in the last seconds; height glides the whole gap', () => {
    const tr = track([key('a', 0, { azimuth: 0, elevation: 50 }), key('b', 4, { azimuth: 90, elevation: 10 })], [link('a', 'b', { turnLast: 1 })]);
    expect(azOf(cameraTrackAt(tr, 2.9, ctx)!)).toBeCloseTo(0, 3);
    expect(azOf(cameraTrackAt(tr, 3.5, ctx)!)).toBeCloseTo(45, 3);
    expect(azOf(cameraTrackAt(tr, 4, ctx)!)).toBeCloseTo(90, 3);
    expect(elOf(cameraTrackAt(tr, 2, ctx)!)).toBeCloseTo(30, 3);
  });
  it('turnLast longer than the gap turns over the whole gap', () => {
    const tr = track([key('a', 0, { azimuth: 0 }), key('b', 1, { azimuth: 90 })], [link('a', 'b', { turnLast: 5 })]);
    expect(azOf(cameraTrackAt(tr, 0.5, ctx)!)).toBeCloseTo(45, 3);
  });
  it('a clockwise orbit between two keys facing the same way goes a full circle', () => {
    const tr = track([key('a', 0, { azimuth: 20 }), key('b', 4, { azimuth: 20 })], [link('a', 'b', { orbit: 'cw' })]);
    expect(mod360(azOf(cameraTrackAt(tr, 2, ctx)!))).toBeCloseTo(200, 3);
    const ccw = track([key('a', 0, { azimuth: 20 }), key('b', 4, { azimuth: 20 })], [link('a', 'b', { orbit: 'ccw' })]);
    expect(mod360(azOf(cameraTrackAt(ccw, 1, ctx)!))).toBeCloseTo(290, 3);
  });
  it('returns null for an empty track', () => {
    expect(cameraTrackAt(track([]), 1, ctx)).toBeNull();
  });
  it('one key holds for all t', () => {
    const tr = track([key('a', 2, { azimuth: 40 })]);
    const a = cameraTrackAt(tr, 0, ctx)!, b = cameraTrackAt(tr, 99, ctx)!;
    expect(a.position.distanceTo(b.position)).toBeCloseTo(0, 6);
    expect(azOf(a)).toBeCloseTo(40, 4);
  });
  it('azimuth crosses ±180 the short way', () => {
    const tr = track([key('a', 0, { azimuth: 170 }), key('b', 1, { azimuth: -170 })], [link('a', 'b')]);
    expect(Math.abs(azOf(cameraTrackAt(tr, 0.5, ctx)!))).toBeCloseTo(180, 3);
  });
  it('cw orbit with one extra turn goes 360 + the gap', () => {
    const tr = track([key('a', 0, { azimuth: 0 }), key('b', 1, { azimuth: 90 })], [link('a', 'b', { orbit: 'cw', extraTurns: 1 })]);
    expect(mod360(azOf(cameraTrackAt(tr, 0.5, ctx)!))).toBeCloseTo(225, 3);
  });
  it('ccw orbit goes the long way down', () => {
    const tr = track([key('a', 0, { azimuth: 0 }), key('b', 1, { azimuth: 90 })], [link('a', 'b', { orbit: 'ccw' })]);
    expect(mod360(azOf(cameraTrackAt(tr, 0.5, ctx)!))).toBeCloseTo(225, 3);
  });
  it('hard cut jumps at the second key', () => {
    const tr = track([key('a', 0, { azimuth: 0 }), key('b', 1, { azimuth: 90 })], [link('a', 'b', { cut: true })]);
    expect(azOf(cameraTrackAt(tr, 0.999, ctx)!)).toBeCloseTo(0, 4);
    expect(azOf(cameraTrackAt(tr, 1, ctx)!)).toBeCloseTo(90, 4);
  });
  it('auto-fit keeps the whole model in frame', () => {
    const tr = track([key('a', 0, { azimuth: 33, elevation: 40, distance: { fit: true, margin: 1.1 } })]);
    const s = cameraTrackAt(tr, 0, ctx)!;
    const cam = new THREE.PerspectiveCamera(s.fov, ctx.aspect, 0.01, 1000);
    cam.position.copy(s.position); cam.lookAt(s.target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const p = new THREE.Vector3(x, y, z).project(cam);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
    }
  });
  it('clamps elevation and distance', () => {
    const hi = cameraTrackAt(track([key('a', 0, { elevation: 120 })]), 0, ctx)!;
    expect(elOf(hi)).toBeCloseTo(89, 3);
    const lo = cameraTrackAt(track([key('a', 0, { elevation: -120, distance: { fit: false, value: 0 } })]), 0, ctx)!;
    expect(elOf(lo)).toBeCloseTo(-85, 3);
    expect(lo.position.distanceTo(lo.target)).toBeCloseTo(0.5, 6);
  });
  it('flowThrough keeps speed across a middle key', () => {
    const tr = track(
      [key('a', 0, { azimuth: 0 }), key('b', 1, { azimuth: 45 }), key('c', 2, { azimuth: 90 })],
      [link('a', 'b', { flowThrough: true }), link('b', 'c', { flowThrough: true })],
    );
    const d = azOf(cameraTrackAt(tr, 1.01, ctx)!) - azOf(cameraTrackAt(tr, 0.99, ctx)!);
    expect(d).toBeGreaterThan(0.7);
    expect(d).toBeLessThan(1.1);
  });
  it('without flowThrough the camera eases to a stop at a middle key', () => {
    const tr = track(
      [key('a', 0, { azimuth: 0 }), key('b', 1, { azimuth: 45 }), key('c', 2, { azimuth: 90 })],
      [link('a', 'b', { curve: { kind: 'easeInOut', strength: 1 } }), link('b', 'c', { curve: { kind: 'easeInOut', strength: 1 } })],
    );
    const d = azOf(cameraTrackAt(tr, 1.01, ctx)!) - azOf(cameraTrackAt(tr, 0.99, ctx)!);
    expect(Math.abs(d)).toBeLessThan(0.1);
  });
  it('lens interpolates with its own curve', () => {
    const tr = track([key('a', 0, { lensMm: 35 }), key('b', 1, { lensMm: 85 })], [link('a', 'b', { lensCurve: { kind: 'linear', strength: 0 } })]);
    expect(cameraTrackAt(tr, 0.5, ctx)!.lensMm).toBeCloseTo(60, 6);
  });
  it('a longer lens gives a narrower field of view', () => {
    const w = cameraTrackAt(track([key('a', 0, { lensMm: 24 })]), 0, ctx)!;
    const n = cameraTrackAt(track([key('a', 0, { lensMm: 100 })]), 0, ctx)!;
    expect(n.fov).toBeLessThan(w.fov);
  });
  it('a build target follows the build box over time', () => {
    const grow: CameraContext = { ...ctx, buildBox: (t) => new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, t, 1)) };
    const tr = track([key('a', 0, { target: { kind: 'build' } })]);
    expect(cameraTrackAt(tr, 4, grow)!.target.y).toBeCloseTo(2, 6);
  });
  it('roll and shutter come through', () => {
    const tr = track([key('a', 0, { roll: 0 }), key('b', 1, { roll: 20 })], [link('a', 'b', { motionBlur: 0.9 })]);
    const s = cameraTrackAt(tr, 0.5, ctx)!;
    expect(s.roll).toBeCloseTo(10, 6);
    expect(s.shutter).toBeCloseTo(0.9, 6);
    expect(cameraTrackAt(tr, 5, ctx)!.shutter).toBeCloseTo(0.5, 6);
  });
  it('straight path moves the camera along a line', () => {
    const tr = track([key('a', 0, { azimuth: -45 }), key('b', 1, { azimuth: 45 })], [link('a', 'b', { path: 'straight' })]);
    const a = cameraTrackAt(tr, 0, ctx)!, b = cameraTrackAt(tr, 1, ctx)!, m = cameraTrackAt(tr, 0.5, ctx)!;
    expect(m.position.distanceTo(a.position.clone().lerp(b.position, 0.5))).toBeCloseTo(0, 5);
  });
});
