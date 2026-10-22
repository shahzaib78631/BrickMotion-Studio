import { expect, test } from 'vitest';
import { buildCatalog, parseDatHeader } from '../../src/catalog/buildCatalog';

test('parses description and category', () => {
  expect(parseDatHeader('3001.dat', '0 Brick  2 x  4\n0 Name: 3001.dat\n0 !CATEGORY Brick\n'))
    .toEqual({ id: '3001', name: 'Brick 2 x 4', category: 'Brick' });
});

test('falls back to first word for category', () => {
  expect(parseDatHeader('3039.dat', '0 Slope Brick 45  2 x  2\n')!.category).toBe('Slope');
});

test('skips moved, alias and obsolete parts', () => {
  expect(parseDatHeader('x.dat', '0 ~Moved to 3001\n')).toBeNull();
  expect(parseDatHeader('y.dat', '0 =Brick 2 x 4\n')).toBeNull();
  expect(parseDatHeader('z.dat', '0 _Brick 2 x 4 obsolete\n')).toBeNull();
});

test('prefers Rebrickable category name when the part number matches', () => {
  const out = buildCatalog([{ id: '3001', name: 'Brick 2 x 4', category: 'Brick' }],
    { parts: new Map([['3001', '11']]), categories: new Map([['11', 'Bricks']]) });
  expect(out[0].category).toBe('Bricks');
});

test('sorts ids naturally', () => {
  const out = buildCatalog([
    { id: '3010', name: 'b', category: 'x' },
    { id: '300', name: 'a', category: 'x' },
    { id: '3001', name: 'c', category: 'x' },
  ], { parts: new Map(), categories: new Map() });
  expect(out.map((e) => e.id)).toEqual(['300', '3001', '3010']);
});
