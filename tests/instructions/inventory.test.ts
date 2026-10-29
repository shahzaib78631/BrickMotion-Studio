import { expect, test } from 'vitest';
import { inventoryDiffs } from '../../src/instructions/inventory';
import type { SetPart } from '../../src/instructions/rebrickable';
import type { Booklet } from '../../src/instructions/types';

const sp = (element: string, ldrawPart: string, color: number, quantity: number, spare = false): SetPart =>
  ({ element, part: ldrawPart, ldrawPart, color, colorName: '', quantity, spare, image: null });
const booklet = (inventory: [string, number][]): Booklet =>
  ({ id: 'b', textHash: 'h', pages: 1, steps: [], inventory: inventory.map(([element, count]) => ({ element, count, crop: null })) });

test('an alternate element id for the same part and colour is not a difference', () => {
  const set = [sp('4211398', '3022', 1, 4), sp('6572522', '22885', 72, 29), sp('9999', '3022', 1, 1, true)];
  const extra = new Map([['302223', sp('302223', '3022', 1, 0)]]);
  expect(inventoryDiffs([booklet([['302223', 4], ['6572522', 29]])], set, extra)).toEqual([]);
});

test('real count differences are reported by part and colour', () => {
  const set = [sp('6572522', '22885', 72, 29)];
  expect(inventoryDiffs([booklet([['6572522', 27]])], set, new Map())).toEqual([
    { message: 'inventory: 22885 colour 72 is 27× in the booklets but 29× on Rebrickable' },
  ]);
});

test('booklets without an inventory page give no differences', () => {
  expect(inventoryDiffs([booklet([])], [sp('1', '3001', 4, 2)], new Map())).toEqual([]);
});
