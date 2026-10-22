import { expect, test } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart } from '../../src/ldraw/metrics';
import { fixtureFetchText } from '../helpers/fixtureLibrary';

const lib = new PartLibrary(fixtureFetchText);

test('2x4 brick footprint and height', async () => {
  const m = measurePart(await lib.loadPart('3001'), '3001');
  expect(m.footprint).toEqual({ w: 4, d: 2 });
  expect(m.heightPlates).toBe(3);
  expect(m.placeholder).toBe(false);
});

test('plate is one plate high', async () => {
  expect(measurePart(await lib.loadPart('3020'), '3020').heightPlates).toBe(1);
});

test('missing part gets placeholder metrics', () => {
  const m = measurePart(null, '3001x');
  expect(m).toMatchObject({ placeholder: true, footprint: { w: 1, d: 1 }, heightPlates: 3 });
  expect(m.body).toEqual({ min: [0, 0, 0], max: [20, 24, 20] });
});
