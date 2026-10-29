import { expect, test } from 'vitest';
import { bookletUrl, orderBooklets } from '../../src/instructions/booklets';
import type { Booklet } from '../../src/instructions/types';

const booklet = (id: string, numbers: number[], textHash = id, section?: number): Booklet => ({
  id, textHash, pages: 40, inventory: [],
  steps: numbers.map((number, i) => ({ page: i + 1, number, picture: null, callout: [], substeps: [], ...(i === 0 && section ? { section } : {}) })),
});
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('bookletUrl turns a LEGO booklet id into the CDN url and leaves paths alone', () => {
  expect(bookletUrl('6668730')).toBe('https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6668730.pdf');
  expect(bookletUrl('https://example.com/x.pdf')).toBe('https://example.com/x.pdf');
  expect(bookletUrl('./booklets/6668730.pdf')).toBeNull();
});

test('duplicates are skipped and continuing booklets are ordered into one model', () => {
  const r = orderBooklets([booklet('b2', range(46, 60)), booklet('b1', range(1, 45)), booklet('b1copy', range(1, 45), 'b1')]);
  expect(r.booklets.map((b) => b.id)).toEqual(['b1', 'b2']);
  expect(r.models).toEqual([['b1', 'b2']]);
  expect(r.flags).toEqual(['b1copy is a duplicate of b1; skipped']);
});

test('a booklet that restarts at step 1 is a new model, ordered by section', () => {
  const r = orderBooklets([booklet('batman', range(1, 32), 'h2', 4), booklet('superman', range(1, 45), 'h1', 1)]);
  expect(r.models).toEqual([['superman'], ['batman']]);
  expect(r.flags).toEqual([]);
});

test('gaps in the step numbers are flagged', () => {
  const r = orderBooklets([booklet('b1', range(1, 45).filter((n) => n !== 12))]);
  expect(r.flags).toEqual(['step 12 missing']);
});

test('a PDF without instruction steps is refused', () => {
  expect(() => orderBooklets([booklet('6668733', [])])).toThrow('no instruction steps found in 6668733');
});

test('regional copies with different text but the same steps are duplicates', () => {
  const a = booklet('6668730', range(1, 45), 'text-en');
  const b = booklet('6668729', range(1, 45), 'text-other-region');
  const r = orderBooklets([a, b]);
  expect(r.models).toEqual([['6668730']]);
  expect(r.flags).toEqual(['6668729 is a duplicate of 6668730; skipped']);
});
