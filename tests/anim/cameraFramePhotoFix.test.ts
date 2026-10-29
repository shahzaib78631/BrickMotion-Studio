import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Timeline } from '../../src/anim/timeline';
import { cameraFrameBands } from '../../src/anim/timeline';
import { initialStagingBounds, fitStagingCamera, frameStagingScene } from '../../src/render/stagingCamera';
import { createCamera, sceneCoordinateFromStuds, sceneCoordinateToStuds, sceneSetupOf } from '../../src/render/sceneSetup';
import { worldBox3 } from '../../src/anim/camera';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({
  min: [x0, y0, z0] as [number, number, number], max: [x1, y1, z1] as [number, number, number],
});
const example = {
  modelBox: box(-60, -80, -60, 60, 0, 60),
  // One piece visible at t=0 and an offscreen work bay used much later.
  tracks: new Map([
    ['initial', { appear: -Infinity, floorBox: box(-240, -24, -400, -180, 0, -350), moves: [] }],
    ['later', { appear: 9, floorBox: box(2000, -24, 2500, 2040, 0, 2540), moves: [] }],
  ]),
  units: [],
} as unknown as Timeline;

describe('camera-frame photographic staging repair', () => {
  it('does not multiply scene-camera fields by twenty LDraw units', () => {
    expect(sceneCoordinateToStuds(12.34567)).toBe(12.346);
    expect(sceneCoordinateFromStuds(24.092)).toBe(24.092);
  });

  it('fits only the visible starting pieces and the build, not later work bays', () => {
    expect(initialStagingBounds(example)).toEqual(box(-240, -80, -400, 60, 0, 60));
    const distant = createCamera(new THREE.Vector3(107, 482, 263), new THREE.Vector3(31, 5, 0), 29.5);
    const fitted = fitStagingCamera(example, distant, 9 / 16);
    const old = new THREE.Vector3(...distant.position).distanceTo(new THREE.Vector3(...distant.target));
    const now = new THREE.Vector3(...fitted.position).distanceTo(new THREE.Vector3(...fitted.target));
    expect(now).toBeLessThan(old);
    const cam = new THREE.PerspectiveCamera(fitted.fov, 9 / 16, 0.05, 5000);
    cam.position.fromArray(fitted.position);
    cam.lookAt(new THREE.Vector3(...fitted.target));
    cam.updateMatrixWorld();
    const b = worldBox3(initialStagingBounds(example));
    let extent = 0;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const ndc = new THREE.Vector3(x, y, z).project(cam);
      expect(Math.abs(ndc.x)).toBeLessThan(0.99);
      expect(Math.abs(ndc.y)).toBeLessThan(0.99);
      extent = Math.max(extent, Math.abs(ndc.x), Math.abs(ndc.y));
    }
    expect(extent).toBeGreaterThan(0.65); // not a tiny dot in the middle
  });

  it('preserves custom camera ID / lights and makes its shot available in Preview & MP4', () => {
    const cam = createCamera(new THREE.Vector3(100, 200, 100), new THREE.Vector3());
    const setup = { ...sceneSetupOf(), cameras: [cam], activeCameraId: cam.id, useCameraForVideo: false };
    const fitted = frameStagingScene(example, setup, 9 / 16);
    expect(fitted.cameras[0].id).toBe(cam.id);
    expect(fitted.cameras[0].position).not.toEqual(cam.position);
    expect(fitted.useCameraForVideo).toBe(true);
    expect(frameStagingScene(example, sceneSetupOf(), 9 / 16).cameras).toHaveLength(1);
  });

  it('builds portrait and landscape-shaped bays without overlapping the model or each other', () => {
    const model = box(-60, -80, -80, 60, 0, 80);
    const portrait = cameraFrameBands(model, 3600, 'around', 9 / 16);
    const landscape = cameraFrameBands(model, 3600, 'around', 16 / 9);
    const bounds = (regions: typeof portrait) => ({
      width: Math.max(...regions.map((r) => r.x0 + r.width)) - Math.min(...regions.map((r) => r.x0)),
      depth: Math.max(...regions.map((r) => r.z0 + r.depth)) - Math.min(...regions.map((r) => r.z0)),
    });
    expect(bounds(portrait).width / bounds(portrait).depth).toBeLessThan(1);
    expect(bounds(landscape).width / bounds(landscape).depth).toBeGreaterThan(1);
    for (const regions of [portrait, landscape]) {
      expect(regions).toHaveLength(4);
      for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i], b = regions[j];
        expect(a.x0 + a.width <= b.x0 || b.x0 + b.width <= a.x0 || a.z0 + a.depth <= b.z0 || b.z0 + b.depth <= a.z0).toBe(true);
      }
    }
  });
});
