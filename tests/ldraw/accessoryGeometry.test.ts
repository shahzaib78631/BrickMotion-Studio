import { expect, it } from 'vitest';
import { sectionAtY } from '../../scripts/lib/accessory-geometry';

it('interpolates a taper rather than treating its bounding box as its section', () => {
  const result = sectionAtY([0, 0, 0, 4, 4, 0, 0, 4, 8], 2);
  expect(result.boundsXZ).toEqual({ min: [0, 0], max: [2, 4] });
  expect(result.segments).toEqual([[[2, 0], [0, 4]]]);
  expect(sectionAtY([0, 0, 0, 4, 4, 0, 0, 4, 8], 5).boundsXZ).toBeNull();
});

it('does not invent sections from coplanar faces or invalid triangles', () => {
  expect(sectionAtY([0, 2, 0, 4, 2, 0, 0, 2, 8], 2).segments).toEqual([]);
  expect(() => sectionAtY([0, 1], 0)).toThrow('Invalid section');
  expect(() => sectionAtY([0, 0, NaN, 0, 0, 0, 0, 0, 0], 0)).toThrow('Invalid section');
});
