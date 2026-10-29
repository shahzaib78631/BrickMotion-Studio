import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fetchSetInventory, fetchSetParts, loadSetParts, resolveSetPart, toSetPart } from '../../src/instructions/rebrickable';

const row = {
  element_id: '6572522', quantity: 29, is_spare: false,
  part: { part_num: '22885', part_img_url: 'https://cdn.rebrickable.com/media/parts/elements/6572522.jpg', external_ids: { LDraw: ['22885'] } },
  color: { id: 72, name: 'Dark Bluish Gray', external_ids: { LDraw: { ext_ids: [72] } } },
};
const pink = {
  element_id: '4550359', quantity: 2, is_spare: false,
  part: { part_num: '3003', part_img_url: null, external_ids: { LDraw: ['3003'] } },
  color: { id: 1001, name: 'Bright Pink', external_ids: { LDraw: { ext_ids: [29] } } },
};

test('maps an API row to LDraw part and colour', () => {
  expect(toSetPart(row)).toEqual({ element: '6572522', part: '22885', ldrawPart: '22885', color: 72, colorName: 'Dark Bluish Gray', quantity: 29, spare: false, image: row.part.part_img_url });
});

test('a row without LDraw ids keeps the Rebrickable part number and a null colour', () => {
  const bare = { element_id: null, quantity: 1, is_spare: true, part: { part_num: '3001', part_img_url: null }, color: { id: 9, name: 'Mystery' } };
  expect(toSetPart(bare)).toEqual({ element: null, part: '3001', ldrawPart: '3001', color: null, colorName: 'Mystery', quantity: 1, spare: true, image: null });
});

test('follows pagination and sends the key header', async () => {
  const calls: [string, Record<string, string>][] = [];
  const pages = [{ results: [row], next: 'https://rebrickable.com/api/v3/x?page=2' }, { results: [row], next: null }];
  const parts = await fetchSetParts('40859-1', 'k', async (u, h) => { calls.push([u, h]); return pages[calls.length - 1]; });
  expect(parts).toHaveLength(2);
  expect(calls[0][0]).toBe('https://rebrickable.com/api/v3/lego/sets/40859-1/parts/?page_size=1000&inc_color_details=1');
  expect(calls[0][1]).toEqual({ Authorization: 'key k' });
  expect(calls[1][0]).toBe('https://rebrickable.com/api/v3/x?page=2');
});

test('includes sub-set parts multiplied by quantity', async () => {
  const responses: Record<string, unknown> = {
    'https://rebrickable.com/api/v3/lego/sets/40859-1/parts/?page_size=1000&inc_color_details=1': { results: [pink], next: null },
    'https://rebrickable.com/api/v3/lego/sets/40859-1/sets/?page_size=1000': { results: [{ set_num: '40859-2', quantity: 2 }], next: null },
    'https://rebrickable.com/api/v3/lego/sets/40859-2/parts/?page_size=1000&inc_color_details=1': { results: [row], next: null },
    'https://rebrickable.com/api/v3/lego/sets/40859-2/sets/?page_size=1000': { results: [], next: null },
  };
  const parts = await fetchSetInventory('40859-1', 'k', async (u) => {
    if (!(u in responses)) throw new Error(`unexpected ${u}`);
    return responses[u];
  });
  const qty = Object.fromEntries(parts.map((p) => [p.element, p.quantity]));
  expect(qty).toEqual({ '6572522': 58, '4550359': 2 });
});

test('printed part missing from LDraw falls back to unprinted, flagged', () => {
  const p = { ...toSetPart(row), part: '87079pr0255', ldrawPart: '87079pr0255' };
  expect(resolveSetPart(p, (id) => id === '87079')).toEqual({ part: '87079', color: 72, flags: ['87079pr0255 not in LDraw library; using unprinted 87079'] });
});

test('part with no LDraw file and no unprinted version is kept and flagged', () => {
  const p = { ...toSetPart(row), part: '99999', ldrawPart: '99999' };
  expect(resolveSetPart(p, () => false)).toEqual({ part: '99999', color: 72, flags: ['99999 not in LDraw library'] });
});

test('colour without an LDraw id is flagged, never guessed', () => {
  const p = { ...toSetPart(row), color: null, colorName: 'Mystery' };
  expect(resolveSetPart(p, () => true).flags).toEqual(['colour Mystery has no LDraw id']);
});

const savedKey = process.env.REBRICKABLE_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.REBRICKABLE_API_KEY;
  else process.env.REBRICKABLE_API_KEY = savedKey;
});

test('loadSetParts reuses the cache without needing a key', async () => {
  delete process.env.REBRICKABLE_API_KEY;
  const file = join(mkdtempSync(join(tmpdir(), 'rb-')), 'parts.json');
  writeFileSync(file, JSON.stringify([toSetPart(row)]));
  expect(await loadSetParts('40859-1', file)).toEqual([toSetPart(row)]);
});

test('loadSetParts explains how to set the key when it is missing', async () => {
  delete process.env.REBRICKABLE_API_KEY;
  const file = join(mkdtempSync(join(tmpdir(), 'rb-')), 'parts.json');
  await expect(loadSetParts('40859-1', file)).rejects.toThrow('Set REBRICKABLE_API_KEY (free key from rebrickable.com/users/<you>/settings/#api)');
});
