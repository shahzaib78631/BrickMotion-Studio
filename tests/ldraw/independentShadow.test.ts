import { expect, it } from 'vitest';
import { independentShadowLookup } from '../../scripts/lib/independent-shadow';
import { flattenPart } from '../../src/ldraw/flatten';
import { parseLDraw } from '../../src/ldraw/parse';
import { ownSnaps } from '../../src/ldraw/shadow';
import { referenceFrames } from '../../scripts/lib/reference-frames';

it('included clear rules remove inherited primitive connectors without deleting included replacements', () => {
  const shadow = independentShadowLookup({
    'part.dat': '0 !LDCAD SNAP_INCL [ref=pin.dat]',
    'pin.dat': '0 !LDCAD SNAP_CLEAR\n0 !LDCAD SNAP_CYL [gender=M] [secs=R 6 40] [center=true]',
    'primitive.dat': '0 !LDCAD SNAP_CYL [gender=M] [secs=R 6 20]',
  });
  const part = parseLDraw('0 Pin\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 primitive.dat', 'part.dat');
  const child = parseLDraw('0 Primitive', 'primitive.dat');
  const flat = flattenPart('part', part, () => child, undefined, shadow);
  expect(flat.snaps).toHaveLength(1);
  expect(flat.snaps![0].length).toBe(40);
  expect(referenceFrames(part, () => child, shadow).definitions).toHaveLength(1);
});

it('centres finger sequences by default but preserves explicit uncentred definitions', () => {
  const shadow = independentShadowLookup({ 'hinge.dat':
    '0 !LDCAD SNAP_FGR [genderOfs=M] [seq=18 4 18] [radius=4]\n0 !LDCAD SNAP_FGR [genderOfs=M] [seq=18 4 18] [radius=4] [center=false]' });
  const snaps = ownSnaps('hinge.dat', shadow);
  expect(snaps[0].start).toEqual([0, 20, 0]);
  expect(snaps[1].start).toEqual([0, 0, 0]);
});

it('retains source modifiers and supplies clip defaults', () => {
  const shadow = independentShadowLookup({ 'part.dat':
    '0 !LDCAD SNAP_GEN [gender=F] [bounding=box 5 32 24] [mirror=corZ]\n0 !LDCAD SNAP_CLP' });
  expect(shadow('part.dat')!.snaps[0]).toMatchObject({ mirror: 'corZ' });
  expect(shadow('part.dat')!.snaps[1]).toMatchObject({ radius: 4, length: 8 });
});

it('rejects missing, cyclic and over-depth reference includes instead of truncating them', () => {
  expect(() => independentShadowLookup({ 'a.dat': '0 !LDCAD SNAP_INCL [ref=missing.dat]' })).toThrow('Missing reference include');
  expect(() => independentShadowLookup({ 'a.dat': '0 !LDCAD SNAP_INCL [ref=a.dat]' })).toThrow('cycle');
  const files: Record<string, string> = { '0.dat': '0 !LDCAD SNAP_CYL [gender=M] [secs=R 6 4]' };
  for (let i = 1; i <= 9; i++) files[`${i}.dat`] = `0 !LDCAD SNAP_INCL [ref=${i - 1}.dat]`;
  expect(() => independentShadowLookup(files)).toThrow('depth limit');
});

it('propagates named clears case-insensitively without discarding unrelated inherited connectors', () => {
  const shadow = independentShadowLookup({ 'a.dat': '0 !LDCAD SNAP_INCL [ref=b.dat]', 'b.dat': '0 !LDCAD SNAP_CLEAR [id=Stud]' });
  expect(shadow('a.dat')!.clear).toEqual(new Set(['stud']));
});
