import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';

const root = join(__dirname, '..', '..', 'public', 'ldraw');
const ready = existsSync(join(root, 'p', 'stud-logo4.dat'));
const library = () => new PartLibrary(async (p) => {
  const f = join(root, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
});
const triangles = (flat: { tris: Map<number, number[]>; doubleSided: Map<number, number[]> }) =>
  [...flat.tris.values(), ...flat.doubleSided.values()].reduce((n, a) => n + a.length / 9, 0);

it.skipIf(!ready)('draws the raised logo on studs without changing stud detection or the body', async () => {
  const plain = library();
  const logos = library();
  logos.setStudLogos(true);
  for (const id of ['3001', '3794b', '6141']) {
    const a = (await plain.loadPart(id))!;
    const b = (await logos.loadPart(id))!;
    expect(triangles(b)).toBeGreaterThan(triangles(a));
    expect(b.studs).toEqual(a.studs);
    expect(b.bodyBox).toEqual(a.bodyBox);
    // the logo's own outline edges are left out so edge lines stay clean
    expect(b.edges.length).toBeLessThanOrEqual(a.edges.length);
  }
});

it.skipIf(!ready)('switching logos re-flattens parts', async () => {
  const lib = library();
  const before = triangles((await lib.loadPart('3001'))!);
  lib.setStudLogos(true);
  expect(triangles((await lib.loadPart('3001'))!)).toBeGreaterThan(before);
  lib.setStudLogos(false);
  expect(triangles((await lib.loadPart('3001'))!)).toBe(before);
});
