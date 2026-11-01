import { expect, test } from 'vitest';
import { neededBomRows } from '../../src/plan/bom';
import type { BomRow } from '../../src/plan/types';

test('drops spares and empty quantities', () => {
  expect(neededBomRows([
    { part: '3005', color: 0, quantity: 2, spare: false },
    { part: '3005', color: 0, quantity: 1, spare: true },
    { part: '3024', color: 0, quantity: 0, spare: false },
  ])).toEqual([{ part: '3005', color: 0, quantity: 2 }]);
});

test('sums the same part and colour asked for twice', () => {
  expect(neededBomRows([
    { part: '3070b', color: 0, quantity: 2, spare: false },
    { part: '3070b', color: 0, quantity: 3, spare: false },
    { part: '3023b', color: 320, quantity: 1, spare: false },
  ])).toEqual([
    { part: '3070b', color: 0, quantity: 5 },
    { part: '3023b', color: 320, quantity: 1 },
  ]);
});
