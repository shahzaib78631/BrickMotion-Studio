import { expect, test } from 'vitest';
import { buildPartGeometry } from '../../src/ldraw/geometry';
import { PartLibrary } from '../../src/ldraw/library';
import { fixtureFetchText } from '../helpers/fixtureLibrary';

const lib = new PartLibrary(fixtureFetchText);

test('main-color geometry keeps every triangle and has normals', async () => {
  const flat = (await lib.loadPart('3001'))!;
  const g = buildPartGeometry(flat);
  const triCount = flat.tris.get(16)!.length / 9;
  expect(g.main!.getAttribute('position').count).toBe(triCount * 3);
  expect(g.main!.getAttribute('normal')).toBeDefined();
  expect(g.fixed).toHaveLength(0);
});

test('fixed colors get their own geometry', async () => {
  const g = buildPartGeometry((await lib.loadPart('twocolor'))!);
  expect(g.fixed).toHaveLength(1);
  expect(g.fixed[0].color).toBe(4);
  expect(g.fixed[0].doubleSided).toBe(false);
});

test('non-certified main color goes to the double-sided geometry', async () => {
  const g = buildPartGeometry((await lib.loadPart('nobfc'))!);
  expect(g.main).toBeNull();
  expect(g.mainDoubleSided!.getAttribute('position').count).toBe(3);
});

test('outline edges come through as line segments in part space', async () => {
  const flat = (await lib.loadPart('3938'))!;
  expect(flat.edges.length).toBeGreaterThan(0);
  expect(flat.edges.length % 6).toBe(0); // xyz pairs
  const g = buildPartGeometry(flat);
  expect(g.edges!.getAttribute('position').count).toBe(flat.edges.length / 3);
  // edges sit on the part: inside its (full) bounds
  const b = flat.fullBox!;
  for (let i = 0; i < flat.edges.length; i += 3)
    for (let a = 0; a < 3; a++) {
      expect(flat.edges[i + a]).toBeGreaterThanOrEqual(b.min[a] - 1e-6);
      expect(flat.edges[i + a]).toBeLessThanOrEqual(b.max[a] + 1e-6);
    }
});
