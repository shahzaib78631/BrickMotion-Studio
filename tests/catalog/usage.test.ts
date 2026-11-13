import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../../src/catalog/buildCatalog';
import { catalogEntries, frequentParts, getPartUsage, loadPartUsage, partUsageOf, usageSources } from '../../src/catalog/usage';

const entry = (id: string, name = id, category = 'Bricks'): CatalogEntry => ({ id, name, category });

const CATALOG = [entry('3001'), entry('3023'), entry('3020'), entry('3710'), entry('9999')];

const FILE = {
  format: 'brickmotion-part-usage',
  version: 1,
  sources: { omrSets: 1469, bricknetModels: 67185 },
  // [id, sets, instances, models, modelInstances] — deliberately unsorted
  parts: [
    ['3023', 1111, 24657, 0, 0],
    ['3001', 500, 1200, 900, 4000],
    ['3020', 987, 7669, 13230, 27546],
    ['3710', 1111, 11549, 13879, 33667],
    ['1234', 5, 9, 0, 0],
  ],
};

describe('part usage', () => {
  beforeEach(() => loadPartUsage(FILE));

  it('keeps the per-part counts and the corpus sizes', () => {
    expect(partUsageOf('3023')).toEqual({ sets: 1111, instances: 24657, models: 0, modelInstances: 0 });
    expect(partUsageOf('nope')).toBeUndefined();
    expect(getPartUsage().size).toBe(5);
    expect(usageSources()).toEqual({ omrSets: 1469, bricknetModels: 67185 });
  });

  it('ranks by official sets, then instances, and only returns catalog parts', () => {
    // 3023 and 3710 tie on sets (1111); 3023 has more instances, so it leads.
    // 1234 (5 sets) is dropped: it is not in the catalog.
    expect(frequentParts(CATALOG).map((e) => e.id)).toEqual(['3023', '3710', '3020', '3001']);
    expect(frequentParts(CATALOG, 2).map((e) => e.id)).toEqual(['3023', '3710']);
  });

  it('drops malformed rows instead of trusting them', () => {
    loadPartUsage({ parts: [null, ['x'], ['', 3], ['ok', 1, 2, 3, 4], ['neg', Number.NaN, -5, 0, 0], [7, 1]] });
    expect(getPartUsage().size).toBe(2);
    expect(partUsageOf('ok')).toEqual({ sets: 1, instances: 2, models: 3, modelInstances: 4 });
    expect(partUsageOf('neg')).toEqual({ sets: 0, instances: -5, models: 0, modelInstances: 0 });
  });

  it('survives a missing dataset', () => {
    loadPartUsage(undefined);
    expect(getPartUsage().size).toBe(0);
    expect(frequentParts(CATALOG)).toEqual([]);
    expect(usageSources()).toEqual({ omrSets: 0, bricknetModels: 0 });
  });
});

describe('catalogEntries', () => {
  it('keeps the given order and drops ids the catalog does not have', () => {
    expect(catalogEntries(CATALOG, ['3020', 'nope', '3001']).map((e) => e.id)).toEqual(['3020', '3001']);
    expect(catalogEntries(CATALOG, [])).toEqual([]);
  });
});
