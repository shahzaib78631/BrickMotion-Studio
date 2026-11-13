import { describe, expect, it } from 'vitest';
import {
  allFileLinks, fileExtension, fileName, filterPages, pageLabel, sanitizeResult, usedExtensions,
  type BricksafePage,
} from '../../src/state/bricksafe';

const page = (url: string, files: string[]): BricksafePage => ({
  url, files, extensions: [...new Set(files.map(fileExtension))].sort(),
});

const PAGES = [
  page('https://bricksafe.com/pages/NMBS/spoorwegen/turntable/', [
    'https://bricksafe.com/files/NMBS/spoorwegen/turntable/a.io',
    'https://bricksafe.com/files/NMBS/spoorwegen/turntable/b.ldr',
  ]),
  page('https://bricksafe.com/pages/Cephei_Delta/pokemocs/klekfi/', [
    'https://bricksafe.com/files/Cephei_Delta/pokemocs/klekfi/klefki.lxf',
  ]),
];

describe('bricksafe results', () => {
  it('keeps well-formed pages and drops everything else', () => {
    const result = sanitizeResult({
      target: 100, found: 3, candidates: 63, rounds: 2, updatedAt: '2026-11-10T18:35:04+00:00', complete: true,
      pages: [
        { url: 'https://bricksafe.com/pages/a/', files: ['https://bricksafe.com/files/a/x.io'], extensions: ['io'] },
        { url: 'https://bricksafe.com/pages/empty/', files: [], extensions: [] },
        { url: '', files: ['x'] },
        null,
        { url: 'https://bricksafe.com/pages/b/', files: [7, 'y.ldr'], extensions: 'io' },
      ],
    })!;
    expect(result.pages.map((p) => p.url)).toEqual(['https://bricksafe.com/pages/a/', 'https://bricksafe.com/pages/b/']);
    expect(result.pages[1].files).toEqual(['y.ldr']);
    expect(result.pages[1].extensions).toEqual([]);
    expect(result.found).toBe(3);
    expect(result.rounds).toBe(2);
    expect(sanitizeResult(null)).toBeNull();
    expect(sanitizeResult({ pages: 'nope' })!.pages).toEqual([]);
  });

  it('reads extensions, page names and file names out of the URLs', () => {
    expect(fileExtension('https://bricksafe.com/files/a/x.io')).toBe('io');
    expect(fileExtension('https://bricksafe.com/files/a/7872%20Ox.io?x=1')).toBe('io');
    expect(fileExtension('https://bricksafe.com/pages/a/folder/')).toBe('');
    expect(pageLabel('https://bricksafe.com/pages/NMBS/spoorwegen/turntable/')).toBe('NMBS/spoorwegen/turntable');
    expect(pageLabel('https://bricksafe.com/pages/the%20build/')).toBe('the build');
    expect(fileName('https://bricksafe.com/files/a/7872%20Ox.io')).toBe('7872 Ox.io');
  });

  it('lists the extensions used, most common first', () => {
    expect(usedExtensions(PAGES)).toEqual(['io', 'ldr', 'lxf']);
    expect(allFileLinks(PAGES)).toHaveLength(3);
  });

  it('filters by text across the page and its files, and by file type', () => {
    expect(filterPages(PAGES, 'klefki', []).map((p) => p.files)).toEqual([['https://bricksafe.com/files/Cephei_Delta/pokemocs/klekfi/klefki.lxf']]);
    expect(filterPages(PAGES, 'NMBS', []).map((p) => p.url)).toEqual([PAGES[0].url]);
    expect(filterPages(PAGES, '', ['ldr'])).toEqual([{ ...PAGES[0], files: ['https://bricksafe.com/files/NMBS/spoorwegen/turntable/b.ldr'] }]);
    // a page with none of the wanted types drops out entirely
    expect(filterPages(PAGES, 'klefki', ['ldr'])).toEqual([]);
    expect(filterPages(PAGES, '', []).map((p) => p.files.length)).toEqual([2, 1]);
  });
});
