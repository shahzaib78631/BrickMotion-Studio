import { expect, it } from 'vitest';
import { parseLDraw } from '../../src/ldraw/parse';
import { connectorPrimitives } from '../../scripts/lib/connector-primitives';

const primitive = parseLDraw('0 Cylinder\n', '4-4cyli.dat');
it('measures a short rotated cavity with its full local frame', () => {
  const root = parseLDraw('0 Test\n0 BFC INVERTNEXT\n1 16 0 10 8 6 0 0 0 0 6 0 -16 0 4-4cyli.dat', 'test.dat');
  const result = connectorPrimitives(root, () => primitive);
  expect(result.cylinders).toHaveLength(1);
  expect(result.cylinders[0]).toMatchObject({ start: [0, 10, 8], end: [0, 10, -8],
    axis: [0, 0, -1], side: [1, 0, 0], radius: 6, length: 16, surface: 'inner' });
});

it('composes nested mirrored transforms without reversing cavity semantics', () => {
  const root = parseLDraw('0 Test\n1 16 5 0 0 -1 0 0 0 1 0 0 0 1 child.dat', 'test.dat');
  const child = parseLDraw('0 Child\n0 BFC INVERTNEXT\n1 16 2 0 0 3 0 0 0 7 0 0 0 3 4-4cyli.dat', 'child.dat');
  const result = connectorPrimitives(root, name => name === 'child.dat' ? child : primitive);
  expect(result.cylinders[0]).toMatchObject({ start: [3, 0, 0], end: [3, 7, 0], radius: 3, surface: 'inner' });
});

it('recognizes an open side stud and refuses elliptical cylinders', () => {
  const root = parseLDraw('0 Test\n1 16 0 10 -6 1 0 0 0 0 1 0 1 0 stud2a.dat\n1 16 0 0 0 3 0 0 0 7 0 0 0 4 4-4cyli.dat', 'test.dat');
  const result = connectorPrimitives(root, () => primitive);
  expect(result.studs[0]).toMatchObject({ base: [0, 10, -6], tip: [0, 10, -10], radius: 6 });
  expect(result.cylinders).toHaveLength(0);
  expect(result.rejected).toHaveLength(1);
});
