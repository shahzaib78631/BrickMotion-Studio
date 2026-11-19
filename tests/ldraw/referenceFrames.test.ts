import { expect, it } from 'vitest';
import { parseLDraw } from '../../src/ldraw/parse';
import { parseShadow } from '../../src/ldraw/shadow';
import { referenceFrames } from '../../scripts/lib/reference-frames';

it('retains axle roll and composed mirrored frames without normalizing away scale', () => {
  const root = parseLDraw('0 Root\n1 16 5 6 7 0 0 -1 0 2 0 -1 0 0 child.dat', 'root.dat');
  const child = parseLDraw('0 Child', 'child.dat');
  const info = parseShadow('0 !LDCAD SNAP_CYL [id=axle] [gender=M] [secs=A 6 20] [scale=YOnly] [pos=1 2 3]');
  const result = referenceFrames(root, () => child, name => name === 'child.dat' ? info : null);
  expect(result.issues).toEqual([]);
  expect(result.definitions).toHaveLength(1);
  expect(result.definitions[0].frame).toEqual({ pos: [2, 10, 6], m: [0, 0, 1, 0, 2, 0, -1, 0, 0] });
});

it('applies inherited clears to children without clearing the parent definitions', () => {
  const root = parseLDraw('0 Root\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 child.dat', 'root.dat');
  const child = parseLDraw('0 Child', 'child.dat');
  const parent = parseShadow('0 !LDCAD SNAP_CLEAR\n0 !LDCAD SNAP_CYL [id=own] [gender=M] [secs=R 6 4]');
  const other = parseShadow('0 !LDCAD SNAP_CYL [id=child] [gender=M] [secs=R 6 4]');
  const result = referenceFrames(root, () => child, name => name === 'root.dat' ? parent : other);
  expect(result.definitions.map(d => d.sourceFile)).toEqual(['root.dat']);
});
