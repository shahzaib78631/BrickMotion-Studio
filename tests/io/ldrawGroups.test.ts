import { expect, test } from 'vitest';
import { importLDraw } from '../../src/io/ldrawImport';

const flat = [
  '0 Town',
  '0 MLCAD BTG station',
  '1 15 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '0 MLCAD BTG station',
  '1 15 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
  '0 MLCAD BTG car',
  '1 4 100 0 0 1 0 0 0 1 0 0 0 1 3002.dat',
  '1 1 200 0 0 1 0 0 0 1 0 0 0 1 3003.dat',
].join('\n');

test('MLCAD groups become submodels placed where they were', () => {
  const plan = importLDraw(flat, 'town.ldr');
  expect(Object.keys(plan.submodels ?? {})).toEqual(['station', 'car']);
  expect(plan.submodels!.station.steps.flatMap((s) => s.pieces)).toHaveLength(2);
  expect(plan.submodels!.car.steps.flatMap((s) => s.pieces)).toHaveLength(1);
  const main = plan.steps.flatMap((s) => s.pieces);
  expect(main).toEqual([
    { part: '3003', color: 1, ldu: [200, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { submodel: 'station', ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { submodel: 'car', ldu: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  ]);
});

test('LeoCAD groups count too; a file with one group and nothing else is left as it is', () => {
  const leo = ['0 !LEOCAD GROUP BEGIN Tree', '1 2 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '0 !LEOCAD GROUP END', '1 2 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'].join('\n');
  expect(Object.keys(importLDraw(leo, 'a.ldr').submodels ?? {})).toEqual(['tree']);
  const one = ['0 MLCAD BTG only', '1 2 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'].join('\n');
  expect(importLDraw(one, 'b.ldr').submodels).toBeUndefined();
});
