import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { sceneCameraStill } from '../../src/export/capture';
import { EMPTY_SCENE_SETUP, type SceneSetup } from '../../src/render/sceneSetup';

const setup = (extra: Partial<SceneSetup> = {}): SceneSetup => ({
  ...EMPTY_SCENE_SETUP,
  cameras: [{ kind: 'camera', id: 'c1', name: 'Hero', position: [0, 0, 10], target: [0, 0, 0], fov: 35, near: 0.1, far: 500 }],
  activeCameraId: 'c1',
  ...extra,
});

describe('sceneCameraStill', () => {
  it('is the active camera looking at its target', () => {
    const shot = sceneCameraStill(setup(), 9 / 16)!;
    expect(shot.ortho).toBe(false);
    expect(shot.fov).toBe(35);
    expect(shot.position.toArray()).toEqual([0, 0, 10]);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(shot.quaternion);
    expect(forward.z).toBeCloseTo(-1);
    expect(shot.view).toBeNull();
  });

  it('crops to the render border when asked, at the image aspect', () => {
    const shot = sceneCameraStill(setup({ cropToRegion: true, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }), 16 / 9)!;
    expect(shot.view?.enabled).toBe(true);
    expect(shot.view!.fullWidth / shot.view!.fullHeight).toBeCloseTo(16 / 9);
    expect(shot.view!.width / shot.view!.fullWidth).toBeCloseTo(0.5);
  });

  it('is null without a usable camera', () => {
    expect(sceneCameraStill(undefined, 1)).toBeNull();
    expect(sceneCameraStill({ ...EMPTY_SCENE_SETUP }, 1)).toBeNull();
  });
});
