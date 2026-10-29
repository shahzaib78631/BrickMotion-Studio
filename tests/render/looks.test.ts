import { expect, test } from 'vitest';
import { DEFAULT_MATERIALS, SCENES, floorFor, sanitizeMaterials, sceneOf, scenePixels } from '../../src/render/looks';

test('every scene has a unique id and a backdrop that spans bottom to top', () => {
  expect(new Set(SCENES.map((s) => s.id)).size).toBe(SCENES.length);
  for (const s of SCENES) {
    expect(s.stops[0].at).toBe(0);
    expect(s.stops[s.stops.length - 1].at).toBe(1);
  }
});

test('the backdrop pixels follow the stops and the pool of light brightens the dark scene', () => {
  const soft = scenePixels(sceneOf('soft'), 2, 16);
  expect([...soft.slice(0, 3)]).toEqual([172, 171, 180]); // bottom row
  const dark = scenePixels(sceneOf('dark'), 32, 32);
  const at = (x: number, y: number) => dark[(y * 32 + x) * 4];
  // spot near the top right (top-left origin y = 0.3 → row ~22 from the bottom) is brighter than a corner
  expect(at(20, 22)).toBeGreaterThan(at(0, 0) + 40);
});

test('materials from storage are sanitised, and auto floors follow the scene', () => {
  expect(sanitizeMaterials(undefined)).toEqual(DEFAULT_MATERIALS);
  expect(sanitizeMaterials({ finish: 'glossy', texture: 'nope', floor: 'wood' })).toEqual({ finish: 'glossy', texture: 'none', floor: 'wood', studLogos: true, roundedEdges: true, ao: { enabled: true, strength: null, radius: null }, contactShadows: 0.5, environment: 'room' });
  expect(floorFor('white', 'auto')).toBe('reflective');
  expect(floorFor('soft', 'auto')).toBe('shadow');
  expect(floorFor('soft', 'concrete')).toBe('concrete');
});

test('stud logos are a stored material choice, on by default', () => {
  expect(DEFAULT_MATERIALS.studLogos).toBe(true);
  expect(sanitizeMaterials({ studLogos: false }).studLogos).toBe(false);
  expect(sanitizeMaterials({ studLogos: 'yes' }).studLogos).toBe(true);
});

test('render scenes use ambient occlusion, soft shadows and no outlines', () => {
  for (const s of SCENES.filter((x) => x.collection === 'render')) {
    expect(s.ao).toBeGreaterThan(0.5);
    expect(s.shadowSoftness).toBeGreaterThan(4);
    expect(s.outlines).toBe(false);
  }
  // classic scenes keep their original look
  expect(sceneOf('soft').ao).toBeUndefined();
  expect(sceneOf('soft').outlines).toBeUndefined();
});

test('ambient occlusion: scene values unless the user overrides them', async () => {
  const { aoFor, sanitizeMaterials: clean } = await import('../../src/render/looks');
  const scene = { enabled: true, strength: null, radius: null };
  expect(aoFor('lavender', scene)).toEqual({ intensity: 0.9, radius: 0.5 });
  expect(aoFor('lavender', { ...scene, enabled: false }).intensity).toBe(0);
  expect(aoFor('lavender', { enabled: true, strength: 0.4, radius: 1 })).toEqual({ intensity: 0.4, radius: 1 });
  // classic scenes have none, but a chosen strength turns it on there too
  expect(aoFor('soft', scene).intensity).toBe(0);
  expect(aoFor('soft', { ...scene, strength: 0.6 }).intensity).toBe(0.6);
  expect(clean({ ao: { enabled: false, strength: 9, radius: 'x' } }).ao).toEqual({ enabled: false, strength: 1.5, radius: null });
  expect(clean({}).ao).toEqual(scene);
});
