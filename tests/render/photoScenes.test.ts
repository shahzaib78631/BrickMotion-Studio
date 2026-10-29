import { describe, expect, it } from 'vitest';
import { SCENES, floorFor, sceneOf, scenePixels } from '../../src/render/looks';
import { PHOTO_RIGS, createPhotoRigLights } from '../../src/render/photoRigs';

const photoLooks = SCENES.filter((scene) => scene.collection === 'photo');

describe('photographic scenes', () => {
  it('adds distinct grey, blue, soft white, sage, warm and dark tabletop looks', () => {
    expect(photoLooks.map((scene) => scene.id)).toEqual([
      'photo-grey', 'slate-blue', 'porcelain', 'sage', 'sandstone', 'graphite',
    ]);
    expect(new Set(SCENES.map((scene) => scene.id)).size).toBe(SCENES.length);
    for (const scene of photoLooks) {
      expect(scene.floor).toBe('shadow');
      expect(scene.shadowOpacity).toBeGreaterThan(0);
      expect(scene.keyDirection?.[1]).toBeGreaterThan(0);
      expect(scene.fillDirection?.[1]).toBeGreaterThan(0);
      expect(scene.rim).toBeGreaterThan(0);
      expect(scene.stops[0].at).toBe(0);
      expect(scene.stops.at(-1)?.at).toBe(1);
      expect(scenePixels(scene, 8, 12)).toHaveLength(8 * 12 * 4);
    }
  });
  it('keeps old project defaults and explicit floor overrides stable', () => {
    expect(sceneOf(undefined).id).toBe('soft');
    expect(sceneOf('nonexistent').id).toBe('soft');
    expect(floorFor('slate-blue', 'auto')).toBe('shadow');
    expect(floorFor('slate-blue', 'wood')).toBe('wood');
    expect(sceneOf('soft').key).toBe(2.35);
  });
  it('uses a real single shadow-casting key in each editable photo lighting rig', () => {
    const focus: [number, number, number] = [120, 35, -80];
    expect(PHOTO_RIGS).toHaveLength(4);
    for (const rig of PHOTO_RIGS) {
      expect(photoLooks.some((look) => look.id === rig.look)).toBe(true);
      const lights = createPhotoRigLights(rig.id, focus, 200);
      expect(lights).toHaveLength(4);
      expect(new Set(lights.map((light) => light.id)).size).toBe(lights.length);
      expect(lights.filter((light) => light.castShadow)).toHaveLength(1);
      expect(lights.filter((light) => light.type === 'ambient')).toHaveLength(1);
      for (const light of lights) {
        expect(light.target).toEqual(focus);
        expect(light.enabled).toBe(true);
        expect(light.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(light.position.every(Number.isFinite)).toBe(true);
        if (light.type !== 'ambient') expect(Math.hypot(...light.position.map((v, i) => v - focus[i]))).toBeCloseTo(600);
      }
    }
  });
  it('scales photo rigs to model size and does not reuse object identities', () => {
    const small = createPhotoRigLights('softbox', [0, 0, 0], 30);
    const big = createPhotoRigLights('softbox', [0, 0, 0], 300);
    expect(Math.hypot(...big[0].position)).toBeGreaterThan(Math.hypot(...small[0].position));
    expect(big[0].id).not.toBe(small[0].id);
  });
});

describe('render studio scenes', () => {
  const renderLooks = SCENES.filter((scene) => scene.collection === 'render');
  it('adds pastel and grey seamless looks with soft overhead shadows', () => {
    expect(renderLooks.map((scene) => scene.id)).toEqual([
      'lavender', 'render-grey', 'steel-grey', 'powder-blue', 'mint', 'peach', 'blush', 'butter', 'cobalt',
    ]);
    for (const scene of renderLooks) {
      expect(scene.floor).toBe('shadow');
      expect(scene.shadowOpacity).toBeGreaterThan(0.2);
      // the key comes mostly from above, so shadows stay short
      const [x, y, z] = scene.keyDirection!;
      expect(y).toBeGreaterThan(2 * Math.hypot(x, z));
      expect(scenePixels(scene, 4, 6)).toHaveLength(4 * 6 * 4);
      expect(sceneOf(scene.id).id).toBe(scene.id);
    }
  });
});
