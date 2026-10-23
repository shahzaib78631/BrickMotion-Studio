import { expect, test } from 'vitest';
import { flattenPart } from '../../src/ldraw/flatten';
import { parseLDraw, type LDrawFile } from '../../src/ldraw/parse';
import { gridOffsets, parseShadow, shadowLookupFrom } from '../../src/ldraw/shadow';

test('reads snap commands and their [key=value] parameters', () => {
  const info = parseShadow([
    '0 LDCad shadow info for "Plate 2 x 2"',
    '0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 4] [pos=0 8 0] [grid=C 2 C 2 20 20]',
    '0 //!LDCAD SNAP_CYL [id=aStud] [gender=F] [caps=one] [secs=R 6 4]',
    '0 !LDCAD SNAP_CLP [radius=4] [length=8] [center=true]',
    '0 !LDCAD SNAP_INCL [ref=connhole.dat] [pos=0 10 0] [ori=1 0 0 0 0 1 0 -1 0] [grid=C 3 1 20 0]',
    '0 !LDCAD SNAP_CLEAR [id=axleHole]',
  ].join('\n'));
  expect(info.snaps.map((s) => s.kind)).toEqual(['cyl', 'clp']); // the commented-out line is ignored
  const cyl = info.snaps[0];
  expect(cyl.kind === 'cyl' && cyl.gender).toBe('F');
  expect(cyl.frames.map((f) => f.pos)).toEqual([[-10, 8, -10], [-10, 8, 10], [10, 8, -10], [10, 8, 10]]);
  expect(info.includes[0].ref).toBe('connhole.dat');
  expect(info.includes[0].frames).toHaveLength(3);
  expect([...info.clear!]).toEqual(['axleHole']);
});

test('grid rows start at the position unless centred', () => {
  expect(gridOffsets('C 2 1 20 0')).toEqual([[-10, 0, 0], [10, 0, 0]]);
  expect(gridOffsets('1 C 2 0 20')).toEqual([[0, 0, -10], [0, 0, 10]]);
  expect(gridOffsets('3 1 20 0')).toEqual([[0, 0, 0], [20, 0, 0], [40, 0, 0]]);
});

const files = (src: Record<string, string>) => {
  const parsed = new Map<string, LDrawFile>(Object.entries(src).map(([k, v]) => [k, parseLDraw(v, k)]));
  return (n: string) => parsed.get(n.toLowerCase().replace(/\\/g, '/')) ?? null;
};

test('a part inherits its sub-files\' snaps, moved with the reference', () => {
  const lookup = files({
    'stud.dat': '3 16 0 0 0 1 0 0 0 0 1',
    'plate.dat': '1 16 10 0 0 1 0 0 0 1 0 0 0 1 stud.dat\n1 16 -10 0 0 1 0 0 0 1 0 0 0 1 stud.dat',
  });
  const shadow = shadowLookupFrom({ 'stud.dat': '0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [caps=one] [secs=R 6 4]' });
  const flat = flattenPart('plate', lookup('plate.dat')!, lookup, undefined, shadow);
  expect(flat.snaps!.map((s) => [s.gender, s.start, s.axis, s.length])).toEqual([
    ['M', [10, 0, 0], [0, -1, 0], 4],
    ['M', [-10, 0, 0], [0, -1, 0], 4],
  ]);
});

test('SNAP_CLEAR drops inherited snaps, by id or all of them', () => {
  const lookup = files({
    'stud.dat': '3 16 0 0 0 1 0 0 0 0 1',
    'hole.dat': '3 16 0 0 0 1 0 0 0 0 1',
    'part.dat': '1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 hole.dat',
  });
  const base = {
    'stud.dat': '0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [secs=R 6 4]',
    'hole.dat': '0 !LDCAD SNAP_CYL [id=axleHole] [gender=F] [secs=A 6 1]',
  };
  const byId = flattenPart('part', lookup('part.dat')!, lookup, undefined, shadowLookupFrom({ ...base, 'part.dat': '0 !LDCAD SNAP_CLEAR [id=axleHole]' }));
  expect(byId.snaps!.map((s) => s.id)).toEqual(['studC']);
  const all = flattenPart('part', lookup('part.dat')!, lookup, undefined, shadowLookupFrom({ ...base, 'part.dat': '0 !LDCAD SNAP_CLEAR\n0 !LDCAD SNAP_CYL [gender=M] [secs=R 4 10]' }));
  expect(all.snaps!.map((s) => s.length)).toEqual([10]); // only the part's own snap
});

test('centred sections are spread around the position', () => {
  const lookup = files({ 'pin.dat': '3 16 0 0 0 1 0 0 0 0 1' });
  const flat = flattenPart('pin', lookup('pin.dat')!, lookup, undefined, shadowLookupFrom({ 'pin.dat': '0 !LDCAD SNAP_CYL [gender=M] [secs=R 4 20] [center=true] [ori=0 -1 0 1 0 0 0 0 1]' }));
  const s = flat.snaps![0];
  expect(s.axis.map((v) => Math.round(v))).toEqual([1, 0, 0]);
  expect(s.start.map((v) => Math.round(v))).toEqual([-10, 0, 0]);
});
