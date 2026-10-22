import { expect, test } from 'vitest';
import { dragDelta } from '../../src/state/drag';

test('a drag on the floor becomes whole studs in plan coordinates (plan z is world −z)', () => {
  expect(dragDelta({ x: 0, z: 0 }, { x: 2.4, z: -3.6 })).toEqual({ x: 2, y: 0, z: 4 });
  expect(dragDelta({ x: 1, z: 1 }, { x: 0.6, z: 1.4 })).toEqual({ x: 0, y: 0, z: 0 });
});
