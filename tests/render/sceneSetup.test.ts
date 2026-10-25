import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { activeSceneCamera, applyCameraCrop, applySceneCamera, cameraCrop, cameraFrame,
  createCamera, createLight, regionFromDrag, removeObject, sceneSetupOf, updateObject } from '../../src/render/sceneSetup';
import { parsePlan } from '../../src/plan/schema';
import { emptyPlan } from '../../src/plan/types';

describe('project scene cameras and lighting', () => {
  it('persists and restores a camera, lamps and border through PlanSchema', () => {
    const camera = createCamera(new THREE.Vector3(5, 8, 22), new THREE.Vector3(0, 3, 0));
    const sun = createLight('sun', new THREE.Vector3(12, 20, 8), new THREE.Vector3(0, 0, 0));
    const plan = { ...emptyPlan('Test scene'), sceneSetup: {
      ...sceneSetupOf(), cameras: [camera], lights: [sun], activeCameraId: camera.id,
      region: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 }, cropToRegion: true,
    } };
    const loaded = parsePlan(JSON.parse(JSON.stringify(plan)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.plan.sceneSetup).toEqual(plan.sceneSetup);
  });
  it('rejects camera pointing to a missing ID and invalid region', () => {
    const basic = { ...emptyPlan(), sceneSetup: { ...sceneSetupOf(), activeCameraId: 'gone' } };
    expect(parsePlan(basic).ok).toBe(false);
    expect(parsePlan({ ...emptyPlan(), sceneSetup: { ...sceneSetupOf(), region: { x: .8, y: 0, width: .3, height: .2 } } }).ok).toBe(false);
  });
  it('rejects degenerate camera transforms or backwards clipping ranges', () => {
    const cam = createCamera(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0));
    const base = { ...emptyPlan(), sceneSetup: { ...sceneSetupOf(), cameras: [cam], activeCameraId: cam.id } };
    expect(parsePlan(base).ok).toBe(true);
    expect(parsePlan({ ...base, sceneSetup: { ...base.sceneSetup, cameras: [{ ...cam, target: [...cam.position] }] } }).ok).toBe(false);
    expect(parsePlan({ ...base, sceneSetup: { ...base.sceneSetup, cameras: [{ ...cam, far: cam.near }] } }).ok).toBe(false);
  });
  it('produces unique scene IDs and exact initial camera pose', () => {
    const one = createCamera(new THREE.Vector3(7, 9, 12), new THREE.Vector3(1, 2, 3));
    const two = createCamera(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
    expect(one.id).not.toBe(two.id);
    expect(one.position).toEqual([7, 9, 12]);
    expect(one.target).toEqual([1, 2, 3]);
  });
  it('creates all four light types without inventing physical properties', () => {
    for (const type of ['sun', 'point', 'spot', 'ambient'] as const) {
      const lamp = createLight(type, new THREE.Vector3(0, 12, 4), new THREE.Vector3());
      expect(lamp.type).toBe(type);
      expect(lamp.color).toMatch(/^#/);
      expect(lamp.enabled).toBe(true);
    }
  });
  it('supports both drag directions and rejects tiny accidental drags', () => {
    expect(regionFromDrag([.7, .8], [.2, .3])).toEqual({ x: .2, y: .3, width: .5, height: .5 });
    expect(regionFromDrag([.2, .3], [.201, .301])).toBeNull();
    expect(regionFromDrag([-.4, .4], [1.6, .8])).toEqual({ x: 0, y: .4, width: 1, height: .4 });
  });
  it('expands arbitrary camera regions preserving output aspect, always within frame', () => {
    const crop = cameraCrop({ x: .83, y: .15, width: .16, height: .38 })!;
    expect(crop.width).toBeCloseTo(crop.height);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1);
  });
  it('fits the camera border inside both portrait and landscape viewports', () => {
    for (const aspect of [9/16, 1, 16/9]) {
      const b = cameraFrame(720, 500, aspect);
      expect(b.width / b.height).toBeCloseTo(aspect);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(720);
    }
  });
  it('applies the same normalized crop to a Three perspective camera', () => {
    const c = new THREE.PerspectiveCamera(45, 16/9, .1, 2000);
    applyCameraCrop(c, { ...sceneSetupOf(), region: { x: .25, y: .25, width: .5, height: .5 }, cropToRegion: true });
    expect(c.view?.fullWidth).toBeCloseTo(10000 * 16/9);
    expect(c.view?.fullHeight).toBe(10000);
    expect(c.view?.offsetX).toBeCloseTo(2500 * 16/9);
    expect(c.view?.width).toBeCloseTo(5000 * 16/9);
    expect(c.aspect).toBeCloseTo(16/9);
    applyCameraCrop(c, undefined);
    expect(c.view?.enabled).toBe(false);
  });
  it('overrides the procedural camera only when an active camera exists', () => {
    const custom = createCamera(new THREE.Vector3(10, 12, 20), new THREE.Vector3(0, 1, 2));
    const setup = { ...sceneSetupOf(), cameras: [custom], activeCameraId: custom.id };
    const output = new THREE.PerspectiveCamera(50, 1.5);
    expect(applySceneCamera(output, setup)).toBe(true);
    expect(output.position.toArray()).toEqual([10, 12, 20]);
    expect(output.fov).toBe(custom.fov);
    expect(applySceneCamera(output, { ...setup, useCameraForVideo: false })).toBe(false);
  });
  it('updates and removes objects, falling back to next available camera', () => {
    const cam1 = createCamera(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
    const cam2 = createCamera(new THREE.Vector3(), new THREE.Vector3(0, 0, -2));
    const setup = { ...sceneSetupOf(), cameras: [cam1, cam2], activeCameraId: cam1.id };
    const renamed = updateObject(setup, cam2.id, (c) => ({ ...c, name: 'Close-up' }));
    expect(renamed.cameras[1].name).toBe('Close-up');
    const removed = removeObject(renamed, cam1.id);
    expect(activeSceneCamera(removed)?.id).toBe(cam2.id);
  });
});
