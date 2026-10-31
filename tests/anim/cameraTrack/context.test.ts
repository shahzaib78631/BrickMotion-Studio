import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyShot, buildCameraContext, resolveExportCamera } from '../../../src/anim/cameraTrack/context';
import { buildFocusBox, worldBox3 } from '../../../src/anim/camera';
import type { Timeline } from '../../../src/anim/timeline';

const tl = () => ({
  intro: 1, buildEnd: 5, duration: 6, heroOrbit: true, camKeys: [], subBuilds: [],
  units: [
    { kind: 'piece', keys: ['a'], start: 1, dur: 1, step: 0, land: { min: [-20, -24, -20], max: [20, 0, 20] } },
    { kind: 'piece', keys: ['b'], start: 3, dur: 1, step: 1, land: { min: [-20, -48, -20], max: [20, -24, 20] } },
  ],
  modelBox: { min: [-20, -48, -20], max: [20, 0, 20] },
} as unknown as Timeline);

describe('buildCameraContext', () => {
  it('frames what the automatic build camera frames, smoothed over time', async () => {
    const { smoothBoxOverTime, atLeast } = await import('../../../src/anim/cameraTrack/context');
    const t = tl();
    const ctx = buildCameraContext(t, 9 / 16, 36);
    const raw = (x: number) => atLeast(worldBox3(buildFocusBox(t, x)), worldBox3(t.modelBox), 0.35);
    for (const at of [0, 1.5, 3.5, 5]) {
      const want = smoothBoxOverTime(raw, at, 0.6);
      expect(ctx.buildBox(at).min.distanceTo(want.min)).toBeLessThan(1e-9);
      expect(ctx.buildBox(at).max.distanceTo(want.max)).toBeLessThan(1e-9);
    }
    expect(ctx.modelBox.equals(worldBox3(t.modelBox))).toBe(true);
    expect(ctx.duration).toBe(6);
  });
  it('the landing piece is the one in the air, else none', () => {
    const ctx = buildCameraContext(tl(), 9 / 16, 36);
    expect(ctx.pieceBox(3.5)!.equals(worldBox3({ min: [-20, -48, -20], max: [20, -24, 20] }))).toBe(true);
    expect(ctx.pieceBox(2.5)).toBeNull();
  });
});

describe('applyShot', () => {
  it('rolls the camera about its view axis', () => {
    const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    applyShot(cam, { position: new THREE.Vector3(0, 0, 10), target: new THREE.Vector3(), fov: 30, roll: 90, lensMm: 50, focus: 0.5, blur: 0, shutter: 0 });
    cam.updateMatrixWorld();
    const up = new THREE.Vector3(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    expect(Math.abs(up.x)).toBeCloseTo(1, 6);
    expect(cam.fov).toBe(30);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    expect(fwd.z).toBeCloseTo(-1, 6);
  });
});

describe('videoCameraInCharge', () => {
  it('a camera track the video uses wins over a saved scene camera', async () => {
    const { videoCameraInCharge } = await import('../../../src/anim/cameraTrack/context');
    const scene = { useCameraForVideo: true, activeCameraId: 'c1' };
    expect(videoCameraInCharge(scene, 'track', 5)).toBe('track');
    expect(videoCameraInCharge(scene, 'track', 0)).toBe('scene');
    expect(videoCameraInCharge(scene, 'automatic', 5)).toBe('scene');
    expect(videoCameraInCharge({ useCameraForVideo: false, activeCameraId: 'c1' }, 'automatic', 0)).toBe('automatic');
    expect(videoCameraInCharge(undefined, 'track', 3)).toBe('track');
  });
});

describe('viewportFollowsTrack', () => {
  it('plays the track in the editor view, and in camera view whenever the video uses the track', async () => {
    const { viewportFollowsTrack } = await import('../../../src/anim/cameraTrack/context');
    const base = { cameraView: false, follow: true, stagingPending: false, exportCamera: 'track' as const, trackKeys: 4, scene: { useCameraForVideo: true, activeCameraId: 'c1' } };
    expect(viewportFollowsTrack(base)).toBe(true);
    expect(viewportFollowsTrack({ ...base, cameraView: true })).toBe(true);
    expect(viewportFollowsTrack({ ...base, cameraView: true, exportCamera: 'automatic' })).toBe(false);
    expect(viewportFollowsTrack({ ...base, follow: false })).toBe(false);
    expect(viewportFollowsTrack({ ...base, stagingPending: true })).toBe(false);
    expect(viewportFollowsTrack({ ...base, trackKeys: 0 })).toBe(false);
  });
});

describe('resolveExportCamera', () => {
  it('uses the track only when there is one', () => {
    expect(resolveExportCamera('track', true)).toBe('track');
    expect(resolveExportCamera('track', false)).toBe('automatic');
    expect(resolveExportCamera('automatic', true)).toBe('automatic');
    expect(resolveExportCamera('buildView', true)).toBe('buildView');
  });
});

describe('shotLens', () => {
  it('turns a shot\'s focus and blur into a lens setting', async () => {
    const { shotLens } = await import('../../../src/anim/cameraTrack/context');
    const { LENS_BLUR_PX } = await import('../../../src/render/looks');
    const base = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 30, roll: 0, lensMm: 50, shutter: 0 };
    expect(shotLens({ ...base, focus: 0.3, blur: 0 })).toEqual({ blur: 'off', focus: 0.3, px: 0 });
    expect(shotLens({ ...base, focus: 0.7, blur: 0.5 })).toEqual({ blur: 'medium', focus: 0.7, px: 0.5 * LENS_BLUR_PX.strong });
  });
});

describe('smoothBoxOverTime', () => {
  it('turns a sudden jump of the framed box into a glide about a second long', async () => {
    const { smoothBoxOverTime } = await import('../../../src/anim/cameraTrack/context');
    const a = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 4, 14));
    const b = new THREE.Box3(new THREE.Vector3(20, 0, -1), new THREE.Vector3(24, 2, 0));
    const jump = (t: number) => (t < 5 ? a : b);
    const at = (t: number) => smoothBoxOverTime(jump, t, 0.6).getCenter(new THREE.Vector3());
    // well away from the jump it is the box itself
    expect(at(3).distanceTo(a.getCenter(new THREE.Vector3()))).toBeLessThan(1e-9);
    expect(at(7).distanceTo(b.getCenter(new THREE.Vector3()))).toBeLessThan(1e-9);
    // no step between frames bigger than a small share of the whole move
    const whole = a.getCenter(new THREE.Vector3()).distanceTo(b.getCenter(new THREE.Vector3()));
    for (let t = 4; t < 6; t += 1 / 30) expect(at(t).distanceTo(at(t + 1 / 30))).toBeLessThan(whole * 0.08);
  });
});

describe('atLeast', () => {
  it('grows a tiny framed box round its centre to a share of the model size, never shrinks one', async () => {
    const { atLeast } = await import('../../../src/anim/cameraTrack/context');
    const model = new THREE.Box3(new THREE.Vector3(0, 0, -8), new THREE.Vector3(10, 3, 6));
    const tiny = new THREE.Box3(new THREE.Vector3(20, 0, -1), new THREE.Vector3(24, 2, 0));
    const grown = atLeast(tiny, model, 0.35);
    const s = grown.getSize(new THREE.Vector3());
    for (const v of s.toArray()) expect(v).toBeGreaterThanOrEqual(0.35 * 14 - 1e-9);
    expect(grown.getCenter(new THREE.Vector3()).distanceTo(tiny.getCenter(new THREE.Vector3()))).toBeLessThan(1e-9);
    expect(atLeast(model, model, 0.35).containsBox(model)).toBe(true);
    const big = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 6, 6));
    expect(atLeast(big, model, 0.35)).toBe(big);
  });
});
