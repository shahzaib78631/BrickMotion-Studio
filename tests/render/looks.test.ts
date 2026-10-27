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
  expect(sanitizeMaterials({ finish: 'glossy', texture: 'nope', floor: 'wood' })).toEqual({ finish: 'glossy', texture: 'none', floor: 'wood' });
  expect(floorFor('white', 'auto')).toBe('reflective');
  expect(floorFor('soft', 'auto')).toBe('shadow');
  expect(floorFor('soft', 'concrete')).toBe('concrete');
});
