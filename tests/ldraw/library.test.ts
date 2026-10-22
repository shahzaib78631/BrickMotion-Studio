import { beforeEach, expect, test } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';
import { fetchCounts, fixtureFetchText } from '../helpers/fixtureLibrary';

let lib: PartLibrary;
beforeEach(() => {
  lib = new PartLibrary(fixtureFetchText);
  fetchCounts.clear();
});

test('body box excludes studs, full box includes them', async () => {
  const p = (await lib.loadPart('3001'))!;
  expect(p.bodyBox).toEqual({ min: [-40, 0, -20], max: [40, 24, 20] });
  expect(p.fullBox!.min[1]).toBe(-4);
});

test('missing part loads as null', async () => {
  expect(await lib.loadPart('3001x')).toBeNull();
});

test('resolves backslash and upper-case sub-file names', async () => {
  expect(await lib.getFile('S\\3001s01.dat')).not.toBeNull();
});

test('triangles from non-certified files are double sided', async () => {
  const p = (await lib.loadPart('nobfc'))!;
  expect(p.doubleSided.get(16)).toHaveLength(9);
  expect(p.tris.get(16)).toBeUndefined();
});

test('parts are fetched once', async () => {
  await lib.loadPart('3001');
  await lib.loadPart('3001');
  expect(fetchCounts.get('parts/3001.dat')).toBe(1);
});

function normalY(pts: number[]): number {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = pts;
  const u = [bx - ax, by - ay, bz - az];
  const v = [cx - ax, cy - ay, cz - az];
  return u[2] * v[0] - u[0] * v[2];
}

test('INVERTNEXT reverses winding', async () => {
  const inv = (await lib.loadPart('inv'))!.tris.get(16)!;
  const plain = (await lib.loadPart('noinv'))!.tris.get(16)!;
  expect(Math.sign(normalY(inv))).toBe(-Math.sign(normalY(plain)));
});

test('fixed colors are kept separate from main color', async () => {
  const p = (await lib.loadPart('twocolor'))!;
  expect(p.tris.get(4)).toHaveLength(9);
  expect(p.tris.get(16)).toHaveLength(9);
});

test('a mirrored reference reverses winding exactly once', async () => {
  const mir = (await lib.loadPart('mirror'))!.tris.get(16)!;
  const plain = (await lib.loadPart('noinv'))!.tris.get(16)!;
  // the mirror flips x, so the stored triangle must still face the same way as the plain one
  expect(Math.sign(normalY(mir))).toBe(Math.sign(normalY(plain)));
});
