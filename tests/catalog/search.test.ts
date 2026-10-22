import { expect, test } from 'vitest';
import { searchCatalog } from '../../src/catalog/catalog';

const entries = [
  { id: '3001p01', name: 'Brick 2 x 4 with Print', category: 'Brick' },
  { id: '3002', name: 'Brick 2 x 3', category: 'Brick' },
  { id: '3001', name: 'Brick 2 x 4', category: 'Brick' },
  { id: '3039', name: 'Slope Brick 45 2 x 2', category: 'Slope' },
  { id: '30010', name: 'Brick 1 x 2 x 3 Window', category: 'Brick' },
];

test('dimension queries match either spelling and prefer plain parts', () => {
  const r = searchCatalog(entries, '2x4').map((e) => e.id);
  expect(r[0]).toBe('3001');
  expect(r).toContain('3001p01');
  expect(r).not.toContain('3002');
  expect(searchCatalog(entries, '2 x 4')[0].id).toBe('3001');
});

test('exact id first, then id prefix', () => {
  const r = searchCatalog(entries, '3001').map((e) => e.id);
  expect(r.slice(0, 3)).toEqual(['3001', '3001p01', '30010']);
});

test('all words must match', () => {
  expect(searchCatalog(entries, 'slope 45').map((e) => e.id)).toEqual(['3039']);
  expect(searchCatalog(entries, 'slope 33')).toEqual([]);
});

test('empty query returns the first entries up to the limit', () => {
  expect(searchCatalog(entries, '', 2)).toHaveLength(2);
});
