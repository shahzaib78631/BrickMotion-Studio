import { expect, test } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';
import { parseLDraw } from '../../src/ldraw/parse';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { connectorLibrary, rimSeats, supplementarySnapsFor } from '../../src/data/connectorLibrary';
import { embeddedPartId, sameGeometry } from '../../src/ldraw/partAlias';

const triangle = '0 Test\n3 16 0 0 0 10 0 0 0 10 0\n';
const otherTriangle = '0 Test\n3 16 0 0 0 30 0 0 0 10 0\n';
const twoTriangles = '0 Test\n3 16 0 0 0 10 0 0 0 10 0\n3 16 0 0 0 0 10 0 10 10 0\n';

test('connector library has one male and one female per measured wheel seat', () => {
  for (const seat of rimSeats) {
    const entries = connectorLibrary.filter((entry) => entry.group === seat.group);
    expect(entries.map((entry) => entry.part).sort()).toEqual([seat.rim, seat.tyre].sort());
    expect(entries.map((entry) => entry.gender).sort()).toEqual(['F', 'M']);
    expect(supplementarySnapsFor(seat.tyre)[0]).toMatchObject({ kind: 'gen', gender: 'F', group: seat.group, radius: seat.radius, length: expect.any(Number) });
    expect(supplementarySnapsFor(seat.rim)[0]).toMatchObject({ kind: 'gen', gender: 'M', group: seat.group, radius: seat.radius });
  }
});

test('an embedded copy gets the library shadow of the part it actually copies', async () => {
  const shadow = shadowLookupFrom({ '3001.dat': '0 !LDCAD SNAP_GEN [gender=M] [group=cloneSeat]' });
  const lib = new PartLibrary(async (path) => (path === 'parts/3001.dat' ? triangle : null), shadow);
  lib.addInline(new Map([['acme - 3001.dat', parseLDraw(triangle, 'acme - 3001.dat')]]));
  const part = await lib.loadPart('acme - 3001');
  expect(part!.snaps).toEqual([expect.objectContaining({ group: 'cloneSeat', gender: 'M' })]);
});

test('an embedded copy with different geometry is not aliased, even with a matching name', async () => {
  const shadow = shadowLookupFrom({ '3001.dat': '0 !LDCAD SNAP_GEN [gender=M] [group=cloneSeat]' });
  const lib = new PartLibrary(async (path) => (path === 'parts/3001.dat' ? twoTriangles : null), shadow);
  lib.addInline(new Map([['acme - 3001.dat', parseLDraw(triangle, 'acme - 3001.dat')]]));
  const part = await lib.loadPart('acme - 3001');
  expect(part!.snaps).toEqual([]);
});

test('same-name geometry check compares shape, not only the bounding box', () => {
  const base = new PartLibrary(async (path) => (path === 'parts/3001.dat' ? twoTriangles : null));
  const inline = new PartLibrary(async () => null);
  inline.addInline(new Map([['acme - 3001.dat', parseLDraw(triangle, 'acme - 3001.dat')]]));
  return Promise.all([base.loadPart('3001'), inline.loadPart('acme - 3001')]).then(([a, b]) => {
    expect(a!.bodyBox).toEqual(b!.bodyBox);
    expect(sameGeometry(a!, b!)).toBe(false);
  });
});

test('supplementary connectors apply without a shadow pack', async () => {
  const lib = new PartLibrary(async (path) => (path === 'parts/51011.dat' ? triangle : null));
  const part = await lib.loadPart('51011');
  expect(part!.snaps).toEqual([expect.objectContaining({ kind: 'gen', gender: 'F', group: 'rim51011_42610' })]);
});

test('supplementary connectors keep the LDCad connector that already exists', async () => {
  const shadow = shadowLookupFrom({ '42610.dat': '0 !LDCAD SNAP_GEN [gender=F] [group=authoritative]' });
  const lib = new PartLibrary(async (path) => (path === 'parts/42610.dat' ? triangle : null), shadow);
  const part = await lib.loadPart('42610');
  expect(part!.snaps!.map((snap) => snap.group).sort()).toEqual(['authoritative', 'rim51011_42610']);
});

test('a shadow group is not supplemented with the opposite gender', async () => {
  const shadow = shadowLookupFrom({ '42610.dat': '0 !LDCAD SNAP_GEN [gender=F] [group=rim51011_42610]' });
  const lib = new PartLibrary(async (path) => (path === 'parts/42610.dat' ? triangle : null), shadow);
  const part = await lib.loadPart('42610');
  expect(part!.snaps).toEqual([expect.objectContaining({ group: 'rim51011_42610', gender: 'F' })]);
});

test('embedded part ids come from the trailing library name', () => {
  expect(embeddedPartId('31039 - 13971.dat')).toBe('13971');
  expect(embeddedPartId('31039 - Blue Power Jet - 61254.dat')).toBe('61254');
  expect(embeddedPartId('13971.dat')).toBeNull();
});
