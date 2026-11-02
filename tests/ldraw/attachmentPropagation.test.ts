import { describe, expect, it } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart } from '../../src/ldraw/metrics';

/** A !HELP example belongs to the part's metadata; it is neither rendered
 * geometry nor a synthetic LDCad connector. Ensure it survives fetching,
 * flattening and measuring as the editor loads its part catalog. */
describe('source attachment metadata propagation', () => {
  it('carries both scabbard poses into metrics without synthesizing snaps', async () => {
    const source = [
      '0 Minifig Scabbard for Two Swords with Bar',
      '0 Name: 19141.dat',
      '0 !HELP Positioning of Swords',
      '0 !HELP 1 1 -.174 -9 35.1 0 -.01745 -.99985 -1 0 0 0 .99985 -.01745 30173.dat',
      '0 !HELP 1 1 -35.1 -5 .174 0 -.99985 .01745 -1 0 0 0 .01745 .99985 30173.dat',
      '0 BFC CERTIFY CCW',
      '3 16 -10 -10 0 10 -10 0 0 10 0',
    ].join('\n');
    const lib = new PartLibrary(async (path) => path === 'parts/19141.dat' ? source : null);
    const flat = await lib.loadPart('19141');
    expect(flat).not.toBeNull();
    expect(flat?.attachmentHints).toHaveLength(2);
    expect(flat?.attachmentHints?.map((x) => x.mirrored)).toEqual([false, true]);
    expect(flat?.snaps).toBeUndefined();
    const metrics = measurePart(flat, '19141');
    expect(metrics.attachmentHints?.map((x) => x.part)).toEqual(['30173.dat', '30173.dat']);
    expect(metrics.snaps).toBeUndefined();
  });
});
