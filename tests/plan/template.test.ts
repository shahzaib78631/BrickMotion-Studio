import { describe, expect, it } from 'vitest';
import { applyTemplateToPlan, fitScene, readTemplate, templateFrom } from '../../src/plan/template';
import { emptyPlan, type Plan } from '../../src/plan/types';
import { DEFAULT_SETTINGS } from '../../src/storage/settings';
import { EMPTY_SCENE_SETUP, type SceneSetup } from '../../src/render/sceneSetup';

const scene: SceneSetup = {
  ...EMPTY_SCENE_SETUP,
  cameras: [{ kind: 'camera', id: 'c1', name: 'Camera 1', position: [10, 10, 10], target: [0, 0, 0], fov: 40, near: 0.1, far: 100 }],
  lights: [{ kind: 'light', id: 'l1', name: 'Point 1', type: 'point', position: [0, 5, 0], target: [0, 0, 0], color: '#fff', intensity: 100, angle: 40, distance: 20, castShadow: false, enabled: true }],
  activeCameraId: 'c1',
};

const modelPlan = (): Plan => ({
  ...emptyPlan('Car'),
  steps: [{ pieces: [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }],
  sceneSetup: scene, assemblySpot: { x: 3, z: 4, angle: 90 }, loosePiecesFollow: false,
});

describe('project templates', () => {
  it('keeps the look and scene but never the model', () => {
    const t = templateFrom('Studio look', DEFAULT_SETTINGS, modelPlan(), { center: [0, 0, 0], size: 10 }, 't1', 5);
    expect(t.name).toBe('Studio look');
    expect(t.settings.video.format).toBe(DEFAULT_SETTINGS.video.format);
    expect(t.scene?.cameras[0].id).toBe('c1');
    expect(t).not.toHaveProperty('steps');
    expect(JSON.stringify(t)).not.toContain('3001.dat');
    expect('apiKey' in t.settings).toBe(false);
  });

  it('fits cameras and lights to a model twice the size somewhere else', () => {
    const out = fitScene(scene, { center: [0, 0, 0], size: 10 }, { center: [5, 0, 0], size: 20 });
    expect(out.cameras[0].position).toEqual([25, 20, 20]);
    expect(out.cameras[0].target).toEqual([5, 0, 0]);
    expect(out.cameras[0].far).toBe(200);
    expect(out.lights[0].position).toEqual([5, 10, 0]);
    expect(out.lights[0].intensity).toBe(400);
    expect(out.lights[0].distance).toBe(40);
    // the template itself is untouched
    expect(scene.cameras[0].position).toEqual([10, 10, 10]);
  });

  it('applies to another model without touching its pieces', () => {
    const t = templateFrom('Look', DEFAULT_SETTINGS, modelPlan(), { center: [0, 0, 0], size: 10 }, 't1');
    const other: Plan = { ...emptyPlan('Plane'), steps: [{ pieces: [{ part: '3003.dat', color: 1, x: 2, y: 0, z: 2, rot: 0 }] }] };
    const next = applyTemplateToPlan(other, t, { center: [0, 0, 0], size: 10 });
    expect(next.steps).toBe(other.steps);
    expect(next.name).toBe('Plane');
    expect(next.sceneSetup?.activeCameraId).toBe('c1');
    expect(next.assemblySpot).toEqual({ x: 3, z: 4, angle: 90 });
    expect(next.loosePiecesFollow).toBe(false);
  });

  it('reads back its own file and rejects others', () => {
    const t = templateFrom('Look', DEFAULT_SETTINGS, modelPlan(), null, 't1');
    expect(readTemplate(JSON.parse(JSON.stringify(t)))?.name).toBe('Look');
    expect(readTemplate({ format: 'brickmotion-plan' })).toBeNull();
    expect(readTemplate({ ...t, reference: { center: [0, 0], size: 1 } })).toBeNull();
  });
});
